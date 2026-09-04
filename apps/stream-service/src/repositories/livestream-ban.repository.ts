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

  /**
   * Which of `livestreamIds` this user is barred from, in ONE query.
   *
   * Batch counterpart of {@link isBanned} for the stream list, which would
   * otherwise need one query per row to apply the same gate `getStream`
   * applies — an N+1 on a read endpoint.
   */
  async bannedStreamIds(
    bannedUserId: string,
    livestreamIds: string[]
  ): Promise<Set<string>> {
    if (livestreamIds.length === 0) return new Set();
    const rows = await this.prisma.livestreamBan.findMany({
      where: { bannedUserId, livestreamId: { in: livestreamIds } },
      select: { livestreamId: true },
    });
    return new Set(rows.map((row) => row.livestreamId));
  }

  async listByStream(livestreamId: string): Promise<LivestreamBan[]> {
    return this.prisma.livestreamBan.findMany({
      where: { livestreamId },
      orderBy: { bannedAt: "desc" },
    });
  }
}
