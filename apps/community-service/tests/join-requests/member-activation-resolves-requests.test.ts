/**
 * Scenario matrix for: "a current member must never hold a live join request".
 *
 * Reported bug (A1): user B asks to join a PRIVATE community; while the request
 * is still PENDING the admin adds B through Add Member. B became a member but
 * the request stayed in the admin's accept/decline list, still actionable.
 *
 * These are SERVICE-level tests — the real `communityService` runs with only the
 * I/O boundary (repository / RabbitMQ / Redis / gRPC) mocked, which is the only
 * layer where the ordering and the fan-out are observable. The atomicity half
 * (membership write and request resolution in ONE transaction) is covered
 * separately in `join-request-resolution-atomicity.test.ts`, which exercises the
 * real repository against a mocked Prisma.
 *
 * Section letters match the scenario matrix in
 * PENDING_REQUEST_ADD_MEMBER_REPORT.md.
 */

jest.mock("../../src/lib/user-client.js", () => ({
  fetchUserSnapshots: jest.fn(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            userId: id,
            username: id,
            displayName: `User ${id.slice(0, 4)}`,
            avatarObjectKey: null,
          },
        ])
      )
  ),
  // Everyone is a friend here: addMembers gates on friendship first (AIM-05),
  // and this suite is about join-request resolution, not that gate.
  fetchAcceptedFriendIds: jest.fn(
    async (_callerId: string, ids: string[]) => new Set(ids)
  ),
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

jest.mock("../../src/messaging/publish-community.js", () => ({
  publishCommunityMemberAddedSafe: jest.fn(),
  publishCommunityMemberJoinedSafe: jest.fn(),
  publishCommunityMemberKickedSafe: jest.fn(),
  publishCommunityMemberBannedSafe: jest.fn(),
  publishCommunityMemberMutedSafe: jest.fn(),
  publishCommunityMemberUnmutedSafe: jest.fn(),
  publishCommunityMemberWarnedSafe: jest.fn(),
  publishCommunityMemberRoleChangedSafe: jest.fn(),
  publishCommunityMemberLeftSafe: jest.fn(),
  publishCommunityAdminTransferredSafe: jest.fn(),
  publishCommunityDeletedSafe: jest.fn(),
  publishCommunityJoinRequestedSafe: jest.fn(),
  publishCommunityJoinRequestApprovedSafe: jest.fn(),
  publishCommunityJoinRequestRejectedSafe: jest.fn(),
  publishCommunityJoinRequestCancelledSafe: jest.fn(),
  publishCommunityInviteSentSafe: jest.fn(),
  publishCommunityInviteAcceptedSafe: jest.fn(),
  publishCommunityReportCreatedSafe: jest.fn(),
  publishCommunityReportActionedSafe: jest.fn(),
}));

jest.mock("../../src/messaging/publish-community-chat.js", () => ({
  publishCommunitySystemMessageForChatSafe: jest.fn(),
  publishCommunitySystemMessageForChatAwaited: jest
    .fn()
    .mockResolvedValue(undefined),
  publishCommunityCreatedForChatSafe: jest.fn(),
  publishCommunityDeletedForChatSafe: jest.fn(),
  publishCommunityInviteLinkSharedForChatSafe: jest.fn(),
  publishCommunityMemberSyncedForChatSafe: jest.fn(),
  publishCommunityMemberMuteSyncedForChatSafe: jest.fn(),
  publishCommunityMemberMuteRetractedForChatSafe: jest.fn(),
  publishCommunityMetaSyncedForChatSafe: jest.fn(),
  publishCommunityStatusChangedForChatSafe: jest.fn(),
  publishCommunityVisibilityChangedForChatSafe: jest.fn(),
}));

jest.mock("@aimess/redis", () => ({
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
    findActiveMemberIdsByRoles: jest.fn(),
    countActiveMembers: jest.fn(),
    setMemberCount: jest.fn(),
    createMember: jest.fn(),
    createManyMembers: jest.fn(),
    reactivateMemberWithSnapshot: jest.fn(),
    createAuditLog: jest.fn(),
    findJoinRequestById: jest.fn(),
    findJoinRequestsByIds: jest.fn(),
    findJoinRequestByCommunityAndUser: jest.fn(),
    findPendingJoinRequestsForUsers: jest.fn(),
    resolvePendingJoinRequests: jest.fn(),
    updateJoinRequest: jest.fn(),
    bulkUpdateJoinRequestStatus: jest.fn(),
    listCommunityJoinRequests: jest.fn(),
    createJoinRequest: jest.fn(),
    recyclePendingJoinRequest: jest.fn(),
  },
}));

jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn(async () => ({ url: null, expiresIn: null })),
  },
}));

import { ForbiddenError } from "@aimess/errors";
import { publishCommunityRoomEvent } from "@aimess/redis";

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { publishCommunitySystemMessageForChatSafe } from "../../src/messaging/publish-community-chat.js";
import {
  publishCommunityJoinRequestApprovedSafe,
  publishCommunityJoinRequestRejectedSafe,
  publishCommunityMemberAddedSafe,
} from "../../src/messaging/publish-community.js";
import { Prisma } from "../../src/generated/prisma/index.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubSystemMessage = publishCommunitySystemMessageForChatSafe as jest.Mock;
const pubApproved = publishCommunityJoinRequestApprovedSafe as jest.Mock;
const pubRejected = publishCommunityJoinRequestRejectedSafe as jest.Mock;
const pubMemberAdded = publishCommunityMemberAddedSafe as jest.Mock;
const pubRoomEvent = publishCommunityRoomEvent as jest.Mock;

const CID = "c".repeat(24);
const RID = "r".repeat(24);
const RID_OTHER = "s".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111"; // user A
const B = "99999999-9999-4999-8999-999999999999"; // user B
const OTHER = "88888888-8888-4888-8888-888888888888"; // an unrelated requester

const privateCommunity = {
  id: CID,
  name: "Secret Club",
  handle: "secret-club",
  description: null,
  avatarUrl: null,
  type: "PRIVATE",
  status: "ACTIVE",
  moderationStatus: "ACTIVE",
  deletedAt: null,
  adminId: ADMIN,
  memberCount: 1,
  category: { id: "cat-1", name: "General" },
};

const memberRow = (userId: string, over: Record<string, unknown> = {}) => ({
  userId,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-08-25T10:00:00.000Z"),
  snapshotUsername: userId,
  snapshotDisplayName: `User ${userId.slice(0, 4)}`,
  snapshotAvatarKey: null,
  ...over,
});

const pendingRequest = (
  id: string,
  userId: string,
  over: Record<string, unknown> = {}
) => ({
  id,
  communityId: CID,
  userId,
  status: "PENDING",
  message: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date("2026-08-25T09:00:00.000Z"),
  updatedAt: new Date("2026-08-25T09:00:00.000Z"),
  ...over,
});

/** Every `community:join_request:updated` broadcast, room + per-moderator. */
const requestUpdatedPayloads = () =>
  pubRoomEvent.mock.calls
    .filter(([, , evt]) => evt === "community:join_request:updated")
    .map(([, , , payload]) => payload);

/** System messages posted for a given user, by subtype. */
const systemMessageTypesFor = (userId: string) =>
  pubSystemMessage.mock.calls
    .map(([arg]) => arg)
    .filter((arg) => arg?.visibleToUserId === userId)
    .map((arg) => arg.systemMessageType);

/**
 * Tiny in-memory member table. `addMembers` reads the roster twice — once to
 * partition candidates, once after the writes to build the response DTO and the
 * per-member notifications — so a flat `mockResolvedValue` cannot model it.
 * Seed it with `seedMember()` to describe the PRE-state of a scenario.
 */
const members = new Map<string, ReturnType<typeof memberRow>>();
const seedMember = (userId: string, over: Record<string, unknown> = {}) =>
  members.set(userId, memberRow(userId, over));

function resetAll() {
  jest.clearAllMocks();
  members.clear();
  repo.findById.mockResolvedValue(privateCommunity);
  repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  repo.findActiveMemberIdsByRoles.mockResolvedValue([ADMIN]);
  repo.countActiveMembers.mockResolvedValue(2);
  repo.setMemberCount.mockResolvedValue(undefined);
  repo.createAuditLog.mockResolvedValue(undefined);
  repo.findPendingJoinRequestsForUsers.mockResolvedValue([]);
  repo.resolvePendingJoinRequests.mockResolvedValue({ count: 0 });
  repo.findMembersByUserIds.mockImplementation(
    async (_cid: string, userIds: string[]) =>
      userIds.map((id) => members.get(id)).filter(Boolean)
  );
  repo.findMemberByUserId.mockImplementation(
    async (_cid: string, userId: string) => members.get(userId) ?? null
  );
  repo.createMember.mockImplementation(async (data: { userId: string }) => {
    seedMember(data.userId);
    return members.get(data.userId)!;
  });
  repo.reactivateMemberWithSnapshot.mockImplementation(
    async (_cid: string, userId: string) => {
      seedMember(userId);
      return members.get(userId)!;
    }
  );
}

