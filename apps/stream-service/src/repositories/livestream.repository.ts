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
    dashUrl?: string | null;
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
        dashUrl: data.dashUrl ?? null,
      } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    });
  }

  async findById(id: string): Promise<Livestream | null> {
    if (!/^[0-9a-f]{24}$/i.test(id)) return null;
    return this.prisma.livestream.findUnique({ where: { id } });
  }

  async findByStreamKey(streamKey: string): Promise<Livestream | null> {
    return this.prisma.livestream.findUnique({ where: { streamKey } });
  }

  async updateById(
    id: string,
    // Accept any extra fields (e.g. dashUrl) before `prisma generate` adds them to the generated type.
    data: Prisma.LivestreamUpdateInput & Record<string, unknown>
  ): Promise<Livestream> {
    if (!/^[0-9a-f]{24}$/i.test(id)) throw new Error(`Invalid ObjectId: ${id}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.prisma.livestream.update({ where: { id }, data: data as any });
  }

  async deleteById(id: string): Promise<void> {
    if (!/^[0-9a-f]{24}$/i.test(id)) throw new Error(`Invalid ObjectId: ${id}`);
    await this.prisma.livestream.delete({ where: { id } });
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

  /** Count of LIVE-only streams for a community (post-end check for last-live broadcast). */
  async countLiveByCommunity(communityId: string): Promise<number> {
    return this.prisma.livestream.count({
      where: { communityId, status: "LIVE" },
    });
  }

  /**
   * Race-safe cap helper: count active (PENDING+LIVE) streams in a community
   * created at-or-before the given (createdAt, id) — i.e. THIS stream's 0-based
   * rank. Deterministic createdAt + id tiebreak so two same-millisecond creates
   * resolve to distinct ranks. The just-created row is excluded from the prior
   * count (strictly before by createdAt, or equal createdAt with a lower id).
   */
  async countActiveCreatedBefore(
    communityId: string,
    createdAt: Date,
    id: string
  ): Promise<number> {
    return this.prisma.livestream.count({
      where: {
        communityId,
        status: { in: [...ACTIVE_STATUSES] },
        OR: [
          { createdAt: { lt: createdAt } },
          { AND: [{ createdAt }, { id: { lt: id } }] },
        ],
      },
    });
  }

  /**
   * Batched LIVE-only counts for a set of communities. Backs the
   * `activeLivestreamCount` enrichment on the mine list + chat rooms list.
   * Communities with 0 live streams are omitted. Counts in memory (live streams
   * per community are capped low) to avoid any Mongo groupBy edge cases.
   */
  async countLiveByCommunityIds(
    communityIds: string[]
  ): Promise<Array<{ communityId: string; count: number }>> {
    if (communityIds.length === 0) return [];
    const rows = await this.prisma.livestream.findMany({
      where: { communityId: { in: communityIds }, status: "LIVE" },
      select: { communityId: true },
    });
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(r.communityId, (counts.get(r.communityId) ?? 0) + 1);
    }
    return [...counts].map(([communityId, count]) => ({ communityId, count }));
  }

  /** Atomic +1 on totalViews. Best-effort — callers should not throw on failure. */
  async incrementTotalViews(id: string): Promise<void> {
    await this.prisma.livestream.update({
      where: { id },
      data: { totalViews: { increment: 1 } },
    });
  }

  /** Atomic +1 on totalComments. Best-effort — callers should not throw on failure. */
  async incrementTotalComments(id: string): Promise<void> {
    await this.prisma.livestream.update({
      where: { id },
      data: { totalComments: { increment: 1 } },
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

  // ---------------------------------------------------------------------------
  // Backoffice admin read model (gRPC live-read source of truth).
  // The admin Livestream Management screen reads streams directly here over
  // gRPC (AdminListStreams / AdminGetStream) — there is NO event-fed read-model
  // to drift out of sync.
  // ---------------------------------------------------------------------------

  /**
   * Offset-paginated admin list with combined filters. The `search` /
   * `communityIds` / `creatorIds` triplet is OR-ed together (title contains the
   * term, OR the stream belongs to one of the search-resolved communities/
   * creators) and AND-ed with the hard filters (status, exact community/creator,
   * date range). Sorting is whitelisted to fields the table exposes.
   */
  async adminList(
    filter: AdminStreamFilter,
    sortField: "createdAt" | "viewerCount" | "durationSeconds",
    sortDir: "asc" | "desc",
    skip: number,
    take: number
  ): Promise<Livestream[]> {
    // duration is not a stored column — approximate ordering with peakViewers'
    // sibling is not meaningful, so we order by livedAt for duration requests
    // (longer-running LIVE streams started earlier) and re-confirm in the
    // service layer where the exact duration is computed. For ENDED streams the
    // service value is exact; createdAt/viewerCount map to stored columns.
    const orderBy =
      sortField === "durationSeconds"
        ? [{ livedAt: sortDir }, { id: "desc" as const }]
        : [{ [sortField]: sortDir }, { id: "desc" as const }];
    return this.prisma.livestream.findMany({
      where: buildAdminWhere(filter),
      orderBy: orderBy as Prisma.LivestreamOrderByWithRelationInput[],
      skip,
      take,
    });
  }

  /** Total rows matching the same filter (drives pagination metadata). */
  async adminCount(filter: AdminStreamFilter): Promise<number> {
    return this.prisma.livestream.count({ where: buildAdminWhere(filter) });
  }
}

/** Combined filter accepted by the admin list/count queries. */
export interface AdminStreamFilter {
  /** Case-insensitive title substring; OR-ed with communityIds/creatorIds. */
  search?: string;
  /** Search-resolved community ids (community-name match); OR-ed with search. */
  communityIds?: string[];
  /** Search-resolved creator ids (creator-name match); OR-ed with search. */
  creatorIds?: string[];
  /** Exact status (PENDING|LIVE|ENDED|CANCELLED); undefined = all. */
  status?: string;
  /** Exact community filter (AND). */
  communityId?: string;
  /** Exact creator filter (AND). */
  creatorId?: string;
  /** AND-restrict to these communities (category filter). Empty/undefined = no restriction. */
  restrictCommunityIds?: string[];
  /** AND-restrict to these stream ids (report filter). Empty/undefined = no restriction. */
  restrictStreamIds?: string[];
  /** createdAt lower bound (inclusive). */
  dateFrom?: Date;
  /** createdAt upper bound (inclusive). */
  dateTo?: Date;
}

/** Translate an {@link AdminStreamFilter} into a Prisma where clause. */
function buildAdminWhere(f: AdminStreamFilter): Prisma.LivestreamWhereInput {
  const and: Prisma.LivestreamWhereInput[] = [];

  if (f.status) and.push({ status: f.status });
  if (f.communityId) and.push({ communityId: f.communityId });
  if (f.creatorId) and.push({ creatorId: f.creatorId });
  if (f.restrictCommunityIds?.length) {
    and.push({ communityId: { in: f.restrictCommunityIds } });
  }
  if (f.restrictStreamIds?.length) {
    and.push({ id: { in: f.restrictStreamIds } });
  }
  if (f.dateFrom || f.dateTo) {
    and.push({
      createdAt: {
        ...(f.dateFrom ? { gte: f.dateFrom } : {}),
        ...(f.dateTo ? { lte: f.dateTo } : {}),
      },
    });
  }

  // Search OR-group: title contains the term OR the stream's community/creator
  // matched the term by name (resolved upstream to ids). Only applied when a
  // search term is present.
  const hasSearch =
    !!f.search ||
    (f.communityIds?.length ?? 0) > 0 ||
    (f.creatorIds?.length ?? 0) > 0;
  if (hasSearch) {
    const or: Prisma.LivestreamWhereInput[] = [];
    if (f.search) {
      or.push({ title: { contains: f.search, mode: "insensitive" } });
    }
    if (f.communityIds?.length)
      or.push({ communityId: { in: f.communityIds } });
    if (f.creatorIds?.length) or.push({ creatorId: { in: f.creatorIds } });
    if (or.length) and.push({ OR: or });
  }

  return and.length ? { AND: and } : {};
}
