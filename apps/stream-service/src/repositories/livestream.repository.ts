import type {
  PrismaClient,
  Livestream,
  Prisma,
} from "../generated/prisma/index.js";

/** Statuses considered "occupying a concurrency slot" for a community. */
const ACTIVE_STATUSES = ["PENDING", "LIVE"] as const;

export class LivestreamRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    communityId: string;
    creatorId: string;
    title: string;
    description?: string;
    thumbnail?: string | null;
    sourceType: string;
    sourceUrl?: string | null;
    streamKey: string;
    status?: string;
    hlsUrl?: string | null;
    flvUrl?: string | null;
  }): Promise<Livestream> {
    return this.prisma.livestream.create({
      data: {
        communityId: data.communityId,
        creatorId: data.creatorId,
        title: data.title,
        description: data.description ?? "",
        thumbnail: data.thumbnail ?? null,
        sourceType: data.sourceType,
        sourceUrl: data.sourceUrl ?? null,
        streamKey: data.streamKey,
        status: data.status ?? "PENDING",
        hlsUrl: data.hlsUrl ?? null,
        flvUrl: data.flvUrl ?? null,
      },
    });
  }

  async findById(id: string): Promise<Livestream | null> {
    return this.prisma.livestream.findUnique({ where: { id } });
  }

  async findByStreamKey(streamKey: string): Promise<Livestream | null> {
    return this.prisma.livestream.findUnique({ where: { streamKey } });
  }

  async updateById(
    id: string,
    data: Prisma.LivestreamUpdateInput
  ): Promise<Livestream> {
    return this.prisma.livestream.update({ where: { id }, data });
  }

  /**
   * Cursor-paginated list (id desc). When `cursor` is given, returns rows with
   * id < cursor (older). Fetches `limit + 1` to derive `hasMore` in the service.
   */
  async listByCommunity(params: {
    communityId?: string;
    status?: string;
    limit: number;
    cursor?: string;
  }): Promise<Livestream[]> {
    const { communityId, status, limit, cursor } = params;
    const where: Prisma.LivestreamWhereInput = {
      ...(communityId ? { communityId } : {}),
      ...(status ? { status } : {}),
      ...(cursor ? { id: { lt: cursor } } : {}),
    };
    return this.prisma.livestream.findMany({
      where,
      orderBy: { id: "desc" },
      take: limit,
    });
  }

  /** Count of PENDING+LIVE streams for a community (concurrency cap). */
  async countActiveByCommunity(communityId: string): Promise<number> {
    return this.prisma.livestream.count({
      where: { communityId, status: { in: [...ACTIVE_STATUSES] } },
    });
  }

  /** Distinct communityIds (subset of input) that currently have a LIVE stream. */
  async findLiveCommunityIds(communityIds: string[]): Promise<string[]> {
    if (communityIds.length === 0) return [];
    const rows = await this.prisma.livestream.findMany({
      where: { communityId: { in: communityIds }, status: "LIVE" },
      select: { communityId: true },
      distinct: ["communityId"],
    });
    return rows.map((r) => r.communityId);
  }
}