beforeEach(resetAll);

// ===========================================================================
// A. The core bug — Add Member while a join request is pending
// ===========================================================================
describe("A. addMembers while B has a PENDING join request", () => {
  beforeEach(() => {
    // B is not a member yet (empty member store); B holds one PENDING request.
    repo.findPendingJoinRequestsForUsers.mockResolvedValue([
      { id: RID, userId: B },
    ]);
  });

  it("A1: hands the membership write the caller id, so the SAME transaction resolves B's request", async () => {
    await communityService.addMembers(CID, ADMIN, [B]);

    // The resolution is not a second service-level write — it rides inside the
    // repository's membership transaction, keyed off this `resolvedBy` argument.
    expect(repo.createMember).toHaveBeenCalledTimes(1);
    expect(repo.createMember).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: CID, userId: B }),
      ADMIN
    );
    // No separate, non-atomic resolve call on the membership path.
    expect(repo.resolvePendingJoinRequests).not.toHaveBeenCalled();
  });

  it("A2: broadcasts community:join_request:updated with AUTO_RESOLVED so open admin lists drop the row live", async () => {
    await communityService.addMembers(CID, ADMIN, [B]);

    const payloads = requestUpdatedPayloads();
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads[0]).toMatchObject({
      communityId: CID,
      requestId: RID,
      status: "AUTO_RESOLVED",
      userId: B,
      actorId: ADMIN,
    });
  });

  it("A5: posts the MEMBER_ADDED line to B — never 'You joined' and never 'request approved'", async () => {
    await communityService.addMembers(CID, ADMIN, [B]);

    expect(systemMessageTypesFor(B)).toEqual(["MEMBER_ADDED"]);
    const call = pubSystemMessage.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.systemMessageType === "MEMBER_ADDED");
    // The line names the admin, and chat-service resolves actorName from
    // triggeredByUserId — so it must be the ADMIN, not the added member.
    expect(call).toMatchObject({
      communityId: CID,
      triggeredByUserId: ADMIN,
      visibleToUserId: B,
      metadata: { targetUserId: B },
    });
  });

  it("A6: publishes member_added via=add_members (the 'you were added' push) and no approved event", async () => {
    await communityService.addMembers(CID, ADMIN, [B]);

    expect(pubMemberAdded).toHaveBeenCalledTimes(1);
    expect(pubMemberAdded.mock.calls[0][0]).toMatchObject({
      targetUserId: B,
      actorId: ADMIN,
      via: "add_members",
    });
    expect(pubApproved).not.toHaveBeenCalled();
  });

  it("A7: creates the membership exactly once", async () => {
    const result = await communityService.addMembers(CID, ADMIN, [B]);

    expect(repo.createMember).toHaveBeenCalledTimes(1);
    expect(result.added.map((m) => m.userId)).toEqual([B]);
    expect(result.skipped).toEqual([]);
  });
});

