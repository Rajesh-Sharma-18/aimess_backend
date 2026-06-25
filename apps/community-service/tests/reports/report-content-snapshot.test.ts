/**
 * Service-layer test for the moderator report card read path
 * (`communityService.listCommunityReports`). Verifies the additive fields the
 * UI card renders: the short `displayId`, the reported-content snapshot
 * (message id / type / text / postedAt), and `reportedContentMedia` resolved
 * from RAW object keys into presigned media on read.
 *
 * Only the I/O boundary is mocked (repository, user-client, storage).
 */

jest.mock("../../src/lib/user-client.js", () => ({
  fetchUserSnapshots: jest.fn(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            userId: id,
            username: id,
            displayName: "Mock User",
            avatarObjectKey: null,
          },
        ])
      )
  ),
  fetchAcceptedFriendIds: jest.fn(async () => []),
}));

jest.mock("@aimess/storage", () => ({
  MEDIA_PREFIXES: { community: [], userAvatars: [] },
  parseObjectKeyFromStored: jest.fn(() => null),
  // Echo the stored object key so the test can assert resolve-on-read happened.
  toMediaObject: jest.fn(
    async (input: {
      stored: string | null;
      contentType?: string | null;
      fileName?: string | null;
      size?: number | null;
    }) => ({
      fileId: null,
      objectKey: input.stored ?? null,
      fileName: input.fileName ?? null,
      contentType: input.contentType ?? null,
      size: input.size ?? null,
      downloadUrl: input.stored ? `https://signed/${input.stored}` : null,
      downloadUrlExpiresIn: input.stored ? 900 : null,
      uploadUrl: null,
      uploadUrlExpiresIn: null,
    })
  ),
}));

jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn(async () => ({ url: null, expiresIn: null })),
  },
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    listCommunityReports: jest.fn(),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "a".repeat(24);
const MOD = "11111111-1111-4111-8111-111111111111";
const REPORTER = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
// slice(-6) = "234567" → parseInt(_,16)=2311527 → %100000 → 11527
const REPORT_ID = "0123456789abcdef01234567";

const reportRow = {
  id: REPORT_ID,
  communityId: CID,
  reporterId: REPORTER,
  targetUserId: TARGET,
  reason: "Spam Messages",
  status: "OPEN",
  reviewedBy: null,
  reviewedAt: null,
  resolution: null,
  reportedMessageId: "msg_99421",
  reportedContentType: "IMAGE",
  reportedContentText: "buy now!!!",
  reportedContentMedia: [
    { objectKey: "community-chat/abc.jpg", contentType: "image/jpeg" },
  ],
  reportedContentPostedAt: new Date("2026-02-02T10:00:00.000Z"),
  createdAt: new Date("2026-02-02T11:00:00.000Z"),
  updatedAt: new Date("2026-02-02T11:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue({ id: CID, name: "C", status: "ACTIVE" });
  repo.findMembership.mockResolvedValue({
    userId: MOD,
    role: "MODERATOR",
    status: "ACTIVE",
  });
  repo.listCommunityReports.mockResolvedValue({ rows: [reportRow], total: 1 });
});

describe("listCommunityReports — report card fields", () => {
  it("returns displayId + reported-content snapshot with resolved media", async () => {
    const res = await communityService.listCommunityReports(CID, MOD, {
      page: 1,
      limit: 20,
      status: "OPEN" as never,
    });

    const item = res.data[0] as Record<string, unknown>;

    // short, deterministic display id (FE renders as "#11527")
    expect(item.displayId).toBe("11527");

    // content snapshot
    expect(item.reportedMessageId).toBe("msg_99421");
    expect(item.reportedContentType).toBe("IMAGE");
    expect(item.reportedContentText).toBe("buy now!!!");
    expect(item.reportedContentPostedAt).toBe("2026-02-02T10:00:00.000Z");

    // media resolved from raw key → presigned (never persisted)
    const media = item.reportedContentMedia as Array<Record<string, unknown>>;
    expect(media).toHaveLength(1);
    expect(media[0]!.objectKey).toBe("community-chat/abc.jpg");
    expect(media[0]!.downloadUrl).toBe("https://signed/community-chat/abc.jpg");

    // reporter + target snapshots still present
    expect((item.reporter as Record<string, unknown>).userId).toBe(REPORTER);
    expect((item.target as Record<string, unknown>).userId).toBe(TARGET);
  });

  it("yields empty media + null snapshot for a user-level report", async () => {
    repo.listCommunityReports.mockResolvedValue({
      rows: [
        {
          ...reportRow,
          reportedMessageId: null,
          reportedContentType: null,
          reportedContentText: null,
          reportedContentMedia: null,
          reportedContentPostedAt: null,
        },
      ],
      total: 1,
    });

    const res = await communityService.listCommunityReports(CID, MOD, {
      page: 1,
      limit: 20,
      status: "OPEN" as never,
    });
    const item = res.data[0] as Record<string, unknown>;

    expect(item.displayId).toBe("11527");
    expect(item.reportedMessageId).toBeNull();
    expect(item.reportedContentMedia).toEqual([]);
  });
});
