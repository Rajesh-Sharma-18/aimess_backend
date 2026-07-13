import { randomUUID } from "node:crypto";
import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";
import type { Call } from "../generated/prisma/index.js";
import type { CallRepository } from "../repositories/call.repository.js";
import type { FriendshipRepository } from "../repositories/friendship.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { LiveKitCredentials, LiveKitService } from "./livekit.service.js";
import type { CallPrivacy } from "../grpc/user-snapshot.client.js";
import { buildParticipantsKey } from "../lib/room-id.js";
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
    private readonly getUserSnapshot: GetUserSnapshotFn
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

    const callId = randomUUID();
    const call = await this.callRepo.create({
      callId,
      callerId: params.callerId,
      calleeId: params.calleeId,
      type: params.type || CallType.AUDIO,
      status: CallStatus.RINGING,
      privateRoomId: params.privateRoomId ?? null,
    });

    // Mint both LiveKit tokens up-front + fetch caller snapshot for the ringing
    // UI in parallel — all three are independent I/O.
    // roomName == callId — generalizes cleanly to group later.
    const [callerCreds, calleeCreds, callerSnapshot] = await Promise.all([
      this.livekit.mintToken(callId, params.callerId),
      this.livekit.mintToken(callId, params.calleeId),
      this.getUserSnapshot(params.callerId).catch(() => ({
        displayName: "",
        avatarUrl: "",
      })),
    ]);

    // Notify callee via Redis. `callerName` + `callerAvatarUrl` let the FE
    // render the incoming ring UI immediately without a second lookup.
    await this.redis
      .publish(
        `user:${params.calleeId}`,
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
          `CallService|initiateCall|redis publish failed: ${String(err)}`
        );
      });

    return { ...call, livekit: callerCreds };
  }

  async answerCall(params: {
    callId: string;
    calleeId: string;
  }): Promise<Call> {
    const call = await this.callRepo.findByCallId(params.callId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    if (call.calleeId !== params.calleeId)
      throw new ForbiddenError("CALL_NOT_PARTICIPANT");
    if (call.status !== CallStatus.RINGING)
      throw new BadRequestError("CALL_NOT_RINGING");

    const updated = await this.callRepo.updateStatus(params.callId, {
      status: CallStatus.IN_PROGRESS,
      answeredAt: new Date(),
    });

    await this.redis
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
      });

    return updated;
  }

  async declineCall(params: {
    callId: string;
    calleeId: string;
  }): Promise<Call> {
    const call = await this.callRepo.findByCallId(params.callId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    if (call.calleeId !== params.calleeId)
      throw new ForbiddenError("CALL_NOT_PARTICIPANT");
    if (call.status !== CallStatus.RINGING)
      throw new BadRequestError("CALL_NOT_RINGING");

    const updated = await this.callRepo.updateStatus(params.callId, {
      status: CallStatus.DECLINED,
      endedAt: new Date(),
      endedBy: params.calleeId,
    });

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
          `CallService|declineCall|redis publish failed: ${String(err)}`
        );
      });

    return updated;
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
    if (!activeStatuses.includes(call.status)) {
      throw new BadRequestError("CALL_ALREADY_ENDED");
    }

    const endedAt = new Date();
    const wasRinging = call.status === CallStatus.RINGING;
    const durationSec = call.answeredAt
      ? Math.floor((endedAt.getTime() - call.answeredAt.getTime()) / 1000)
      : 0;

    const updated = await this.callRepo.updateStatus(params.callId, {
      status: CallStatus.ENDED,
      endedAt,
      durationSec,
      endedBy: params.userId,
    });

    // Pre-answer cancel: callee never joined `call:<id>` room, reach them via
    // their personal `user:<id>` channel with `call:cancelled` instead.
    if (wasRinging) {
      await this.redis
        .publish(
          `user:${call.calleeId}`,
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
   * their `user:<id>` room since they never answered). Idempotent per row via
   * `callRepo.claimForMissed` — if two nodes race, only one wins the atomic
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
          .publish(`user:${call.calleeId}`, payload)
          .catch((err: unknown) =>
            logger.warn(
              `CallService|sweep|publish user room failed: ${String(err)}`
            )
          ),
      ]);
    }
    if (flipped > 0) {
      logger.info(`CallService|sweep|flipped ${flipped} call(s) to MISSED`);
    }
    return flipped;
  }

  /**
   * Reconcile a Call from a LiveKit `room_finished` webhook. The webhook is
   * our authoritative "the media session actually ended" signal — protects
   * against clients that crash/lose network without sending `call:end`.
   *
   * Idempotent: only IN_PROGRESS calls transition. RINGING at this point is
   * unusual (LiveKit never fires room_started for empty rooms), but if it
   * happens we leave it alone and let the timeout sweep flip it to MISSED.
   */
  async reconcileFromLiveKitRoomFinished(callId: string): Promise<void> {
    const call = await this.callRepo.findByCallId(callId);
    if (!call) return; // room name wasn't a callId — ignore
    if (call.status !== CallStatus.IN_PROGRESS) return; // already terminal

    const endedAt = new Date();
    const durationSec = call.answeredAt
      ? Math.floor((endedAt.getTime() - call.answeredAt.getTime()) / 1000)
      : 0;

    await this.callRepo.updateStatus(callId, {
      status: CallStatus.ENDED,
      endedAt,
      durationSec,
      endedBy: "SYSTEM_LIVEKIT",
    });

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
  }
}
