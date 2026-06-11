import { randomUUID } from "node:crypto";
import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";
import type { Call } from "../generated/prisma/index.js";
import type { CallRepository } from "../repositories/call.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import { CallStatus, CallType } from "../types/enums.js";

export class CallService {
  constructor(
    private readonly callRepo: CallRepository,
    private readonly privateRoomRepo: PrivateRoomRepository,
    private readonly redis: Redis | Cluster
  ) {}

  async initiateCall(params: {
    callerId: string;
    calleeId: string;
    type: string;
    privateRoomId?: string | null;
  }): Promise<Call> {
    // Check block status via private room
    if (params.privateRoomId) {
      const room = await this.privateRoomRepo.findByRoomId(
        params.privateRoomId,
        {
          projection: { blockedBy: 1 },
        }
      );
      if (room) {
        const blockedBy = Array.isArray(room.blockedBy)
          ? (room.blockedBy as string[])
          : [];
        if (blockedBy.includes(params.callerId)) {
          throw new ForbiddenError("CALL_BLOCKED");
        }
      }
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

    // Notify callee via Redis
    await this.redis
      .publish(
        `user:${params.calleeId}`,
        JSON.stringify({
          event: "call:incoming",
          data: {
            callId,
            callerId: params.callerId,
            callType: params.type || CallType.AUDIO,
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `CallService|initiateCall|redis publish failed: ${String(err)}`
        );
      });

    return call;
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
    const durationSec = call.answeredAt
      ? Math.floor((endedAt.getTime() - call.answeredAt.getTime()) / 1000)
      : 0;

    const updated = await this.callRepo.updateStatus(params.callId, {
      status: CallStatus.ENDED,
      endedAt,
      durationSec,
      endedBy: params.userId,
    });

    await this.redis
      .publish(
        `call:${params.callId}`,
        JSON.stringify({
          event: "call:ended",
          data: { callId: params.callId, endedBy: params.userId, durationSec },
        })
      )
      .catch((err: unknown) => {
        logger.warn(`CallService|endCall|redis publish failed: ${String(err)}`);
      });

    return { ...updated, durationSec };
  }

  async getCallByCallId(callId: string): Promise<Call | null> {
    return this.callRepo.findByCallId(callId);
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
}
