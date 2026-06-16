/**
 * Service-layer regression for commit e21dede
 * (community join-request approve/reject notification fan-out + realtime).
 *
 * The HTTP-level join-requests.test.ts mocks the whole `communityService`, so it
 * can't see the publish side-effects. This suite exercises the REAL
 * `communityService` methods with only the I/O boundary mocked (repository,
 * RabbitMQ `*-Safe` publishers, `@aimess/redis` room broadcaster, avatar
 * resolver) and asserts the exact domain events the FE/notifications spine
 * depends on:
 *
 *   - rejectJoinRequest / bulkRejectJoinRequests  → community.join_request_rejected
 *     (the previously-SILENT path — the core regression this commit fixed).
 *   - approveJoinRequest / bulkApproveJoinRequests → community.join_request_approved
 *     AND member_added routed through notifyMemberJoined with the enriched payload
 *     (requestId + communityName + moderatorRecipientIds) and the
 *     `community:member:joined` room broadcast.
 *   - redeemInviteLink (autoApprove) → member_added via notifyMemberJoined
 *     (actor === target so the consumer still welcomes the joiner).
 */

// Re-mock the publishers as a COMPLETE bag (the global setup mock predates the
// two new fns) so we can assert on the approved/rejected publishers too.
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

// Mock the @aimess/redis room broadcaster — assert the community:member:joined
// roster broadcast goes through the ONE shared helper.
jest.mock("@aimess/redis", () => ({
  publishCommunityRoomEvent: jest.fn(async () => 1),
}));

// Mock the repository (the Prisma I/O boundary).
jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findJoinRequestById: jest.fn(),
    findJoinRequestsByIds: jest.fn(),
    updateJoinRequest: jest.fn(),
    bulkUpdateJoinRequestStatus: jest.fn(),
    findMemberByUserId: jest.fn(),
    findMembersByUserIds: jest.fn(),
    createMember: jest.fn(),
    reactivateMemberWithSnapshot: jest.fn(),
    countActiveMembers: jest.fn(),
    setMemberCount: jest.fn(),
    updateLastActivity: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
    createAuditLog: jest.fn(),
    findInviteLinkByCode: jest.fn(),
    findInviteLinkById: jest.fn(),
    incrementInviteLinkUsageIfUnder: jest.fn(),
  },
}));

// Avatar resolver used by notifyMemberJoined's roster DTO + toMemberData.
jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn(async () => ({ url: null, expiresIn: null })),
  },
}));

import { publishCommunityRoomEvent } from "@aimess/redis";

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import {
  publishCommunityJoinRequestApprovedSafe,
  publishCommunityJoinRequestRejectedSafe,
  publishCommunityMemberAddedSafe,
} from "../../src/messaging/publish-community.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubApproved = publishCommunityJoinRequestApprovedSafe as jest.Mock;
const pubRejected = publishCommunityJoinRequestRejectedSafe as jest.Mock;
const pubMemberAdded = publishCommunityMemberAddedSafe as jest.Mock;
const pubRoomEvent = publishCommunityRoomEvent as jest.Mock;

const CID = "c".repeat(24);
const RID = "r".repeat(24);
const MOD = "11111111-1111-4111-8111-111111111111"; // the approving moderator
const REQUESTER = "99999999-9999-4999-8999-999999999999"; // the join requester

const community = {
  id: CID,
  name: "Cool Community",
  type: "PUBLIC",
  adminId: MOD,
  memberCount: 5,
  moderationStatus: "ACTIVE",
};

const memberRow = {
  userId: REQUESTER,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-06-16T00:00:00.000Z"),
  snapshotUsername: "requester",
  snapshotDisplayName: "The Requester",
  snapshotAvatarKey: null,
};

const pendingRequest = {
  id: RID,
  communityId: CID,
  userId: REQUESTER,
  status: "PENDING",
  message: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date("2026-06-15T00:00:00.000Z"),
  updatedAt: new Date("2026-06-15T00:00:00.000Z"),
};

describe("approveJoinRequest — events + member fan-out", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findJoinRequestById.mockResolvedValue(pendingRequest);
    // findMemberByUserId: 1st (race re-read) → no member; 2nd (post-write) → member.
    repo.findMemberByUserId
      .mockResolvedValueOnce(null)
      .mockResolvedValue(memberRow);
    repo.createMember.mockResolvedValue(memberRow);
    repo.countActiveMembers.mockResolvedValue(6);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.updateLastActivity.mockResolvedValue(undefined);
    repo.updateJoinRequest.mockResolvedValue({
      ...pendingRequest,
      status: "APPROVED",
      decidedBy: MOD,
      decidedAt: new Date(),
    });
    repo.createAuditLog.mockResolvedValue(undefined);
    repo.findActiveMemberIdsByRoles.mockResolvedValue([MOD, "moderator-2"]);
  });

  it("publishes community.join_request_approved for the requester", async () => {
    await communityService.approveJoinRequest(CID, MOD, RID);

    expect(pubApproved).toHaveBeenCalledTimes(1);
    const payload = pubApproved.mock.calls[0][0];
    expect(payload).toMatchObject({
      communityId: CID,
      communityName: "Cool Community",
      requestId: RID,
      userId: REQUESTER, // recipient = the requester, NOT the moderator
      decidedBy: { userId: MOD, username: null },
    });
    expect(typeof payload.decidedAt).toBe("string");
    expect(typeof payload.eventAt).toBe("string");
  });

  it("routes member_added through notifyMemberJoined with the enriched payload", async () => {
    await communityService.approveJoinRequest(CID, MOD, RID);

    expect(pubMemberAdded).toHaveBeenCalledTimes(1);
    const added = pubMemberAdded.mock.calls[0][0];
    expect(added).toMatchObject({
      communityId: CID,
      actorId: MOD,
      targetUserId: REQUESTER,
      via: "join_request_approved",
      requestId: RID,
      communityName: "Cool Community",
      moderatorRecipientIds: [MOD, "moderator-2"],
    });
  });

  it("broadcasts community:member:joined into the community room", async () => {
    await communityService.approveJoinRequest(CID, MOD, RID);

    expect(pubRoomEvent).toHaveBeenCalledTimes(1);
    const [, roomCommunityId, event, dto] = pubRoomEvent.mock.calls[0];
    expect(roomCommunityId).toBe(CID);
    expect(event).toBe("community:member:joined");
    expect(dto).toMatchObject({
      userId: REQUESTER,
      role: "MEMBER",
      joinedAt: memberRow.joinedAt.getTime(), // epoch ms in the roster DTO
    });
  });

  it("does NOT publish a rejected event on the approve path", async () => {
    await communityService.approveJoinRequest(CID, MOD, RID);
    expect(pubRejected).not.toHaveBeenCalled();
  });
});

