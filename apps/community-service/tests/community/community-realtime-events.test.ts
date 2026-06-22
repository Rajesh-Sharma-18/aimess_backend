/**
 * Suite: community-realtime-events
 *
 * Exercises the NEW Redis pub/sub broadcasts added to community.service.ts for
 * kick, ban, leaveCommunity, bulkLeaveCommunities, unbanMember, and
 * notifyMemberJoined (via approveJoinRequest).
 *
 * Pattern mirrors apps/community-service/tests/join-requests/join-request-notifications.test.ts:
 *   - Real communityService with only I/O boundaries mocked.
 *   - publishCommunityRoomEvent from @aimess/redis is the primary assertion target.
 */

// ---------------------------------------------------------------------------
// Mock overrides — must appear before any import (Jest hoists jest.mock calls).
// These supplement / override the global-mocks.ts setupFilesAfterEnv stubs.
// ---------------------------------------------------------------------------

jest.mock("../../src/messaging/publish-community.js", () => ({
  publishCommunityMemberAddedSafe: jest.fn(),
  publishCommunityMemberKickedSafe: jest.fn(),
  publishCommunityMemberBannedSafe: jest.fn(),
  publishCommunityMemberUnbannedSafe: jest.fn(),
  publishCommunityMemberMutedSafe: jest.fn(),
  publishCommunityMemberUnmutedSafe: jest.fn(),
  publishCommunityMemberWarnedSafe: jest.fn(),
  publishCommunityMemberRoleChangedSafe: jest.fn(),
  publishCommunityAdminTransferredSafe: jest.fn(),
  publishCommunityDeletedSafe: jest.fn(),
  publishCommunityMemberLeftSafe: jest.fn(),
  publishCommunityJoinRequestedSafe: jest.fn(),
  publishCommunityJoinRequestApprovedSafe: jest.fn(),
  publishCommunityJoinRequestRejectedSafe: jest.fn(),
  publishCommunityInviteSentSafe: jest.fn(),
  publishCommunityInviteAcceptedSafe: jest.fn(),
  publishCommunityReportCreatedSafe: jest.fn(),
  publishCommunityReportActionedSafe: jest.fn(),
}));

jest.mock("@aimess/redis", () => ({
  publishCommunityRoomEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMemberByUserId: jest.fn(),
    findMembersByUserIds: jest.fn(),
    updateMemberStatus: jest.fn(),
    countActiveMembers: jest.fn(),
    setMemberCount: jest.fn(),
    updateLastActivity: jest.fn(),
    createAuditLog: jest.fn(),
    createMember: jest.fn(),
    reactivateMemberWithSnapshot: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
    updateJoinRequest: jest.fn(),
    findJoinRequestById: jest.fn(),
    findActiveMembershipsWithRoleByCommunityIds: jest.fn(),
    findCommunitiesByIds: jest.fn(),
    deleteCommunityHard: jest.fn(),
  },
}));

jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn(async () => ({ url: null, expiresIn: null })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after all jest.mock declarations)
// ---------------------------------------------------------------------------

import { publishCommunityRoomEvent } from "@aimess/redis";
import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { publishCommunityMemberLeftSafe } from "../../src/messaging/publish-community.js";

// ---------------------------------------------------------------------------
// Typed aliases
// ---------------------------------------------------------------------------

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubRoomEvent = publishCommunityRoomEvent as jest.Mock;
const pubMemberLeft = publishCommunityMemberLeftSafe as jest.Mock;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";
const MOD = "22222222-2222-4222-8222-222222222222";
const TARGET = "99999999-9999-4999-8999-999999999999";
const NON_ADMIN = "88888888-8888-4888-8888-888888888888";
const RID = "r".repeat(24); // join-request id

const community = {
  id: CID,
  name: "Test Community",
  type: "PUBLIC",
  adminId: ADMIN,
  memberCount: 10,
  moderationStatus: "ACTIVE",
};

const activeMemberTarget = {
  userId: TARGET,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-06-01T00:00:00.000Z"),
  snapshotUsername: "target_user",
  snapshotDisplayName: "Target User",
  snapshotAvatarKey: null,
  bannedAt: null,
  bannedBy: null,
  banReason: null,
};

const activeMemberNonAdmin = {
  userId: NON_ADMIN,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-06-01T00:00:00.000Z"),
  snapshotUsername: "non_admin",
  snapshotDisplayName: "Non Admin",
  snapshotAvatarKey: null,
  bannedAt: null,
  bannedBy: null,
  banReason: null,
};

// ---------------------------------------------------------------------------
// Global beforeEach reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  pubRoomEvent.mockClear();
  pubMemberLeft.mockClear();
});

// ---------------------------------------------------------------------------
// Suite 1 — kickMember
// ---------------------------------------------------------------------------

