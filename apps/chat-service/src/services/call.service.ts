import { randomUUID } from "node:crypto";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";
import { env } from "../config/env.js";
import type { Redis, Cluster } from "ioredis";
import type { Call } from "../generated/prisma/index.js";
import type { CallRepository } from "../repositories/call.repository.js";
import type { FriendshipRepository } from "../repositories/friendship.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { LiveKitCredentials, LiveKitService } from "./livekit.service.js";
import type {
  CallChatMessageService,
  CallChatMessageOutcome,
} from "./call-chat-message.service.js";
import type { CallPrivacy } from "../grpc/user-snapshot.client.js";
import type { CallFlagService } from "./call-flag.service.js";
import { buildParticipantsKey, generateRoomId } from "../lib/room-id.js";
import {
  publishCallIncomingSafe,
  publishCallMissedSafe,
  publishCallCancelSafe,
} from "../events/publish-call-incoming.js";
import { CallStatus, CallType } from "../types/enums.js";

/**
 * Callee-scoped privacy lookup. Kept as an injected function (not a client
 * object) so tests can stub it without touching gRPC/opossum.
 * ponytail: no cache — read hits Postgres once per call attempt via user-service.
 * Add read-through Redis if call-attempt rate ever becomes a real cost.
 */
export type GetCallPrivacyFn = (userId: string) => Promise<CallPrivacy>;

/**
 * Fetch caller display name + presigned avatar URL for the `call:incoming`
 * event so the callee's FE can render the ringing UI without a second lookup.
 * Returns empty strings on failure — a lookup miss must never block a call.
 */
export type GetUserSnapshotFn = (
  userId: string
) => Promise<{ displayName: string; avatarUrl: string }>;

export class CallService {
  constructor(
    private readonly callRepo: CallRepository,
    private readonly privateRoomRepo: PrivateRoomRepository,
    private readonly redis: Redis | Cluster,
    private readonly livekit: LiveKitService,
    private readonly friendshipRepo: FriendshipRepository,
    private readonly getCallPrivacy: GetCallPrivacyFn,
    private readonly getUserSnapshot: GetUserSnapshotFn,
    private readonly callChatMessages?: Pick<CallChatMessageService, "post">,
    /**
     * Platform-wide calling kill-switch. Optional so existing call sites and
     * tests that predate it construct unchanged — when absent, calling is on.
     */
    private readonly callFlags?: Pick<CallFlagService, "isCallingEnabled">,
    /** Optional so pre-existing 1:1-only construction sites/tests keep compiling. */
    private readonly groupMemberRepo?: Pick<
      GroupMemberRepository,
      "findActiveByRoomAndUser" | "findActiveMembers"
    >
  ) {}

  /**
   * GROUP calls only: the full rung roster. 1:1 calls: the single calleeId.
   * `calleeIds` defaults to `[]` in the schema but pre-migration rows (and
   * hand-built test fixtures) may still lack it entirely — treat missing the
   * same as empty rather than throwing.
   */
  private ringTargets(call: Pick<Call, "calleeId" | "calleeIds">): string[] {
    const ids = call.calleeIds ?? [];
    return ids.length > 0 ? ids : [call.calleeId];
  }

  /**
   * Publish to the call room AND to every participant's personal room.
   *
   * `call:<callId>` is joined only inside the call:initiate / call:answer ack, so a
   * socket that reconnects mid-call is no longer in it and would never learn the call
   * ended — the panel hangs on a live call forever. `self:<userId>` is re-joined on
   * every connect, so mirroring there is what makes terminal events survive a
   * reconnect. Clients already ignore events for a callId they aren't on, so the
   * double delivery to a socket in both rooms is a no-op.
   *
   * Every publish is independently non-fatal: a call must still end if one fails.
   */
  private async publishToCallAndParticipants(
    call: Pick<Call, "callId" | "callerId" | "calleeId" | "calleeIds">,
    payload: string,
    logTag: string
  ): Promise<void> {
    const warn = (target: string) => (err: unknown) =>
      logger.warn(
        `CallService|${logTag}|redis publish failed target=${target}: ${String(err)}`
      );
    const selves = [call.callerId, ...this.ringTargets(call)];
    await Promise.all([
      this.redis
        .publish(`call:${call.callId}`, payload)
        .catch(warn(`call:${call.callId}`)),
      ...selves.map((userId) =>
        this.redis
          .publish(`self:${userId}`, payload)
          .catch(warn(`self:${userId}`))
      ),
    ]);
  }

  /** True if `userId` is a callee on this call — 1:1's calleeId OR a GROUP roster member. */
  private isCallee(
    call: Pick<Call, "calleeId" | "calleeIds">,
    userId: string
  ): boolean {
    return call.calleeId === userId || (call.calleeIds ?? []).includes(userId);
  }

