/**
 * Service-layer tests for `communityService.joinCommunity()`.
 *
 * Covers the overhauled join flow:
 *   - PUBLIC community → instant ACTIVE membership (self_join)
 *   - PRIVATE community → PENDING join request (join_requested event)
 *   - Idempotent re-joins (ALREADY_MEMBER)
 *   - Error guards (banned, suspended, not-found)
 *
 * Pattern follows apps/community-service/tests/join-requests/join-request-notifications.test.ts:
 * the real communityService runs; only the I/O boundary is mocked (repository,
 * RabbitMQ publishers, @aimess/redis room broadcaster, avatar resolver,
 * user-client snapshot fetcher).
 */

// ---------------------------------------------------------------------------
// Mock overrides — must appear BEFORE any import (Jest hoists jest.mock calls).
// These extend / replace the global-mocks.ts stubs set by setupFilesAfterEnv.
// ---------------------------------------------------------------------------

jest.mock("../../src/lib/user-client.js", () => ({
  fetchUserSnapshots: jest.fn(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            userId: id,
            username: id,
            displayName: "Mock User",
            avatarObjectKey: null,
          },
        ])
      )
  ),
  fetchAcceptedFriendIds: jest.fn(async () => new Set<string>()),
}));

jest.mock("@aimess/storage", () => ({
  MEDIA_PREFIXES: { community: [], userAvatars: [] },
  toMediaObject: jest.fn(async () => ({
    url: null,
    downloadUrl: null,
    objectKey: null,
    expiresAt: null,
  })),
}));

// Full publisher bag — includes the new publishCommunityMemberJoinedSafe.
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

