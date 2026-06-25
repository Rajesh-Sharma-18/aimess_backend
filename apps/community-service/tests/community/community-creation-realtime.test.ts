/**
 * Suite: community-creation-realtime
 *
 * Verifies that communityService.create() fires a `community:added` socket
 * event (with via: "created") to the creator's /chat room immediately after
 * the community is saved, so the creator's list updates without a page reload.
 *
 * This is the same event as join/add flows — the FE has one unified insert
 * path and branches on `via === "created"` for any creation-specific UI.
 *
 * Assertion target: publishChatUserEvent from @aimess/redis
 *   channel:  user:<creatorId>
 *   event:    "community:added"
 *   payload:  CommunityAddedPayload (via: "created", role: "ADMIN",
 *             lastActivity.type: "created")
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
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findActiveCategoryById: jest.fn(),
    createCommunity: jest.fn(),
    createMember: jest.fn(),
    createManyMembers: jest.fn(),
    setMemberCount: jest.fn(),
    updateLastActivity: jest.fn(),
    createAuditLog: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
  },
}));

jest.mock("../../src/lib/community-cache.js", () => ({
  communityCache: {
    invalidateNameAvailability: jest.fn(async () => undefined),
    invalidateHandleAvailability: jest.fn(async () => undefined),
  },
}));

jest.mock("../../src/lib/user-client.js", () => ({
  fetchAcceptedFriendIds: jest.fn(async () => new Set()),
  fetchUserSnapshots: jest.fn(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            username: "creator_user",
            displayName: "Creator",
            avatarObjectKey: null,
          },
        ])
      )
  ),
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

// ---------------------------------------------------------------------------
// Imports (after all jest.mock declarations)
// ---------------------------------------------------------------------------

import { publishChatUserEvent, publishCommunityRoomEvent } from "@aimess/redis";
import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

// ---------------------------------------------------------------------------
// Typed aliases
// ---------------------------------------------------------------------------

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubChatUser = publishChatUserEvent as jest.Mock;
const pubRoomEvent = publishCommunityRoomEvent as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREATOR = "11111111-1111-4111-8111-111111111111";
const CID = "c".repeat(24);
const NOW = new Date("2026-06-17T10:15:30.000Z");

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

const validInput = {
  name: "Tech Enthusiasts",
  handle: "tech-enthusiasts",
  description: "A community for tech lovers",
  type: "PUBLIC" as const,
  categoryId: "cat001",
  memberIds: [],
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
  repo.setMemberCount.mockResolvedValue(undefined);
  repo.updateLastActivity.mockResolvedValue(undefined);
  repo.createAuditLog.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Suite — community:added (via: "created") socket event
// ---------------------------------------------------------------------------

describe("communityService.create — community:added socket event (via: created)", () => {
  it("publishes community:added to the creator's user channel", async () => {
    await communityService.create(CREATOR, validInput);

    const call = pubChatUser.mock.calls.find(
      ([, , evt]) => evt === "community:added"
    );
    expect(call).toBeDefined();
    expect(call![1]).toBe(CREATOR);
  });

  it("payload.via is 'created' (distinguishes creation from join/add flows)", async () => {
    await communityService.create(CREATOR, validInput);

    const call = pubChatUser.mock.calls.find(
      ([, , evt]) => evt === "community:added"
    );
    const payload = call![3] as Record<string, unknown>;
    expect(payload.via).toBe("created");
  });

  it("payload matches CommunityAddedPayload shape: communityId, name, role ADMIN", async () => {
    await communityService.create(CREATOR, validInput);

    const call = pubChatUser.mock.calls.find(
      ([, , evt]) => evt === "community:added"
    );
    const payload = call![3] as Record<string, unknown>;
    expect(payload.communityId).toBe(CID);
    expect(payload.name).toBe("Tech Enthusiasts");
    expect(payload.handle).toBe("tech-enthusiasts");
    expect(payload.role).toBe("ADMIN");
    expect(payload.memberCount).toBe(1);
    expect(payload.status).toBe("ACTIVE");
  });

  it("lastActivity.type is 'created' with correct preview", async () => {
    await communityService.create(CREATOR, validInput);

    const call = pubChatUser.mock.calls.find(
      ([, , evt]) => evt === "community:added"
    );
    const payload = call![3] as Record<string, unknown>;
    const lastActivity = payload.lastActivity as Record<string, unknown>;
    expect(lastActivity).toBeDefined();
    expect(lastActivity.type).toBe("created");
    expect(lastActivity.userId).toBeNull();
    expect(lastActivity.username).toBeNull();
    expect(lastActivity.preview).toBe("Community created");
    expect(typeof lastActivity.dateTime).toBe("number");
    expect(lastActivity.dateTime).toBe(NOW.getTime());
  });

  it("emits exactly once per create call", async () => {
    await communityService.create(CREATOR, validInput);

    const calls = pubChatUser.mock.calls.filter(
      ([, , evt]) => evt === "community:added"
    );
    expect(calls).toHaveLength(1);
  });

  it("does NOT emit on a different user's channel", async () => {
    await communityService.create(CREATOR, validInput);

    const wrongUserCall = pubChatUser.mock.calls.find(
      ([, userId, evt]) => evt === "community:added" && userId !== CREATOR
    );
    expect(wrongUserCall).toBeUndefined();
  });

  it("does NOT throw when Redis publish fails (fire-and-forget)", async () => {
    pubChatUser.mockRejectedValueOnce(new Error("Redis unavailable"));

    await expect(
      communityService.create(CREATOR, validInput)
    ).resolves.not.toThrow();
  });

  it("still returns CommunityData from HTTP response even when Redis publish fails", async () => {
    pubChatUser.mockRejectedValueOnce(new Error("Redis unavailable"));

    const result = await communityService.create(CREATOR, validInput);
    expect(result).toMatchObject({
      id: CID,
      name: "Tech Enthusiasts",
      role: "ADMIN",
    });
  });

  it("does NOT broadcast community:added to the community room (user-targeted only)", async () => {
    await communityService.create(CREATOR, validInput);

    const roomCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:added"
    );
    expect(roomCall).toBeUndefined();
  });

  it("does NOT emit community:created (deprecated event)", async () => {
    await communityService.create(CREATOR, validInput);

    const oldEvent = pubChatUser.mock.calls.find(
      ([, , evt]) => evt === "community:created"
    );
    expect(oldEvent).toBeUndefined();
  });
});