describe("rejectJoinRequest — previously-silent path now emits an event", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findJoinRequestById.mockResolvedValue(pendingRequest);
    repo.updateJoinRequest.mockResolvedValue({
      ...pendingRequest,
      status: "REJECTED",
      decidedBy: MOD,
      decidedAt: new Date(),
    });
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("publishes community.join_request_rejected addressed to the requester", async () => {
    await communityService.rejectJoinRequest(CID, MOD, RID);

    expect(pubRejected).toHaveBeenCalledTimes(1);
    const payload = pubRejected.mock.calls[0][0];
    expect(payload).toMatchObject({
      communityId: CID,
      communityName: "Cool Community",
      requestId: RID,
      userId: REQUESTER,
      decidedBy: { userId: MOD, username: null },
    });
    expect(typeof payload.decidedAt).toBe("string");
  });

  it("does NOT emit an approved event or a member_added on reject", async () => {
    await communityService.rejectJoinRequest(CID, MOD, RID);
    expect(pubApproved).not.toHaveBeenCalled();
    expect(pubMemberAdded).not.toHaveBeenCalled();
    expect(pubRoomEvent).not.toHaveBeenCalled();
  });
});

describe("bulkRejectJoinRequests — emits one rejected event per pending request", () => {
  const RID2 = "s".repeat(24);
  const REQUESTER2 = "88888888-8888-4888-8888-888888888888";

  beforeEach(() => {
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findJoinRequestsByIds.mockResolvedValue([
      pendingRequest,
      {
        ...pendingRequest,
        id: RID2,
        userId: REQUESTER2,
      },
    ]);
    repo.bulkUpdateJoinRequestStatus.mockResolvedValue(undefined);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("fans a rejected event to every requester, none skipped", async () => {
    const result = await communityService.bulkRejectJoinRequests(CID, MOD, [
      RID,
      RID2,
    ]);

    expect(result.rejected).toEqual([RID, RID2]);
    expect(result.skipped).toEqual([]);
    expect(pubRejected).toHaveBeenCalledTimes(2);
    const recipients = pubRejected.mock.calls.map((c) => c[0].userId).sort();
    expect(recipients).toEqual([REQUESTER2, REQUESTER].sort());
    // Every payload carries the community name (notification copy depends on it).
    for (const call of pubRejected.mock.calls) {
      expect(call[0].communityName).toBe("Cool Community");
    }
  });

  it("does not emit a rejected event for a non-PENDING request (skipped)", async () => {
    repo.findJoinRequestsByIds.mockResolvedValue([
      { ...pendingRequest, status: "APPROVED" },
    ]);
    const result = await communityService.bulkRejectJoinRequests(CID, MOD, [
      RID,
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.skipped).toEqual([RID]);
    expect(pubRejected).not.toHaveBeenCalled();
  });
});

describe("redeemInviteLink (autoApprove) — member_added with welcome-able actor", () => {
  beforeEach(() => {
    repo.findInviteLinkByCode.mockResolvedValue({
      id: "link-1",
      code: "ABC123",
      communityId: CID,
      createdBy: MOD,
      maxUses: null,
      usedCount: 0,
      autoApprove: true,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    repo.findById.mockResolvedValue(community);
    repo.findMemberByUserId.mockResolvedValue(null); // not yet a member
    repo.incrementInviteLinkUsageIfUnder.mockResolvedValue({ count: 1 });
    repo.createAuditLog.mockResolvedValue(undefined);
    repo.findInviteLinkById.mockResolvedValue({
      id: "link-1",
      code: "ABC123",
      communityId: CID,
      createdBy: MOD,
      maxUses: null,
      usedCount: 1,
      autoApprove: true,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    repo.createMember.mockResolvedValue({ ...memberRow, userId: REQUESTER });
    repo.countActiveMembers.mockResolvedValue(6);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.updateLastActivity.mockResolvedValue(undefined);
    repo.findActiveMemberIdsByRoles.mockResolvedValue([MOD]);
  });

  it("publishes member_added with via=invite_link_redeem and actor===target", async () => {
    await communityService.redeemInviteLink("ABC123", REQUESTER);

    expect(pubMemberAdded).toHaveBeenCalledTimes(1);
    const added = pubMemberAdded.mock.calls[0][0];
    expect(added).toMatchObject({
      communityId: CID,
      via: "invite_link_redeem",
      targetUserId: REQUESTER,
      actorId: REQUESTER, // actor===target → consumer STILL welcomes the joiner
      communityName: "Cool Community",
    });
    // No join-request decision events for an auto-approve self-join.
    expect(pubApproved).not.toHaveBeenCalled();
    expect(pubRejected).not.toHaveBeenCalled();
  });
});