// ===========================================================================
// B. Same bug class — every other member-making path
// ===========================================================================
describe("B. other membership paths and their request handling", () => {
  it("B1: a normal approve still activates the member and announces the approval", async () => {
    repo.findJoinRequestById.mockResolvedValue(pendingRequest(RID, B));
    repo.updateJoinRequest.mockResolvedValue(
      pendingRequest(RID, B, { status: "APPROVED", decidedBy: ADMIN })
    );

    const res = await communityService.approveJoinRequest(CID, ADMIN, RID);

    expect(res.request.status).toBe("APPROVED");
    expect(repo.createMember).toHaveBeenCalledWith(
      expect.objectContaining({ userId: B }),
      ADMIN
    );
    expect(pubApproved).toHaveBeenCalledTimes(1);
    // C1: the chat line describes the membership outcome, not the decision —
    // the approval itself still reaches the requester as its own notification
    // (pubApproved above).
    expect(systemMessageTypesFor(B)).toEqual(["COMMUNITY_JOINED"]);
  });

  it("B2: a concurrent accept that wins the unique index degrades Add Member to a skip, not an error storm", async () => {
    repo.findPendingJoinRequestsForUsers.mockResolvedValue([
      { id: RID, userId: B },
    ]);
    repo.createMember.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    const result = await communityService.addMembers(CID, ADMIN, [B]);

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([{ userId: B, reason: "ALREADY_MEMBER" }]);
    // The winner already posted B's join line — this loser must post nothing.
    expect(systemMessageTypesFor(B)).toEqual([]);
    expect(pubMemberAdded).not.toHaveBeenCalled();
  });

  it("B2: the mirror race — approve losing to a concurrent add resolves instead of duplicating", async () => {
    repo.findJoinRequestById.mockResolvedValue(pendingRequest(RID, B));
    // Not a member when approve probes; the concurrent add lands in between and
    // the insert loses the unique index.
    repo.createMember.mockImplementation(async () => {
      seedMember(B);
      throw new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      });
    });
    repo.updateJoinRequest.mockResolvedValue(
      pendingRequest(RID, B, { status: "AUTO_RESOLVED", decidedBy: ADMIN })
    );

    const res = await communityService.approveJoinRequest(CID, ADMIN, RID);

    expect(res.request.status).toBe("AUTO_RESOLVED");
    expect(res.member.userId).toBe(B);
    expect(pubApproved).not.toHaveBeenCalled();
    expect(systemMessageTypesFor(B)).toEqual([]);
  });

  it("B4: a previously DECLINED request does not block a later Add Member", async () => {
    // A REJECTED row is not PENDING, so nothing is queued for resolution.
    repo.findPendingJoinRequestsForUsers.mockResolvedValue([]);

    const result = await communityService.addMembers(CID, ADMIN, [B]);

    expect(result.added.map((m) => m.userId)).toEqual([B]);
    expect(requestUpdatedPayloads()).toEqual([]);
  });

  it("B7: adding B resolves only B's request — another user's pending request is untouched", async () => {
    repo.findPendingJoinRequestsForUsers.mockResolvedValue([
      { id: RID, userId: B },
    ]);

    await communityService.addMembers(CID, ADMIN, [B]);

    // Scoped to the community and to the ids actually being activated.
    expect(repo.findPendingJoinRequestsForUsers).toHaveBeenCalledWith(CID, [B]);
    const payloads = requestUpdatedPayloads();
    expect(payloads.map((p) => p.requestId)).toEqual([RID]);
    expect(payloads.map((p) => p.userId)).not.toContain(OTHER);
  });

  it("B7: a candidate skipped as BANNED keeps their request (no phantom resolution)", async () => {
    seedMember(B, { status: "BANNED" });
    repo.findPendingJoinRequestsForUsers.mockResolvedValue([
      { id: RID, userId: B },
    ]);

    const result = await communityService.addMembers(CID, ADMIN, [B]);

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([{ userId: B, reason: "BANNED" }]);
    expect(requestUpdatedPayloads()).toEqual([]);
  });

  it("B8: a bulk add resolves the pending request of every user it actually activates", async () => {
    repo.findPendingJoinRequestsForUsers.mockResolvedValue([
      { id: RID, userId: B },
      { id: RID_OTHER, userId: OTHER },
    ]);

    await communityService.addMembers(CID, ADMIN, [B, OTHER]);

    expect(repo.createMember).toHaveBeenCalledTimes(2);
    const payloads = requestUpdatedPayloads();
    expect(payloads.map((p) => p.requestId).sort()).toEqual(
      [RID, RID_OTHER].sort()
    );
    expect(payloads.every((p) => p.status === "AUTO_RESOLVED")).toBe(true);
  });

  it("B: a self-join style activation stamps the member as resolver, not an admin", async () => {
    // notifyMemberJoined-independent: the repository call is what carries it.
    repo.findPendingJoinRequestsForUsers.mockResolvedValue([]);
    seedMember(B, { status: "LEFT" });

    await communityService.addMembers(CID, ADMIN, [B]);

    expect(repo.reactivateMemberWithSnapshot).toHaveBeenCalledWith(
      CID,
      B,
      expect.any(Object),
      ADMIN
    );
  });
});

