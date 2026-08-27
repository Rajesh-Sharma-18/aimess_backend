/**
 * Service-layer tests for `communityService.createInviteLink()`.
 *
 * Authorization change: invite-link creation was MODERATOR/ADMIN-only; it is now
 * allowed for ANY active member. These tests lock the new membership-STATE rule
 * (every role admitted while ACTIVE; non-members and non-ACTIVE statuses denied)
 * plus the abuse guards (per-member active-link cap, audit, createdBy ownership).
 *
 * NOTE: these tests exercise the PARAMETERIZED temp-link path (they pass
 * `maxUses` / `expiresInMinutes`). A bare `{}` call on a PRIVATE community is the
 * permanent single-source-of-truth short-circuit — it returns the stored
 * permanent code WITHOUT a new row and skips the rate-limit / active-link-cap
 * guards. That path is covered in permanent-invitation-link.test.ts. The abuse
 * guards below only apply to the parameterized path, so the calls pass a param.
 *
 * Only the I/O boundary is mocked (repository, storage). The per-user Redis rate
 * limit fails open under test (cache not ready), so it does not interfere here;
 * it is covered directly in invite-rate-limit.test.ts.
 */

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
  // Spread the real module first: a factory that returns only the stubs
  // replaces EVERY other export with undefined, and `createBannedUserGuard`
  // is called at import time by `authenticate-access-token.ts` - so every
  // suite that touches `app.ts` died on "is not a function" before it ran.
  ...jest.requireActual("@aimess/redis"),
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

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "a".repeat(24);
const LINK_ID = "b".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";

const community = {
  id: CID,
  name: "Cool Community",
  handle: "cool_community",
  avatarUrl: null,
  coverUrl: null,
  type: "PRIVATE",
  adminId: "11111111-1111-4111-8111-111111111111",
  memberCount: 5,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  deletedAt: null,
};

const createdRow = (over: Record<string, unknown> = {}) => ({
  id: LINK_ID,
  code: "abc123",
  communityId: CID,
  createdBy: CALLER,
  maxUses: null,
  usedCount: 0,
  autoApprove: false,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date("2026-06-24T00:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue(community);
  repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });
  repo.countActiveInviteLinksByCreator.mockResolvedValue(0);
  repo.createInviteLink.mockImplementation(
    async (data: Record<string, unknown>) =>
      createdRow({ createdBy: data.createdBy, communityId: data.communityId })
  );
});

describe("createInviteLink — authorization (any active member)", () => {
  it.each(["MEMBER", "MODERATOR", "ADMIN"])(
    "an ACTIVE %s can create an invite link",
    async (role) => {
      repo.findMembership.mockResolvedValue({ role, status: "ACTIVE" });

      // Parameterized call → legacy temp-link create path (a fresh row).
      const link = await communityService.createInviteLink(CID, CALLER, {
        maxUses: 5,
      });

      expect(link.communityId).toBe(CID);
      expect(link.createdBy).toBe(CALLER); // ownership preserved
      expect(repo.createInviteLink).toHaveBeenCalledWith(
        expect.objectContaining({ communityId: CID, createdBy: CALLER })
      );
    }
  );

  it("a NON-MEMBER (no membership row) is forbidden", async () => {
    repo.findMembership.mockResolvedValue(null);

    await expect(
      communityService.createInviteLink(CID, CALLER, {})
    ).rejects.toThrow("COMMUNITY_FORBIDDEN");
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "BANNED", "LEFT"])(
    "a %s (non-ACTIVE) member is forbidden",
    async (status) => {
      repo.findMembership.mockResolvedValue({ role: "MEMBER", status });

      await expect(
        communityService.createInviteLink(CID, CALLER, {})
      ).rejects.toThrow("COMMUNITY_FORBIDDEN");
      expect(repo.createInviteLink).not.toHaveBeenCalled();
    }
  );

  it("a missing community → 404, no link created", async () => {
    repo.findById.mockResolvedValue(null);

    await expect(
      communityService.createInviteLink(CID, CALLER, {})
    ).rejects.toThrow("COMMUNITY_NOT_FOUND");
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });
});

describe("createInviteLink — abuse guards", () => {
  it("has no active-link cap — creates even with many links already active", async () => {
    // The per-member active-link cap was removed; a member may hold any number
    // of active invite links. A large existing count must NOT block creation.
    repo.countActiveInviteLinksByCreator.mockResolvedValue(1000);

    const link = await communityService.createInviteLink(CID, CALLER, {
      maxUses: 5,
    });
    expect(link.linkId).toBe(LINK_ID);
    expect(repo.createInviteLink).toHaveBeenCalled();
  });

  it("records an INVITE_LINK_CREATED audit entry on success", async () => {
    await communityService.createInviteLink(CID, CALLER, {
      maxUses: 5,
      expiresInMinutes: 60,
    });

    expect(repo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: CID,
        actorId: CALLER,
        action: "INVITE_LINK_CREATED",
      })
    );
  });
});
