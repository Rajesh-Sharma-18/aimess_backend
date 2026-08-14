/**
 * Ban → Automatic Leave → Unban (no restore, but stays listed) → Rejoin,
 * end-to-end service tests.
 *
 * Verifies the architecture requirement that banMember reuses the SAME removal
 * core as leaveCommunity (removeActiveMember) instead of duplicating cleanup
 * logic, that unbanMember lifts BANNED to LEFT WITHOUT restoring ACTIVE
 * membership yet WITHOUT evicting the community from the target's list either
 * (unbannedAt keeps it visible/read-only until the target explicitly
 * dismisses it — see resolveSelfRemoval), and that the full lifecycle
 * (ban → unban → rejoin) respects every existing membership/join rule with no
 * bypass.
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
import {
  publishCommunitySystemMessageForChatSafe,
  publishCommunitySystemMessageForChatAwaited,
} from "../../src/messaging/publish-community-chat.js";
import { fetchUserSnapshots } from "../../src/lib/user-client.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubRoomEvent = publishCommunityRoomEvent as jest.Mock;
const pubUserEvent = publishChatUserEvent as jest.Mock;
const pubBanned = publishCommunityMemberBannedSafe as jest.Mock;
const pubMemberLeft = publishCommunityMemberLeftSafe as jest.Mock;
const pubSysMsg = publishCommunitySystemMessageForChatSafe as jest.Mock;
const pubSysMsgAwaited =
  publishCommunitySystemMessageForChatAwaited as jest.Mock;

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

  it("flips the target's own view to read-only via community:membership:restricted (community stays in their list — restricted-access model)", async () => {
    await communityService.banMember(CID, ADMIN, TARGET);

    expect(pubUserEvent).toHaveBeenCalledWith(
      expect.anything(),
      TARGET,
      "community:membership:restricted",
      expect.objectContaining({
        communityId: CID,
        // Same shared membership block as the unban event and a fresh GET —
        // BANNED is not "joined" (access revoked); isBanned drives the banner.
        isJoined: false,
        isBanned: true,
        membershipStatus: "BANNED",
        reason: "banned",
      })
    );
    // Must NOT fire the list-eviction event — a banned community stays visible.
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

  it("enqueues NO MEMBER_BANNED system message — the eviction + ban-notice events are the whole story the client gets", async () => {
    await communityService.banMember(CID, ADMIN, TARGET);

    // MEMBER_BANNED is hidden end-to-end (HIDDEN_SYSTEM_MESSAGE_TYPES): the
    // banned user's sticky banner already says "You're banned from this
    // community", so a chat bubble repeating it was a duplicate. Removing the
    // publish also removes the race it used to be awaited to narrow.
    expect(pubSysMsgAwaited).not.toHaveBeenCalledWith(
      expect.objectContaining({ systemMessageType: "MEMBER_BANNED" })
    );
    expect(pubRoomEvent).toHaveBeenCalled();
    expect(pubUserEvent).toHaveBeenCalled();
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

describe("unbanMember — lifts ban to LEFT, never restores ACTIVE membership, but keeps the community listed", () => {
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

  it("flips status to LEFT (not ACTIVE), clears ban metadata, and sets unbannedAt", async () => {
    const result = await communityService.unbanMember(CID, ADMIN, TARGET);

    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      CID,
      TARGET,
      "LEFT",
      { bannedAt: null, bannedBy: null, banReason: null },
      undefined,
      undefined,
      // clearDismissed — a dismissedAt from this ban cycle must not hide a
      // future re-ban from the target's list.
      true,
      expect.any(Date) // unbannedAt — keeps this specific LEFT row listed
    );
    expect(result.status).toBe("LEFT");
  });

  it("does NOT emit a community-wide or personal 'rejoined' system message", async () => {
    await communityService.unbanMember(CID, ADMIN, TARGET);

    expect(pubSysMsg).not.toHaveBeenCalled();
  });

  it("does NOT evict the community from the target's list — unban must never remove it, only an explicit self-dismiss does", async () => {
    await communityService.unbanMember(CID, ADMIN, TARGET);

    expect(pubUserEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      TARGET,
      "community:membership:removed",
      expect.anything()
    );
  });

  it("flips the target's view to the post-unban non-member state via community:membership:restricted — payload matches a fresh GET field-for-field so the open screen can switch to Join Community without a refetch", async () => {
    await communityService.unbanMember(CID, ADMIN, TARGET);

    expect(pubUserEvent).toHaveBeenCalledWith(
      expect.anything(),
      TARGET,
      "community:membership:restricted",
      expect.objectContaining({
        communityId: CID,
        // Exactly what deriveMembershipState/toCommunityData would return now:
        // ban cleared, membership NOT restored → render the join flow.
        isJoined: false,
        isBanned: false,
        membershipStatus: "NONE",
      })
    );
  });

  it("rejects unbanning a member who is not currently BANNED", async () => {
    repo.findMemberByUserId.mockResolvedValue(activeTargetMember); // ACTIVE, not BANNED

    await expect(
      communityService.unbanMember(CID, ADMIN, TARGET)
    ).rejects.toMatchObject({ message: "COMMUNITY_MEMBER_NOT_BANNED" });
  });
});

describe("resolveSelfRemoval — dismissing a just-unbanned (LEFT, unbannedAt set) community", () => {
  it("hides it via setMemberDismissed, same mechanism as dismissing a BANNED community", async () => {
    repo.findById.mockResolvedValue(publicCommunity);
    const unbannedNotDismissed = {
      status: "LEFT",
      role: "MEMBER",
      unbannedAt: new Date("2026-01-06T00:00:00.000Z"),
      dismissedAt: null,
    };

    const outcome = await communityService.resolveSelfRemoval(
      TARGET,
      publicCommunity,
      unbannedNotDismissed,
      new Date().toISOString()
    );

    expect(outcome).toBe("REMOVED");
    expect(repo.setMemberDismissed).toHaveBeenCalledWith(CID, TARGET);
    expect(pubUserEvent).toHaveBeenCalledWith(
      expect.anything(),
      TARGET,
      "community:membership:removed",
      expect.objectContaining({ communityId: CID, reason: "dismissed" })
    );
  });

  it("is idempotent once already dismissed", async () => {
    repo.findById.mockResolvedValue(publicCommunity);
    const alreadyDismissed = {
      status: "LEFT",
      role: "MEMBER",
      unbannedAt: new Date("2026-01-06T00:00:00.000Z"),
      dismissedAt: new Date("2026-01-07T00:00:00.000Z"),
    };

    const outcome = await communityService.resolveSelfRemoval(
      TARGET,
      publicCommunity,
      alreadyDismissed,
      new Date().toISOString()
    );

    expect(outcome).toBe("ALREADY_REMOVED");
    expect(repo.setMemberDismissed).not.toHaveBeenCalled();
  });

  it("an ordinary LEFT (voluntary leave/kick, unbannedAt never set) is still idempotent ALREADY_REMOVED — no special-casing", async () => {
    repo.findById.mockResolvedValue(publicCommunity);
    const ordinaryLeft = {
      status: "LEFT",
      role: "MEMBER",
      unbannedAt: null,
      dismissedAt: null,
    };

    const outcome = await communityService.resolveSelfRemoval(
      TARGET,
      publicCommunity,
      ordinaryLeft,
      new Date().toISOString()
    );

    expect(outcome).toBe("ALREADY_REMOVED");
    expect(repo.setMemberDismissed).not.toHaveBeenCalled();
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
    // call — never an implicit side effect of unbanMember itself. It always
    // resets to MEMBER regardless of the pre-ban rank on the stale row.
    expect(repo.reactivateMemberWithSnapshot).toHaveBeenCalledWith(
      CID,
      TARGET,
      expect.anything()
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
      expect.anything()
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
      expect.anything()
    );
  });
});
