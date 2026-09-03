/**
 * Ban must block EVERY membership-creation surface, not just the direct
 * `POST /:id/join` endpoint — invite-link redemption (which QR-code join also
 * uses — QR just scans the same link/code, no separate backend path), permanent
 * invitation codes, join-request creation, and join-request approval (defends
 * against the ban landing in the race window between a user requesting and a
 * moderator approving).
 *
 * The single exception is an explicit per-user invite (`CommunityInvite`,
 * MODERATOR+ only): accepting one re-admits and unbans the invitee, and a
 * BANNED user holding one may also redeem a link. A banned user with no invite
 * is still refused everywhere.
 *
 * Pattern: real communityService, only the I/O boundary mocked (global-mocks.ts
 * setupFilesAfterEnv already stubs the repository/publishers/redis/gRPC — this
 * file only overrides return values per scenario). Companion to
 * ban-unban-rejoin.test.ts, which covers banMember/unbanMember/joinCommunity.
 */

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import {
  fetchAcceptedFriendIds,
  fetchUserSnapshots,
} from "../../src/lib/user-client.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const snapshots = fetchUserSnapshots as unknown as jest.Mock;

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
  // Default: no explicit invite, so every ban gate stays closed. The two
  // re-admission cases below opt in by overriding this.
  repo.findInviteByCommunityAndInvitee.mockResolvedValue(null);
  snapshots.mockResolvedValue(
    new Map([
      [
        TARGET,
        {
          username: "target",
          displayName: "Target User",
          avatarObjectKey: null,
        },
      ],
    ])
  );
});

/**
 * The ONE exception to the rule above: an explicit MODERATOR+ invitation is a
 * deliberate re-admission, so accepting it unbans the invitee. The reactivation
 * write is what clears bannedAt/bannedBy/banReason.
 */
describe("acceptInvite — an explicit invite unbans the invitee", () => {
  const pendingInvite = {
    id: INVITE_ID,
    communityId: CID,
    inviterId: ADMIN,
    inviteeId: TARGET,
    status: "PENDING",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  beforeEach(() => {
    repo.findInviteById.mockResolvedValue(pendingInvite);
    repo.findMemberByUserId.mockResolvedValue(bannedTarget);
    repo.updateInvite.mockResolvedValue({
      ...pendingInvite,
      status: "ACCEPTED",
    });
  });

  it("reactivates the BANNED row instead of throwing COMMUNITY_JOIN_BANNED", async () => {
    await communityService.acceptInvite(TARGET, INVITE_ID);

    expect(repo.reactivateMemberWithSnapshot).toHaveBeenCalledWith(
      CID,
      TARGET,
      expect.any(Object)
    );
    // Never createMember — the BANNED row already occupies [communityId, userId].
    expect(repo.createMember).not.toHaveBeenCalled();
  });

  it("closes the invite as ACCEPTED", async () => {
    await communityService.acceptInvite(TARGET, INVITE_ID);

    expect(repo.updateInvite).toHaveBeenCalledWith(INVITE_ID, {
      status: "ACCEPTED",
    });
  });
});

describe("redeemInviteLink — rejects a BANNED redeemer with no invite", () => {
  const activeLink = {
    id: LINK_ID,
    communityId: CID,
    code: "abc123",
    autoApprove: true,
    revokedAt: null,
    expiresAt: null,
    maxUses: null,
    usedCount: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
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

  it("admits a BANNED redeemer who holds a PENDING invite, without burning a use", async () => {
    const pendingInvite = {
      id: INVITE_ID,
      communityId: CID,
      inviterId: ADMIN,
      inviteeId: TARGET,
      status: "PENDING",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    repo.findInviteByCommunityAndInvitee.mockResolvedValue(pendingInvite);
    repo.findInviteById.mockResolvedValue(pendingInvite);
    repo.updateInvite.mockResolvedValue({
      ...pendingInvite,
      status: "ACCEPTED",
    });

    await communityService.redeemInviteLink("abc123", TARGET);

    expect(repo.reactivateMemberWithSnapshot).toHaveBeenCalledWith(
      CID,
      TARGET,
      expect.any(Object)
    );
    // The invite, not the link, admitted them — the link's usage is untouched.
    expect(repo.incrementInviteLinkUsageIfUnder).not.toHaveBeenCalled();
  });
});

describe("redeemPermanentInviteCode — rejects a BANNED redeemer with no invite (QR / permanent link share to the same underlying flow)", () => {
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
    // addMembers gates on friendship first (AIM-05), so this case has to make
    // the target a friend or it would be skipped as NOT_FRIEND and never reach
    // the BANNED classification this suite is about.
    (fetchAcceptedFriendIds as unknown as jest.Mock).mockResolvedValue(
      new Set([TARGET])
    );
  });

  it("reports the banned userId as skipped with reason BANNED, no member row created", async () => {
    const result = await communityService.addMembers(CID, ADMIN, [TARGET]);

    expect(result.skipped).toEqual([{ userId: TARGET, reason: "BANNED" }]);
    expect(result.added).toEqual([]);
    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
  });
});
