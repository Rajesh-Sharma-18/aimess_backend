/**
 * Ban → Automatic Leave → Unban (no restore) → Rejoin, end-to-end service tests.
 *
 * Verifies the architecture requirement that banMember reuses the SAME removal
 * core as leaveCommunity (removeActiveMember) instead of duplicating cleanup
 * logic, and that the full lifecycle (ban → unban → rejoin) respects every
 * existing membership/join rule with no bypass.
 *
 * Pattern: real communityService, only the I/O boundary mocked (global-mocks.ts
 * setupFilesAfterEnv already stubs the repository/publishers/redis/gRPC — this
 * file only overrides return values per scenario).
 */

import { publishCommunityRoomEvent, publishChatUserEvent } from "@aimess/redis";

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import {
  publishCommunityMemberBannedSafe,
  publishCommunityMemberLeftSafe,
} from "../../src/messaging/publish-community.js";
import { publishCommunitySystemMessageForChatSafe } from "../../src/messaging/publish-community-chat.js";
import { fetchUserSnapshots } from "../../src/lib/user-client.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubRoomEvent = publishCommunityRoomEvent as jest.Mock;
const pubUserEvent = publishChatUserEvent as jest.Mock;
const pubBanned = publishCommunityMemberBannedSafe as jest.Mock;
const pubMemberLeft = publishCommunityMemberLeftSafe as jest.Mock;
const pubSysMsg = publishCommunitySystemMessageForChatSafe as jest.Mock;

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";
const TARGET = "99999999-9999-4999-8999-999999999999";
const REQ_ID = "r".repeat(24);

const publicCommunity = {
  id: CID,
  name: "Cool Community",
  handle: "cool-community",
  avatarUrl: null,
  type: "PUBLIC",
  adminId: ADMIN,
  memberCount: 5,
  moderationStatus: "ACTIVE",
};

const privateCommunity = { ...publicCommunity, type: "PRIVATE" };

const adminMembership = {
  userId: ADMIN,
  communityId: CID,
  role: "ADMIN",
  status: "ACTIVE",
  joinedAt: new Date(),
};

const activeTargetMember = {
  userId: TARGET,
  communityId: CID,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  snapshotUsername: "target",
  snapshotDisplayName: "Target User",
  snapshotAvatarKey: null,
};

// A promoted target — used to prove ban strips the elevated rank instead of
// leaving it on the row for a later reactivation to silently restore.
const moderatorTargetMember = { ...activeTargetMember, role: "MODERATOR" };

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue(publicCommunity);
  repo.findMembership.mockResolvedValue(adminMembership);
  repo.countActiveMembers.mockResolvedValue(4);
  repo.setMemberCount.mockResolvedValue(undefined);
  repo.createAuditLog.mockResolvedValue(undefined);
});

describe("banMember — reuses the leave removal core (architecture requirement)", () => {
  beforeEach(() => {
    repo.findMemberByUserId.mockResolvedValue(activeTargetMember);
    repo.updateMemberStatus.mockResolvedValue({
      ...activeTargetMember,
      status: "BANNED",
    });
  });

  it("flips status to BANNED with ban metadata via the shared updateMemberStatus call", async () => {
    await communityService.banMember(CID, ADMIN, TARGET, "spam");

    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      CID,
      TARGET,
      "BANNED",
      expect.objectContaining({ bannedBy: ADMIN, banReason: "spam" }),
      "MEMBER"
    );
  });

  it("recomputes memberCount exactly like a voluntary leave", async () => {
    await communityService.banMember(CID, ADMIN, TARGET);

    expect(repo.countActiveMembers).toHaveBeenCalledWith(CID);
    expect(repo.setMemberCount).toHaveBeenCalledWith(CID, 4);
  });

  it("evicts via community:member:removed (socket room cleanup) with reason 'banned'", async () => {
    await communityService.banMember(CID, ADMIN, TARGET);

    expect(pubRoomEvent).toHaveBeenCalledWith(
      expect.anything(),
      CID,
      "community:member:removed",
      expect.objectContaining({
        communityId: CID,
        userId: TARGET,
        reason: "banned",
      })
    );
  });

  it("keeps the community in the target's list — pushes the distinct community:membership:banned (lock in place, never a list-drop)", async () => {
    await communityService.banMember(CID, ADMIN, TARGET);

    expect(pubUserEvent).toHaveBeenCalledWith(
      expect.anything(),
      TARGET,
      "community:membership:banned",
      expect.objectContaining({
        communityId: CID,
        userId: TARGET,
        actorId: ADMIN,
      })
    );
    // The list-drop event (used by kick/leave) must NOT fire for a ban.
    expect(pubUserEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      TARGET,
      "community:membership:removed",
      expect.anything()
    );
  });

  it("does NOT publish the voluntary-leave domain event (ban has its own MEMBER_BANNED event)", async () => {
    await communityService.banMember(CID, ADMIN, TARGET);

    expect(pubMemberLeft).not.toHaveBeenCalled();
    expect(pubBanned).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: CID,
        targetUserId: TARGET,
        actorId: ADMIN,
      })
    );
  });

  it("resets role to MEMBER in the same write, so a banned MODERATOR can never have rank restored on a later reactivation", async () => {
    repo.findMemberByUserId.mockResolvedValue(moderatorTargetMember);
    repo.updateMemberStatus.mockResolvedValue({
      ...moderatorTargetMember,
      role: "MEMBER",
      status: "BANNED",
    });

    await communityService.banMember(CID, ADMIN, TARGET, "spam");

    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      CID,
      TARGET,
      "BANNED",
      expect.objectContaining({ bannedBy: ADMIN, banReason: "spam" }),
      "MEMBER"
    );
  });
});

