/**
 * Suite: community-create-onboards-members
 *
 * Regression for the production bug "User B / User C added during community
 * creation don't see the community in their list without a hard reload".
 *
 * Root cause: communityService.create() historically emitted `community:added`
 * ONLY to the creator — members added at creation time (via createManyMembers)
 * got a DB row but NO realtime onboarding (no socket event, no cross-service
 * notification). This suite proves the fix: create() now fans out the SAME
 * onboarding as POST /:id/members to EVERY initial member:
 *   1. a personal `community:added` to each added member's user:<id> channel,
 *   2. the cross-service `community.member_added` notification for each,
 * while still emitting the creator's own `community:added` (via: "created").
 */

// ---------------------------------------------------------------------------
// Mock overrides — hoisted before any import.
// ---------------------------------------------------------------------------

jest.mock("@aimess/redis", () => ({
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/messaging/publish-community-chat.js", () => ({
  publishCommunityCreatedForChatSafe: jest.fn(),
  publishCommunitySystemMessageForChatSafe: jest.fn(),
  publishCommunityMemberSyncedForChatSafe: jest.fn(),
  publishCommunityStatusChangedForChatSafe: jest.fn(),
  publishCommunityInviteLinkSharedForChatSafe: jest.fn(),
  publishCommunityDeletedForChatSafe: jest.fn(),
  publishCommunityVisibilityChangedForChatSafe: jest.fn(),
}));

jest.mock("../../src/messaging/publish-community.js", () => ({
  publishCommunityMemberAddedSafe: jest.fn(),
  publishCommunityMemberKickedSafe: jest.fn(),
  publishCommunityMemberBannedSafe: jest.fn(),
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
  publishCommunityMemberJoinedSafe: jest.fn(),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findActiveCategoryById: jest.fn(),
    createCommunity: jest.fn(),
    createMember: jest.fn(),
    createManyMembers: jest.fn(),
    setMemberCount: jest.fn(),
    findMembersByUserIds: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
    updateLastActivity: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

jest.mock("../../src/lib/community-cache.js", () => ({
  communityCache: {
    invalidateNameAvailability: jest.fn(async () => undefined),
    invalidateHandleAvailability: jest.fn(async () => undefined),
  },
}));

jest.mock("../../src/lib/user-client.js", () => ({
  fetchAcceptedFriendIds: jest.fn(),
  fetchUserSnapshots: jest.fn(),
  fetchUserSnapshotHits: jest.fn(async () => new Map()),
  fetchExistingUserIds: jest.fn(async () => new Set()),
}));

jest.mock("../../src/grpc/chat.client.js", () => ({
  getChatClient: jest.fn(() => ({
    ensureCommunityRoom: jest.fn(async () => undefined),
    getCommunityChatSummaries: jest.fn(async () => []),
    bulkMarkCommunityRead: jest.fn(async () => 0),
  })),
}));

jest.mock("../../src/services/community-image.service.js", () => ({
  communityImageService: {
    resolveObjectKeyForCommunity: jest.fn(async () => null),
    resolveViewUrlForClient: jest.fn(async () => null),
  },
}));

jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn(async () => null),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after all jest.mock declarations)
// ---------------------------------------------------------------------------

import { publishChatUserEvent } from "@aimess/redis";
import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { publishCommunityMemberAddedSafe } from "../../src/messaging/publish-community.js";
import {
  fetchAcceptedFriendIds,
  fetchUserSnapshots,
} from "../../src/lib/user-client.js";

// ---------------------------------------------------------------------------
// Typed aliases
// ---------------------------------------------------------------------------

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubChatUser = publishChatUserEvent as jest.Mock;
const pubMemberAdded = publishCommunityMemberAddedSafe as jest.Mock;
const friendIds = fetchAcceptedFriendIds as jest.Mock;
const snapshots = fetchUserSnapshots as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREATOR = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const USER_C = "33333333-3333-4333-8333-333333333333";
const CID = "c".repeat(24);
const NOW = new Date("2026-06-25T10:15:30.000Z");

const dbCommunity = {
  id: CID,
  name: "Tech Enthusiasts",
  handle: "tech-enthusiasts",
  description: "A community for tech lovers",
  type: "PUBLIC",
  categoryId: "cat001",
  categoryName: "Technology",
  category: { id: "cat001", name: "Technology" },
  creatorId: CREATOR,
  adminId: CREATOR,
  memberCount: 1,
  avatarUrl: null,
  coverUrl: null,
  moderationStatus: "ACTIVE",
  isLive: false,
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const memberRow = (userId: string) => ({
  userId,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: NOW,
  snapshotUsername: `user_${userId.slice(0, 4)}`,
  snapshotDisplayName: `User ${userId.slice(0, 4)}`,
  snapshotAvatarKey: null,
});

const inputWithMembers = {
  name: "Tech Enthusiasts",
  handle: "tech-enthusiasts",
  description: "A community for tech lovers",
  type: "PUBLIC" as const,
  categoryId: "cat001",
  memberIds: [USER_B, USER_C],
  avatarObjectKey: null,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  repo.findActiveCategoryById.mockResolvedValue({
    id: "cat001",
    name: "Technology",
  });
  repo.createCommunity.mockResolvedValue(dbCommunity);
  repo.createMember.mockResolvedValue(undefined);
  repo.createManyMembers.mockResolvedValue({ count: 2 });
  repo.setMemberCount.mockResolvedValue(undefined);
  repo.findMembersByUserIds.mockResolvedValue([
    memberRow(USER_B),
    memberRow(USER_C),
  ]);
  repo.findActiveMemberIdsByRoles.mockResolvedValue([CREATOR]);
  repo.createAuditLog.mockResolvedValue(undefined);

  // Both invited users are accepted friends → both are added.
  friendIds.mockResolvedValue(new Set([USER_B, USER_C]));
  snapshots.mockImplementation(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            username: `user_${id.slice(0, 4)}`,
            displayName: `User ${id.slice(0, 4)}`,
            avatarObjectKey: null,
          },
        ])
      )
  );
});

