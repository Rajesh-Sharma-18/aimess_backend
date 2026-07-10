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
      expect.objectContaining({ bannedBy: ADMIN, banReason: "spam" })
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
      expect.objectContaining({ communityId: CID, userId: TARGET, reason: "banned" })
    );
  });

  it("drops the community from the target's active list via community:membership:removed", async () => {
    await communityService.banMember(CID, ADMIN, TARGET);

    expect(pubUserEvent).toHaveBeenCalledWith(
      expect.anything(),
      TARGET,
      "community:membership:removed",
      expect.objectContaining({
        communityId: CID,
        membershipStatus: "REMOVED",
        reason: "banned",
      })
    );
  });

  it("does NOT publish the voluntary-leave domain event (ban has its own MEMBER_BANNED event)", async () => {
    await communityService.banMember(CID, ADMIN, TARGET);

    expect(pubMemberLeft).not.toHaveBeenCalled();
    expect(pubBanned).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: CID, targetUserId: TARGET, actorId: ADMIN })
    );
  });
});

describe("unbanMember — lifts ban to LEFT, never restores ACTIVE membership", () => {
  const bannedTarget = { ...activeTargetMember, status: "BANNED", bannedAt: new Date() };

  beforeEach(() => {
    repo.findMemberByUserId.mockResolvedValue(bannedTarget);
    repo.updateMemberStatus.mockResolvedValue({ ...bannedTarget, status: "LEFT" });
  });

  it("flips status to LEFT (not ACTIVE) and clears ban metadata", async () => {
    const result = await communityService.unbanMember(CID, ADMIN, TARGET);

    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      CID,
      TARGET,
      "LEFT",
      { bannedAt: null, bannedBy: null, banReason: null }
    );
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

