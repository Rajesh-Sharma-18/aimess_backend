import { randomUUID } from "node:crypto";
import { callContentType, isTerminalCallStatus } from "@aimess/constants";
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
import type { GroupSystemMessageService } from "./group-system-message.service.js";
import {
  assertCanStartCall,
  assertFriendshipStillValid,
  type CallPeerSnapshot,
} from "../lib/call-authorization.js";
import {
  publishCallIncomingSafe,
  publishCallMissedSafe,
  publishCallCancelSafe,
  publishCallHandledPushSafe,
  publishCallActivitySafe,
} from "../events/publish-call-incoming.js";
import { CallStatus, CallType, SystemEvent } from "../types/enums.js";

/**
 * Callee-scoped privacy lookup. Kept as an injected function (not a client
 * object) so tests can stub it without touching gRPC/opossum.
 * ponytail: no cache — read hits Postgres once per call attempt via user-service.
 * Add read-through Redis if call-attempt rate ever becomes a real cost.
 */
export type GetCallPrivacyFn = (userId: string) => Promise<CallPrivacy>;

/**
 * Media-leg claims are keyed by callId, so a stale one can never affect a later
 * call and there is nothing to clean up on hangup — the TTL is the only reaper.
 * Comfortably above CALL_MAX_DURATION_SEC (1h by default) so a claim cannot
 * expire out from under a call that is still running; if it ever did, the leg
 * checks fall back to the pre-existing user-level behaviour rather than break.
 */
const CALL_LEG_TTL_SEC = 4 * 60 * 60;

/**
 * `endedBy` sentinel for a call the SERVER ended because the friendship behind
 * it disappeared — kept distinguishable from a real hangup and from the other
 * `SYSTEM_*` reasons so call analytics and support can tell them apart.
 */
const END_REASON_FRIENDSHIP = "SYSTEM_FRIENDSHIP";

/**
 * How long after a call goes IN_PROGRESS a `declineCall` may still be read as
 * "the callee tapped Decline in the split second after Accept" (see the
 * accept-then-decline branch in {@link CallService.declineCall}).
 *
 * That branch ends a call that is already IN_PROGRESS, so it must not be
 * reachable by a STALE decline. Mobile clients queue terminal intents while
 * offline, and a decline replayed minutes later — after the user answered the
 * same ring from another device, or after a lost `participant_joined` webhook
 * left `answeredAt` null on a perfectly live call — used to tear down a
 * conversation in progress. A genuine accept-then-decline race is sub-second;
 * anything past this window is a replay and is answered idempotently instead.
 */
const ACCEPT_THEN_DECLINE_WINDOW_MS = 10_000;

/**
 * Socket-room membership marker, written when a user initiates or answers a
 * call and read by the gateway to authorize `call:rejoin` after a transport
 * reconnect. Written HERE (rather than only in the gateway) so the REST call
 * actions — the fallback a backgrounded/killed mobile app uses, where there is
 * no socket to join — leave the same membership behind as the socket path.
 * Key/value/TTL must stay identical to the gateway's `rememberCallMember`.
 */
const CALL_MEMBER_TTL_SEC = 4 * 60 * 60;

/**
 * Fetch caller display name + presigned avatar URL for the `call:incoming`
 * event so the callee's FE can render the ringing UI without a second lookup.
 * Returns empty strings on failure — a lookup miss must never block a call.
 */