const addedCalls = () =>
  pubChatUser.mock.calls.filter(([, , evt]) => evt === "community:added");

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("communityService.create — onboards members added at creation", () => {
  it("emits community:added to the creator AND every added member (3 total)", async () => {
    await communityService.create(CREATOR, inputWithMembers);

    const recipients = addedCalls().map(([, userId]) => userId);
    expect(recipients).toHaveLength(3);
    expect(new Set(recipients)).toEqual(new Set([CREATOR, USER_B, USER_C]));
  });

  it("the creator's community:added carries via='created'", async () => {
    await communityService.create(CREATOR, inputWithMembers);

    const creatorCall = addedCalls().find(([, userId]) => userId === CREATOR);
    expect((creatorCall![3] as Record<string, unknown>).via).toBe("created");
  });

  it("each added member's community:added carries via='add_members' + role MEMBER", async () => {
    await communityService.create(CREATOR, inputWithMembers);

    for (const member of [USER_B, USER_C]) {
      const call = addedCalls().find(([, userId]) => userId === member);
      expect(call).toBeDefined();
      const payload = call![3] as Record<string, unknown>;
      expect(payload.via).toBe("add_members");
      expect(payload.role).toBe("MEMBER");
      expect(payload.communityId).toBe(CID);
      // Reflects the real roster (creator + B + C).
      expect(payload.memberCount).toBe(3);
    }
  });

  it("every community:added payload carries an eventId + occurredAt for dedup/ordering", async () => {
    await communityService.create(CREATOR, inputWithMembers);

    for (const call of addedCalls()) {
      const payload = call[3] as Record<string, unknown>;
      expect(typeof payload.eventId).toBe("string");
      expect((payload.eventId as string).length).toBeGreaterThan(0);
      expect(typeof payload.occurredAt).toBe("number");
      expect(typeof payload.addedAt).toBe("number");
    }
  });

  it("publishes the cross-service community.member_added notification for each added member", async () => {
    await communityService.create(CREATOR, inputWithMembers);

    const targets = pubMemberAdded.mock.calls.map(
      ([data]) => (data as { targetUserId: string }).targetUserId
    );
    expect(new Set(targets)).toEqual(new Set([USER_B, USER_C]));
  });

  it("a member-onboarding socket failure does NOT fail the create (fire-and-forget)", async () => {
    // Creator emit succeeds; member emits reject — create must still resolve.
    pubChatUser.mockImplementation(async (_redis, userId: string) => {
      if (userId !== CREATOR) throw new Error("Redis unavailable");
      return 1;
    });

    await expect(
      communityService.create(CREATOR, inputWithMembers)
    ).resolves.toMatchObject({ id: CID, role: "ADMIN" });
  });

  it("does not double-onboard when no members are added (creator only)", async () => {
    await communityService.create(CREATOR, {
      ...inputWithMembers,
      memberIds: [],
    });

    expect(addedCalls()).toHaveLength(1);
    expect(addedCalls()[0]![1]).toBe(CREATOR);
    expect(pubMemberAdded).not.toHaveBeenCalled();
  });
});
