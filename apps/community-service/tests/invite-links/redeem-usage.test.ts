/**
 * Service-layer tests for `communityService.redeemInviteLink()` usage accounting.
 *
 * Regression guard for the fix: a usage slot is consumed ONLY when a redeem
 * produces a real join effect (new/reactivated membership on autoApprove, or a
 * NEW/recycled join request). Idempotent re-taps (already ACTIVE, or already
 * PENDING) must NOT increment `usedCount`, else a single user re-tapping a
 * maxUses-limited link would exhaust it for everyone.
 *
 * Only the I/O boundary is mocked (repository, user-client, storage, publishers).
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
    findInviteLinkByCode: jest.fn(),
    findInviteLinkById: jest.fn(),
    findById: jest.fn(),
    findMemberByUserId: jest.fn(),
    findInviteByCommunityAndInvitee: jest.fn(),
    incrementInviteLinkUsageIfUnder: jest.fn(),
    findJoinRequestByCommunityAndUser: jest.fn(),
    createJoinRequest: jest.fn(),
    recyclePendingJoinRequest: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
    createMember: jest.fn(),
    reactivateMemberWithSnapshot: jest.fn(),
    countActiveMembers: jest.fn(),
    setMemberCount: jest.fn(),
    updateLastActivity: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn(async () => ({ url: null, expiresIn: null })),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "c".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";
const LINK_ID = "l".repeat(24);

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
};

const link = (over: Record<string, unknown> = {}) => ({
  id: LINK_ID,
  code: "abc123",
  communityId: CID,
  createdBy: CALLER,
  maxUses: 1,
  usedCount: 0,
  autoApprove: false,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date("2026-06-23T00:00:00.000Z"),
  ...over,
});

const pendingRequest = {
  id: "r".repeat(24),
  communityId: CID,
  userId: CALLER,
  status: "PENDING",
  message: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date("2026-06-23T00:00:00.000Z"),
  updatedAt: new Date("2026-06-23T00:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue(community);
  repo.findInviteLinkById.mockResolvedValue(link());
  repo.incrementInviteLinkUsageIfUnder.mockResolvedValue({ count: 1 });
  repo.findActiveMemberIdsByRoles.mockResolvedValue([]);
  repo.createJoinRequest.mockResolvedValue(pendingRequest);
  repo.recyclePendingJoinRequest.mockResolvedValue(pendingRequest);
  repo.createAuditLog.mockResolvedValue(undefined);
});

describe("redeemInviteLink — usage accounting (autoApprove=false)", () => {
  it("consumes a use for a NEW join request", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(link());
    repo.findMemberByUserId.mockResolvedValue(null);
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue(null);

    const res = await communityService.redeemInviteLink("abc123", CALLER);

    expect(repo.incrementInviteLinkUsageIfUnder).toHaveBeenCalledTimes(1);
    expect(res.request).toBeDefined();
  });

  it("does NOT consume a use when the caller already has a PENDING request", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(link());
    repo.findMemberByUserId.mockResolvedValue(null);
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue(pendingRequest);

    const res = await communityService.redeemInviteLink("abc123", CALLER);

    expect(repo.incrementInviteLinkUsageIfUnder).not.toHaveBeenCalled();
    expect(repo.createAuditLog).not.toHaveBeenCalled();
    expect(res.request).toBeDefined();
  });

  it("consumes a use when recycling a previously REJECTED request", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(link());
    repo.findMemberByUserId.mockResolvedValue(null);
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue({
      ...pendingRequest,
      status: "REJECTED",
    });

    await communityService.redeemInviteLink("abc123", CALLER);

    expect(repo.incrementInviteLinkUsageIfUnder).toHaveBeenCalledTimes(1);
  });

  it("does NOT consume a use for an already-ACTIVE member (idempotent)", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(link());
    repo.findMemberByUserId.mockResolvedValue({
      userId: CALLER,
      role: "MEMBER",
      status: "ACTIVE",
      joinedAt: new Date(),
      snapshotUsername: CALLER,
      snapshotDisplayName: "Mock User",
      snapshotAvatarKey: null,
    });

    const res = await communityService.redeemInviteLink("abc123", CALLER);

    expect(repo.incrementInviteLinkUsageIfUnder).not.toHaveBeenCalled();
    expect(res.member).toBeDefined();
  });
});

describe("redeemInviteLink — usage accounting (autoApprove=true)", () => {
  it("consumes a use when a membership is created", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(link({ autoApprove: true }));
    repo.findInviteLinkById.mockResolvedValue(link({ autoApprove: true }));
    repo.findMemberByUserId.mockResolvedValue(null);
    repo.createMember.mockResolvedValue({
      userId: CALLER,
      role: "MEMBER",
      status: "ACTIVE",
      joinedAt: new Date(),
      snapshotUsername: CALLER,
      snapshotDisplayName: "Mock User",
      snapshotAvatarKey: null,
    });
    repo.countActiveMembers.mockResolvedValue(6);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.updateLastActivity.mockResolvedValue(undefined);

    const res = await communityService.redeemInviteLink("abc123", CALLER);

    expect(repo.incrementInviteLinkUsageIfUnder).toHaveBeenCalledTimes(1);
    expect(res.member).toBeDefined();
  });

  it("reactivates a LEFT (unbanned-but-not-rejoined) member instead of creating a fresh row", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(link({ autoApprove: true }));
    repo.findInviteLinkById.mockResolvedValue(link({ autoApprove: true }));
    repo.findMemberByUserId.mockResolvedValue({
      userId: CALLER,
      role: "MEMBER",
      status: "LEFT",
      joinedAt: new Date(),
      snapshotUsername: CALLER,
      snapshotDisplayName: "Mock User",
      snapshotAvatarKey: null,
    });
    repo.reactivateMemberWithSnapshot.mockResolvedValue({
      userId: CALLER,
      role: "MEMBER",
      status: "ACTIVE",
      joinedAt: new Date(),
      snapshotUsername: CALLER,
      snapshotDisplayName: "Mock User",
      snapshotAvatarKey: null,
    });
    repo.countActiveMembers.mockResolvedValue(6);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.updateLastActivity.mockResolvedValue(undefined);

    const res = await communityService.redeemInviteLink("abc123", CALLER);

    expect(repo.reactivateMemberWithSnapshot).toHaveBeenCalledTimes(1);
    expect(repo.createMember).not.toHaveBeenCalled();
    expect(res.member).toBeDefined();
  });
});

describe("redeemInviteLink — a BANNED caller is rejected outright, no bypass of the ban", () => {
  it("throws COMMUNITY_JOIN_BANNED and never touches usage accounting or membership", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(link({ autoApprove: true }));
    repo.findMemberByUserId.mockResolvedValue({
      userId: CALLER,
      role: "MEMBER",
      status: "BANNED",
      joinedAt: new Date(),
      snapshotUsername: CALLER,
      snapshotDisplayName: "Mock User",
      snapshotAvatarKey: null,
    });

    await expect(
      communityService.redeemInviteLink("abc123", CALLER)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_BANNED" });

    expect(repo.incrementInviteLinkUsageIfUnder).not.toHaveBeenCalled();
    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
  });
});