  /**
   * Serialize one caller's `initiateCall` critical section (self-cleanup → busy
   * gate → create).
   *
   * Without it the RPC is fully re-entrant, and two rapid initiates from the same
   * user interleave: one request's self-cleanup — which runs BEFORE its own row
   * exists — flips to ENDED the row the other request created milliseconds
   * earlier. The victim carries on obliviously, minting tokens and ringing the
   * callee for a call already dead in the DB, and the caller is never told.
   *
   * Fails OPEN when Redis is unreachable: this race is rare and a total calling
   * outage is not an acceptable trade. Short TTL so a crashed holder cannot wedge
   * a user out of calling, and release is token-checked so an expired lock that
   * was retaken by a newer attempt is never deleted out from under it.
   */
  private async withCallerLock<T>(
    callerId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const LOCK_TTL_MS = 10_000;
    const key = `lock:call-initiate:${callerId}`;
    const token = randomUUID();
    try {
      const held = await this.redis.set(key, token, "PX", LOCK_TTL_MS, "NX");
      if (held !== "OK") throw new ConflictError("CALL_ALREADY_IN_CALL");
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      logger.warn(`CallService|withCallerLock|acquire failed: ${String(err)}`);
      return fn();
    }
    try {
      return await fn();
    } finally {
      try {
        await this.redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token
        );
      } catch (err) {
        logger.warn(
          `CallService|withCallerLock|release failed: ${String(err)}`
        );
      }
    }
  }

  async initiateCall(params: {
    callerId: string;
    calleeId: string;
    type: string;
    privateRoomId?: string | null;
  }): Promise<Call & { livekit: LiveKitCredentials }> {
    if (params.callerId === params.calleeId) {
      throw new BadRequestError("CALL_SELF_NOT_ALLOWED");
    }

    // Gate 0: platform-wide kill-switch (admin panel). Checked before every
    // other gate because it's global — no point resolving friendship/privacy
    // for a feature that is switched off. Fails OPEN: `isCallingEnabled` never
    // throws, and an absent flag service means calling is on. Blocks only NEW
    // calls; anything already connected keeps running.
    if (this.callFlags && !(await this.callFlags.isCallingEnabled())) {
      throw new ForbiddenError("CALLING_DISABLED");
    }

    // Gate 1: callee's `whoCanCallMe` privacy setting (user-service). Read
    // BEFORE friendship, because EVERYONE is the one scope that deliberately
    // admits a non-friend — running the friendship gate first would reject
    // those callers with FRIENDSHIP_REQUIRED and make EVERYONE unreachable.
    const privacy = await this.getCallPrivacy(params.calleeId);
    if (privacy.whoCanCallMe === "NO_ONE") {
      throw new ForbiddenError("PRIVACY_BLOCKED");
    }

    // Gate 2: friendship, waived ONLY by EVERYONE. Local Prisma read on
    // chat-service's event-sourced Friendship replica — no gRPC hop. Blocks
    // non-friends AND ex-friends (the shared-DM-room check below is a
    // defense-in-depth, not this).
    if (privacy.whoCanCallMe !== "EVERYONE") {
      const areFriends = await this.friendshipRepo.areFriends(
        params.callerId,
        params.calleeId
      );
      if (!areFriends) throw new ForbiddenError("FRIENDSHIP_REQUIRED");
    }

    // SELECTED_FRIENDS additionally requires the caller to be in the allow-list
    // (friendship itself was already enforced by gate 2).
    if (
      privacy.whoCanCallMe === "SELECTED_FRIENDS" &&
      !privacy.allowedUserIds.includes(params.callerId)
    ) {
      throw new ForbiddenError("PRIVACY_BLOCKED");
    }

    // The caller and callee MUST share a private DM room — without this, any
    // authenticated user could ring an arbitrary calleeId (stranger, non-friend)
    // by supplying a fabricated/omitted privateRoomId. When the client omits
    // privateRoomId, derive the canonical room for this pair instead of
    // trusting an unrelated calleeId outright.
    const participantsKey = buildParticipantsKey(
      params.callerId,
      params.calleeId
    );
    let room = params.privateRoomId
      ? await this.privateRoomRepo.findByRoomId(params.privateRoomId, {
          projection: { participants: 1, blockedBy: 1 },
        })
      : await this.privateRoomRepo.findByParticipantsKey(participantsKey);
    // whoCanCallMe=EVERYONE means a stranger may ring — and a stranger has no
    // DM room yet, so requiring one would silently re-impose the friendship
    // gate this scope exists to waive. Open the canonical room for the pair,
    // exactly as the first message between them would.
    // ponytail: no conv:created fan-out here (the ringing UI is the client's
    // signal); add it if an empty room ever needs to appear in the inbox
    // before the call is answered.
    if (!room && privacy.whoCanCallMe === "EVERYONE" && !params.privateRoomId) {
      room = await this.privateRoomRepo.create({
        roomId: generateRoomId("prv"),
        participants: [params.callerId, params.calleeId].sort(),
        participantsKey,
      });
    }
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    const participants = Array.isArray(room.participants)
      ? (room.participants as string[])
      : [];
    if (
      !participants.includes(params.callerId) ||
      !participants.includes(params.calleeId)
    ) {
      throw new ForbiddenError("CHAT_NOT_PARTICIPANT");
    }

    const blockedBy = Array.isArray(room.blockedBy)
      ? (room.blockedBy as string[])
      : [];
    if (blockedBy.includes(params.callerId)) {
      throw new ForbiddenError("CALL_BLOCKED");
    }

    // Busy/conflict handling. Only GENUINELY-active calls block a new one: a
    // call is active iff IN_PROGRESS, or RINGING and still within the ringing
    // window (`initiatedAt >= freshCutoff`). A RINGING row older than that is a
    // crashed/abandoned attempt about to be swept to MISSED — never "busy".
    // This freshness bound is the guard against the old false-busy regression.
    const now = new Date();
    const freshCutoff = new Date(
      now.getTime() - env.CALL_RINGING_TIMEOUT_SEC * 1000
    );
    // Same idea for answered calls: past this, the row is an abandoned session
    // the sweep is about to end, not a real conversation.
    const liveCutoff = new Date(
      now.getTime() - env.CALL_MAX_DURATION_SEC * 1000
    );

    const callId = randomUUID();

    // (a) self-cleanup, (b) busy gate and the create MUST be atomic per caller —
    // see withCallerLock. Outside the lock, a concurrent initiate's self-cleanup
    // cancels the row this one is about to create.
    const call = await this.withCallerLock(params.callerId, async () => {
      // (a) Self-cleanup: a new outgoing call means the caller abandoned any prior
      // OUTGOING ring. Cancel the caller's own RINGING-as-caller rows so (1) the
      // caller is never falsely "busy" on their own zombie call, and (2) the old
      // callee's ring stops immediately instead of waiting for the sweep.
      // Bounded by `now` so it can only ever touch rings that predate this
      // request — belt to the lock's braces if a lock is ever lost or expires.
      const ownRinging = await this.callRepo.findCallerRinging(
        params.callerId,
        now
      );
      for (const stale of ownRinging) {
        const { won } = await this.callRepo.claimStatusTransition(
          stale.callId,
          CallStatus.RINGING,
          { status: CallStatus.ENDED, endedAt: now, endedBy: params.callerId }
        );
        if (!won) continue;
        await this.redis
          .publish(
            `self:${stale.calleeId}`,
            JSON.stringify({
              event: "call:cancelled",
              data: { callId: stale.callId },
            })
          )
          .catch((err: unknown) =>
            logger.warn(
              `CallService|initiateCall|self-cleanup publish failed: ${String(err)}`
            )
          );
      }

      // (b) Busy gate — is either party genuinely active right now?
      const active = await this.callRepo.findActiveByParticipant(
        [params.callerId, params.calleeId],
        freshCutoff,
        liveCutoff
      );
      const calleeBusy = active.some(
        (c) => c.callerId === params.calleeId || c.calleeId === params.calleeId
      );
      if (calleeBusy) throw new ConflictError("CALL_USER_BUSY");
      const callerBusy = active.some(
        (c) => c.callerId === params.callerId || c.calleeId === params.callerId
      );
      // Defense-in-depth: the caller's own client also guards against this, and
      // self-cleanup above already cleared their outbound rings — reaching here
      // means the caller is IN_PROGRESS or has a fresh INCOMING ring to handle.
      if (callerBusy) throw new ConflictError("CALL_ALREADY_IN_CALL");

      return this.callRepo.create({
        callId,
        callerId: params.callerId,
        calleeId: params.calleeId,
        type: params.type || CallType.AUDIO,
        status: CallStatus.RINGING,
        // Always persist the canonical room we authorized above. The website
        // normally omits privateRoomId and lets us derive it from the pair.
        privateRoomId: room.roomId,
      });
    });

    // Glare backstop: the true sub-latency A↔B race where both initiates pass
    // gate (b) before either row is visible. After create, look for a reciprocal
    // active call for this exact pair. Deterministic winner = lexicographically
    // smaller callId; the loser cancels its own row and throws busy BEFORE
    // publishing call:incoming — so it creates no client session and sends no
    // stray ring, and the loser's caller (the winner's callee) still gets the
    // winner's ring and can answer it. One call connects, deterministically.
    // ponytail: residual — if both creates AND both reciprocal reads interleave
    // sub-ms, neither sees the other and the 60s ring-timeout is the final
    // backstop. Add a unique sorted-pair index only if this shows up in practice.
    const reciprocal = await this.callRepo.findActiveBetween(
      params.callerId,
      params.calleeId,
      call.callId,
      freshCutoff,
      liveCutoff
    );
    if (reciprocal && call.callId > reciprocal.callId) {
      await this.callRepo.claimStatusTransition(
        call.callId,
        CallStatus.RINGING,
        {
          status: CallStatus.ENDED,
          endedAt: now,
          endedBy: params.callerId,
        }
      );
      throw new ConflictError("CALL_USER_BUSY");
    }

    // Mint both LiveKit tokens up-front + fetch caller snapshot for the ringing
    // UI in parallel — all three are independent I/O.
    // roomName == callId — generalizes cleanly to group later.
    const [callerCreds, calleeCreds, callerSnapshot, calleeSnapshot] =
      await Promise.all([
        this.livekit.mintToken(callId, params.callerId),
        this.livekit.mintToken(callId, params.calleeId),
        this.getUserSnapshot(params.callerId).catch(() => ({
          displayName: "",
          avatarUrl: "",
        })),
        this.getUserSnapshot(params.calleeId).catch(() => ({
          displayName: "",
          avatarUrl: "",
        })),
      ]);

    // Notify callee via Redis `self:<id>` — NOT `user:<id>`. Every peer that
    // presence:subscribed joins Socket.IO `user:<calleeId>`; publishing there
    // leaked call:incoming (and LiveKit tokens) to the caller, who then ran
    // busy auto-decline logic on zombie HMR sockets.
    await Promise.all([
      this.redis
        .publish(
          `self:${params.calleeId}`,
          JSON.stringify({
            event: "call:incoming",
            data: {
              callId,
              callerId: params.callerId,
              callerName: callerSnapshot.displayName,
              callerAvatarUrl: callerSnapshot.avatarUrl,
              callType: params.type || CallType.AUDIO,
              livekitUrl: calleeCreds.url,
              token: calleeCreds.token,
            },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CallService|initiateCall|redis publish incoming failed: ${String(err)}`
          );
        }),
      this.redis
        .publish(
          `self:${params.callerId}`,
          JSON.stringify({
            event: "call:outgoing_mirror",
            data: {
              callId,
              calleeId: params.calleeId,
              calleeName: calleeSnapshot.displayName,
              calleeAvatarUrl: calleeSnapshot.avatarUrl,
              callType: params.type || CallType.AUDIO,
            },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CallService|initiateCall|redis publish outgoing_mirror failed: ${String(err)}`
          );
        }),
    ]);

    // Push fallback: the Redis/socket path above only reaches a LIVE socket. A
    // callee with the tab backgrounded or closed gets nothing, so also fan out a
    // high-priority FCM push via notifications-service. Fire-and-forget — never
    // blocks or fails the call.
    publishCallIncomingSafe({
      callId,
      calleeId: params.calleeId,
      callerId: params.callerId,
      callerName: callerSnapshot.displayName,
      callerAvatar: callerSnapshot.avatarUrl,
      callType: params.type || CallType.AUDIO,
      initiatedAt: now.getTime(),
      livekitUrl: calleeCreds.url,
      token: calleeCreds.token,
    });

    return { ...call, livekit: callerCreds };
  }

  /**
   * GROUP call — MVP scope, deliberately simpler than {@link initiateCall}'s
   * 1:1 gating:
   *  - Authorization is group ACTIVE-membership, not friendship/privacy (the
   *    group itself is the trust boundary the caller and every rung member
   *    already crossed by being members).
   *  - Busy-gate is "is the CALLER already on a call" + "is there already an
   *    active call for this group" — no per-callee busy/glare checking across
   *    the whole roster (that's real N-party call-state work, out of scope
   *    for this MVP; a busy member's own answerCall attempt just never
   *    succeeds if they end up double-booked).
   *  - No CallChatMessageService audit trail yet (see postCallChatMessageSafe).
   *  - No friendship gate, and only the `whoCanCallMe = NO_ONE` opt-out from
   *    the privacy gate — group membership implies consent to be rung by the
   *    group, but never overrides an explicit "nobody may call me".
   */
  async initiateGroupCall(params: {
    callerId: string;
    groupId: string;
    type: string;
  }): Promise<Call & { livekit: LiveKitCredentials }> {
    if (!this.groupMemberRepo) {
      throw new ForbiddenError("CALLING_DISABLED");
    }
    if (this.callFlags && !(await this.callFlags.isCallingEnabled())) {
      throw new ForbiddenError("CALLING_DISABLED");
    }

    const caller = await this.groupMemberRepo.findActiveByRoomAndUser(
      params.groupId,
      params.callerId
    );
    if (!caller) throw new ForbiddenError("CHAT_NOT_A_MEMBER");

    const members = await this.groupMemberRepo.findActiveMembers(
      params.groupId
    );
    const rosterIds = members
      .map((m) => m.userId)
      .filter((id) => id !== params.callerId);
    // `whoCanCallMe = NO_ONE` is a hard opt-out from ringing, and it holds
    // inside groups too — a member who chose it must get no call:incoming, no
    // push and no VoIP wake, even though group membership is otherwise the
    // trust boundary here. FRIENDS / SELECTED_FRIENDS are deliberately NOT
    // applied: group members frequently aren't friends, and enforcing those
    // would break group calling for everyone rather than honor an opt-out.
    // Fails OPEN per member: a user-service blip must not silence a whole
    // group call, and NO_ONE is still enforced on the callee's own answer path.
    const optedOut = new Set(
      (
        await Promise.all(
          rosterIds.map(async (id) => {
            try {
              const p = await this.getCallPrivacy(id);
              return p.whoCanCallMe === "NO_ONE" ? id : null;
            } catch {
              return null;
            }
          })
        )
      ).filter((id): id is string => id !== null)
    );
    const calleeIds = rosterIds.filter((id) => !optedOut.has(id));
    if (calleeIds.length === 0) {
      throw new BadRequestError("CALL_SELF_NOT_ALLOWED");
    }

    const now = new Date();
    const freshCutoff = new Date(
      now.getTime() - env.CALL_RINGING_TIMEOUT_SEC * 1000
    );
    const liveCutoff = new Date(
      now.getTime() - env.CALL_MAX_DURATION_SEC * 1000
    );

    // Caller busy-gate — reuses the same "genuinely active" predicate as 1:1.
    const callerActive = await this.callRepo.findActiveByParticipant(
      [params.callerId],
      freshCutoff,
      liveCutoff
    );
    if (callerActive.length > 0) {
      throw new ConflictError("CALL_ALREADY_IN_CALL");
    }

    // Group busy-gate — one call per group at a time (MVP policy).
    const activeGroupCall = await this.callRepo.findActiveByGroup(
      params.groupId,
      freshCutoff,
      liveCutoff
    );
    if (activeGroupCall) {
      throw new ConflictError("CALL_USER_BUSY");
    }

    const callId = randomUUID();
    const call = await this.callRepo.create({
      callId,
      callerId: params.callerId,
      calleeId: "",
      type: params.type || CallType.AUDIO,
      status: CallStatus.RINGING,
      groupId: params.groupId,
      calleeIds,
    });

    const callerSnapshot = await this.getUserSnapshot(params.callerId).catch(
      () => ({ displayName: "", avatarUrl: "" })
    );

    // Mint one LiveKit token per rung member (all join the SAME room = callId
    // — LiveKit itself needs no group-specific handling) + the caller's own,
    // then fan out the ring. Same self:<id> channel/shape 1:1 uses, just
    // looped over the roster.
    const calleeCredsList = await Promise.all(
      calleeIds.map((id) => this.livekit.mintToken(callId, id))
    );
    const callerCreds = await this.livekit.mintToken(callId, params.callerId);

    await Promise.all(
      calleeIds.map((calleeId, i) =>
        this.redis
          .publish(
            `self:${calleeId}`,
            JSON.stringify({
              event: "call:incoming",
              data: {
                callId,
                callerId: params.callerId,
                callerName: callerSnapshot.displayName,
                callerAvatarUrl: callerSnapshot.avatarUrl,
                callType: params.type || CallType.AUDIO,
                groupId: params.groupId,
                livekitUrl: calleeCredsList[i]!.url,
                token: calleeCredsList[i]!.token,
              },
            })
          )
          .catch((err: unknown) => {
            logger.warn(
              `CallService|initiateGroupCall|redis publish incoming failed calleeId=${calleeId}: ${String(err)}`
            );
          })
      )
    );

    await this.redis
      .publish(
        `self:${params.callerId}`,
        JSON.stringify({
          event: "call:outgoing_mirror",
          data: {
            callId,
            groupId: params.groupId,
            calleeIds,
            callType: params.type || CallType.AUDIO,
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `CallService|initiateGroupCall|redis publish outgoing_mirror failed: ${String(err)}`
        );
      });

    for (let i = 0; i < calleeIds.length; i++) {
      publishCallIncomingSafe({
        callId,
        calleeId: calleeIds[i]!,
        callerId: params.callerId,
        callerName: callerSnapshot.displayName,
        callerAvatar: callerSnapshot.avatarUrl,
        callType: params.type || CallType.AUDIO,
        initiatedAt: now.getTime(),
        livekitUrl: calleeCredsList[i]!.url,
        token: calleeCredsList[i]!.token,
      });
    }

    return { ...call, livekit: callerCreds };
  }

  async answerCall(params: {
    callId: string;
    calleeId: string;
  }): Promise<Call & { livekit: LiveKitCredentials }> {
    const call = await this.callRepo.findByCallId(params.callId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    if (!this.isCallee(call, params.calleeId))
      throw new ForbiddenError("CALL_NOT_PARTICIPANT");
    const livekit = await this.livekit.mintToken(
      params.callId,
      params.calleeId
    );
    if (call.status === CallStatus.IN_PROGRESS) return { ...call, livekit };
    if (call.status !== CallStatus.RINGING)
      throw new BadRequestError("CALL_NOT_RINGING");

    // Busy re-check: callee may already be IN_PROGRESS on a different call
    // (race: two callers initiated before either row existed, bypassing the
    // create-time busy gate). Exclude the call being answered.
    const now = new Date();
    const freshCutoff = new Date(
      now.getTime() - env.CALL_RINGING_TIMEOUT_SEC * 1000
    );
    const liveCutoff = new Date(
      now.getTime() - env.CALL_MAX_DURATION_SEC * 1000
    );
    const calleeConcurrent = await this.callRepo.findActiveByParticipant(
      [params.calleeId],
      freshCutoff,
      liveCutoff
    );
    const alreadyBusy = calleeConcurrent.some(
      (c) => c.callId !== params.callId && c.status === CallStatus.IN_PROGRESS
    );
    if (alreadyBusy) throw new ConflictError("CALL_USER_BUSY");

    const answeredAt = new Date();
    const { won } = await this.callRepo.claimStatusTransition(
      params.callId,
      CallStatus.RINGING,
      {
        status: CallStatus.IN_PROGRESS,
        answeredAt,
      }
    );
    if (!won) {
      const again = await this.callRepo.findByCallId(params.callId);
      if (again?.status === CallStatus.IN_PROGRESS)
        return { ...again, livekit };
      throw new BadRequestError("CALL_NOT_RINGING");
    }
    const updated: Call = {
      ...call,
      status: CallStatus.IN_PROGRESS,
      answeredAt,
      updatedAt: answeredAt,
    };

    await Promise.all([
      this.publishToCallAndParticipants(
        updated,
        JSON.stringify({
          event: "call:answered",
          data: { callId: params.callId },
        }),
        "answerCall"
      ),
      this.publishCallHandled(
        params.calleeId,
        params.callId,
        "answered_elsewhere"
      ),
    ]);

    publishCallCancelSafe({
      calleeId: params.calleeId,
      callId: params.callId,
      reason: "answered_elsewhere",
      callerId: call.callerId,
    });

    return { ...updated, livekit };
  }

  async declineCall(params: {
    callId: string;
    calleeId: string;
  }): Promise<Call> {
    const call = await this.callRepo.findByCallId(params.callId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    if (!this.isCallee(call, params.calleeId))
      throw new ForbiddenError("CALL_NOT_PARTICIPANT");
    // Idempotent / stale-UI: already left RINGING — succeed without error so
    // double-taps don't trip the gateway circuit breaker.
    if (call.status !== CallStatus.RINGING) return call;

    // GROUP: one member declining must NOT kill the ring for the rest of the
    // roster (unlike 1:1, where the single callee declining IS the whole
    // call). Drop them from calleeIds and tell the caller; only transition
    // the call to DECLINED once the last rung member has declined.
    if (call.groupId && call.calleeIds.length > 0) {
      const updated = await this.callRepo.removeGroupCallee(
        params.callId,
        params.calleeId
      );
      if (!updated) throw new NotFoundError("CALL_NOT_FOUND");

      await Promise.all([
        this.redis
          .publish(
            `call:${params.callId}`,
            JSON.stringify({
              event: "call:member_declined",
              data: { callId: params.callId, userId: params.calleeId },
            })
          )
          .catch((err: unknown) => {
            logger.warn(
              `CallService|declineCall(group)|redis publish failed: ${String(err)}`
            );
          }),
        this.publishCallHandled(
          params.calleeId,
          params.callId,
          "declined_elsewhere"
        ),
      ]);
      publishCallCancelSafe({
        calleeId: params.calleeId,
        callId: params.callId,
        reason: "declined",
        callerId: call.callerId,
      });

      if (updated.calleeIds.length > 0) return updated;

      // Last rung member declined — end the call for the caller too, same
      // terminal shape as 1:1's single-callee decline.
      const endedAt = new Date();
      const { won } = await this.callRepo.claimStatusTransition(
        params.callId,
        CallStatus.RINGING,
        { status: CallStatus.DECLINED, endedAt, endedBy: params.calleeId }
      );
      if (won) {
        await this.redis
          .publish(
            `call:${params.callId}`,
            JSON.stringify({
              event: "call:declined",
              data: { callId: params.callId },
            })
          )
          .catch((err: unknown) => {
            logger.warn(
              `CallService|declineCall(group)|final publish failed: ${String(err)}`
            );
          });
      }
      const again = await this.callRepo.findByCallId(params.callId);
      return (
        again ?? {
          ...updated,
          status: CallStatus.DECLINED,
          endedAt,
          endedBy: params.calleeId,
        }
      );
    }

    const endedAt = new Date();
    const { won } = await this.callRepo.claimStatusTransition(
      params.callId,
      CallStatus.RINGING,
      {
        status: CallStatus.DECLINED,
        endedAt,
        endedBy: params.calleeId,
      }
    );
    if (!won) {
      const again = await this.callRepo.findByCallId(params.callId);
      if (again) return again;
      throw new BadRequestError("CALL_NOT_RINGING");
    }
    const updated: Call = {
      ...call,
      status: CallStatus.DECLINED,
      endedAt,
      endedBy: params.calleeId,
      updatedAt: endedAt,
    };

    await Promise.all([
      this.publishToCallAndParticipants(
        updated,
        JSON.stringify({
          event: "call:declined",
          data: { callId: params.callId },
        }),
        "declineCall"
      ),
      this.publishCallHandled(
        params.calleeId,
        params.callId,
        "declined_elsewhere"
      ),
    ]);

    publishCallCancelSafe({
      calleeId: params.calleeId,
      callId: params.callId,
      reason: "declined",
      callerId: call.callerId,
    });

    await this.postCallChatMessageSafe(
      updated,
      "DECLINED",
      endedAt,
      0,
      params.calleeId
    );

    return updated;
  }

  private async publishCallHandled(
    calleeId: string,
    callId: string,
    reason: "answered_elsewhere" | "declined_elsewhere"
  ): Promise<void> {
    await this.redis
      .publish(
        `self:${calleeId}`,
        JSON.stringify({
          event: "call:handled",
          data: { callId, reason },
        })
      )
      .catch((err: unknown) => {
        logger.warn(`CallService|call:handled publish failed: ${String(err)}`);
      });
  }

  async endCall(params: {
    callId: string;
    userId: string;
  }): Promise<Call & { durationSec: number }> {
    const call = await this.callRepo.findByCallId(params.callId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    if (
      call.callerId !== params.userId &&
      !this.isCallee(call, params.userId)
    ) {
      throw new ForbiddenError("CALL_NOT_PARTICIPANT");
    }
    const activeStatuses: string[] = [
      CallStatus.RINGING,
      CallStatus.IN_PROGRESS,
    ];
    // Idempotent hangup — double-tap / teardown-after-terminal must not error.
    if (!activeStatuses.includes(call.status)) {
      return { ...call, durationSec: call.durationSec ?? 0 };
    }

    const endedAt = new Date();
    const wasRinging = call.status === CallStatus.RINGING;
    const durationSec = call.answeredAt
      ? Math.max(
          0,
          Math.floor((endedAt.getTime() - call.answeredAt.getTime()) / 1000)
        )
      : 0;

    const { won } = await this.callRepo.claimStatusTransition(
      params.callId,
      call.status,
      {
        status: CallStatus.ENDED,
        endedAt,
        durationSec,
        endedBy: params.userId,
      }
    );
    if (!won) {
      const again = await this.callRepo.findByCallId(params.callId);
      if (again && !activeStatuses.includes(again.status)) {
        return { ...again, durationSec: again.durationSec ?? durationSec };
      }
      throw new BadRequestError("CALL_ALREADY_ENDED");
    }
    const updated: Call = {
      ...call,
      status: CallStatus.ENDED,
      endedAt,
      durationSec,
      endedBy: params.userId,
      updatedAt: endedAt,
    };

    // Pre-answer cancel: rung callee(s) never joined `call:<id>` room, reach
    // them via their personal `self:<id>` channel with `call:cancelled`
    // instead. GROUP calls loop the whole rung roster; 1:1 is the same single
    // publish it always was.
    if (wasRinging) {
      const targets = this.ringTargets(call);
      await Promise.all(
        targets.map((calleeId) =>
          this.redis
            .publish(
              `self:${calleeId}`,
              JSON.stringify({
                event: "call:cancelled",
                data: { callId: params.callId },
              })
            )
            .catch((err: unknown) => {
              logger.warn(
                `CallService|endCall|cancel publish failed calleeId=${calleeId}: ${String(err)}`
              );
            })
        )
      );

      for (const calleeId of targets) {
        publishCallCancelSafe({
          calleeId,
          callId: params.callId,
          reason: "ended",
          callerId: call.callerId,
        });
      }

      await this.postCallChatMessageSafe(
        updated,
        "CANCELLED",
        endedAt,
        0,
        params.userId
      );
    } else {
      await this.publishToCallAndParticipants(
        updated,
        JSON.stringify({
          event: "call:ended",
          data: {
            callId: params.callId,
            endedBy: params.userId,
            durationSec,
          },
        }),
        "endCall"
      );

      await this.postCallChatMessageSafe(
        call,
        "ENDED",
        endedAt,
        durationSec,
        params.userId
      );
    }

    return { ...updated, durationSec };
  }

  async getCallByCallId(
    callId: string,
    requesterId: string
  ): Promise<Call | null> {
    const call = await this.callRepo.findByCallId(callId);
    if (!call) return null;
    // IDOR guard: only the caller or callee may read a call's details (AUDIT H8).
    if (call.callerId !== requesterId && !this.isCallee(call, requesterId)) {
      throw new ForbiddenError("CALL_NOT_PARTICIPANT");
    }
    return call;
  }

  async getCallHistory(params: {
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<{ calls: Call[]; nextCursor: string | null; hasMore: boolean }> {
    const calls = await this.callRepo.findByParticipant(
      params.userId,
      params.limit + 1,
      params.cursor
    );
    const hasMore = calls.length > params.limit;
    const page = calls.slice(0, params.limit);
    const nextCursor =
      hasMore && page.length > 0
        ? page[page.length - 1]!.initiatedAt.toISOString()
        : null;
    return { calls: page, nextCursor, hasMore };
  }

  /**
   * Sweep stuck RINGING calls → MISSED and publish `call:missed` to both the
   * caller (in `call:<callId>` room since Phase 1) and the callee (only in
   * their `self:<id>` room since they never answered), plus an FCM push to the
   * callee so a backgrounded/offline device still finds out. Idempotent per row
   * via `callRepo.claimForMissed` — if two nodes race, only one wins the atomic
   * update and only that node publishes. Returns count of flips for observability.
   */
  async sweepMissedCalls(
    now: Date,
    timeoutSec: number,
    batchLimit: number
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - timeoutSec * 1000);
    const candidates = await this.callRepo.findStuckRinging(cutoff, batchLimit);
    let flipped = 0;
    for (const call of candidates) {
      const { won } = await this.callRepo.claimForMissed(call.callId, now);
      if (!won) continue;
      flipped++;
      // Kick this off now so it overlaps with the Redis publishes / chat message
      // below instead of adding to the tail latency of the loop.
      const snapshotPromise = this.getUserSnapshot(call.callerId).catch(() => ({
        displayName: "",
        avatarUrl: "",
      }));
      const payload = JSON.stringify({
        event: "call:missed",
        data: { callId: call.callId },
      });
      // Fire both publishes in parallel — non-fatal if either fails. GROUP
      // calls loop the whole rung roster on the self:<id> side.
      const targets = this.ringTargets(call);
      await Promise.all([
        this.redis
          .publish(`call:${call.callId}`, payload)
          .catch((err: unknown) =>
            logger.warn(
              `CallService|sweep|publish call room failed: ${String(err)}`
            )
          ),
        ...targets.map((calleeId) =>
          this.redis
            .publish(`self:${calleeId}`, payload)
            .catch((err: unknown) =>
              logger.warn(
                `CallService|sweep|publish user room failed calleeId=${calleeId}: ${String(err)}`
              )
            )
        ),
      ]);
      for (const calleeId of targets) {
        publishCallCancelSafe({
          calleeId,
          callId: call.callId,
          reason: "missed",
          callerId: call.callerId,
        });
      }
      await this.postCallChatMessageSafe(call, "MISSED", now, 0, "SYSTEM");

      // Push fallback: the two Redis publishes above only reach a LIVE socket.
      // A callee whose tab is backgrounded or closed would otherwise never learn
      // they missed a call — this is the one place that tells them afterward.
      const callerSnapshot = await snapshotPromise;
      for (const calleeId of targets) {
        publishCallMissedSafe({
          callId: call.callId,
          calleeId,
          callerId: call.callerId,
          callerName: callerSnapshot.displayName,
          callerAvatar: callerSnapshot.avatarUrl,
          callType: call.type,
          missedAt: now.getTime(),
        });
      }
    }
    if (flipped > 0) {
      logger.info(`CallService|sweep|flipped ${flipped} call(s) to MISSED`);
    }
    return flipped;
  }

  /**
   * Sweep calls stranded in IN_PROGRESS → ENDED.
   *
   * `sweepMissedCalls` only reaps RINGING, so a call that was answered and then
   * lost its `room_finished` webhook (gateway restart, network blip, signature
   * failure) stayed IN_PROGRESS forever — keeping both participants permanently
   * "busy" and, once something finally closed it, recording an absurd duration.
   *
   * The real end time is unknowable: LiveKit auto-closes empty rooms, so the
   * media session ended whenever the clients vanished — we just never heard.
   * We therefore CAP `durationSec` at `maxDurationSec` rather than recording
   * the true elapsed time, which is exactly what produced an 8-day call and
   * destroyed the duration analytics. `endedBy: "SYSTEM_TIMEOUT"` keeps these
   * distinguishable from real hangups and from `SYSTEM_LIVEKIT` reconciles.
   *
   * Idempotent per row via `claimStatusTransition` — if two nodes race, only
   * one wins the atomic update and only that node publishes.
   */
  async sweepStaleInProgressCalls(
    now: Date,
    maxDurationSec: number,
    batchLimit: number
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - maxDurationSec * 1000);
    const candidates = await this.callRepo.findStuckInProgress(
      cutoff,
      batchLimit
    );
    let flipped = 0;
    for (const call of candidates) {
      const durationSec = Math.min(
        maxDurationSec,
        call.answeredAt
          ? Math.max(
              0,
              Math.floor((now.getTime() - call.answeredAt.getTime()) / 1000)
            )
          : maxDurationSec
      );
      const { won } = await this.callRepo.claimStatusTransition(
        call.callId,
        CallStatus.IN_PROGRESS,
        {
          status: CallStatus.ENDED,
          endedAt: now,
          durationSec,
          endedBy: "SYSTEM_TIMEOUT",
        }
      );
      if (!won) continue;
      flipped++;

      await this.publishToCallAndParticipants(
        call,
        JSON.stringify({
          event: "call:ended",
          data: {
            callId: call.callId,
            endedBy: "SYSTEM_TIMEOUT",
            durationSec,
          },
        }),
        "sweepStale"
      );

      await this.postCallChatMessageSafe(
        call,
        "ENDED",
        now,
        durationSec,
        "SYSTEM_TIMEOUT"
      );
    }
    if (flipped > 0) {
      logger.info(
        `CallService|sweepStale|flipped ${flipped} stranded IN_PROGRESS call(s) to ENDED`
      );
    }
    return flipped;
  }

  /**
   * Reconcile a Call from a LiveKit `room_finished` OR `participant_left` webhook
   * — the authoritative "the media session for this call is gone" signal. Guards
   * against clients that crash / lose network without sending `call:end` or
   * `call:decline`. `participant_left` is what catches the 1:1 case where one peer
   * drops but the other stays connected: the room never empties, so `room_finished`
   * never fires, and the row would otherwise sit IN_PROGRESS keeping BOTH users
   * "busy" until the max-duration sweep. LiveKit fires `participant_left` only after
   * its own reconnection grace, so a transient blip does not reach here.
   *
   * Idempotent via `claimStatusTransition` (first writer wins, only it publishes):
   *  - IN_PROGRESS → ENDED, publish `call:ended` to `call:<id>` + chat audit.
   *  - RINGING → cancel (caller abandoned before answer): ENDED + `call:cancelled`
   *    to the callee's `self:` channel + push dismiss, mirroring `endCall`'s
   *    pre-answer branch so the ring stops now instead of at the 60s missed sweep.
   *    ONLY on `room_finished` — see the guard below.
   *  - anything terminal → no-op.
   */
  async reconcileFromLiveKitRoomFinished(
    callId: string,
    eventType: string
  ): Promise<void> {
    const call = await this.callRepo.findByCallId(callId);
    if (!call) return; // room name wasn't a callId — ignore

    if (call.status === CallStatus.RINGING) {
      // `participant_left` must never cancel a ringing call. During RINGING the
      // caller is the room's ONLY participant, so any churn on their connection
      // fires it — notably cancelling one call while immediately placing the next,
      // which cancelled the brand-new call and surfaced to the caller as a 15s
      // hang then "engine not connected". Only a real room close counts here; a
      // caller who is genuinely gone is still caught by the 60s missed sweep.
      if (eventType !== "room_finished") {
        logger.debug(
          `CallService|reconcile|ignoring ${eventType} for RINGING call=${callId}`
        );
        return;
      }
      const endedAt = new Date();
      const { won } = await this.callRepo.claimStatusTransition(
        callId,
        CallStatus.RINGING,
        { status: CallStatus.ENDED, endedAt, endedBy: "SYSTEM_LIVEKIT" }
      );
      if (!won) return;

      // Publish to BOTH rooms — mirrors sweepMissedCalls. Unlike endCall's
      // RINGING branch (where the CALLER initiated the end and already cleared
      // their own session), this is a server-triggered end: the caller has NOT
      // done any local teardown, so they must be told too — otherwise their FE
      // sits with a ghost outgoing ring if their own `RoomEvent.Disconnected`
      // didn't fire (rare network split where LiveKit sees them leave but the
      // /chat socket survives). Callee gets it on `self:<id>` (they never joined
      // `call:<id>` — pre-answer); caller gets it on `call:<id>` (joined at ack).
      const cancelPayload = JSON.stringify({
        event: "call:cancelled",
        data: { callId },
      });
      const targets = this.ringTargets(call);
      await Promise.all([
        ...targets.map((calleeId) =>
          this.redis
            .publish(`self:${calleeId}`, cancelPayload)
            .catch((err: unknown) =>
              logger.warn(
                `CallService|reconcile|cancel publish (callee=${calleeId}) failed: ${String(err)}`
              )
            )
        ),
        this.redis
          .publish(`call:${callId}`, cancelPayload)
          .catch((err: unknown) =>
            logger.warn(
              `CallService|reconcile|cancel publish (call room) failed: ${String(err)}`
            )
          ),
      ]);

      for (const calleeId of targets) {
        publishCallCancelSafe({
          calleeId,
          callId,
          reason: "cancelled",
          callerId: call.callerId,
        });
      }

      await this.postCallChatMessageSafe(
        call,
        "CANCELLED",
        endedAt,
        0,
        "SYSTEM_LIVEKIT"
      );
      return;
    }

    if (call.status !== CallStatus.IN_PROGRESS) return; // already terminal

    const endedAt = new Date();
    const durationSec = call.answeredAt
      ? Math.max(
          0,
          Math.floor((endedAt.getTime() - call.answeredAt.getTime()) / 1000)
        )
      : 0;

    const { won } = await this.callRepo.claimStatusTransition(
      callId,
      CallStatus.IN_PROGRESS,
      {
        status: CallStatus.ENDED,
        endedAt,
        durationSec,
        endedBy: "SYSTEM_LIVEKIT",
      }
    );
    if (!won) return;

    await this.publishToCallAndParticipants(
      call,
      JSON.stringify({
        event: "call:ended",
        data: { callId, endedBy: "SYSTEM_LIVEKIT", durationSec },
      }),
      "reconcile"
    );

    await this.postCallChatMessageSafe(
      call,
      "ENDED",
      endedAt,
      durationSec,
      "SYSTEM_LIVEKIT"
    );
  }

  private async postCallChatMessageSafe(
    call: Call,
    outcome: CallChatMessageOutcome,
    endedAt: Date,
    durationSec: number,
    endedBy: string
  ): Promise<void> {
    // GROUP calls have no calleeId-shaped chat-message audit yet — CallChatMessageService
    // is built around a single caller/callee pair. Skip rather than post a
    // misleading 1:1-shaped system message; a group-call variant is a
    // follow-up, not part of this MVP.
    if (!this.callChatMessages || call.groupId) return;
    try {
      await this.callChatMessages.post({
        callId: call.callId,
        callerId: call.callerId,
        calleeId: call.calleeId,
        privateRoomId: call.privateRoomId,
        callType: call.type,
        outcome,
        durationSec,
        endedAt,
        endedBy,
      });
    } catch (error) {
      // A chat-side effect must never prevent the authoritative call transition.
      logger.warn(
        `CallService|chat message failed callId=${call.callId} outcome=${outcome}: ${String(error)}`
      );
    }
  }
}
