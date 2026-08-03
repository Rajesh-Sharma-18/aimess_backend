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
import type { LiveKitCredentials, LiveKitService } from "./livekit.service.js";
import type {
  CallChatMessageService,
  CallChatMessageOutcome,
} from "./call-chat-message.service.js";
import type { CallPrivacy } from "../grpc/user-snapshot.client.js";
import type { CallFlagService } from "./call-flag.service.js";
import { buildParticipantsKey } from "../lib/room-id.js";
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
    private readonly callFlags?: Pick<CallFlagService, "isCallingEnabled">
  ) {}

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

    // Gate 1: friendship. Local Prisma read on chat-service's event-sourced
    // Friendship replica — no gRPC hop. Blocks non-friends AND ex-friends
    // (the shared-DM-room check below is a defense-in-depth, not this).
    const areFriends = await this.friendshipRepo.areFriends(
      params.callerId,
      params.calleeId
    );
    if (!areFriends) throw new ForbiddenError("FRIENDSHIP_REQUIRED");

    // Gate 2: callee's `whoCanCallMe` privacy setting (user-service).
    // FRIENDS is already satisfied by gate 1; NO_ONE always rejects; and
    // SELECTED_FRIENDS requires the caller to be in the callee's allow-list.
    const privacy = await this.getCallPrivacy(params.calleeId);
    if (privacy.whoCanCallMe === "NO_ONE") {
      throw new ForbiddenError("PRIVACY_BLOCKED");
    }
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
    const room = params.privateRoomId
      ? await this.privateRoomRepo.findByRoomId(params.privateRoomId, {
          projection: { participants: 1, blockedBy: 1 },
        })
      : await this.privateRoomRepo.findByParticipantsKey(
          buildParticipantsKey(params.callerId, params.calleeId)
        );
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

    // (a) Self-cleanup: a new outgoing call means the caller abandoned any prior
    // OUTGOING ring. Cancel the caller's own RINGING-as-caller rows so (1) the
    // caller is never falsely "busy" on their own zombie call, and (2) the old
    // callee's ring stops immediately instead of waiting for the sweep.
    const ownRinging = await this.callRepo.findCallerRinging(params.callerId);
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

    const callId = randomUUID();
    const call = await this.callRepo.create({
      callId,
      callerId: params.callerId,
      calleeId: params.calleeId,
      type: params.type || CallType.AUDIO,
      status: CallStatus.RINGING,
      // Always persist the canonical room we authorized above. The website
      // normally omits privateRoomId and lets us derive it from the pair.
      privateRoomId: room.roomId,
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

  async answerCall(params: {
    callId: string;
    calleeId: string;
  }): Promise<Call & { livekit: LiveKitCredentials }> {
    const call = await this.callRepo.findByCallId(params.callId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    if (call.calleeId !== params.calleeId)
      throw new ForbiddenError("CALL_NOT_PARTICIPANT");
    const livekit = await this.livekit.mintToken(
      params.callId,
      params.calleeId
    );
    if (call.status === CallStatus.IN_PROGRESS) return { ...call, livekit };
    if (call.status !== CallStatus.RINGING)
      throw new BadRequestError("CALL_NOT_RINGING");

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
      this.redis
        .publish(
          `call:${params.callId}`,
          JSON.stringify({
            event: "call:answered",
            data: { callId: params.callId },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CallService|answerCall|redis publish failed: ${String(err)}`
          );
        }),
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
    });

    return { ...updated, livekit };
  }

  async declineCall(params: {
    callId: string;
    calleeId: string;
  }): Promise<Call> {
    const call = await this.callRepo.findByCallId(params.callId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    if (call.calleeId !== params.calleeId)
      throw new ForbiddenError("CALL_NOT_PARTICIPANT");
    // Idempotent / stale-UI: already left RINGING — succeed without error so
    // double-taps don't trip the gateway circuit breaker.
    if (call.status !== CallStatus.RINGING) return call;

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
      this.redis
        .publish(
          `call:${params.callId}`,
          JSON.stringify({
            event: "call:declined",
            data: { callId: params.callId },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CallService|declineCall|redis publish failed: ${String(err)}`
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
    if (call.callerId !== params.userId && call.calleeId !== params.userId) {
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

    // Pre-answer cancel: callee never joined `call:<id>` room, reach them via
    // their personal `self:<id>` channel with `call:cancelled` instead.
    if (wasRinging) {
      await this.redis
        .publish(
          `self:${call.calleeId}`,
          JSON.stringify({
            event: "call:cancelled",
            data: { callId: params.callId },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CallService|endCall|cancel publish failed: ${String(err)}`
          );
        });

      publishCallCancelSafe({
        calleeId: call.calleeId,
        callId: params.callId,
        reason: "ended",
      });

      await this.postCallChatMessageSafe(
        updated,
        "CANCELLED",
        endedAt,
        0,
        params.userId
      );
    } else {
      await this.redis
        .publish(
          `call:${params.callId}`,
          JSON.stringify({
            event: "call:ended",
            data: {
              callId: params.callId,
              endedBy: params.userId,
              durationSec,
            },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CallService|endCall|redis publish failed: ${String(err)}`
          );
        });

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
    if (call.callerId !== requesterId && call.calleeId !== requesterId) {
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
      // Fire both publishes in parallel — non-fatal if either fails.
      await Promise.all([
        this.redis
          .publish(`call:${call.callId}`, payload)
          .catch((err: unknown) =>
            logger.warn(
              `CallService|sweep|publish call room failed: ${String(err)}`
            )
          ),
        this.redis
          .publish(`self:${call.calleeId}`, payload)
          .catch((err: unknown) =>
            logger.warn(
              `CallService|sweep|publish user room failed: ${String(err)}`
            )
          ),
      ]);
      publishCallCancelSafe({
        calleeId: call.calleeId,
        callId: call.callId,
        reason: "missed",
      });
      await this.postCallChatMessageSafe(call, "MISSED", now, 0, "SYSTEM");

      // Push fallback: the two Redis publishes above only reach a LIVE socket.
      // A callee whose tab is backgrounded or closed would otherwise never learn
      // they missed a call — this is the one place that tells them afterward.
      const callerSnapshot = await snapshotPromise;
      publishCallMissedSafe({
        callId: call.callId,
        calleeId: call.calleeId,
        callerId: call.callerId,
        callerName: callerSnapshot.displayName,
        callerAvatar: callerSnapshot.avatarUrl,
        callType: call.type,
        missedAt: now.getTime(),
      });
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

      await this.redis
        .publish(
          `call:${call.callId}`,
          JSON.stringify({
            event: "call:ended",
            data: {
              callId: call.callId,
              endedBy: "SYSTEM_TIMEOUT",
              durationSec,
            },
          })
        )
        .catch((err: unknown) =>
          logger.warn(`CallService|sweepStale|publish failed: ${String(err)}`)
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
   *    (During RINGING only the caller is in the LiveKit room, so a leave here can
   *    only be the caller giving up.)
   *  - anything terminal → no-op.
   */
  async reconcileFromLiveKitRoomFinished(callId: string): Promise<void> {
    const call = await this.callRepo.findByCallId(callId);
    if (!call) return; // room name wasn't a callId — ignore

    if (call.status === CallStatus.RINGING) {
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
      await Promise.all([
        this.redis
          .publish(`self:${call.calleeId}`, cancelPayload)
          .catch((err: unknown) =>
            logger.warn(
              `CallService|reconcile|cancel publish (callee) failed: ${String(err)}`
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

      publishCallCancelSafe({
        calleeId: call.calleeId,
        callId,
        reason: "cancelled",
      });

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

    await this.redis
      .publish(
        `call:${callId}`,
        JSON.stringify({
          event: "call:ended",
          data: { callId, endedBy: "SYSTEM_LIVEKIT", durationSec },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `CallService|reconcile|redis publish failed: ${String(err)}`
        );
      });

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
}
