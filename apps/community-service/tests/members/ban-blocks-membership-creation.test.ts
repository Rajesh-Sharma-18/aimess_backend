/**
 * Ban must block EVERY membership-creation surface, not just the direct
 * `POST /:id/join` endpoint — 1:1 invite acceptance, invite-link redemption
 * (which QR-code join also uses — QR just scans the same link/code, no
 * separate backend path), permanent invitation codes, join-request creation,
 * and join-request approval (defends against the ban landing in the race
 * window between a user requesting and a moderator approving).
 *
 * Pattern: real communityService, only the I/O boundary mocked (global-mocks.ts
 * setupFilesAfterEnv already stubs the repository/publishers/redis/gRPC — this
 * file only overrides return values per scenario). Companion to
 * ban-unban-rejoin.test.ts, which covers banMember/unbanMember/joinCommunity.
 */

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";
const TARGET = "99999999-9999-4999-8999-999999999999";
const INVITE_ID = "i".repeat(24);
const LINK_ID = "l".repeat(24);
const REQUEST_ID = "r".repeat(24);

const publicCommunity = {
  id: CID,
  name: "Cool Community",
  handle: "cool-community",
  avatarUrl: null,
  type: "PUBLIC",
  adminId: ADMIN,
  memberCount: 5,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
};

const adminMembership = {
  userId: ADMIN,
  communityId: CID,
  role: "ADMIN",
  status: "ACTIVE",
  joinedAt: new Date(),
};

const bannedTarget = {
  userId: TARGET,
  communityId: CID,
  role: "MEMBER",
  status: "BANNED",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  snapshotUsername: "target",
  snapshotDisplayName: "Target User",
  snapshotAvatarKey: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue(publicCommunity);
  repo.findMembership.mockResolvedValue(adminMembership);
});

describe("acceptInvite — rejects a BANNED invitee", () => {
  const pendingInvite = {
    id: INVITE_ID,
    communityId: CID,
    inviterId: ADMIN,
    inviteeId: TARGET,
    status: "PENDING",
  };

  beforeEach(() => {
    repo.findInviteById.mockResolvedValue(pendingInvite);
    repo.findMemberByUserId.mockResolvedValue(bannedTarget);
    repo.updateInvite.mockResolvedValue({
      ...pendingInvite,
      status: "DECLINED",
    });
  });

  it("throws COMMUNITY_JOIN_BANNED and does not create/reactivate a member", async () => {
    await expect(
      communityService.acceptInvite(TARGET, INVITE_ID)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_BANNED" });

    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
  });

  it("closes the invite as DECLINED instead of leaving it PENDING (race defense)", async () => {
    await expect(
      communityService.acceptInvite(TARGET, INVITE_ID)
    ).rejects.toBeTruthy();

    expect(repo.updateInvite).toHaveBeenCalledWith(INVITE_ID, {
      status: "DECLINED",
    });
  });
});

describe("redeemInviteLink — rejects a BANNED redeemer", () => {
  const activeLink = {
    id: LINK_ID,
    communityId: CID,
    code: "abc123",
    autoApprove: true,
    revokedAt: null,
    expiresAt: null,
    maxUses: null,
    usedCount: 0,
  };

  beforeEach(() => {
    repo.findInviteLinkByCode.mockResolvedValue(activeLink);
    repo.findMemberByUserId.mockResolvedValue(bannedTarget);
  });

  it("throws COMMUNITY_JOIN_BANNED before consuming a usage slot", async () => {
    await expect(
      communityService.redeemInviteLink("abc123", TARGET)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_BANNED" });

    expect(repo.incrementInviteLinkUsageIfUnder).not.toHaveBeenCalled();
    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
  });
});

describe("redeemPermanentInviteCode — rejects a BANNED redeemer (QR / permanent link share to the same underlying flow)", () => {
  const communityWithCode = {
    ...publicCommunity,
    invitationCode: "perm-code",
    invitationCodeCreatedAt: new Date(),
    createdAt: new Date(),
  };

  beforeEach(() => {
    repo.findMemberByUserId.mockResolvedValue(bannedTarget);
  });

  it("throws COMMUNITY_JOIN_BANNED and never creates a join request", async () => {
    await expect(
      communityService.redeemPermanentInviteCode(
        "perm-code",
        communityWithCode,
        TARGET
      )
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_BANNED" });

    expect(repo.createJoinRequest).not.toHaveBeenCalled();
  });
});

describe("createJoinRequest — rejects a BANNED requester", () => {
  beforeEach(() => {
    repo.findMemberByUserId.mockResolvedValue(bannedTarget);
  });

  it("throws COMMUNITY_JOIN_BANNED and never creates a request row", async () => {
    await expect(
      communityService.createJoinRequest(CID, TARGET, null)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_BANNED" });

    expect(repo.createJoinRequest).not.toHaveBeenCalled();
  });
});

describe("approveJoinRequest — rejects when the requester was banned after requesting (race defense)", () => {
  const pendingRequest = {
    id: REQUEST_ID,
    communityId: CID,
    userId: TARGET,
    status: "PENDING",
    message: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    repo.findJoinRequestById.mockResolvedValue(pendingRequest);
    // Re-read on approval finds the target now BANNED (banned between their
    // request and the moderator's decision).
    repo.findMemberByUserId.mockResolvedValue(bannedTarget);
    repo.updateJoinRequest.mockResolvedValue({
      ...pendingRequest,
      status: "REJECTED",
    });
  });

  it("throws COMMUNITY_JOIN_BANNED and does not create/reactivate a member", async () => {
    await expect(
      communityService.approveJoinRequest(CID, ADMIN, REQUEST_ID)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_BANNED" });

    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
  });

  it("closes the request as REJECTED instead of leaving it PENDING", async () => {
    await expect(
      communityService.approveJoinRequest(CID, ADMIN, REQUEST_ID)
    ).rejects.toBeTruthy();

    expect(repo.updateJoinRequest).toHaveBeenCalledWith(REQUEST_ID, {
      status: "REJECTED",
      decidedBy: ADMIN,
      decidedAt: expect.any(Date),
    });
  });
});

describe("addMembers — skips a BANNED target instead of re-adding them", () => {
  beforeEach(() => {
    repo.findMembersByUserIds.mockResolvedValue([bannedTarget]);
  });

  it("reports the banned userId as skipped with reason BANNED, no member row created", async () => {
    const result = await communityService.addMembers(CID, ADMIN, [TARGET]);

    expect(result.skipped).toEqual([{ userId: TARGET, reason: "BANNED" }]);
    expect(result.added).toEqual([]);
    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
  });
});
