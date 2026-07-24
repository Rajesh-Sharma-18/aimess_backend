import type { PrismaClient, Call } from "../generated/prisma/index.js";
import { CallStatus } from "../types/enums.js";

export class CallRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    callId: string;
    callerId: string;
    calleeId: string;
    type: string;
    status: string;
    privateRoomId?: string | null;
  }): Promise<Call> {
    return this.prisma.call.create({
      data: {
        callId: data.callId,
        callerId: data.callerId,
        calleeId: data.calleeId,
        type: data.type,
        status: data.status,
        privateRoomId: data.privateRoomId ?? null,
      },
    });
  }

  async findByCallId(callId: string): Promise<Call | null> {
    return this.prisma.call.findUnique({ where: { callId } });
  }

  async updateStatus(
    callId: string,
    update: {
      status: string;
      answeredAt?: Date | null;
      endedAt?: Date | null;
      durationSec?: number | null;
      endedBy?: string | null;
    }
  ): Promise<Call> {
    return this.prisma.call.update({
      where: { callId },
      data: update,
    });
  }

  /**
   * Atomically transition a call only while it is still in the expected state.
   * This prevents answer/decline/end/webhook handlers from racing the ringing
   * timeout (or each other) and resurrecting an already-terminal call.
   */
  async claimStatusTransition(
    callId: string,
    expectedStatus: string,
    update: {
      status: string;
      answeredAt?: Date | null;
      endedAt?: Date | null;
      durationSec?: number | null;
      endedBy?: string | null;
    }
  ): Promise<{ won: boolean }> {
    const result = await this.prisma.call.updateMany({
      where: { callId, status: expectedStatus },
      data: update,
    });
    return { won: result.count === 1 };
  }

  /**
   * Sweep helpers for the ringing-timeout worker. Multi-node safe:
   * `claimForMissed` uses an atomic `updateMany` with a `status: RINGING`
   * filter — whichever node's write lands first wins (`count === 1`); the
   * other's filter no longer matches and returns `count === 0`. No locks.
   */
  async findStuckRinging(cutoff: Date, limit: number): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: { status: "RINGING", initiatedAt: { lt: cutoff } },
      take: limit,
    });
  }

  /**
   * Sweep candidates for calls stranded in IN_PROGRESS: answered longer ago
   * than any plausible call could run. These are rows whose LiveKit room has
   * already closed but whose `room_finished` webhook never landed — without
   * this they stay IN_PROGRESS forever and keep the participants "busy".
   * Keyed on `answeredAt` (when the call actually started), not `initiatedAt`.
   */
  async findStuckInProgress(cutoff: Date, limit: number): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: {
        status: CallStatus.IN_PROGRESS,
        answeredAt: { lt: cutoff },
      },
      take: limit,
    });
  }

  async claimForMissed(callId: string, now: Date): Promise<{ won: boolean }> {
    const result = await this.prisma.call.updateMany({
      where: { callId, status: "RINGING" },
      data: { status: "MISSED", endedAt: now, endedBy: "SYSTEM" },
    });
    return { won: result.count === 1 };
  }

  async findByParticipant(
    userId: string,
    limit: number,
    cursor?: string | null
  ): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: {
        OR: [{ callerId: userId }, { calleeId: userId }],
        ...(cursor ? { initiatedAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { initiatedAt: "desc" },
      take: limit,
    });
  }

  /**
   * Busy-detection query. A call counts as "genuinely active" (and therefore
   * blocks a new call) only if it is IN_PROGRESS, or RINGING **and still fresh**
   * (`initiatedAt >= freshCutoff`). A RINGING row older than the ringing-timeout
   * window is a crashed/abandoned attempt that the sweep is about to flip to
   * MISSED — it must NOT count as busy (this is the guard against the old
   * false-busy bug). Returns every active call touching any of `userIds`.
   */
  async findActiveByParticipant(
    userIds: string[],
    freshCutoff: Date
  ): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: {
        OR: [{ callerId: { in: userIds } }, { calleeId: { in: userIds } }],
        AND: [
          {
            OR: [
              { status: CallStatus.IN_PROGRESS },
              {
                status: CallStatus.RINGING,
                initiatedAt: { gte: freshCutoff },
              },
            ],
          },
        ],
      },
    });
  }

  /**
   * Glare backstop: find an active call between exactly this pair (either
   * direction) other than `excludeCallId`. Same freshness rule as
   * `findActiveByParticipant`.
   */
  async findActiveBetween(
    userA: string,
    userB: string,
    excludeCallId: string,
    freshCutoff: Date
  ): Promise<Call | null> {
    return this.prisma.call.findFirst({
      where: {
        callId: { not: excludeCallId },
        OR: [
          { callerId: userA, calleeId: userB },
          { callerId: userB, calleeId: userA },
        ],
        AND: [
          {
            OR: [
              { status: CallStatus.IN_PROGRESS },
              {
                status: CallStatus.RINGING,
                initiatedAt: { gte: freshCutoff },
              },
            ],
          },
        ],
      },
    });
  }

  /**
   * The caller's own outbound rings. Starting a new outgoing call implies the
   * caller abandoned any prior one, so the service cancels these first (both to
   * avoid falsely marking the caller busy on their own zombie call and to stop
   * the old callee's ring immediately).
   */
  async findCallerRinging(callerId: string): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: { callerId, status: CallStatus.RINGING },
    });
  }
}