jest.mock("@aimess/redis", () => ({
  // Spread the real module first: a factory that returns only the stubs
  // replaces EVERY other export with undefined, and `createBannedUserGuard`
  // is called at import time by `authenticate-access-token.ts` - so every
  // suite that touches `app.ts` died on "is not a function" before it ran.
  ...jest.requireActual("@aimess/redis"),
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMemberByUserId: jest.fn(),
    findMembersByUserIds: jest.fn(),
    createMember: jest.fn(),
    reactivateMemberWithSnapshot: jest.fn(),
    countActiveMembers: jest.fn(),
    setMemberCount: jest.fn(),
    updateLastActivity: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
    createAuditLog: jest.fn(),
    findJoinRequestByCommunityAndUser: jest.fn(),
    createJoinRequest: jest.fn(),
    recyclePendingJoinRequest: jest.fn(),
    // join-request read helpers used by approve/reject (no-op here but required
    // so the mock shape doesn't throw when other service methods are exercised)
    findJoinRequestById: jest.fn(),
    findJoinRequestsByIds: jest.fn(),
    updateJoinRequest: jest.fn(),
    bulkUpdateJoinRequestStatus: jest.fn(),
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
import {
  publishCommunityMemberAddedSafe,
  publishCommunityMemberJoinedSafe,
  publishCommunityJoinRequestedSafe,
} from "../../src/messaging/publish-community.js";
import { publishCommunitySystemMessageForChatSafe } from "../../src/messaging/publish-community-chat.js";

// ---------------------------------------------------------------------------
// Typed aliases
// ---------------------------------------------------------------------------

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubMemberAdded = publishCommunityMemberAddedSafe as jest.Mock;
const pubMemberJoined = publishCommunityMemberJoinedSafe as jest.Mock;
const pubJoinRequested = publishCommunityJoinRequestedSafe as jest.Mock;
const pubRoomEvent = publishCommunityRoomEvent as jest.Mock;
const pubSystemMessage = publishCommunitySystemMessageForChatSafe as jest.Mock;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CID = "c".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";
const MOD = "11111111-1111-4111-8111-111111111111";
const REQ_ID = "r".repeat(24);

const publicCommunity = {
  id: CID,
  name: "Cool Community",
  handle: "cool-community",
  avatarUrl: null,
  type: "PUBLIC",
  adminId: MOD,
  memberCount: 5,
  moderationStatus: "ACTIVE",
};

const privateCommunity = {
  ...publicCommunity,
  type: "PRIVATE",
};

const freshMemberRow = {
  userId: CALLER,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-06-17T00:00:00.000Z"),
  snapshotUsername: CALLER,
  snapshotDisplayName: "Mock User",
  snapshotAvatarKey: null,
};

const pendingJoinRequest = {
  id: REQ_ID,
  communityId: CID,
  userId: CALLER,
  status: "PENDING",
  message: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date("2026-06-17T00:00:00.000Z"),
  updatedAt: new Date("2026-06-17T00:00:00.000Z"),
};

// ---------------------------------------------------------------------------
// GROUP 1: PUBLIC community — instant ACTIVE membership
// ---------------------------------------------------------------------------

describe("joinCommunity — PUBLIC community", () => {
  beforeEach(() => {
    // Default happy-path: fresh join (no prior membership row).
    repo.findById.mockResolvedValue(publicCommunity);
    repo.findMemberByUserId.mockResolvedValue(null);
    repo.createMember.mockResolvedValue(freshMemberRow);
    repo.countActiveMembers.mockResolvedValue(6);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.updateLastActivity.mockResolvedValue(undefined);
    repo.findActiveMemberIdsByRoles.mockResolvedValue([MOD]);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("1.1 fresh join — creates ACTIVE member and returns JOINED", async () => {
    const result = await communityService.joinCommunity(CID, CALLER);

    expect(result.status).toBe("JOINED");
    expect(result.membershipStatus).toBe("ACTIVE");
    expect(repo.createMember).toHaveBeenCalledTimes(1);
    expect(repo.createMember).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: CID,
        userId: CALLER,
        status: "ACTIVE",
      })
    );
  });

  it("1.1 fresh join — calls notifyMemberJoined with via=self_join", async () => {
    await communityService.joinCommunity(CID, CALLER);

    // notifyMemberJoined routes through publishCommunityMemberAddedSafe with via=self_join.
    expect(pubMemberAdded).toHaveBeenCalledTimes(1);
    const added = pubMemberAdded.mock.calls[0][0];
    expect(added).toMatchObject({
      communityId: CID,
      actorId: CALLER,
      targetUserId: CALLER,
      via: "self_join",
    });
  });

  it("1.1 fresh join — publishes MEMBER_JOINED with reactivated=false", async () => {
    await communityService.joinCommunity(CID, CALLER);

    expect(pubMemberJoined).toHaveBeenCalledTimes(1);
    const joined = pubMemberJoined.mock.calls[0][0];
    expect(joined).toMatchObject({
      communityId: CID,
      userId: CALLER,
      communityName: "Cool Community",
      reactivated: false,
    });
    expect(typeof joined.eventAt).toBe("string");
  });

  it("1.1 fresh join — broadcasts community:member:joined into the community room", async () => {
    await communityService.joinCommunity(CID, CALLER);

    // notifyMemberJoined emits community:member:joined + community:stats:updated
    expect(pubRoomEvent).toHaveBeenCalledTimes(2);
    const joinedCall = pubRoomEvent.mock.calls.find(
      ([, , evt]) => evt === "community:member:joined"
    );
    expect(joinedCall).toBeDefined();
    const [, roomCommunityId, , dto] = joinedCall!;
    expect(roomCommunityId).toBe(CID);
    expect(dto).toMatchObject({ userId: CALLER, role: "MEMBER" });
  });

  it("1.1 fresh join — emits ONLY the PERSONAL COMMUNITY_JOINED to the joiner (no community-wide join line)", async () => {
    await communityService.joinCommunity(CID, CALLER);

    const types = pubSystemMessage.mock.calls.map(
      (c) => c[0].systemMessageType
    );
    // Only the personal line — no community-wide MEMBER_JOINED announcement.
    expect(types).toContain("COMMUNITY_JOINED");
    expect(types).not.toContain("MEMBER_JOINED");

    // Personal "You joined" line — targeted at the joiner.
    const personal = pubSystemMessage.mock.calls.find(
      (c) => c[0].systemMessageType === "COMMUNITY_JOINED"
    )![0];
    expect(personal).toMatchObject({
      communityId: CID,
      triggeredByUserId: CALLER,
      visibleToUserId: CALLER,
    });
  });

  it("1.2 reactivation (LEFT → ACTIVE) — calls reactivateMemberWithSnapshot", async () => {
    const leftMember = { ...freshMemberRow, status: "LEFT" };
    repo.findMemberByUserId.mockResolvedValue(leftMember);
    repo.reactivateMemberWithSnapshot.mockResolvedValue(freshMemberRow);

    const result = await communityService.joinCommunity(CID, CALLER);

    expect(result.status).toBe("JOINED");
    expect(repo.reactivateMemberWithSnapshot).toHaveBeenCalledTimes(1);
    expect(repo.createMember).not.toHaveBeenCalled();
  });

  it("1.2 reactivation — publishes MEMBER_JOINED with reactivated=true", async () => {
    const leftMember = { ...freshMemberRow, status: "LEFT" };
    repo.findMemberByUserId.mockResolvedValue(leftMember);
    repo.reactivateMemberWithSnapshot.mockResolvedValue(freshMemberRow);

    await communityService.joinCommunity(CID, CALLER);

    expect(pubMemberJoined).toHaveBeenCalledTimes(1);
    expect(pubMemberJoined.mock.calls[0][0]).toMatchObject({
      communityId: CID,
      userId: CALLER,
      reactivated: true,
    });
  });

  it("1.3 idempotent (already ACTIVE) — returns ALREADY_MEMBER with zero DB writes", async () => {
    const activeMember = { ...freshMemberRow, status: "ACTIVE" };
    repo.findMemberByUserId.mockResolvedValue(activeMember);

    const result = await communityService.joinCommunity(CID, CALLER);

    expect(result.status).toBe("ALREADY_MEMBER");
    expect(result.membershipStatus).toBe("ACTIVE");
    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
    expect(pubMemberJoined).not.toHaveBeenCalled();
    expect(pubMemberAdded).not.toHaveBeenCalled();
    expect(pubRoomEvent).not.toHaveBeenCalled();
  });

  it("1.4 banned user — throws ForbiddenError with COMMUNITY_JOIN_BANNED", async () => {
    const bannedMember = { ...freshMemberRow, status: "BANNED" };
    repo.findMemberByUserId.mockResolvedValue(bannedMember);

    await expect(
      communityService.joinCommunity(CID, CALLER)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_BANNED" });
  });

  it("1.5 community suspended — throws ForbiddenError with COMMUNITY_SUSPENDED", async () => {
    repo.findById.mockResolvedValue({
      ...publicCommunity,
      moderationStatus: "SUSPENDED",
    });

    await expect(
      communityService.joinCommunity(CID, CALLER)
    ).rejects.toMatchObject({ message: "COMMUNITY_SUSPENDED" });
  });

  it("1.6 community not found — throws NotFoundError with COMMUNITY_NOT_FOUND", async () => {
    repo.findById.mockResolvedValue(null);

    await expect(
      communityService.joinCommunity(CID, CALLER)
    ).rejects.toMatchObject({ message: "COMMUNITY_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// GROUP 2: PRIVATE community — PENDING join request
// ---------------------------------------------------------------------------

describe("joinCommunity — PRIVATE community", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(privateCommunity);
    repo.findMemberByUserId.mockResolvedValue(null);
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue(null);
    repo.createJoinRequest.mockResolvedValue(pendingJoinRequest);
    repo.findActiveMemberIdsByRoles.mockResolvedValue([MOD]);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("2.1 no prior request — creates join request and returns REQUEST_CREATED", async () => {
    const result = await communityService.joinCommunity(CID, CALLER);

    expect(result.status).toBe("REQUEST_CREATED");
    expect(result.membershipStatus).toBe("PENDING");
    expect(repo.createJoinRequest).toHaveBeenCalledTimes(1);
    expect(repo.createJoinRequest).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: CID, userId: CALLER })
    );
  });

  it("2.1 no prior request — publishes JOIN_REQUESTED event", async () => {
    await communityService.joinCommunity(CID, CALLER);

    expect(pubJoinRequested).toHaveBeenCalledTimes(1);
    const payload = pubJoinRequested.mock.calls[0][0];
    expect(payload).toMatchObject({
      communityId: CID,
      userId: CALLER,
      requestId: REQ_ID,
      communityName: "Cool Community",
      moderatorRecipientIds: [MOD],
    });
    expect(typeof payload.eventAt).toBe("string");
  });

  it("2.1 no prior request — does NOT create any membership row", async () => {
    await communityService.joinCommunity(CID, CALLER);

    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
  });

  it("2.2 idempotent PENDING — does NOT call createJoinRequest or publish event", async () => {
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue(
      pendingJoinRequest
    );

    const result = await communityService.joinCommunity(CID, CALLER);

    expect(result.status).toBe("REQUEST_CREATED");
    expect(repo.createJoinRequest).not.toHaveBeenCalled();
    expect(pubJoinRequested).not.toHaveBeenCalled();
  });

  it("2.3 recycle REJECTED — calls recyclePendingJoinRequest and publishes event", async () => {
    const rejectedRequest = {
      ...pendingJoinRequest,
      status: "REJECTED",
      decidedBy: MOD,
      decidedAt: new Date(),
    };
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue(rejectedRequest);
    repo.recyclePendingJoinRequest.mockResolvedValue(pendingJoinRequest);

    const result = await communityService.joinCommunity(CID, CALLER);

    expect(result.status).toBe("REQUEST_CREATED");
    expect(repo.recyclePendingJoinRequest).toHaveBeenCalledTimes(1);
    expect(repo.createJoinRequest).not.toHaveBeenCalled();
    expect(pubJoinRequested).toHaveBeenCalledTimes(1);
  });

  it("2.4 already ACTIVE member in PRIVATE community — returns ALREADY_MEMBER", async () => {
    const activeMember = { ...freshMemberRow, status: "ACTIVE" };
    repo.findMemberByUserId.mockResolvedValue(activeMember);

    const result = await communityService.joinCommunity(CID, CALLER);

    expect(result.status).toBe("ALREADY_MEMBER");
    expect(result.membershipStatus).toBe("ACTIVE");
    expect(repo.createJoinRequest).not.toHaveBeenCalled();
    expect(pubJoinRequested).not.toHaveBeenCalled();
  });

  it("2.4 banned user in PRIVATE community — throws ForbiddenError with COMMUNITY_JOIN_BANNED", async () => {
    const bannedMember = { ...freshMemberRow, status: "BANNED" };
    repo.findMemberByUserId.mockResolvedValue(bannedMember);

    await expect(
      communityService.joinCommunity(CID, CALLER)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_BANNED" });
  });
});
