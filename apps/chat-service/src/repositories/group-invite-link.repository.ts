import type {
  PrismaClient,
  GroupInviteLink,
} from "../generated/prisma/index.js";

export class GroupInviteLinkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    roomId: string;
    token: string;
    createdBy: string;
    [key: string]: unknown;
  }): Promise<GroupInviteLink> {
    return this.prisma.groupInviteLink.create({
      data: {
        roomId: data.roomId,
        token: data.token,
        createdBy: data.createdBy,
        status: (data.status as string) ?? "ACTIVE",
        expiresAt: (data.expiresAt as Date) ?? null,
        maxUses: (data.maxUses as number) ?? null,
        usedCount: (data.usedCount as number) ?? 0,
        shareName: (data.shareName as string) ?? "",
        createdAt: (data.createdAt as Date) ?? new Date(),
      },
    });
  }

  async findByToken(token: string): Promise<GroupInviteLink | null> {
    return this.prisma.groupInviteLink.findUnique({ where: { token } });
  }

  async findActiveByToken(token: string): Promise<GroupInviteLink | null> {
    return this.prisma.groupInviteLink.findFirst({
      where: { token, status: "ACTIVE" },
    });
  }

  async findActiveByRoom(roomId: string): Promise<GroupInviteLink[]> {
    return this.prisma.groupInviteLink.findMany({
      where: { roomId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
  }

  async countActiveByRoom(roomId: string): Promise<number> {
    return this.prisma.groupInviteLink.count({
      where: { roomId, status: "ACTIVE" },
    });
  }

  async revoke(token: string, userId: string): Promise<GroupInviteLink | null> {
    const existing = await this.prisma.groupInviteLink.findFirst({
      where: { token, status: "ACTIVE" },
    });
    if (!existing) return null;

    return this.prisma.groupInviteLink.update({
      where: { id: existing.id },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        revokedBy: userId,
      },
    });
  }

  async incrementUsedCount(token: string): Promise<GroupInviteLink | null> {
    const existing = await this.prisma.groupInviteLink.findUnique({
      where: { token },
    });
    if (!existing) return null;

    return this.prisma.groupInviteLink.update({
      where: { token },
      data: { usedCount: { increment: 1 } },
    });
  }

  async revokeAllForRoom(roomId: string, userId: string): Promise<void> {
    await this.prisma.groupInviteLink.updateMany({
      where: { roomId, status: "ACTIVE" },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        revokedBy: userId,
      },
    });
  }
}
