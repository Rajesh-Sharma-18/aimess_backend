/**
 * Member removal / ban — silent-chat regression tests.
 *
 * Product rule: when an admin or moderator removes (kicks) or bans a member,
 * NO chat system message must be created or surface on any API. The removal is
 * silent from the chat-message perspective. Non-chat side-effects (audit log,
 * roster broadcast, personal socket event, push notification RabbitMQ event)
 * must all still fire correctly.
 *
 * Key invariants verified:
 *  1. publishCommunitySystemMessageForChatSafe is NEVER called for MEMBER_REMOVED
 *     or MEMBER_BANNED.
 *  2. publishChatUserEvent is called with "community:membership:removed" on the
 *     removed/banned user's personal channel (multi-device delivery).
 *  3. publishCommunityRoomEvent is called with "community:member:removed" (roster
 *     update + gateway eviction for devices currently in the room).
 *  4. publishCommunityMemberKickedSafe / publishCommunityMemberBannedSafe are
 *     called (RabbitMQ events driving push notifications via notifications-service).
 *  5. idempotent ban: already-banned member → no writes, no events.
 */

import { communityService } from "../src/services/community.service.js";
import { publishCommunitySystemMessageForChatSafe } from "../src/messaging/publish-community-chat.js";
import {
  publishCommunityMemberKickedSafe,
  publishCommunityMemberBannedSafe,
} from "../src/messaging/publish-community.js";
import { publishCommunityRoomEvent, publishChatUserEvent } from "@aimess/redis";
import { communityRepository } from "../src/repositories/community.repository.js";

// Cast mock references so we can call .mockResolvedValue() etc.

const repo = communityRepository as Record<string, jest.Mock>;
const publishSystemMsg = publishCommunitySystemMessageForChatSafe as jest.Mock;
const publishRoomEvent = publishCommunityRoomEvent as jest.Mock;
const publishUserEvent = publishChatUserEvent as jest.Mock;
const publishKicked = publishCommunityMemberKickedSafe as jest.Mock;
const publishBanned = publishCommunityMemberBannedSafe as jest.Mock;

const COMMUNITY_ID = "comm-test-1";
const CALLER_ID = "admin-user-1";
const TARGET_ID = "member-user-2";

const mockCommunity = {
  id: COMMUNITY_ID,
  name: "Test Community",
  handle: "test-community",
  description: null,
  type: "PUBLIC",
  status: "ACTIVE",
  moderationStatus: "ACTIVE",
  adminId: CALLER_ID,
  memberCount: 10,
  deletedAt: null,
  category: { id: "cat-1", name: "General" },
};

// Caller has ADMIN role (can kick/ban anyone except other admins)
const mockCallerMembership = {
  userId: CALLER_ID,
  communityId: COMMUNITY_ID,
  role: "ADMIN",
  status: "ACTIVE",
  joinedAt: new Date(),
  snapshotUsername: "admin",
  snapshotDisplayName: "Admin User",
  snapshotAvatarKey: null,
};

const mockTargetMember = {
  userId: TARGET_ID,
  communityId: COMMUNITY_ID,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date(),
  snapshotUsername: "targetuser",
  snapshotDisplayName: "Target User",
  snapshotAvatarKey: null,
};

function setupKickMocks(): void {
  repo.findById.mockResolvedValue(mockCommunity);
  repo.findMembership.mockResolvedValue(mockCallerMembership);
  repo.findMemberByUserId.mockResolvedValue(mockTargetMember);
  repo.updateMemberStatus.mockResolvedValue({
    ...mockTargetMember,
    status: "LEFT",
  });
  repo.countActiveMembers.mockResolvedValue(9);
  repo.setMemberCount.mockResolvedValue(undefined);
  repo.createAuditLog.mockResolvedValue(undefined);
}

function setupBanMocks(): void {
  repo.findById.mockResolvedValue(mockCommunity);
  repo.findMembership.mockResolvedValue(mockCallerMembership);
  repo.findMemberByUserId.mockResolvedValue(mockTargetMember);
  repo.updateMemberStatus.mockResolvedValue({
    ...mockTargetMember,
    status: "BANNED",
  });
  repo.countActiveMembers.mockResolvedValue(9);
  repo.setMemberCount.mockResolvedValue(undefined);
  repo.createAuditLog.mockResolvedValue(undefined);
}

// ─── kickMember ──────────────────────────────────────────────────────────────

