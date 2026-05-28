import type { PrismaClient, Call } from "../generated/prisma/index.js";

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
}
