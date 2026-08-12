/**
 * AUDIT-108 — `autoApprove: true` on a PRIVATE community's invite link needs a
 * moderation role.
 *
 * Invite-link creation is deliberately open to every ACTIVE member. But
 * `autoApprove` is not an ordinary link option on a PRIVATE community: it
 * bypasses the join-request queue entirely, which is the only thing making the
 * community private. A rank-and-file MEMBER could therefore mint a link that let
 * anyone holding it walk straight in, with no moderator ever seeing a request.
 *
 * Deciding who gets in is a moderation power, so it now takes a moderation role.
 * PUBLIC communities are unaffected — anyone can join them anyway, so
 * auto-approve grants nothing that isn't already available.
 */

jest.mock("../../src/lib/user-client.js", () => ({
  fetchExistingUserIds: jest.fn(async () => null),
  fetchUserSnapshots: jest.fn(async () => new Map()),
  fetchAcceptedFriendIds: jest.fn(async () => new Set()),
}));

jest.mock("@aimess/storage", () => ({
  MEDIA_PREFIXES: { community: [], userAvatars: [] },
  parseObjectKeyFromStored: jest.fn(() => null),
  toMediaObject: jest.fn(async () => ({
    url: null,
    downloadUrl: null,
    objectKey: null,
    expiresAt: null,
  })),
}));

jest.mock("@aimess/redis", () => ({
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    countActiveInviteLinksByCreator: jest.fn(),
    createInviteLink: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

import { ForbiddenError } from "@aimess/errors";

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "a".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";

const makeCommunity = (type: "PUBLIC" | "PRIVATE") => ({
  id: CID,
  name: "Tech Community",
  handle: "tech_community",
  avatarUrl: null,
  coverUrl: null,
  type,
  adminId: "11111111-1111-4111-8111-111111111111",
  memberCount: 5,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  deletedAt: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.countActiveInviteLinksByCreator.mockResolvedValue(0);
  repo.createInviteLink.mockImplementation(
    async (data: Record<string, unknown>) => ({
      id: "b".repeat(24),
      code: data.code,
      communityId: CID,
      createdBy: CALLER,
      maxUses: data.maxUses ?? null,
      usedCount: 0,
      autoApprove: data.autoApprove ?? false,
      expiresAt: data.expiresAt ?? null,
      revokedAt: null,
      createdAt: new Date("2026-06-24T00:00:00.000Z"),
    })
  );
});

describe("PRIVATE community", () => {
  beforeEach(() => repo.findById.mockResolvedValue(makeCommunity("PRIVATE")));

  it("SECURITY: a plain MEMBER cannot create an auto-approve link", async () => {
    repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });

    await expect(
      communityService.createInviteLink(CID, CALLER, { autoApprove: true })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });

  it("a plain MEMBER can still create an ordinary request-to-join link", async () => {
    repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });

    const link = await communityService.createInviteLink(CID, CALLER, {
      maxUses: 5,
    });

    expect(link.autoApprove).toBe(false);
    expect(repo.createInviteLink).toHaveBeenCalledWith(
      expect.objectContaining({ autoApprove: false })
    );
  });

  it.each(["MODERATOR", "ADMIN"])(
    "%s may create an auto-approve link",
    async (role) => {
      repo.findMembership.mockResolvedValue({ role, status: "ACTIVE" });

      const link = await communityService.createInviteLink(CID, CALLER, {
        autoApprove: true,
      });

      expect(link.autoApprove).toBe(true);
    }
  );
});

describe("PUBLIC community", () => {
  beforeEach(() => repo.findById.mockResolvedValue(makeCommunity("PUBLIC")));

  it("a plain MEMBER may create an auto-approve link — it grants nothing new", async () => {
    repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });

    const link = await communityService.createInviteLink(CID, CALLER, {
      autoApprove: true,
    });

    expect(link.autoApprove).toBe(true);
  });
});
