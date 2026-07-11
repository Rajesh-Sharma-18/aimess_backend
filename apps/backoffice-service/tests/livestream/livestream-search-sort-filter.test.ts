/**
 * Admin Livestream List (GET /v1/livestreams) — search/sort/filter.
 *
 * Root cause (see docs/LIVESTREAM-MANAGEMENT-API-SPEC.md §6 + this suite):
 *   - Creator-name search matched ONLY `admin_db.UserIndex.username` (no
 *     first/last name column) — a creator's full name could never match.
 *   - Community-name search used the paginated `adminListCommunities` (capped
 *     at 50, meant for the community list screen) instead of the purpose-built
 *     `adminSearchCommunityIds`.
 *   - Category-NAME search did not exist at all — `search` only ever matched
 *     title/community-name/creator-name.
 *   - `sort=reportCount:*` (and any of title/communityName/creatorName/
 *     category/status) silently fell back to `createdAt` ordering — the
 *     mapping in `GrpcLivestreamRepository.list()` only recognized
 *     `viewerCount`/`duration`.
 *
 * This suite exercises the fixed repository directly (mocking only the I/O
 * boundary: stream/community/user gRPC clients + admin_db Prisma) so the
 * actual search/filter/sort logic runs for real — the route-level spec
 * (livestream-management.test.ts) fully mocks `livestreamService` and so
 * never caught any of this.
 */
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    report: {
      // Kept for the detail path's admin_db.Report reports[] enrichment
      // (moderator card list — unrelated to reportCount).
      findMany: jest.fn(async () => []),
    },
  },
}));
jest.mock("../../src/grpc/stream.client.js", () => ({
  streamClient: {
    adminListStreams: jest.fn(),
    adminGetStream: jest.fn(),
    adminGetLivestreamReportCounts: jest.fn(async () => []),
  },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: {
    adminGetCommunitiesByIds: jest.fn(async () => new Map()),
    adminListCommunities: jest.fn(async () => ({ communities: [], total: 0 })),
    adminSearchCommunityIds: jest.fn(async () => []),
    adminListCategories: jest.fn(async () => ({ categories: [], total: 0 })),
  },
}));
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminGetProfilesByIds: jest.fn(async () => []),
    adminSearchProfileIds: jest.fn(async () => []),
  },
}));

import { streamClient } from "../../src/grpc/stream.client.js";
import { communityClient } from "../../src/grpc/community.client.js";
import { userClient } from "../../src/grpc/user.client.js";
import { livestreamRepository } from "../../src/repositories/livestream.repository.js";
import type { ListLivestreamsQuery } from "../../src/types/livestream.types.js";

const adminListStreams = streamClient.adminListStreams as jest.Mock;
const adminSearchCommunityIds =
  communityClient.adminSearchCommunityIds as jest.Mock;
const adminListCategories = communityClient.adminListCategories as jest.Mock;
const adminListCommunities = communityClient.adminListCommunities as jest.Mock;
const adminGetCommunitiesByIds =
  communityClient.adminGetCommunitiesByIds as jest.Mock;
const adminSearchProfileIds = userClient.adminSearchProfileIds as jest.Mock;
const adminGetProfilesByIds = userClient.adminGetProfilesByIds as jest.Mock;
const adminGetLivestreamReportCounts =
  streamClient.adminGetLivestreamReportCounts as jest.Mock;

function baseQuery(
  overrides: Partial<ListLivestreamsQuery> = {}
): ListLivestreamsQuery {
  return {
    sort: "createdAt:desc",
    page: 1,
    limit: 20,
    ...overrides,
  };
}

