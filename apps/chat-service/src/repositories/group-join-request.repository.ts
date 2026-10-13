import type {
  PrismaClient,
  GroupJoinRequest,
} from "../generated/prisma/index.js";

export class GroupJoinRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<GroupJoinRequest | null> {
    return this.prisma.groupJoinRequest.findUnique({ where: { id } });
  }

  findPending(roomId: string, userId: string): Promise<GroupJoinRequest | null> {
    return this.prisma.groupJoinRequest.findFirst({
      where: { roomId, userId, status: "PENDING" },
    });
  }

  create(data: {
    roomId: string;
    userId: string;
    inviteToken?: string | null;
    invitedBy?: string | null;
  }): Promise<GroupJoinRequest> {
    return this.prisma.groupJoinRequest.create({ data });
  }

  listPendingByRoom(
    roomId: string,
    opts: { cursor?: string; limit: number }
  ): Promise<GroupJoinRequest[]> {
    return this.prisma.groupJoinRequest.findMany({
      where: { roomId, status: "PENDING" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
  }

  countPendingByRoom(roomId: string): Promise<number> {
    return this.prisma.groupJoinRequest.count({
      where: { roomId, status: "PENDING" },
    });
  }

  listPendingByUser(userId: string): Promise<GroupJoinRequest[]> {
    return this.prisma.groupJoinRequest.findMany({
      where: { userId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
  }

  /** PENDING → `status` only if still PENDING; null when someone else settled it first. */
  async settle(
    id: string,
    status: string,
    decidedBy: string | null
  ): Promise<GroupJoinRequest | null> {
    const { count } = await this.prisma.groupJoinRequest.updateMany({
      where: { id, status: "PENDING" },
      data: { status, decidedBy, decidedAt: new Date() },
    });
    return count ? this.findById(id) : null;
  }

  /** Undo a claim when the follow-up add failed for a non-terminal reason. */
  async reopen(id: string): Promise<void> {
    await this.prisma.groupJoinRequest.update({
      where: { id },
      data: { status: "PENDING", decidedBy: null, decidedAt: null },
    });
  }
}