export type GetUserSnapshotFn = (userId: string) => Promise<CallPeerSnapshot>;

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
    >,
    /**
     * Group-call timeline audit rows. Same role CallChatMessageService plays for
     * 1:1, but a group call's row belongs in the GroupMessage timeline, so it
     * reuses the group lifecycle writer with a VOICE_CALL/VIDEO_CALL kind
     * override instead of duplicating a second persistence path.
     */
    private readonly groupSystemMessages?: Pick<
      GroupSystemMessageService,
      "postOrUpdateCall"
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

  /**
   * The one leg of `userId` that owns this call's media.
   *
   * Call signalling is broadcast to `self:<userId>` — every device of the user —
   * so without this key nothing in the system can tell the device that answered
   * from the three that merely watched it ring. That is what let a sibling tab
   * show live controls and hang up a call it was never on.
   *
   * Redis rather than a Call column because a GROUP call needs one leg PER callee,
   * which a scalar field cannot express, and because the winner is decided by an
   * atomic SET NX — the same primitive `withCallerLock` already relies on.
   */
  private legKey(callId: string, userId: string): string {
    return `call:leg:${callId}:${userId}`;
  }

  /**
   * Claim the media leg for `legId`. Re-claiming with the same legId wins (a
   * socket reconnect or a retried answer is not a second device).
   *
   * Fails CLOSED, unlike `withCallerLock`: if Redis is unreachable we cannot tell
   * two devices apart, and letting both through is precisely the failure this
   * guards — two legs join LiveKit under one identity, the newer evicts the older,
   * and the `participant_left` webhook ends the call for BOTH parties. A ring the
   * user has to tap again is the cheaper failure.
   */
  private async claimCallLeg(
    callId: string,
    userId: string,
    legId: string
  ): Promise<boolean> {
    const key = this.legKey(callId, userId);
    const won = await this.redis.set(key, legId, "EX", CALL_LEG_TTL_SEC, "NX");
    if (won === "OK") return true;
    return (await this.redis.get(key)) === legId;
  }

  /** See {@link CALL_MEMBER_TTL_SEC}. Best-effort: rejoin is a convenience, not correctness. */
  private async rememberCallMember(
    callId: string,
    userId: string
  ): Promise<void> {
    if (!callId || !userId) return;
    try {
      await this.redis.set(
        `call:member:${callId}:${userId}`,
        "1",
        "EX",
        CALL_MEMBER_TTL_SEC
      );
    } catch (err) {
      logger.warn(`CallService|rememberCallMember|failed: ${String(err)}`);
    }
  }

  /** Token-checked release, so a retaken claim is never deleted out from under. */
  private async releaseCallLeg(
    callId: string,
    userId: string,
    legId: string
  ): Promise<void> {
    try {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        this.legKey(callId, userId),
        legId
      );
    } catch (err) {
      logger.warn(`CallService|releaseCallLeg|failed: ${String(err)}`);
    }
  }

  /**
   * True when `legId` is not the leg that owns `userId`'s side of this call.
   * An absent claim means nobody claimed it (older client, pre-answer) — not a
   * mismatch — so it returns false and the caller keeps its previous behaviour.
   */
  private async isForeignLeg(
    callId: string,
    userId: string,
    legId?: string
  ): Promise<boolean> {
    if (!legId) return false;
    try {
      const holder = await this.redis.get(this.legKey(callId, userId));
      return Boolean(holder) && holder !== legId;
    } catch (err) {
      logger.warn(`CallService|isForeignLeg|read failed: ${String(err)}`);
      return false;
    }
  }

  async initiateCall(params: {
    callerId: string;
    calleeId: string;
    type: string;
    privateRoomId?: string | null;
  }): Promise<Call & { livekit: LiveKitCredentials }> {
    // Kill-switch, blocking (both directions), deleted target, friendship,
    // privacy scope, shared DM room and room-level blocks — the ENTIRE call
    // permission rule, in one place, for every entry point. Throws a business
    // ForbiddenError/NotFoundError before any side effect exists: no call row,
    // no LiveKit token, no ring, no push.
    //
    // The inline gate ladder this replaced lives in `lib/call-authorization.ts`
    // unchanged, INCLUDING the `isBlockedEitherWay` pre-gate and the
    // both-directions `room.blockedBy` check — moved there rather than dropped.
    const { room, calleeSnapshot } = await assertCanStartCall(
      {
        friendshipRepo: this.friendshipRepo,
        privateRoomRepo: this.privateRoomRepo,
        getCallPrivacy: this.getCallPrivacy,
        getUserSnapshot: this.getUserSnapshot,
        callFlags: this.callFlags,
      },
      params
    );

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
        // Fans out to the caller's own `self:` channel too, not just the
        // callee's: the caller's OTHER devices are showing an outgoing-mirror
        // banner for this abandoned ring and have no other way to learn it died.
        await this.publishToCallAndParticipants(
          stale,
          JSON.stringify({
            event: "call:cancelled",
            data: { callId: stale.callId },
          }),
          "initiateCall|self-cleanup"
        );
        // The abandoned ring already has a "Ringing…" card in the timeline —
        // settle it here, or it would sit ringing forever (the missed sweep skips
        // it now that this row is no longer RINGING).
        await this.postCallChatMessageSafe(
          stale,
          "CANCELLED",
          now,
          0,
          params.callerId
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

      // (c) Last-moment friendship re-check. The gates above ran before the room
      // lookup, the lock and the busy queries, so a callee who unfriends inside
      // that window would still be rung. One indexed read on the local replica,
      // immediately before the row exists — the only position that actually
      // closes the race. Cached client-side state is never trusted for this.
      await assertFriendshipStillValid(
        this.friendshipRepo,
        params.callerId,
        params.calleeId
      );

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

    await this.rememberCallMember(callId, params.callerId);

    // Mint both LiveKit tokens up-front + fetch caller snapshot for the ringing
    // UI in parallel — independent I/O. The CALLEE snapshot is not refetched:
    // the authorization gate already read it (that is how it rejects a deleted
    // account), so the outgoing-mirror reuses it instead of a second lookup.
    // roomName == callId — generalizes cleanly to group later.
    const [callerCreds, calleeCreds, callerSnapshot] = await Promise.all([
      this.livekit.mintToken(callId, params.callerId),
      this.livekit.mintToken(callId, params.calleeId),
      this.getUserSnapshot(params.callerId).catch(() => ({
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

    // The chat card appears NOW, while the phone is still ringing — WhatsApp
    // behavior. Posted only after the glare backstop above, so the losing side
    // of a simultaneous-dial race never leaves an orphan ringing card. This
    // same row is then transitioned in place by answer/decline/end/miss; it is
    // never joined by a second card.
    await this.postCallChatMessageSafe(
      call,
      "RINGING",
      now,
      0,
      params.callerId
    );

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

    await this.rememberCallMember(callId, params.callerId);

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

    // Ringing card in the group timeline, same as 1:1 — see initiateCall.
    await this.postCallChatMessageSafe(
      call,
      "RINGING",
      now,
      0,
      params.callerId
    );

    return { ...call, livekit: callerCreds };
  }

  async answerCall(params: {
    callId: string;
    calleeId: string;
    legId?: string;
  }): Promise<Call & { livekit: LiveKitCredentials }> {
    const call = await this.callRepo.findByCallId(params.callId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    if (!this.isCallee(call, params.calleeId))
      throw new ForbiddenError("CALL_NOT_PARTICIPANT");

    // Answering a still-RINGING call ESTABLISHES it, so the friendship must hold
    // here too — otherwise a ring that was in flight when the relationship ended
    // could still be picked up. A call already IN_PROGRESS is deliberately left
    // alone (this only runs while it is ringing): an established call is not
    // torn down by a relationship change. GROUP calls are membership-gated, not
    // friendship-gated, so they skip this.
    if (
      !call.groupId &&
      call.status === CallStatus.RINGING &&
      call.callerId &&
      call.callerId !== params.calleeId
    ) {
      await assertFriendshipStillValid(
        this.friendshipRepo,
        params.calleeId,
        call.callerId
      );
    }

    // Decide WHICH of this user's devices is answering before anything else, and
    // before a token exists. Every device of the callee is ringing with the same
    // credentials, so a loser that walks away from here with a token joins the
    // room as a second leg under the same LiveKit identity, evicts the leg that
    // really answered, and the eviction webhook ends the call for both parties.
    const legId = params.legId;
    if (
      legId &&
      !(await this.claimCallLeg(params.callId, params.calleeId, legId))
    ) {
      throw new ConflictError("CALL_ALREADY_ANSWERED");
    }

    try {
      return await this.answerCallClaimed(params, call, legId);
    } catch (err) {
      // Hand the leg back so the user can answer from any device on a retry — a
      // failed answer must not wedge a still-ringing call. Not for a lost race:
      // that claim belongs to the winner.
      if (legId && !(err instanceof ConflictError)) {
        await this.releaseCallLeg(params.callId, params.calleeId, legId);
      }
      throw err;
    }
  }

  private async answerCallClaimed(
    params: { callId: string; calleeId: string },
    call: Call,
    legId: string | undefined
  ): Promise<Call & { livekit: LiveKitCredentials }> {
    const livekit = await this.livekit.mintToken(
      params.callId,
      params.calleeId
    );
    // Answering is what earns a seat in `call:<id>` — record it before any
    // early return below, so a retried/duplicate answer is still allowed to
    // rejoin the room after a reconnect.
    await this.rememberCallMember(params.callId, params.calleeId);
    // Already answered — by THIS leg (a retry or a reconnect after the claim
    // landed), because a foreign leg could not have got past claimCallLeg.
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

    // `answeredAt` is deliberately NOT set here. It is stamped only when the
    // callee's LiveKit `participant_joined` webhook arrives (see
    // `markMediaJoined`), so the value always means "media was actually up".
    // If a callee taps Accept and then End before LiveKit joins, `answeredAt`
    // stays null and the terminal paths (`endCall`, `declineCall`,
    // `reconcileFromLiveKitRoomFinished`) treat the call as cancelled with
    // zero duration — matching the user's intent, not a false "answered call".
    const transitionedAt = new Date();
    const { won } = await this.callRepo.claimStatusTransition(
      params.callId,
      CallStatus.RINGING,
      {
        status: CallStatus.IN_PROGRESS,
      }
    );
    if (!won) {
      const again = await this.callRepo.findByCallId(params.callId);
      // Lost the status CAS to another CALLEE (group call) — this device may not
      // adopt their call. A second leg of the SAME callee never reaches here; it
      // was already turned away by the leg claim.
      if (again?.status === CallStatus.IN_PROGRESS)
        return { ...again, livekit };
      throw new BadRequestError("CALL_NOT_RINGING");
    }
    const updated: Call = {
      ...call,
      status: CallStatus.IN_PROGRESS,
      answeredAt: null,
      updatedAt: transitionedAt,
    };

    await Promise.all([
      this.publishToCallAndParticipants(
        updated,
        JSON.stringify({
          event: "call:answered",
          // Who picked up, so a device that is still legitimately ringing (a
          // GROUP call's other members) doesn't mistake someone else's answer
          // for "answered on my other device".
          data: { callId: params.callId, answeredByUserId: params.calleeId },
        }),
        "answerCall"
      ),
      this.publishCallHandled(
        params.calleeId,
        params.callId,
        "answered_elsewhere",
        legId
      ),
    ]);

    // NOT publishCallCancelSafe: this fires against a callee who is now MID-CALL
    // on the device that just answered. A `call.cancelled` push reaches every one
    // of their devices with no leg exclusion (the socket `call:handled` above is
    // leg-excluded; the push cannot carry a leg), so the answering device would
    // dismiss the very call it just picked up — caller left connected, callee
    // cut. `call.handled` is the non-terminal "stop ringing, call continues
    // elsewhere" signal; a device mid-call on this callId ignores it.
    publishCallHandledPushSafe({
      calleeId: params.calleeId,
      callId: params.callId,
      reason: "answered_elsewhere",
      callerId: call.callerId,
    });

    // "Ringing…" → "Ongoing" on the SAME card. The final duration replaces this
    // when endCall lands; until then every device (including the ones that did
    // not answer) sees the call is live rather than still ringing.
    await this.postCallChatMessageSafe(
      updated,
      "ANSWERED",
      transitionedAt,
      0,
      params.calleeId
    );

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

    // Accept-then-decline race (1:1): the callee tapped Decline in the tight
    // window after their client already emitted `call:answer` but before the
    // callee's media actually joined LiveKit. Row is IN_PROGRESS with a null
    // `answeredAt`. Treat this as a valid decline — the user's intent is
    // clearly "no", and no real call happened. Delegate through `endCall`
    // (attributed to the callee), which now takes the pre-media branch and
    // publishes `call:cancelled` + posts a CANCELLED chat card with no
    // duration. Group calls stay in the RINGING-only path below — a group
    // decline mid-roster does not translate to "reject the whole call".
    //
    // Time-bounded on `updatedAt` (stamped by the RINGING → IN_PROGRESS claim)
    // because this is the ONLY decline path that can end a call that is already
    // up: a decline replayed long after the fact — a mobile client flushing a
    // queued intent on reconnect, or a retried delivery — would otherwise hang
    // up a live conversation. `answeredAt` cannot bound it: it is stamped by
    // the best-effort `participant_joined` webhook, so a lost webhook leaves it
    // null for the entire call. See ACCEPT_THEN_DECLINE_WINDOW_MS.
    // A row with no `updatedAt` (hand-built fixtures, pre-migration rows) gives us
    // nothing to judge staleness by — treat it as in-window so the pre-existing
    // behaviour holds rather than silently swallowing a genuine decline.
    const sinceAnswerMs = call.updatedAt
      ? Date.now() - call.updatedAt.getTime()
      : 0;
    if (
      call.status === CallStatus.IN_PROGRESS &&
      call.answeredAt === null &&
      !call.groupId &&
      sinceAnswerMs <= ACCEPT_THEN_DECLINE_WINDOW_MS
    ) {
      // `endCall`'s cancel branch is a strict refinement of `Call` (durationSec
      // narrowed to `number`), so it's assignable to `declineCall`'s Promise<Call>.
      return this.endCall({
        callId: params.callId,
        userId: params.calleeId,
      });
    }

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
        // Only the LAST decline is the call's outcome — posting per-member
        // would spam the timeline with one row per rung member.
        await this.postCallChatMessageSafe(
          updated,
          "DECLINED",
          endedAt,
          0,
          params.calleeId
        );
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

  /**
   * "This ring was dealt with on another of your devices."
   *
   * Addressed to `self:<calleeId>`, which includes the device that acted — so the
   * payload names the leg that handled it and the gateway drops the message for
   * that one socket. Without `handledByLegId` the acting device would dismiss its
   * own live call, which is why the web client used to ignore this event whenever
   * it had answered, disarming it for the devices that actually needed it.
   */
  private async publishCallHandled(
    calleeId: string,
    callId: string,
    reason: "answered_elsewhere" | "declined_elsewhere",
    handledByLegId?: string
  ): Promise<void> {
    await this.redis
      .publish(
        `self:${calleeId}`,
        JSON.stringify({
          event: "call:handled",
          data: { callId, reason, handledByLegId },
        })
      )
      .catch((err: unknown) => {
        logger.warn(`CallService|call:handled publish failed: ${String(err)}`);
      });
  }

  async endCall(params: {
    callId: string;
    userId: string;
    legId?: string;
    /**
     * "NO_ANSWER" — the CALLER's client is ending this call because its ring
     * window elapsed, not because the user hung up. Advisory: the outcome is
     * still derived here from the persisted call (see `noAnswer` below), so a
     * client cannot fabricate one.
     */
    reason?: "NO_ANSWER";
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

    // Authorization is per LEG, not per user: `userId` alone would let any of the
    // callee's other devices hang up the call the answering one is on — a stale
    // banner, a background tab closing, a client build that never learned it lost
    // the answer race. Silently a no-op, since from that device's point of view
    // there is nothing to end. The caller side stays user-scoped on purpose: its
    // mirror devices are allowed to cancel their own outgoing call.
    if (
      call.status === CallStatus.IN_PROGRESS &&
      this.isCallee(call, params.userId) &&
      (await this.isForeignLeg(params.callId, params.userId, params.legId))
    ) {
      logger.info(
        `CallService|endCall|ignored from non-answering leg callId=${params.callId} userId=${params.userId}`
      );
      return { ...call, durationSec: call.durationSec ?? 0 };
    }

    const endedAt = new Date();
    // Fold "IN_PROGRESS but the callee's media never actually joined LiveKit"
    // into the RINGING/pre-answer cancel branch: no duration, cancel event
    // to the caller, CANCELLED chat card. Without this, an accept-then-end
    // race records a real answered call with a spurious duration timer.
    const wasRinging = call.status === CallStatus.RINGING;
    const wasPreMedia =
      call.status === CallStatus.IN_PROGRESS && call.answeredAt === null;
    const cancelPath = wasRinging || wasPreMedia;
    const durationSec = call.answeredAt
      ? Math.max(
          0,
          Math.floor((endedAt.getTime() - call.answeredAt.getTime()) / 1000)
        )
      : 0;

    // A ring the CALLER let run out is a NO-ANSWER, not a cancellation — the
    // very outcome the RINGING → MISSED sweep would record a beat later, only
    // without the wait. That wait is why it never happened in practice: the
    // client's ring timeout ends the call at the same 60s the server sweep uses,
    // so the row always settled as CANCELLED first and the caller never saw
    // "No answer" nor the callee a missed call.
    //
    // Every clause is server-side: the call must still be RINGING, must never
    // have been answered, and the request must come from the caller. So this
    // only ever picks between two honest readings of one hangup, and the
    // CONNECTED race is impossible — an answer moves the row to IN_PROGRESS,
    // and the claim below is scoped to the status read above.
    const noAnswer =
      wasRinging &&
      !call.answeredAt &&
      params.reason === "NO_ANSWER" &&
      call.callerId === params.userId;

    const { won } = await this.callRepo.claimStatusTransition(
      params.callId,
      call.status,
      {
        status: noAnswer ? CallStatus.MISSED : CallStatus.ENDED,
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
      status: noAnswer ? CallStatus.MISSED : CallStatus.ENDED,
      endedAt,
      durationSec,
      endedBy: params.userId,
      updatedAt: endedAt,
    };

    // Pre-answer cancel: rung callee(s) never joined the `call:<id>` room, so
    // `call:cancelled` has to reach them on their personal `self:<id>` channel.
    // It goes to the CALLER's `self:` channel too — the caller's other devices
    // are showing an outgoing-mirror banner for this ring and would otherwise
    // never learn it was cancelled, leaving the banner up forever. The
    // `wasPreMedia` branch (accept-then-quick-end race) shares this exact fan
    // out: the callee's `self:<id>` gets `call:cancelled` (their mirror device
    // needs the same dismiss), and the caller-side sees a cancelled card
    // rather than a fake connected one with a duration.
    //
    // NO_ANSWER is a distinct outcome and takes precedence: the caller let the
    // ring run out, which settles as MISSED via the same fan-out the sweep uses,
    // not as a cancellation. It implies RINGING (so cancelPath would also match),
    // hence it must be checked first.
    if (noAnswer) {
      // Identical fan-out to the sweep's — one shared method, so the two paths
      // to the same outcome can never drift into two different behaviours.
      await this.fanOutUnansweredRing(updated, endedAt);
    } else if (cancelPath) {
      const targets = this.ringTargets(call);
      await this.publishToCallAndParticipants(
        updated,
        JSON.stringify({
          event: "call:cancelled",
          data: { callId: params.callId },
        }),
        "endCall|cancel"
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

  /**
   * Tear down every active 1:1 call between a pair whose relationship no longer
   * permits one — driven by `friendship.deleted` / `friendship.blocked` (see
   * `events/friendship.consumer.ts`).
   *
   * `assertCanStartCall` only guards the START of a call, and `answerCall` only
   * re-checks while the call is RINGING. Without this, unfriending or blocking
   * someone mid-conversation left the two of them talking: the relationship the
   * call was authorized by no longer existed, but nothing revisited the call.
   * Blocking in particular has to sever contact NOW, not when the other side
   * happens to hang up.
   *
   * Both live states are covered, with the same terminal shape their user-driven
   * equivalents produce, so clients need no new handling:
   *  - RINGING     → ENDED + `call:cancelled` + push dismiss + a CANCELLED card.
   *  - IN_PROGRESS → ENDED + `call:ended` (with the real duration) + ENDED card.
   *
   * Every transition goes through `claimStatusTransition`, so a redelivered AMQP
   * event, a concurrent hangup and this sweep can all race safely: only the
   * winner publishes. Returns how many rows it actually ended.
   *
   * ponytail: the media session is torn down by the clients reacting to
   * `call:ended` — LiveKitService mints tokens only, it has no room-delete. A
   * client that ignores the event keeps its leg until LiveKit's own timeout.
   * Add a RoomServiceClient `deleteRoom` here if that ever needs to be forced.
   */
  async endCallsBetween(userA: string, userB: string): Promise<number> {
    if (!userA || !userB || userA === userB) return 0;
    const now = new Date();
    const freshCutoff = new Date(
      now.getTime() - env.CALL_RINGING_TIMEOUT_SEC * 1000
    );
    const liveCutoff = new Date(
      now.getTime() - env.CALL_MAX_DURATION_SEC * 1000
    );

    const active = await this.callRepo.findAllActiveBetween(
      userA,
      userB,
      freshCutoff,
      liveCutoff
    );

    let ended = 0;
    for (const call of active) {
      const wasRinging = call.status === CallStatus.RINGING;
      const durationSec = call.answeredAt
        ? Math.max(
            0,
            Math.floor((now.getTime() - call.answeredAt.getTime()) / 1000)
          )
        : 0;

      const { won } = await this.callRepo.claimStatusTransition(
        call.callId,
        call.status,
        {
          status: CallStatus.ENDED,
          endedAt: now,
          durationSec,
          endedBy: END_REASON_FRIENDSHIP,
        }
      );
      if (!won) continue;
      ended++;

      const updated: Call = {
        ...call,
        status: CallStatus.ENDED,
        endedAt: now,
        durationSec,
        endedBy: END_REASON_FRIENDSHIP,
        updatedAt: now,
      };

      await this.publishToCallAndParticipants(
        updated,
        JSON.stringify(
          wasRinging
            ? { event: "call:cancelled", data: { callId: call.callId } }
            : {
                event: "call:ended",
                data: {
                  callId: call.callId,
                  endedBy: END_REASON_FRIENDSHIP,
                  durationSec,
                },
              }
        ),
        "endCallsBetween"
      );

      if (wasRinging) {
        // The callee never joined `call:<id>`, and their device may not even be
        // awake — the push is what actually clears a ring in the tray.
        for (const calleeId of this.ringTargets(call)) {
          publishCallCancelSafe({
            calleeId,
            callId: call.callId,
            reason: "cancelled",
            callerId: call.callerId,
          });
        }
      }

      await this.postCallChatMessageSafe(
        updated,
        wasRinging ? "CANCELLED" : "ENDED",
        now,
        durationSec,
        END_REASON_FRIENDSHIP
      );
    }

    if (ended > 0) {
      logger.info(
        `CallService|endCallsBetween|ended ${ended} call(s) for ${userA}<->${userB}`
      );
    }
    return ended;
  }

  /**
   * Cut every live 1:1 call between this pair — a block must not leave the two
   * of them still talking, and a ring must not keep ringing.
   *
   * Ends each call through the normal `endCall` path (attributed to `endedBy`,
   * always a participant here), so the hangup fan-out and the timeline row are
   * identical to a manual hangup — no second teardown path to keep in sync.
   * Best-effort per call: one failure must not strand the others, and the
   * caller (an event consumer) must never nack over it.
   */
  async terminateCallsBetween(
    userA: string,
    userB: string,
    endedBy: string
  ): Promise<void> {
    const now = new Date();
    const active = await this.callRepo.findAllActiveBetween(
      userA,
      userB,
      new Date(now.getTime() - env.CALL_RINGING_TIMEOUT_SEC * 1000),
      new Date(now.getTime() - env.CALL_MAX_DURATION_SEC * 1000)
    );
    for (const call of active) {
      try {
        await this.endCall({ callId: call.callId, userId: endedBy });
      } catch (err) {
        logger.warn(
          `CallService|terminateCallsBetween|failed callId=${call.callId}: ${String(err)}`
        );
      }
    }
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
      await this.fanOutUnansweredRing(call, now);
    }
    if (flipped > 0) {
      logger.info(`CallService|sweep|flipped ${flipped} call(s) to MISSED`);
    }
    return flipped;
  }

  /**
   * Everything that happens once a ring is known to be unanswered, for BOTH
   * paths that can discover it: the RINGING → MISSED sweep, and the caller's own
   * client reporting its ring window elapsed (`endCall` with reason NO_ANSWER).
   *
   * Called only by a writer that already WON the atomic status claim, so it runs
   * exactly once per call — no duplicate card, push or unread increment, even if
   * the sweep and the caller race. Every step is individually non-fatal.
   *
   *  1. `call:missed` on `call:<id>` and each rung callee's `self:<id>` — the
   *     caller's panel goes to "no answer", the callee's ring UI clears.
   *  2. A dismissal data-push, so a device that never woke stops ringing.
   *  3. ONE call card, transitioned in place to MISSED. Both participants read
   *     that same row; the caller renders "No answer", the callee "Missed call".
   *  4. The missed-call push, the only thing that tells a backgrounded or
   *     offline callee afterwards.
   */
  private async fanOutUnansweredRing(call: Call, at: Date): Promise<void> {
    // Kicked off first so it overlaps the publishes below instead of adding to
    // the tail latency of the sweep loop.
    const snapshotPromise = this.getUserSnapshot(call.callerId).catch(() => ({
      displayName: "",
      avatarUrl: "",
    }));
    const payload = JSON.stringify({
      event: "call:missed",
      data: { callId: call.callId },
    });
    // GROUP calls loop the whole rung roster on the self:<id> side.
    const targets = this.ringTargets(call);
    await Promise.all([
      this.redis
        .publish(`call:${call.callId}`, payload)
        .catch((err: unknown) =>
          logger.warn(
            `CallService|missed|publish call room failed: ${String(err)}`
          )
        ),
      ...targets.map((calleeId) =>
        this.redis
          .publish(`self:${calleeId}`, payload)
          .catch((err: unknown) =>
            logger.warn(
              `CallService|missed|publish user room failed calleeId=${calleeId}: ${String(err)}`
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
    await this.postCallChatMessageSafe(call, "MISSED", at, 0, "SYSTEM");

    const callerSnapshot = await snapshotPromise;
    for (const calleeId of targets) {
      publishCallMissedSafe({
        callId: call.callId,
        calleeId,
        callerId: call.callerId,
        callerName: callerSnapshot.displayName,
        callerAvatar: callerSnapshot.avatarUrl,
        callType: call.type,
        missedAt: at.getTime(),
      });
    }
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
    eventType: string,
    remainingParticipants = -1
  ): Promise<void> {
    const call = await this.callRepo.findByCallId(callId);
    if (!call) return; // room name wasn't a callId — ignore

    // Both parties are still in the room, so the call is plainly not over: what
    // left was an extra leg. LiveKit evicts the older connection when a second
    // device of the same user joins with the same participant identity, and
    // honouring that eviction here would end a perfectly live call for everyone.
    // -1 means the webhook reported no count — behave as before.
    if (eventType === "participant_left" && remainingParticipants >= 2) {
      logger.info(
        `CallService|reconcile|ignoring participant_left with ${remainingParticipants} still in room call=${callId}`
      );
      return;
    }

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
    const preMedia = call.answeredAt === null;
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

    // Media never actually joined for the callee before the room went away
    // (accept-then-quick-end / callee never fully connected). Same shape as
    // the RINGING branch above: cancelled event, CANCELLED card, no duration
    // — never surface a fake connected call.
    if (preMedia) {
      const cancelPayload = JSON.stringify({
        event: "call:cancelled",
        data: { callId },
      });
      await this.publishToCallAndParticipants(
        call,
        cancelPayload,
        "reconcile|preMediaCancel"
      );
      for (const calleeId of this.ringTargets(call)) {
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

  /**
   * Stamp `answeredAt` from a LiveKit `participant_joined` webhook — the only
   * event that proves the callee's media actually arrived. Idempotent; the
   * caller's own join and every reconnect / duplicate-identity race no-op.
   * The webhook is best-effort: if it never lands, `endCall` sees a null
   * `answeredAt` and closes the row as cancelled (no duration), which is a
   * strictly better failure than the previous "count from the answer socket
   * event and produce a spurious duration".
   */
  async markMediaJoined(
    callId: string,
    participantIdentity: string
  ): Promise<void> {
    if (!callId || !participantIdentity) return;
    const call = await this.callRepo.findByCallId(callId);
    if (!call) return; // room name wasn't a callId — ignore
    if (call.status !== CallStatus.IN_PROGRESS) return; // already terminal
    if (call.answeredAt !== null) return; // already stamped
    // The caller joined LiveKit at initiate; only the callee's join proves
    // the media path is up on both sides. Anything else is a no-op.
    if (!this.isCallee(call, participantIdentity)) return;

    const { won } = await this.callRepo.markAnsweredIfNull(callId, new Date());
    if (won) {
      logger.info(
        `CallService|markMediaJoined|answeredAt stamped call=${callId} participant=${participantIdentity}`
      );
    }
  }

  private async postCallChatMessageSafe(
    call: Call,
    outcome: CallChatMessageOutcome,
    endedAt: Date,
    durationSec: number,
    endedBy: string
  ): Promise<void> {
    // GROUP calls land in the GroupMessage timeline instead — CallChatMessageService
    // is built around a single caller/callee pair and writes PrivateMessage rows.
    if (call.groupId) {
      await this.postGroupCallChatMessageSafe(
        call,
        outcome,
        durationSec,
        endedBy
      );
      return;
    }
    // Call HISTORY (Notification Center → Friends) is projected from the same
    // terminal transition as the chat card, and from this one choke point, so
    // every lifecycle call site is covered by construction and no live or
    // intermediate state can leak a card. Deliberately outside the
    // `callChatMessages` guard below: the history row does not depend on the
    // chat timeline row having been written.
    if (isTerminalCallStatus(outcome)) {
      await this.projectCallActivitySafe(call, outcome, endedAt, durationSec);
    }

    if (!this.callChatMessages) return;
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

  /**
   * Projects a settled 1:1 call into both participants' call history (the
   * Notification Center's FRIENDS tab), over the existing call push queue.
   *
   * Reuses the canonical record wholesale: the terminal `CallTimelineStatus`,
   * the call row's own `type`, and its stored `durationSec` — no second call
   * state machine and no duration re-derivation. Direction is resolved per
   * recipient downstream from `callerId`, never from text.
   *
   * PRIVATE calls only. A group/community call is group activity and belongs
   * to the group timeline (see postGroupCallChatMessageSafe) — routing it into
   * FRIENDS would miscategorise it.
   *
   * Best-effort throughout: the publish is fire-and-forget and both snapshot
   * lookups degrade to empty strings (the read path re-resolves the peer's
   * name/avatar from `actorId` anyway).
   */
  private async projectCallActivitySafe(
    call: Call,
    outcome: CallChatMessageOutcome,
    endedAt: Date,
    durationSec: number
  ): Promise<void> {
    if (call.groupId) return;
    const empty = { displayName: "", avatarUrl: "" };
    // Total isolation from the snapshot lookup: a rejection, a synchronous
    // throw, or an absent resolver must never break a terminal call
    // transition. The read path re-resolves name/avatar from `actorId` anyway,
    // so these values are only a fallback.
    const snapshot = async (userId: string): Promise<CallPeerSnapshot> => {
      try {
        return (await this.getUserSnapshot(userId)) ?? empty;
      } catch {
        return empty;
      }
    };
    const [caller, callee] = await Promise.all([
      snapshot(call.callerId),
      snapshot(call.calleeId),
    ]);
    publishCallActivitySafe({
      callId: call.callId,
      callerId: call.callerId,
      calleeId: call.calleeId,
      callType: String(call.type ?? "").toUpperCase() || CallType.AUDIO,
      status: outcome,
      durationSec: Math.max(0, Math.floor(durationSec)),
      privateRoomId: call.privateRoomId ?? "",
      endedAt: endedAt.getTime(),
      callerName: caller.displayName ?? "",
      callerAvatar: caller.avatarUrl ?? "",
      calleeName: callee.displayName ?? "",
      calleeAvatar: callee.avatarUrl ?? "",
    });
  }

  /**
   * GROUP counterpart of the 1:1 call audit row. Posts one CALL_ENDED entry into
   * the group's timeline, stored as VOICE_CALL / VIDEO_CALL (never SYSTEM) so
   * every read path — REST history, /changes, chat:catchup, live `message:new`,
   * inbox preview — reports the same call kind a DM does. `content.call` carries
   * the identical structured sub-object as the private row, so clients render
   * the call card from metadata rather than parsing text.
   *
   * Sender-less (`actorId: null`): like 1:1, nobody "sent" the outcome — the call
   * did. The GroupSystemMessageService path already skips unread for any row with
   * a `systemEvent`, so a group call never raises a badge.
   *
   * ponytail: no clientMessageId-style idempotency barrier here — every call site
   * sits behind a won `claimStatusTransition` / `claimForMissed`, so there is
   * exactly one writer per terminal transition. Add one if group calls ever gain
   * a retry path that can re-enter a terminal state.
   */
  private async postGroupCallChatMessageSafe(
    call: Call,
    outcome: CallChatMessageOutcome,
    durationSec: number,
    endedBy: string
  ): Promise<void> {
    if (!this.groupSystemMessages || !call.groupId) return;
    const callType = String(call.type ?? "").toUpperCase() || CallType.AUDIO;
    const seconds = Math.max(0, Math.floor(durationSec));
    try {
      await this.groupSystemMessages.postOrUpdateCall({
        callId: call.callId,
        roomId: call.groupId,
        actorId: null,
        // CALL_STARTED while the call is live, CALL_ENDED once it settles —
        // one row, two markers, matching the 1:1 writer.
        systemEvent: isTerminalCallStatus(outcome)
          ? SystemEvent.CALL_ENDED
          : SystemEvent.CALL_STARTED,
        messageType: callContentType(callType),
        systemData: {
          callId: call.callId,
          callType,
          status: outcome,
          durationSec: seconds,
          callerId: call.callerId,
          endedBy,
        },
        contentExtra: {
          call: {
            callId: call.callId,
            callType,
            callStatus: outcome,
            // Legacy alias — pre-lifecycle clients read `outcome`.
            outcome,
            durationSec: seconds,
            callerId: call.callerId,
          },
        },
      });
    } catch (error) {
      logger.warn(
        `CallService|group chat message failed callId=${call.callId} outcome=${outcome}: ${String(error)}`
      );
    }
  }
}