function stream(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "LS-1",
    communityId: "C-1",
    creatorId: "U-1",
    title: "Test stream",
    description: "",
    thumbnail: "",
    sourceType: "PHONE_CAMERA",
    status: "LIVE",
    hlsUrl: "",
    flvUrl: "",
    viewerCount: 10,
    peakViewers: 20,
    totalViews: 30,
    uniqueViewerCount: 5,
    totalComments: 0,
    durationSeconds: 60,
    livedAt: 1000,
    endedAt: 0,
    createdAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  adminListStreams.mockResolvedValue({ streams: [], total: 0 });
  adminSearchCommunityIds.mockResolvedValue([]);
  adminListCategories.mockResolvedValue({ categories: [], total: 0 });
  adminListCommunities.mockResolvedValue({ communities: [], total: 0 });
  adminGetCommunitiesByIds.mockResolvedValue(new Map());
  adminSearchProfileIds.mockResolvedValue([]);
  adminGetProfilesByIds.mockResolvedValue([]);
  adminGetLivestreamReportCounts.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Search only.
// ---------------------------------------------------------------------------
describe("search", () => {
  it("resolves community-name matches via the purpose-built adminSearchCommunityIds (not adminListCommunities)", async () => {
    adminSearchCommunityIds.mockResolvedValue(["C-42"]);

    await livestreamRepository.list(baseQuery({ search: "Indie Devs" }));

    expect(adminSearchCommunityIds).toHaveBeenCalledWith("Indie Devs");
    expect(adminListCommunities).not.toHaveBeenCalled();
    const arg = adminListStreams.mock.calls[0][0];
    expect(arg.communityIds).toEqual(["C-42"]);
    expect(arg.search).toBe("Indie Devs");
  });

  it("resolves creator FULL NAME matches via adminSearchProfileIds (root-cause fix — admin_db has no first/last name)", async () => {
    adminSearchProfileIds.mockResolvedValue(["U-99"]);

    await livestreamRepository.list(baseQuery({ search: "John Doe" }));

    expect(adminSearchProfileIds).toHaveBeenCalledWith("John Doe");
    const arg = adminListStreams.mock.calls[0][0];
    expect(arg.creatorIds).toEqual(["U-99"]);
  });

  it("resolves category-NAME matches to their member communities (previously unsupported entirely)", async () => {
    adminListCategories.mockResolvedValue({
      categories: [{ id: "CAT-1", name: "Gaming", slug: "gaming" }],
      total: 1,
    });
    adminListCommunities.mockResolvedValue({
      communities: [{ communityId: "C-7" }],
      total: 1,
    });

    await livestreamRepository.list(baseQuery({ search: "Gaming" }));

    expect(adminListCategories).toHaveBeenCalledWith(
      expect.objectContaining({ search: "Gaming" })
    );
    // Category → community resolution reuses the existing category-filter path.
    expect(adminListCommunities).toHaveBeenCalledWith(
      expect.objectContaining({ category: "CAT-1" })
    );
    const arg = adminListStreams.mock.calls[0][0];
    expect(arg.communityIds).toEqual(["C-7"]);
  });

  it("merges community-name and category-name search hits into one communityIds set (deduped)", async () => {
    adminSearchCommunityIds.mockResolvedValue(["C-1", "C-2"]);
    adminListCategories.mockResolvedValue({
      categories: [{ id: "CAT-1", name: "Tech", slug: "tech" }],
      total: 1,
    });
    adminListCommunities.mockResolvedValue({
      communities: [{ communityId: "C-2" }, { communityId: "C-3" }],
      total: 2,
    });

    await livestreamRepository.list(baseQuery({ search: "tech" }));

    const arg = adminListStreams.mock.calls[0][0];
    expect(new Set(arg.communityIds)).toEqual(new Set(["C-1", "C-2", "C-3"]));
  });

  it("does not resolve any search id-sets when search is absent", async () => {
    await livestreamRepository.list(baseQuery());
    expect(adminSearchCommunityIds).not.toHaveBeenCalled();
    expect(adminSearchProfileIds).not.toHaveBeenCalled();
    expect(adminListCategories).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sort only — native (DB-level) fields.
// ---------------------------------------------------------------------------
describe("sort — native stream-service columns", () => {
  it.each([
    ["title:asc", "title", "asc"],
    ["status:desc", "status", "desc"],
    ["viewerCount:asc", "viewerCount", "asc"],
    ["duration:desc", "duration", "desc"],
    ["createdAt:asc", "createdAt", "asc"],
  ])(
    "pushes sort=%s down to stream-service as sortField=%s sortDir=%s",
    async (sort, sortField, sortDir) => {
      await livestreamRepository.list(baseQuery({ sort }));
      const arg = adminListStreams.mock.calls[0][0];
      expect(arg.sortField).toBe(sortField);
      expect(arg.sortDir).toBe(sortDir);
    }
  );

  it("supports sortBy/order composing into the same sort field (validator-level, asserted here via the resulting query.sort contract)", async () => {
    // The validator composes sortBy=title&order=asc into sort="title:asc"
    // before the repository ever sees it — assert the repository honors
    // that composed value like any other native sort.
    await livestreamRepository.list(baseQuery({ sort: "title:asc" }));
    const arg = adminListStreams.mock.calls[0][0];
    expect(arg.sortField).toBe("title");
    expect(arg.sortDir).toBe("asc");
  });
});

// ---------------------------------------------------------------------------
// Sort only — external (cross-service) fields.
// ---------------------------------------------------------------------------
describe("sort — cross-service fields (candidate-set sort, fixes the reportCount fallback bug)", () => {
  it("sorts by reportCount across the full candidate set BEFORE paginating (root-cause fix)", async () => {
    adminListStreams.mockResolvedValue({
      streams: [
        stream({ id: "LS-A", createdAt: 1 }),
        stream({ id: "LS-B", createdAt: 2 }),
        stream({ id: "LS-C", createdAt: 3 }),
      ],
      total: 3,
    });
    adminGetLivestreamReportCounts.mockResolvedValue([
      { livestreamId: "LS-A", count: 5 },
      { livestreamId: "LS-B", count: 1 },
      // LS-C has no Report rows → 0.
    ]);

    const page = await livestreamRepository.list(
      baseQuery({ sort: "reportCount:desc" })
    );

    // Candidate fetch must NOT ask stream-service to sort by reportCount
    // (stream-service has no such column) — createdAt is the neutral probe order.
    expect(adminListStreams).toHaveBeenCalledWith(
      expect.objectContaining({ sortField: "createdAt" })
    );
    expect(page.data.map((r) => r.livestreamId)).toEqual([
      "LS-A",
      "LS-B",
      "LS-C",
    ]);
    expect(page.data.map((r) => r.reportCount)).toEqual([5, 1, 0]);
  });

  it("sorts by communityName with a bounded (not per-row) number of community lookups", async () => {
    // 5 candidates, page size 2 — proves the batched lookup count stays
    // constant (candidate-set pass + final-page pass) instead of growing
    // with the number of streams (which would indicate an N+1).
    adminListStreams.mockResolvedValue({
      streams: [
        stream({ id: "LS-A", communityId: "C-A" }),
        stream({ id: "LS-B", communityId: "C-B" }),
        stream({ id: "LS-C", communityId: "C-C" }),
        stream({ id: "LS-D", communityId: "C-D" }),
        stream({ id: "LS-E", communityId: "C-E" }),
      ],
      total: 5,
    });
    const brief = (name: string) => ({
      communityId: name,
      name,
      avatarUrl: "",
      categoryId: "",
      categoryName: "",
      categorySlug: "",
      memberCount: 0,
    });
    adminGetCommunitiesByIds.mockResolvedValue(
      new Map([
        ["C-A", brief("Zebra Club")],
        ["C-B", brief("Alpha Club")],
        ["C-C", brief("Mid Club")],
        ["C-D", brief("Delta Club")],
        ["C-E", brief("Echo Club")],
      ])
    );

    const page = await livestreamRepository.list(
      baseQuery({ sort: "communityName:asc", page: 1, limit: 2 })
    );

    // Sorted asc: Alpha(B), Delta(D), Echo(E), Mid(C), Zebra(A) → page 1 = Alpha, Delta.
    expect(page.data.map((r) => r.community.name)).toEqual([
      "Alpha Club",
      "Delta Club",
    ]);
    // ONE batched lookup for the 5-row candidate set + ONE for the 2-row final
    // page — bounded at 2 regardless of how many streams matched, not 5.
    expect(adminGetCommunitiesByIds).toHaveBeenCalledTimes(2);
  });

  it("sorts by creatorName with a bounded (not per-row) number of profile lookups", async () => {
    adminListStreams.mockResolvedValue({
      streams: [
        stream({ id: "LS-A", creatorId: "U-A" }),
        stream({ id: "LS-B", creatorId: "U-B" }),
        stream({ id: "LS-C", creatorId: "U-C" }),
      ],
      total: 3,
    });
    adminGetProfilesByIds.mockResolvedValue([
      {
        userId: "U-A",
        username: "zed",
        avatarUrl: "",
        firstName: "Zed",
        lastName: "",
        createdAt: "",
      },
      {
        userId: "U-B",
        username: "amy",
        avatarUrl: "",
        firstName: "Amy",
        lastName: "",
        createdAt: "",
      },
      {
        userId: "U-C",
        username: "mia",
        avatarUrl: "",
        firstName: "Mia",
        lastName: "",
        createdAt: "",
      },
    ]);

    const page = await livestreamRepository.list(
      baseQuery({ sort: "creatorName:asc", page: 1, limit: 2 })
    );

    expect(page.data.map((r) => r.creator.displayName)).toEqual(["Amy", "Mia"]);
    // Bounded at 2 (candidate-set pass + final-page pass), not 3 (one per stream).
    expect(adminGetProfilesByIds).toHaveBeenCalledTimes(2);
  });

  it("sorts by category using batched community lookups (categoryName)", async () => {
    adminListStreams.mockResolvedValue({
      streams: [
        stream({ id: "LS-A", communityId: "C-A" }),
        stream({ id: "LS-B", communityId: "C-B" }),
      ],
      total: 2,
    });
    adminGetCommunitiesByIds.mockResolvedValue(
      new Map([
        [
          "C-A",
          {
            communityId: "C-A",
            name: "",
            avatarUrl: "",
            categoryId: "",
            categoryName: "Sports",
            categorySlug: "",
            memberCount: 0,
          },
        ],
        [
          "C-B",
          {
            communityId: "C-B",
            name: "",
            avatarUrl: "",
            categoryId: "",
            categoryName: "Music",
            categorySlug: "",
            memberCount: 0,
          },
        ],
      ])
    );

    const page = await livestreamRepository.list(
      baseQuery({ sort: "category:asc" })
    );

    expect(page.data.map((r) => r.category.name)).toEqual(["Music", "Sports"]);
  });

  it("preserves the true total from stream-service even though the candidate set is what gets sorted", async () => {
    adminListStreams.mockResolvedValue({
      streams: [stream({ id: "LS-A" })],
      total: 500,
    });

    const page = await livestreamRepository.list(
      baseQuery({ sort: "reportCount:desc" })
    );

    expect(page.pagination.total).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Filter only.
// ---------------------------------------------------------------------------
describe("filter", () => {
  it("forwards status/communityId/creatorId/date-range (epoch ms) as exact AND filters", async () => {
    const from = Date.parse("2026-01-01T00:00:00.000Z");
    const to = Date.parse("2026-01-31T23:59:59.999Z");
    await livestreamRepository.list(
      baseQuery({
        status: "LIVE",
        communityId: "C-1",
        creatorId: "U-1",
        dateFrom: from,
        dateTo: to,
      })
    );
    const arg = adminListStreams.mock.calls[0][0];
    expect(arg.status).toBe("LIVE");
    expect(arg.communityId).toBe("C-1");
    expect(arg.creatorId).toBe("U-1");
    expect(arg.dateFrom).toBe(from);
    expect(arg.dateTo).toBe(to);
  });

  it("reportStatus=NOT_REPORTED excludes ids with reports via excludeStreamIds", async () => {
    adminGetLivestreamReportCounts.mockResolvedValue([
      { livestreamId: "LS-BAD-1", count: 4 },
      { livestreamId: "LS-BAD-2", count: 1 },
    ]);
    await livestreamRepository.list(baseQuery({ hasReports: false }));
    const arg = adminListStreams.mock.calls[0][0];
    expect(arg.excludeStreamIds).toEqual(["LS-BAD-1", "LS-BAD-2"]);
    expect(arg.restrictStreamIds).toBeUndefined();
  });

  it("maps the SCHEDULED admin status to stream-service's PENDING", async () => {
    await livestreamRepository.list(baseQuery({ status: "SCHEDULED" }));
    expect(adminListStreams.mock.calls[0][0].status).toBe("PENDING");
  });

  it("restricts to a category's communities via the category filter", async () => {
    adminListCommunities.mockResolvedValue({
      communities: [{ communityId: "C-9" }],
      total: 1,
    });
    await livestreamRepository.list(baseQuery({ category: "gaming" }));
    expect(adminListCommunities).toHaveBeenCalledWith(
      expect.objectContaining({ category: "gaming" })
    );
    expect(adminListStreams.mock.calls[0][0].restrictCommunityIds).toEqual([
      "C-9",
    ]);
  });

  it("short-circuits to an empty page when the category has no communities (no stream-service call)", async () => {
    adminListCommunities.mockResolvedValue({ communities: [], total: 0 });
    const page = await livestreamRepository.list(
      baseQuery({ category: "ghost-category" })
    );
    expect(page.data).toEqual([]);
    expect(page.pagination.total).toBe(0);
    expect(adminListStreams).not.toHaveBeenCalled();
  });

  it("restricts to reported stream ids via minReports", async () => {
    // stream-service already applies the min-count filter — return only LS-1.
    adminGetLivestreamReportCounts.mockResolvedValue([
      { livestreamId: "LS-1", count: 3 },
    ]);
    await livestreamRepository.list(baseQuery({ minReports: 2 }));
    expect(adminListStreams.mock.calls[0][0].restrictStreamIds).toEqual([
      "LS-1",
    ]);
    expect(adminGetLivestreamReportCounts).toHaveBeenCalledWith(
      expect.objectContaining({ minCount: 2 })
    );
  });

  it("short-circuits to an empty page when hasReports=true matches nothing", async () => {
    adminGetLivestreamReportCounts.mockResolvedValue([]);
    const page = await livestreamRepository.list(
      baseQuery({ hasReports: true })
    );
    expect(page.data).toEqual([]);
    expect(adminListStreams).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Combinations.
// ---------------------------------------------------------------------------
describe("combinations", () => {
  it("search + sort (native): title search with viewerCount sort", async () => {
    adminSearchCommunityIds.mockResolvedValue(["C-1"]);
    await livestreamRepository.list(
      baseQuery({ search: "Building", sort: "viewerCount:asc" })
    );
    const arg = adminListStreams.mock.calls[0][0];
    expect(arg.search).toBe("Building");
    expect(arg.sortField).toBe("viewerCount");
    expect(arg.sortDir).toBe("asc");
  });

  it("search + filter: creator-name search AND status filter", async () => {
    adminSearchProfileIds.mockResolvedValue(["U-5"]);
    await livestreamRepository.list(
      baseQuery({ search: "Jane", status: "ENDED" })
    );
    const arg = adminListStreams.mock.calls[0][0];
    expect(arg.creatorIds).toEqual(["U-5"]);
    expect(arg.status).toBe("ENDED");
  });

  it("filter + sort: category filter AND reportCount sort (external) still restricts the candidate set", async () => {
    adminListCommunities.mockResolvedValue({
      communities: [{ communityId: "C-9" }],
      total: 1,
    });
    adminListStreams.mockResolvedValue({
      streams: [stream({ id: "LS-1", communityId: "C-9" })],
      total: 1,
    });
    adminGetLivestreamReportCounts.mockResolvedValue([
      { livestreamId: "LS-1", count: 2 },
    ]);

    const page = await livestreamRepository.list(
      baseQuery({ category: "gaming", sort: "reportCount:desc" })
    );

    const candidateArg = adminListStreams.mock.calls[0][0];
    expect(candidateArg.restrictCommunityIds).toEqual(["C-9"]);
    expect(page.data[0].reportCount).toBe(2);
  });

  it("search + filter + sort: community search + minReports filter + creatorName sort", async () => {
    adminSearchCommunityIds.mockResolvedValue(["C-1"]);
    adminGetLivestreamReportCounts
      .mockResolvedValueOnce([
        { livestreamId: "LS-A", count: 4 },
        { livestreamId: "LS-B", count: 4 },
      ]) // resolveStreamIdsWithReports (minReports)
      .mockResolvedValueOnce([]); // reportCountsByStream (not needed for creatorName sort)
    adminListStreams.mockResolvedValue({
      streams: [
        stream({ id: "LS-A", creatorId: "U-A" }),
        stream({ id: "LS-B", creatorId: "U-B" }),
      ],
      total: 2,
    });
    adminGetProfilesByIds.mockResolvedValue([
      {
        userId: "U-A",
        username: "zed",
        avatarUrl: "",
        firstName: "Zed",
        lastName: "",
        createdAt: "",
      },
      {
        userId: "U-B",
        username: "amy",
        avatarUrl: "",
        firstName: "Amy",
        lastName: "",
        createdAt: "",
      },
    ]);

    const page = await livestreamRepository.list(
      baseQuery({
        search: "Indie",
        minReports: 3,
        sort: "creatorName:asc",
      })
    );

    const candidateArg = adminListStreams.mock.calls[0][0];
    expect(candidateArg.communityIds).toEqual(["C-1"]);
    expect(candidateArg.restrictStreamIds).toEqual(["LS-A", "LS-B"]);
    expect(page.data.map((r) => r.creator.displayName)).toEqual(["Amy", "Zed"]);
  });
});

// ---------------------------------------------------------------------------
// Pagination preserved.
// ---------------------------------------------------------------------------
describe("pagination", () => {
  it("preserves page/limit/total/hasNext across a native sort", async () => {
    adminListStreams.mockResolvedValue({
      streams: [stream({ id: "LS-1" })],
      total: 41,
    });
    const page = await livestreamRepository.list(
      baseQuery({ page: 2, limit: 20 })
    );
    expect(page.pagination).toMatchObject({
      mode: "offset",
      page: 2,
      limit: 20,
      total: 41,
      hasNext: true,
      hasPrev: true,
    });
  });

  it("preserves page/limit correctly when slicing an externally-sorted candidate set", async () => {
    const streams = Array.from({ length: 5 }, (_, i) =>
      stream({ id: `LS-${i}`, createdAt: i })
    );
    adminListStreams.mockResolvedValue({ streams, total: 5 });
    adminGetLivestreamReportCounts.mockResolvedValue(
      streams.map((s, i) => ({ livestreamId: s.id, count: i }))
    );

    const page = await livestreamRepository.list(
      baseQuery({ sort: "reportCount:desc", page: 2, limit: 2 })
    );

    // Sorted desc by reportCount: LS-4(4), LS-3(3), LS-2(2), LS-1(1), LS-0(0).
    // Page 2 limit 2 → items at index 2,3 → LS-2, LS-1.
    expect(page.data.map((r) => r.livestreamId)).toEqual(["LS-2", "LS-1"]);
    expect(page.pagination.page).toBe(2);
    expect(page.pagination.limit).toBe(2);
    expect(page.pagination.total).toBe(5);
  });
});
