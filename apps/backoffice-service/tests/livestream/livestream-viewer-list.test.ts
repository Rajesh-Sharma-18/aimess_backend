/**
 * Admin livestream Viewer List (GET /admin/v1/livestreams/:id/users) must:
 *  - sequence `no` as (page - 1) * limit + index + 1 (pagination-based, not DB-derived)
 *  - enrich each viewer with `type` (Admin|Moderator|Member) from their CURRENT
 *    community role, defaulting to Member when the role lookup has no entry
 *    (e.g. the viewer has since left the community)
 *  - fetch roles in ONE batched gRPC call keyed by the viewer userIds on the
 *    page (no N+1 per-viewer round trip)
 */
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    report: {
      findMany: jest.fn(async () => []),
      groupBy: jest.fn(async () => []),
    },
  },
}));

import { streamClient } from "../../src/grpc/stream.client.js";
import { userClient } from "../../src/grpc/user.client.js";
import { communityClient } from "../../src/grpc/community.client.js";
import { livestreamRepository } from "../../src/repositories/livestream.repository.js";

const adminGetStream = streamClient.adminGetStream as jest.Mock;
const adminListViewerSessions =
  streamClient.adminListViewerSessions as jest.Mock;
const adminGetProfilesByIds = userClient.adminGetProfilesByIds as jest.Mock;
const adminGetMemberRoles = communityClient.adminGetMemberRoles as jest.Mock;

function baseStream(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "LS-1",
    communityId: "C-1",
    creatorId: "U-1",
    title: "Test stream",
    description: "",
    thumbnail: "",
    sourceType: "PHONE_CAMERA",
    hlsUrl: "",
    flvUrl: "",
    viewerCount: 1,
    peakViewers: 1,
    totalViews: 1,
    uniqueViewerCount: 1,
    totalComments: 0,
    durationSeconds: 60,
    livedAt: 1000,
    endedAt: 0,
    createdAt: 1000,
    ...overrides,
  };
}

describe("admin livestream viewer list — sequence + role enrichment", () => {
  beforeEach(() => {
    adminGetStream.mockReset();
    adminListViewerSessions.mockReset();
    adminGetProfilesByIds.mockReset();
    adminGetMemberRoles.mockReset();
    adminGetStream.mockResolvedValue(baseStream());
  });

  it("maps ADMIN/MODERATOR roles and defaults unknown viewers to Member", async () => {
    adminListViewerSessions.mockResolvedValueOnce({
      sessions: [
        {
          userId: "u-admin",
          joinedAt: 1000,
          leftAt: 0,
          watchDurationSeconds: 10,
        },
        {
          userId: "u-mod",
          joinedAt: 2000,
          leftAt: 3000,
          watchDurationSeconds: 20,
        },
        {
          userId: "u-ex-member",
          joinedAt: 4000,
          leftAt: 0,
          watchDurationSeconds: 30,
        },
      ],
      total: 3,
    });
    adminGetProfilesByIds.mockResolvedValueOnce([
      { userId: "u-admin", username: "alice", avatarUrl: "" },
      { userId: "u-mod", username: "bob", avatarUrl: "" },
      { userId: "u-ex-member", username: "carol", avatarUrl: "" },
    ]);
    adminGetMemberRoles.mockResolvedValueOnce(
      new Map([
        ["u-admin", "ADMIN"],
        ["u-mod", "MODERATOR"],
        // u-ex-member intentionally absent — no longer a member.
      ])
    );

    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
    });

    expect(adminGetMemberRoles).toHaveBeenCalledWith("C-1", [
      "u-admin",
      "u-mod",
      "u-ex-member",
    ]);
    expect(page.data.find((v) => v.userId === "u-admin")?.type).toBe("Admin");
    expect(page.data.find((v) => v.userId === "u-mod")?.type).toBe("Moderator");
    expect(page.data.find((v) => v.userId === "u-ex-member")?.type).toBe(
      "Member"
    );
  });

  it("sequences `no` from the page/limit, not the DB row order", async () => {
    adminListViewerSessions.mockResolvedValueOnce({
      sessions: [
        { userId: "u-1", joinedAt: 1000, leftAt: 0, watchDurationSeconds: 1 },
        { userId: "u-2", joinedAt: 1000, leftAt: 0, watchDurationSeconds: 1 },
      ],
      total: 12,
    });
    adminGetProfilesByIds.mockResolvedValueOnce([]);
    adminGetMemberRoles.mockResolvedValueOnce(new Map());

    const page = await livestreamRepository.listUsers("LS-1", {
      page: 2,
      limit: 10,
    });

    expect(page.data.map((v) => v.no)).toEqual([11, 12]);
  });

  it("skips the role gRPC call entirely when the page has no viewers", async () => {
    adminListViewerSessions.mockResolvedValueOnce({ sessions: [], total: 0 });

    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
    });

    expect(page.data).toEqual([]);
    expect(adminGetMemberRoles).not.toHaveBeenCalled();
  });
});