// ===========================================================================
// C. System messages & notifications
// ===========================================================================
describe("C. copy per path", () => {
  it("C1: add → MEMBER_ADDED; approve / self-join / invite-link → COMMUNITY_JOINED", async () => {
    const base = {
      community: privateCommunity as never,
      member: memberRow(B) as never,
      memberCount: 2,
      actorId: ADMIN,
      eventAt: "2026-08-25T10:00:00.000Z",
    };

    await communityService.notifyMemberJoined({ ...base, via: "add_members" });
    await communityService.notifyMemberJoined({
      ...base,
      via: "join_request_approved",
    });
    await communityService.notifyMemberJoined({ ...base, via: "self_join" });
    await communityService.notifyMemberJoined({
      ...base,
      via: "invite_link_redeem",
    });

    expect(systemMessageTypesFor(B)).toEqual([
      "MEMBER_ADDED",
      "COMMUNITY_JOINED",
      "COMMUNITY_JOINED",
      "COMMUNITY_JOINED",
    ]);
  });

  it("C2: one add produces exactly one membership line for the added user", async () => {
    repo.findPendingJoinRequestsForUsers.mockResolvedValue([
      { id: RID, userId: B },
    ]);

    await communityService.addMembers(CID, ADMIN, [B]);

    expect(systemMessageTypesFor(B)).toHaveLength(1);
  });

  it("C: the new member's own list-row preview matches the line they were sent", async () => {
    await communityService.notifyMemberJoined({
      community: privateCommunity as never,
      member: memberRow(B) as never,
      memberCount: 2,
      actorId: ADMIN,
      via: "add_members",
      eventAt: "2026-08-25T10:00:00.000Z",
    });

    const { publishChatUserEvent } = jest.requireMock("@aimess/redis") as {
      publishChatUserEvent: jest.Mock;
    };
    const added = publishChatUserEvent.mock.calls.find(
      ([, , evt]) => evt === "community:added"
    );
    expect(added?.[3].lastActivity.preview).toBe(
      "You were added to the community"
    );
  });
});

// ===========================================================================
// D. Server-side enforcement (non-negotiable)
// ===========================================================================
describe("D. server-side enforcement", () => {
  it("D1: approve on a request whose user is already a member is a no-op, not a second membership", async () => {
    repo.findJoinRequestById.mockResolvedValue(pendingRequest(RID, B));
    seedMember(B);
    repo.updateJoinRequest.mockResolvedValue(
      pendingRequest(RID, B, { status: "AUTO_RESOLVED", decidedBy: ADMIN })
    );

    const res = await communityService.approveJoinRequest(CID, ADMIN, RID);

    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
    // Resolved, never resurrected as APPROVED — this admin granted nothing.
    expect(repo.updateJoinRequest).toHaveBeenCalledWith(
      RID,
      expect.objectContaining({ status: "AUTO_RESOLVED" })
    );
    expect(res.request.status).toBe("AUTO_RESOLVED");
    expect(pubApproved).not.toHaveBeenCalled();
    expect(systemMessageTypesFor(B)).toEqual([]);
  });

  it("D1: a stale approve on an ALREADY-resolved request stays a no-op (no 400, no rewrite)", async () => {
    repo.findJoinRequestById.mockResolvedValue(
      pendingRequest(RID, B, { status: "AUTO_RESOLVED", decidedBy: ADMIN })
    );
    seedMember(B);

    const res = await communityService.approveJoinRequest(CID, ADMIN, RID);

    expect(res.request.status).toBe("AUTO_RESOLVED");
    expect(repo.updateJoinRequest).not.toHaveBeenCalled();
    expect(repo.createMember).not.toHaveBeenCalled();
  });

  it("D2: a late decline never revokes membership", async () => {
    repo.findJoinRequestById.mockResolvedValue(pendingRequest(RID, B));
    seedMember(B);
    repo.updateJoinRequest.mockResolvedValue(
      pendingRequest(RID, B, { status: "AUTO_RESOLVED", decidedBy: ADMIN })
    );

    const res = await communityService.rejectJoinRequest(CID, ADMIN, RID);

    expect(res.status).toBe("AUTO_RESOLVED");
    expect(repo.updateJoinRequest).not.toHaveBeenCalledWith(
      RID,
      expect.objectContaining({ status: "REJECTED" })
    );
    expect(pubRejected).not.toHaveBeenCalled();
    // No "your request was declined" line to someone who is in the community.
    expect(systemMessageTypesFor(B)).toEqual([]);
  });

  it("D2: declining a genuine pending request from a NON-member is unchanged", async () => {
    repo.findJoinRequestById.mockResolvedValue(pendingRequest(RID, B));
    // B is absent from the member store — not a member.
    repo.updateJoinRequest.mockResolvedValue(
      pendingRequest(RID, B, { status: "REJECTED", decidedBy: ADMIN })
    );

    const res = await communityService.rejectJoinRequest(CID, ADMIN, RID);

    expect(res.status).toBe("REJECTED");
    expect(pubRejected).toHaveBeenCalledTimes(1);
    expect(systemMessageTypesFor(B)).toEqual(["JOIN_REQUEST_REJECTED"]);
  });

  it("D4: the admin list never returns a request from a current member, and repairs it", async () => {
    repo.listCommunityJoinRequests.mockResolvedValue({
      rows: [pendingRequest(RID, B), pendingRequest(RID_OTHER, OTHER)],
      total: 2,
    });
    // B slipped through as a member with a stale PENDING row; OTHER has not.
    seedMember(B);

    const page = await communityService.listCommunityJoinRequests(CID, ADMIN, {
      page: 1,
      limit: 20,
    });

    expect(page.data.map((r) => r.userId)).toEqual([OTHER]);
    expect(page.pagination.totalData).toBe(1);
    // Self-heal so the row cannot come back on the next page load.
    await Promise.resolve();
    expect(repo.resolvePendingJoinRequests).toHaveBeenCalledWith(
      CID,
      [B],
      ADMIN
    );
  });

  it("D4: a clean list is returned untouched (no needless repair write)", async () => {
    repo.listCommunityJoinRequests.mockResolvedValue({
      rows: [pendingRequest(RID, B)],
      total: 1,
    });
    // Nobody in the page is a member.

    const page = await communityService.listCommunityJoinRequests(CID, ADMIN, {
      page: 1,
      limit: 20,
    });

    expect(page.data.map((r) => r.userId)).toEqual([B]);
    expect(page.pagination.totalData).toBe(1);
    expect(repo.resolvePendingJoinRequests).not.toHaveBeenCalled();
  });

  it("D5: a plain member cannot add members, approve, or reject", async () => {
    repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });
    repo.findJoinRequestById.mockResolvedValue(pendingRequest(RID, B));

    await expect(communityService.addMembers(CID, B, [OTHER])).rejects.toThrow(
      ForbiddenError
    );
    await expect(
      communityService.approveJoinRequest(CID, B, RID)
    ).rejects.toThrow(ForbiddenError);
    await expect(
      communityService.rejectJoinRequest(CID, B, RID)
    ).rejects.toThrow(ForbiddenError);
  });
});