describe("unbanMember — lifts ban to LEFT, never restores ACTIVE membership", () => {
  const bannedTarget = {
    ...activeTargetMember,
    status: "BANNED",
    bannedAt: new Date(),
  };

  beforeEach(() => {
    repo.findMemberByUserId.mockResolvedValue(bannedTarget);
    repo.updateMemberStatus.mockResolvedValue({
      ...bannedTarget,
      status: "LEFT",
    });
  });

  it("flips status to LEFT (not ACTIVE) and clears ban metadata", async () => {
    const result = await communityService.unbanMember(CID, ADMIN, TARGET);

    expect(repo.updateMemberStatus).toHaveBeenCalledWith(CID, TARGET, "LEFT", {
      bannedAt: null,
      bannedBy: null,
      banReason: null,
    });
    expect(result.status).toBe("LEFT");
  });

  it("does NOT emit a community-wide or personal 'rejoined' system message", async () => {
    await communityService.unbanMember(CID, ADMIN, TARGET);

    expect(pubSysMsg).not.toHaveBeenCalled();
  });

  it("rejects unbanning a member who is not currently BANNED", async () => {
    repo.findMemberByUserId.mockResolvedValue(activeTargetMember); // ACTIVE, not BANNED

    await expect(
      communityService.unbanMember(CID, ADMIN, TARGET)
    ).rejects.toMatchObject({ message: "COMMUNITY_MEMBER_NOT_BANNED" });
  });
});

describe("Rejoin after unban — respects existing join rules, never auto-restores", () => {
  const leftAfterUnban = { ...activeTargetMember, status: "LEFT" };

  it("PUBLIC community: unbanned (LEFT) user must explicitly re-join — reactivates via the normal join flow, not automatically", async () => {
    repo.findById.mockResolvedValue(publicCommunity);
    repo.findMemberByUserId.mockResolvedValue(leftAfterUnban);
    repo.reactivateMemberWithSnapshot.mockResolvedValue({
      ...leftAfterUnban,
      status: "ACTIVE",
    });
    repo.countActiveMembers.mockResolvedValue(5);
    repo.findActiveMemberIdsByRoles.mockResolvedValue([ADMIN]);

    const result = await communityService.joinCommunity(CID, TARGET);

    expect(result.status).toBe("JOINED");
    // Reactivation is a real membership write triggered by the user's own join
    // call — never an implicit side effect of unbanMember itself.
    expect(repo.reactivateMemberWithSnapshot).toHaveBeenCalledWith(
      CID,
      TARGET,
      expect.anything(),
      leftAfterUnban.role
    );
  });

  it("PRIVATE community: unbanned (LEFT) user must go through the join-request/approval flow, not instant ACTIVE", async () => {
    repo.findById.mockResolvedValue(privateCommunity);
    repo.findMemberByUserId.mockResolvedValue(leftAfterUnban);
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue(null);
    repo.createJoinRequest.mockResolvedValue({
      id: REQ_ID,
      communityId: CID,
      userId: TARGET,
      status: "PENDING",
      message: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    repo.findActiveMemberIdsByRoles.mockResolvedValue([ADMIN]);

    const result = await communityService.joinCommunity(CID, TARGET);

    expect(result.status).toBe("REQUEST_CREATED");
    expect(result.membershipStatus).toBe("PENDING");
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
  });

  it("still-BANNED user (no unban yet) is rejected outright, no bypass", async () => {
    repo.findById.mockResolvedValue(publicCommunity);
    repo.findMemberByUserId.mockResolvedValue({
      ...activeTargetMember,
      status: "BANNED",
    });

    await expect(
      communityService.joinCommunity(CID, TARGET)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_BANNED" });
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
    expect(repo.createJoinRequest).not.toHaveBeenCalled();
  });
});

describe("Full ban/unban cycle never restores a previous MODERATOR/ADMIN role (regression)", () => {
  // The row as it exists in the DB after banMember's role-reset write and
  // unbanMember's status flip: role is already MEMBER, not the MODERATOR
  // rank the user held before the ban — this is what makes every rejoin
  // path below correct without any change to the rejoin code itself.
  const leftAfterBanUnbanCycle = {
    ...moderatorTargetMember,
    role: "MEMBER",
    status: "LEFT",
  };

  it("re-join (PUBLIC) reactivates as MEMBER, never the pre-ban MODERATOR rank", async () => {
    repo.findById.mockResolvedValue(publicCommunity);
    repo.findMemberByUserId.mockResolvedValue(leftAfterBanUnbanCycle);
    repo.reactivateMemberWithSnapshot.mockResolvedValue({
      ...leftAfterBanUnbanCycle,
      status: "ACTIVE",
    });
    repo.countActiveMembers.mockResolvedValue(5);
    repo.findActiveMemberIdsByRoles.mockResolvedValue([ADMIN]);

    await communityService.joinCommunity(CID, TARGET);

    expect(repo.reactivateMemberWithSnapshot).toHaveBeenCalledWith(
      CID,
      TARGET,
      expect.anything(),
      "MEMBER"
    );
  });

  it("admin re-add (addMembers) reactivates as MEMBER, never the pre-ban MODERATOR rank", async () => {
    repo.findMembersByUserIds.mockResolvedValue([leftAfterBanUnbanCycle]);
    (fetchUserSnapshots as jest.Mock).mockResolvedValue(
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
    repo.reactivateMemberWithSnapshot.mockResolvedValue({
      ...leftAfterBanUnbanCycle,
      status: "ACTIVE",
    });

    await communityService.addMembers(CID, ADMIN, [TARGET]);

    expect(repo.reactivateMemberWithSnapshot).toHaveBeenCalledWith(
      CID,
      TARGET,
      expect.anything(),
      "MEMBER"
    );
  });
});
