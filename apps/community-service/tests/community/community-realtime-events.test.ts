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
  publishChatUserEvent: jest.fn(async () => 1),
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
    setMemberDismissed: jest.fn(),
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

import { publishCommunityRoomEvent, publishChatUserEvent } from "@aimess/redis";
import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { publishCommunityMemberLeftSafe } from "../../src/messaging/publish-community.js";
import {
  publishCommunitySystemMessageForChatSafe,
  publishCommunitySystemMessageForChatAwaited,
} from "../../src/messaging/publish-community-chat.js";

// ---------------------------------------------------------------------------
// Typed aliases
// ---------------------------------------------------------------------------

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubRoomEvent = publishCommunityRoomEvent as jest.Mock;
const pubUserEvent = publishChatUserEvent as jest.Mock;
const pubMemberLeft = publishCommunityMemberLeftSafe as jest.Mock;
const pubSysMsg = publishCommunitySystemMessageForChatSafe as jest.Mock;
const pubSysMsgAwaited =
  publishCommunitySystemMessageForChatAwaited as jest.Mock;

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
  handle: "test-community",
  description: "A test community",
  avatarUrl: null,
  type: "PUBLIC",
  adminId: ADMIN,
  memberCount: 10,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  category: { id: "cat-1", name: "General" },
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
  pubUserEvent.mockClear();
  pubMemberLeft.mockClear();
  pubSysMsg.mockClear();
  pubSysMsgAwaited.mockClear();
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

  it("posts a MEMBER_REMOVED chat system message (visible moderation — Telegram parity)", async () => {
    await communityService.kickMember(CID, ADMIN, TARGET, "violating rules");

    // Moderation actions are visible to all members (Telegram parity): the
    // chat-timeline SYSTEM line is posted. Only MEMBER_LEFT / MEMBER_JOINED are
    // hidden (HIDDEN_SYSTEM_MESSAGE_TYPES); MEMBER_REMOVED is NOT.
    const postedTypes = pubSysMsg.mock.calls.map(
      ([arg]) => (arg as { systemMessageType?: string }).systemMessageType
    );
    expect(postedTypes).toContain("MEMBER_REMOVED");
  });

  it("does NOT write removal to lastActivity (removal never becomes the list preview)", async () => {
    repo.updateLastActivity.mockClear();
    await communityService.kickMember(CID, ADMIN, TARGET, "violating rules");
    expect(repo.updateLastActivity).not.toHaveBeenCalled();
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

  it("posts a MEMBER_BANNED chat system message (PERSONAL — visible only to the banned user), via the AWAITED publish", async () => {
    await communityService.banMember(CID, ADMIN, TARGET, "spam");

    // MEMBER_BANNED is NOT in HIDDEN_SYSTEM_MESSAGE_TYPES, so it's always
    // posted. It rides the AWAITED variant (not the fire-and-forget Safe one)
    // so the enqueue is confirmed before eviction/ban-notice events fire.
    const postedTypes = pubSysMsgAwaited.mock.calls.map(
      ([arg]) => (arg as { systemMessageType?: string }).systemMessageType
    );
    expect(postedTypes).toContain("MEMBER_BANNED");
  });

  it("does NOT write removal/ban to lastActivity (ban never becomes the list preview)", async () => {
    repo.updateLastActivity.mockClear();
    await communityService.banMember(CID, ADMIN, TARGET, "spam");
    expect(repo.updateLastActivity).not.toHaveBeenCalled();
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

  it("does NOT post a MEMBER_LEFT chat system message (silent leave)", async () => {
    await communityService.leaveCommunity(CID, NON_ADMIN);

    // The roster socket + domain event still fire (asserted above); the chat
    // timeline line "X left the community" is suppressed for everyone.
    const postedTypes = pubSysMsg.mock.calls.map(
      ([arg]) => (arg as { systemMessageType?: string }).systemMessageType
    );
    expect(postedTypes).not.toContain("MEMBER_LEFT");
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
// Suite 3b — bulkDeleteCommunities
// ---------------------------------------------------------------------------

describe("bulkDeleteCommunities", () => {
  const CID2 = "d".repeat(24);
  const bannedMember = {
    ...activeMemberNonAdmin,
    status: "BANNED",
    bannedAt: new Date("2026-06-05T00:00:00.000Z"),
    bannedBy: ADMIN,
    banReason: "spam",
  };
  const adminMembership = {
    ...activeMemberNonAdmin,
    userId: ADMIN,
    role: "ADMIN",
  };

  beforeEach(() => {
    repo.findCommunitiesByIds.mockResolvedValue([{ id: CID }, { id: CID2 }]);
    repo.updateMemberStatus.mockResolvedValue({
      ...activeMemberNonAdmin,
      status: "LEFT",
    });
    repo.countActiveMembers.mockResolvedValue(9);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("admin: fails with OWNER_CANNOT_DELETE and never touches membership", async () => {
    repo.findMemberByUserId.mockResolvedValue(adminMembership);

    const result = await communityService.bulkDeleteCommunities(ADMIN, [CID]);

    expect(result.results).toEqual([
      { communityId: CID, status: "FAILED", errorCode: "OWNER_CANNOT_DELETE" },
    ]);
    expect(result.summary).toEqual({ requested: 1, removed: 0, failed: 1 });
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  });

  it("active member: removed via the shared leave path, real-time events fire", async () => {
    repo.findMemberByUserId.mockResolvedValue(activeMemberNonAdmin);

    const result = await communityService.bulkDeleteCommunities(NON_ADMIN, [
      CID,
    ]);

    expect(result.results).toEqual([{ communityId: CID, status: "REMOVED" }]);
    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      CID,
      NON_ADMIN,
      "LEFT"
    );
    expect(pubMemberLeft).toHaveBeenCalledTimes(1);
    const removedCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:member:removed"
    );
    expect(removedCall).toBeDefined();
  });

  it("banned member: does not touch membership, still reports REMOVED", async () => {
    repo.findMemberByUserId.mockResolvedValue(bannedMember);

    const result = await communityService.bulkDeleteCommunities(NON_ADMIN, [
      CID,
    ]);

    expect(result.results).toEqual([{ communityId: CID, status: "REMOVED" }]);
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
    expect(pubRoomEvent).not.toHaveBeenCalled();
    expect(pubMemberLeft).not.toHaveBeenCalled();
  });

  it("pending member: skipped without error", async () => {
    repo.findMemberByUserId.mockResolvedValue({
      ...activeMemberNonAdmin,
      status: "PENDING",
    });

    const result = await communityService.bulkDeleteCommunities(NON_ADMIN, [
      CID,
    ]);

    expect(result.results).toEqual([{ communityId: CID, status: "SKIPPED" }]);
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  });

  it("already-left / no membership: skipped gracefully", async () => {
    repo.findMemberByUserId.mockResolvedValue(null);

    const result = await communityService.bulkDeleteCommunities(NON_ADMIN, [
      CID,
    ]);

    expect(result.results).toEqual([{ communityId: CID, status: "SKIPPED" }]);
  });

  it("unknown community id: fails with NOT_FOUND", async () => {
    repo.findCommunitiesByIds.mockResolvedValue([{ id: CID }]);
    repo.findMemberByUserId.mockResolvedValue(activeMemberNonAdmin);

    const missingId = "e".repeat(24);
    const result = await communityService.bulkDeleteCommunities(NON_ADMIN, [
      missingId,
    ]);

    expect(result.results).toEqual([
      { communityId: missingId, status: "FAILED", errorCode: "NOT_FOUND" },
    ]);
  });

  it("processes multiple ids independently — partial success", async () => {
    repo.findMemberByUserId.mockImplementation((communityId: string) =>
      Promise.resolve(
        communityId === CID ? activeMemberNonAdmin : adminMembership
      )
    );

    const result = await communityService.bulkDeleteCommunities(NON_ADMIN, [
      CID,
      CID2,
    ]);

    expect(result.summary).toEqual({ requested: 2, removed: 1, failed: 1 });
    expect(result.results).toEqual(
      expect.arrayContaining([
        { communityId: CID, status: "REMOVED" },
        {
          communityId: CID2,
          status: "FAILED",
          errorCode: "OWNER_CANNOT_DELETE",
        },
      ])
    );
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

  it("posts a MEMBER_UNBANNED chat system message (visible moderation — Telegram parity)", async () => {
    await communityService.unbanMember(CID, ADMIN, TARGET);

    // MEMBER_UNBANNED is NOT in HIDDEN_SYSTEM_MESSAGE_TYPES — lifting a ban is
    // shown in the chat timeline to all members (Telegram parity).
    const postedTypes = pubSysMsg.mock.calls.map(
      ([arg]) => (arg as { systemMessageType?: string }).systemMessageType
    );
    expect(postedTypes).toContain("MEMBER_UNBANNED");
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

  it("emits community:added to the new member's user channel with full community data", async () => {
    await communityService.approveJoinRequest(CID, MOD, RID);

    // Personal onboarding event — the new member is not yet in the community
    // room, so this user-channel emit is what makes the community appear in
    // their list WITHOUT a refresh or GET /communities/mine round-trip.
    const addedCall = pubUserEvent.mock.calls.find(
      ([, , evt]) => evt === "community:added"
    );
    expect(addedCall).toBeDefined();
    const [, userId, , payload] = addedCall!;
    expect(userId).toBe(TARGET);
    expect(payload).toMatchObject({
      communityId: CID,
      name: "Test Community",
      handle: "test-community",
      memberCount: 11,
      role: "MEMBER",
      status: "ACTIVE",
      via: "join_request_approved",
    });
    expect(typeof payload.joinedAt).toBe("number");
    expect(typeof payload.addedAt).toBe("number");
  });
});