// ===========================================================================
// Bulk decide paths
// ===========================================================================
describe("bulk approve / reject vs current members", () => {
  it("bulk approve reports an already-member request as skipped and resolves it", async () => {
    repo.findJoinRequestsByIds.mockResolvedValue([
      pendingRequest(RID, B),
      pendingRequest(RID_OTHER, OTHER),
    ]);
    seedMember(B);
    repo.bulkUpdateJoinRequestStatus.mockResolvedValue({ count: 1 });

    const res = await communityService.bulkApproveJoinRequests(CID, ADMIN, [
      RID,
      RID_OTHER,
    ]);

    expect(res.approved).toEqual([RID_OTHER]);
    expect(res.skipped).toContain(RID);
    expect(repo.bulkUpdateJoinRequestStatus).toHaveBeenCalledWith(
      [RID],
      "AUTO_RESOLVED",
      ADMIN,
      expect.any(Date)
    );
    // Only the genuinely approved user gets an approval notification.
    expect(pubApproved).toHaveBeenCalledTimes(1);
    expect(pubApproved.mock.calls[0][0].userId).toBe(OTHER);
  });

  it("bulk reject never declines a request from a current member", async () => {
    repo.findJoinRequestsByIds.mockResolvedValue([
      pendingRequest(RID, B),
      pendingRequest(RID_OTHER, OTHER),
    ]);
    seedMember(B);
    repo.bulkUpdateJoinRequestStatus.mockResolvedValue({ count: 1 });

    const res = await communityService.bulkRejectJoinRequests(CID, ADMIN, [
      RID,
      RID_OTHER,
    ]);

    expect(res.rejected).toEqual([RID_OTHER]);
    expect(res.skipped).toContain(RID);
    expect(repo.bulkUpdateJoinRequestStatus).toHaveBeenCalledWith(
      [RID],
      "AUTO_RESOLVED",
      ADMIN,
      expect.any(Date)
    );
    expect(repo.bulkUpdateJoinRequestStatus).toHaveBeenCalledWith(
      [RID_OTHER],
      "REJECTED",
      ADMIN,
      expect.any(Date)
    );
  });
});