describe("kickMember — real-time broadcasts", () => {
  beforeEach(() => {
    // _assertCanModerateMember calls: findById, findMembership, findMemberByUserId
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findMemberByUserId.mockResolvedValue(activeMemberTarget);
    // After assertCanModerateMember: updateMemberStatus, countActiveMembers, setMemberCount
    repo.updateMemberStatus.mockResolvedValue({
      ...activeMemberTarget,
      status: "LEFT",
    });
    repo.countActiveMembers.mockResolvedValue(9);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.updateLastActivity.mockResolvedValue(undefined);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("emits community:member:removed with reason=kicked", async () => {
    await communityService.kickMember(CID, ADMIN, TARGET, "violating rules");

    const removedCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:member:removed"
    );
    expect(removedCall).toBeDefined();
    const [, communityId, , payload] = removedCall!;
    expect(communityId).toBe(CID);
    expect(payload).toMatchObject({
      communityId: CID,
      userId: TARGET,
      reason: "kicked",
      actorId: ADMIN,
    });
    expect(typeof payload.updatedAt).toBe("number");
  });

  it("emits community:stats:updated with the new count", async () => {
    await communityService.kickMember(CID, ADMIN, TARGET);

    const statsCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:stats:updated"
    );
    expect(statsCall).toBeDefined();
    const [, communityId, , payload] = statsCall!;
    expect(communityId).toBe(CID);
    expect(payload).toMatchObject({
      communityId: CID,
      memberCount: 9,
    });
    expect(typeof payload.updatedAt).toBe("number");
  });

  it("emits exactly 2 room events total", async () => {
    await communityService.kickMember(CID, ADMIN, TARGET);
    expect(pubRoomEvent).toHaveBeenCalledTimes(2);
  });

  it("does NOT throw when Redis publish fails", async () => {
    pubRoomEvent.mockRejectedValueOnce(new Error("Redis down"));
    pubRoomEvent.mockRejectedValueOnce(new Error("Redis down"));

    await expect(
      communityService.kickMember(CID, ADMIN, TARGET)
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — banMember
// ---------------------------------------------------------------------------

describe("banMember — real-time broadcasts", () => {
  beforeEach(() => {
    // banMember calls: findById, findMembership, findMemberByUserId (for target)
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findMemberByUserId.mockResolvedValue(activeMemberTarget);
    repo.updateMemberStatus.mockResolvedValue({
      ...activeMemberTarget,
      status: "BANNED",
    });
    repo.countActiveMembers.mockResolvedValue(9);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.updateLastActivity.mockResolvedValue(undefined);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("emits community:member:removed with reason=banned", async () => {
    await communityService.banMember(CID, ADMIN, TARGET, "spam");

    const removedCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:member:removed"
    );
    expect(removedCall).toBeDefined();
    const [, communityId, , payload] = removedCall!;
    expect(communityId).toBe(CID);
    expect(payload).toMatchObject({
      communityId: CID,
      userId: TARGET,
      reason: "banned",
      actorId: ADMIN,
    });
    expect(typeof payload.updatedAt).toBe("number");
  });

  it("emits community:stats:updated with the new count", async () => {
    await communityService.banMember(CID, ADMIN, TARGET);

    const statsCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:stats:updated"
    );
    expect(statsCall).toBeDefined();
    const [, , , payload] = statsCall!;
    expect(payload).toMatchObject({
      communityId: CID,
      memberCount: 9,
    });
    expect(typeof payload.updatedAt).toBe("number");
  });

  it("emits NO room events on idempotent ban (target already BANNED)", async () => {
    // findMemberByUserId returns a BANNED member → early return, no writes, no broadcasts
    repo.findMemberByUserId.mockResolvedValue({
      ...activeMemberTarget,
      status: "BANNED",
    });

    await communityService.banMember(CID, ADMIN, TARGET);

    expect(pubRoomEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — leaveCommunity
// ---------------------------------------------------------------------------

describe("leaveCommunity — real-time broadcasts", () => {
  beforeEach(() => {
    // leaveCommunity calls: findById, findMemberByUserId (for caller), updateMemberStatus,
    // countActiveMembers, setMemberCount, createAuditLog
    repo.findById.mockResolvedValue(community);
    repo.findMemberByUserId.mockResolvedValue(activeMemberNonAdmin);
    repo.updateMemberStatus.mockResolvedValue({
      ...activeMemberNonAdmin,
      status: "LEFT",
    });
    repo.countActiveMembers.mockResolvedValue(9);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("emits community:member:removed with reason=left", async () => {
    await communityService.leaveCommunity(CID, NON_ADMIN);

    const removedCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:member:removed"
    );
    expect(removedCall).toBeDefined();
    const [, communityId, , payload] = removedCall!;
    expect(communityId).toBe(CID);
    expect(payload).toMatchObject({
      communityId: CID,
      userId: NON_ADMIN,
      reason: "left",
      actorId: NON_ADMIN,
    });
    expect(typeof payload.updatedAt).toBe("number");
  });

  it("emits community:stats:updated with the new count", async () => {
    await communityService.leaveCommunity(CID, NON_ADMIN);

    const statsCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:stats:updated"
    );
    expect(statsCall).toBeDefined();
    const [, , , payload] = statsCall!;
    expect(payload).toMatchObject({
      communityId: CID,
      memberCount: 9,
    });
    expect(typeof payload.updatedAt).toBe("number");
  });

  it("also publishes the RabbitMQ member_left event (pre-existing omission now fixed)", async () => {
    await communityService.leaveCommunity(CID, NON_ADMIN);

    expect(pubMemberLeft).toHaveBeenCalledTimes(1);
    const payload = pubMemberLeft.mock.calls[0][0];
    expect(payload).toMatchObject({
      communityId: CID,
      actorId: NON_ADMIN,
    });
    expect(typeof payload.eventAt).toBe("string");
  });

  it("emits NO room events when admin is the last member (auto-delete branch)", async () => {
    // Admin as last member: memberCount === 1, isAdmin = true → deleteCommunityHard, no broadcasts
    repo.findById.mockResolvedValue({
      ...community,
      adminId: ADMIN,
      memberCount: 1,
    });
    repo.findMemberByUserId.mockResolvedValue({
      userId: ADMIN,
      role: "ADMIN",
      status: "ACTIVE",
      joinedAt: new Date(),
      snapshotUsername: "admin_user",
      snapshotDisplayName: "Admin",
      snapshotAvatarKey: null,
      bannedAt: null,
      bannedBy: null,
      banReason: null,
    });
    repo.deleteCommunityHard = jest.fn(async () => undefined);

    await communityService.leaveCommunity(CID, ADMIN);

    expect(pubRoomEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — unbanMember
// ---------------------------------------------------------------------------

describe("unbanMember — real-time broadcast", () => {
  beforeEach(() => {
    // unbanMember calls: findById, findMembership, findMemberByUserId (target BANNED),
    // updateMemberStatus, countActiveMembers, setMemberCount, createAuditLog
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findMemberByUserId.mockResolvedValue({
      ...activeMemberTarget,
      status: "BANNED",
    });
    repo.updateMemberStatus.mockResolvedValue({
      ...activeMemberTarget,
      status: "LEFT",
    });
    repo.countActiveMembers.mockResolvedValue(9);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("emits community:member:unbanned", async () => {
    await communityService.unbanMember(CID, ADMIN, TARGET);

    const unbanCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:member:unbanned"
    );
    expect(unbanCall).toBeDefined();
    const [, communityId, , payload] = unbanCall!;
    expect(communityId).toBe(CID);
    expect(payload).toMatchObject({
      communityId: CID,
      userId: TARGET,
      actorId: ADMIN,
    });
    expect(typeof payload.updatedAt).toBe("number");
  });

  it("does NOT emit community:stats:updated on unban", async () => {
    await communityService.unbanMember(CID, ADMIN, TARGET);

    const statsCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:stats:updated"
    );
    expect(statsCall).toBeUndefined();
  });

  it("emits exactly 1 room event total", async () => {
    await communityService.unbanMember(CID, ADMIN, TARGET);
    expect(pubRoomEvent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — notifyMemberJoined emits community:stats:updated alongside
//            community:member:joined (via approveJoinRequest)
// ---------------------------------------------------------------------------

describe("notifyMemberJoined — emits community:stats:updated alongside community:member:joined", () => {
  const pendingRequest = {
    id: RID,
    communityId: CID,
    userId: TARGET,
    status: "PENDING",
    message: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date("2026-06-15T00:00:00.000Z"),
    updatedAt: new Date("2026-06-15T00:00:00.000Z"),
  };

  beforeEach(() => {
    // approveJoinRequest calls: findById, findMembership (caller), findJoinRequestById,
    // findMemberByUserId (A12 race re-read → null), createMember,
    // countActiveMembers, setMemberCount, updateLastActivity, updateJoinRequest,
    // createAuditLog, findMemberByUserId (post-write fetch), findActiveMemberIdsByRoles
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findJoinRequestById.mockResolvedValue(pendingRequest);
    // findMemberByUserId: 1st call (A12 race re-read) → null; subsequent calls → member row
    repo.findMemberByUserId
      .mockResolvedValueOnce(null)
      .mockResolvedValue(activeMemberTarget);
    repo.createMember.mockResolvedValue(activeMemberTarget);
    repo.countActiveMembers.mockResolvedValue(11);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.updateLastActivity.mockResolvedValue(undefined);
    repo.updateJoinRequest.mockResolvedValue({
      ...pendingRequest,
      status: "APPROVED",
      decidedBy: MOD,
      decidedAt: new Date(),
    });
    repo.createAuditLog.mockResolvedValue(undefined);
    repo.findActiveMemberIdsByRoles.mockResolvedValue([ADMIN, MOD]);
  });

  it("emits community:stats:updated alongside community:member:joined", async () => {
    await communityService.approveJoinRequest(CID, MOD, RID);

    const joinedCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:member:joined"
    );
    const statsCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:stats:updated"
    );

    expect(joinedCall).toBeDefined();
    expect(statsCall).toBeDefined();
  });

  it("community:stats:updated carries the post-join memberCount", async () => {
    await communityService.approveJoinRequest(CID, MOD, RID);

    const statsCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:stats:updated"
    );
    expect(statsCall).toBeDefined();
    const [, communityId, , payload] = statsCall!;
    expect(communityId).toBe(CID);
    expect(payload).toMatchObject({
      communityId: CID,
      memberCount: 11,
    });
    expect(typeof payload.updatedAt).toBe("number");
  });
});
