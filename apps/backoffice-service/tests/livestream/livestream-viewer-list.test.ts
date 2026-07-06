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