describe("kickMember — silent-chat policy", () => {
  beforeEach(setupKickMocks);

  it("does NOT publish any MEMBER_REMOVED chat system message", async () => {
    await communityService.kickMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    const removalCalls = publishSystemMsg.mock.calls.filter(
      (call: any[]) => call[0]?.systemMessageType === "MEMBER_REMOVED"
    );
    expect(removalCalls).toHaveLength(0);
  });

  it("does NOT call publishCommunitySystemMessageForChatSafe at all during kick", async () => {
    await communityService.kickMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    expect(publishSystemMsg).not.toHaveBeenCalled();
  });

  it("publishes community:membership:removed (not :restricted) to the kicked user's personal channel — the community disappears from their list; they rejoin via the normal flow", async () => {
    await communityService.kickMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    expect(publishUserEvent).toHaveBeenCalledWith(
      expect.anything(), // redis instance
      TARGET_ID,
      "community:membership:removed",
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        membershipStatus: "REMOVED",
        reason: "kicked",
      })
    );
    expect(publishUserEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      TARGET_ID,
      "community:membership:restricted",
      expect.anything()
    );
  });

  it("marks the row LEFT with a removedAt/removedBy kick marker (status unchanged from a voluntary leave, so rejoin flows keep working)", async () => {
    await communityService.kickMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      COMMUNITY_ID,
      TARGET_ID,
      "LEFT",
      undefined,
      undefined,
      expect.objectContaining({ removedBy: CALLER_ID })
    );
  });

  it("publishes community:member:removed to the room (roster update + eviction)", async () => {
    await communityService.kickMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    expect(publishRoomEvent).toHaveBeenCalledWith(
      expect.anything(),
      COMMUNITY_ID,
      "community:member:removed",
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        userId: TARGET_ID,
        reason: "kicked",
      })
    );
  });

  it("fires the MEMBER_KICKED RabbitMQ domain event (drives push notification)", async () => {
    await communityService.kickMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    expect(publishKicked).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        targetUserId: TARGET_ID,
        actorId: CALLER_ID,
      })
    );
  });
});

// ─── banMember ───────────────────────────────────────────────────────────────

describe("banMember — silent-chat policy", () => {
  beforeEach(setupBanMocks);

  it("publishes a PERSONAL MEMBER_BANNED chat system message visible only to the banned user (Telegram parity)", async () => {
    await communityService.banMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    const banCalls = publishSystemMsg.mock.calls.filter(
      (call: any[]) => call[0]?.systemMessageType === "MEMBER_BANNED"
    );
    expect(banCalls).toHaveLength(1);
    expect(banCalls[0][0]).toMatchObject({
      communityId: COMMUNITY_ID,
      systemMessageType: "MEMBER_BANNED",
      triggeredByUserId: CALLER_ID,
      visibleToUserId: TARGET_ID,
    });
  });

  it("publishes community:membership:restricted (not :removed) to the banned user's personal channel — the community stays in their list, fully blocked (USER_BANNED)", async () => {
    await communityService.banMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    expect(publishUserEvent).toHaveBeenCalledWith(
      expect.anything(),
      TARGET_ID,
      "community:membership:restricted",
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        membershipStatus: "BANNED",
        isBanned: true,
        reason: "banned",
      })
    );
    expect(publishUserEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      TARGET_ID,
      "community:membership:removed",
      expect.anything()
    );
  });

  it("fires the MEMBER_BANNED RabbitMQ domain event (drives push notification)", async () => {
    await communityService.banMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    expect(publishBanned).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        targetUserId: TARGET_ID,
        actorId: CALLER_ID,
      })
    );
  });

  it("idempotent: already-banned member is returned as-is with no writes or events", async () => {
    // Override: target is already BANNED
    repo.findMemberByUserId.mockResolvedValue({
      ...mockTargetMember,
      status: "BANNED",
    });

    await communityService.banMember(COMMUNITY_ID, CALLER_ID, TARGET_ID);

    expect(publishSystemMsg).not.toHaveBeenCalled();
    expect(publishBanned).not.toHaveBeenCalled();
    expect(publishUserEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      TARGET_ID,
      "community:membership:removed",
      expect.anything()
    );
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  });
});

// ─── Policy constants ─────────────────────────────────────────────────────────

describe("HIDDEN_SYSTEM_MESSAGE_TYPES policy contract", () => {
  it("MEMBER_REMOVED is hidden — removal is silent in chat", async () => {
    const { isHiddenSystemMessage } = await import("@aimess/constants");
    expect(isHiddenSystemMessage("MEMBER_REMOVED")).toBe(true);
  });

  it("MEMBER_BANNED is NOT hidden — it is PERSONAL (visible only to the banned user), not community-hidden", async () => {
    const { isHiddenSystemMessage, isPersonalSystemMessage } =
      await import("@aimess/constants");
    expect(isHiddenSystemMessage("MEMBER_BANNED")).toBe(false);
    expect(isPersonalSystemMessage("MEMBER_BANNED")).toBe(true);
  });

  it("MEMBER_LEFT is hidden (voluntary leave is also silent)", async () => {
    const { isHiddenSystemMessage } = await import("@aimess/constants");
    expect(isHiddenSystemMessage("MEMBER_LEFT")).toBe(true);
  });

  it("ROLE_CHANGED is NOT hidden — admin transfers remain visible in chat", async () => {
    const { isHiddenSystemMessage } = await import("@aimess/constants");
    expect(isHiddenSystemMessage("ROLE_CHANGED")).toBe(false);
  });

  it("MEMBER_REMOVED does NOT bump lastActivity — can never become list preview", async () => {
    const { isEligibleForLastActivity } = await import("@aimess/constants");
    expect(isEligibleForLastActivity("MEMBER_REMOVED")).toBe(false);
  });

  it("MEMBER_BANNED does NOT bump lastActivity", async () => {
    const { isEligibleForLastActivity } = await import("@aimess/constants");
    expect(isEligibleForLastActivity("MEMBER_BANNED")).toBe(false);
  });
});