/**
 * Search / role filter / username|role sort have no backing column on the
 * viewer-session store, so listUsers routes them through a bounded candidate-set
 * enrichment path: pull the set, enrich (username/display name + community
 * role), filter/sort in memory, then paginate. `total` becomes the FILTERED
 * count so the FE pager stays correct.
 */
describe("admin livestream viewer list — candidate-set search/filter/sort", () => {
  const CANDIDATES = [
    { userId: "u-a", joinedAt: 3000, leftAt: 0, watchDurationSeconds: 5 },
    { userId: "u-b", joinedAt: 1000, leftAt: 0, watchDurationSeconds: 5 },
    { userId: "u-c", joinedAt: 2000, leftAt: 0, watchDurationSeconds: 5 },
  ];
  const PROFILES = [
    {
      userId: "u-a",
      username: "zoe",
      firstName: "Zoe",
      lastName: "Alpha",
      avatarUrl: "",
    },
    {
      userId: "u-b",
      username: "amy",
      firstName: "Amy",
      lastName: "Bravo",
      avatarUrl: "",
    },
    {
      userId: "u-c",
      username: "mike",
      firstName: "Mike",
      lastName: "Charlie",
      avatarUrl: "",
    },
  ];
  const ROLES = new Map([
    ["u-a", "ADMIN"],
    ["u-b", "MEMBER"],
    ["u-c", "MODERATOR"],
  ]);

  beforeEach(() => {
    adminGetStream.mockReset();
    adminListViewerSessions.mockReset();
    adminGetProfilesByIds.mockReset();
    adminGetMemberRoles.mockReset();
    adminGetStream.mockResolvedValue(baseStream());
    adminListViewerSessions.mockResolvedValue({
      sessions: CANDIDATES,
      total: CANDIDATES.length,
    });
    adminGetProfilesByIds.mockResolvedValue(PROFILES);
    adminGetMemberRoles.mockResolvedValue(ROLES);
  });

  it("pulls a candidate set (page 1, not the requested page) when a filter/sort is active", async () => {
    await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      search: "amy",
    });
    expect(adminListViewerSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "LS-1",
        page: 1,
        sortField: "joinedAt",
      })
    );
  });

  it("search matches username", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      search: "amy",
    });
    expect(page.data.map((v) => v.userId)).toEqual(["u-b"]);
    expect(page.pagination.total).toBe(1);
  });

  it("search matches display name (first + last), case-insensitively", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      search: "charlie",
    });
    expect(page.data.map((v) => v.userId)).toEqual(["u-c"]);
  });

  it("search matches exact user id", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      search: "u-a",
    });
    expect(page.data.map((v) => v.userId)).toEqual(["u-a"]);
  });

  it("search with no match returns an empty page (total 0)", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      search: "nobody",
    });
    expect(page.data).toEqual([]);
    expect(page.pagination.total).toBe(0);
  });

  it("role filter keeps only viewers with the matching community role (case-insensitive)", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      role: "admin",
    });
    expect(page.data.map((v) => v.userId)).toEqual(["u-a"]);
    expect(page.data[0].type).toBe("Admin");
  });

  it("ignores an unrecognized role filter (returns all viewers, not zero)", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      role: "HOST", // no livestream participant-role model → not a valid filter
    });
    expect(page.data.map((v) => v.userId).sort()).toEqual([
      "u-a",
      "u-b",
      "u-c",
    ]);
    expect(page.pagination.total).toBe(3);
  });

  it("username sort ascending orders by username", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      sortField: "username",
      sortDir: "asc",
    });
    // amy < mike < zoe
    expect(page.data.map((v) => v.username)).toEqual(["amy", "mike", "zoe"]);
  });

  it("username sort descending reverses the order", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      sortField: "username",
      sortDir: "desc",
    });
    expect(page.data.map((v) => v.username)).toEqual(["zoe", "mike", "amy"]);
  });

  it("role sort orders by community role label", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 1,
      limit: 10,
      sortField: "role",
      sortDir: "asc",
    });
    // Admin < Member < Moderator
    expect(page.data.map((v) => v.type)).toEqual([
      "Admin",
      "Member",
      "Moderator",
    ]);
  });

  it("paginates the filtered+sorted candidate set", async () => {
    const page = await livestreamRepository.listUsers("LS-1", {
      page: 2,
      limit: 2,
      sortField: "username",
      sortDir: "asc",
    });
    // Page 2 of [amy, mike, zoe] @ limit 2 → [zoe], numbered from 3.
    expect(page.data.map((v) => v.username)).toEqual(["zoe"]);
    expect(page.data[0].no).toBe(3);
    expect(page.pagination.total).toBe(3);
  });
});
