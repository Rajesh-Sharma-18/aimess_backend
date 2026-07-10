import type { PrismaClient, LivestreamBan } from "../generated/prisma/index.js";

/**
 * Bans barring a user from a livestream. Idempotent ban (no duplicate rows);
 * unban is a delete. `isBanned` backs the join gate (CheckStreamAccess).
 */
export class LivestreamBanRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ban(data: {
    livestreamId: string;
    bannedUserId: string;
    bannedBy: string;
    reason?: string | null;
    snapshotUsername?: string | null;
    snapshotDisplayName?: string | null;
  }): Promise<LivestreamBan> {
    const existing = await this.prisma.livestreamBan.findFirst({
      where: {
        livestreamId: data.livestreamId,
        bannedUserId: data.bannedUserId,
      },
    });
    if (existing) return existing;
    return this.prisma.livestreamBan.create({
      data: {
        livestreamId: data.livestreamId,
        bannedUserId: data.bannedUserId,
        bannedBy: data.bannedBy,
        reason: data.reason ?? null,
        snapshotUsername: data.snapshotUsername ?? null,
        snapshotDisplayName: data.snapshotDisplayName ?? null,
      },
    });
  }

  async unban(livestreamId: string, bannedUserId: string): Promise<void> {
    await this.prisma.livestreamBan.deleteMany({
      where: { livestreamId, bannedUserId },
    });
  }

  async isBanned(livestreamId: string, bannedUserId: string): Promise<boolean> {
    const row = await this.prisma.livestreamBan.findFirst({
      where: { livestreamId, bannedUserId },
    });
    return row !== null;
  }

  async listByStream(livestreamId: string): Promise<LivestreamBan[]> {
    return this.prisma.livestreamBan.findMany({
      where: { livestreamId },
      orderBy: { bannedAt: "desc" },
    });
  }
}
