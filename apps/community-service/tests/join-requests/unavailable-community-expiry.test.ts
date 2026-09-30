/**
 * Pending join requests when a PRIVATE community becomes unavailable.
 *
 * Close (owner), platform suspension, system-ban close and delete must each
 * leave NO actionable request behind:
 *   - every PENDING request becomes EXPIRED (never left PENDING, never revived
 *     by a reopen — the user has to ask again, which is a new attempt);
 *   - the admins' "Accept Requests" rows and inbox/tray cards are taken back
 *     (community:join_request:updated + the retraction), even on delete, where
 *     the admins are evicted in the same call;
 *   - the requester's "Cancel Request" is cleared live
 *     (community:join_request:update on /notify).
 *
 * And the backend refuses a stale decision on its own — a hidden button is not
 * a guard: approve/reject against a closed or deleted community fail, and an
 * approve that races the close loses inside the repository transaction.
 *
 * Real communityService; the repository and publishers are mocked.
 */

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMemberByUserId: jest.fn(),
    findMembersByUserIds: jest.fn(async () => []),
    findActiveMemberIds: jest.fn(async () => []),
    findActiveMemberIdsByRoles: jest.fn(),
    updateCommunity: jest.fn(),
    captureClosureSnapshot: jest.fn(),
    clearClosureSnapshot: jest.fn(),
    markAllActiveMembersLeft: jest.fn(),
    setMemberCount: jest.fn(),
    countActiveMembers: jest.fn(async () => 1),
    createAuditLog: jest.fn(),
    findMuteByUserAndCommunity: jest.fn(async () => null),
    adminSetModerationStatus: jest.fn(),
    expirePendingJoinRequests: jest.fn(),
    findJoinRequestById: jest.fn(),
    findJoinRequestsByIds: jest.fn(),
    findJoinRequestByCommunityAndUser: jest.fn(),
    createJoinRequest: jest.fn(),
    recyclePendingJoinRequest: jest.fn(),
    settleJoinRequestToMember: jest.fn(),
    settlePendingJoinRequest: jest.fn(),
    bulkUpdateJoinRequestStatus: jest.fn(),
  },
}));

jest.mock("../../src/grpc/stream.client.js", () => ({
  getStreamClient: () => ({
    forceEndStreamsByCommunity: jest.fn(async () => undefined),
  }),
}));

import {
  publishChatUserEvent,
  publishCommunityRoomEvent,
  publishUserSocketEvent,
} from "@aimess/redis";
import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import {
  publishCommunityJoinRequestApprovedSafe,
  publishCommunityJoinRequestedSafe,
  publishCommunityJoinRequestRejectedSafe,
  publishCommunityJoinRequestRetractedSafe,
} from "../../src/messaging/publish-community.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubRoom = publishCommunityRoomEvent as jest.Mock;
const pubUser = publishChatUserEvent as jest.Mock;
const pubNotify = publishUserSocketEvent as jest.Mock;
const pubRetracted = publishCommunityJoinRequestRetractedSafe as jest.Mock;
const pubApproved = publishCommunityJoinRequestApprovedSafe as jest.Mock;
const pubRejected = publishCommunityJoinRequestRejectedSafe as jest.Mock;
const pubRequested = publishCommunityJoinRequestedSafe as jest.Mock;

const CID = "c".repeat(24);
const OWNER = "11111111-1111-4111-8111-111111111111";
const MOD = "22222222-2222-4222-8222-222222222222";
const U1 = "33333333-3333-4333-8333-333333333333";
const U2 = "44444444-4444-4444-8444-444444444444";
const R1 = "a".repeat(24);
const R2 = "b".repeat(24);
const PLATFORM_ADMIN = "platform-admin-1";

const open = {
  id: CID,
  name: "Private Club",
  handle: "private-club",
  avatarUrl: null,
  type: "PRIVATE",
  adminId: OWNER,
  creatorId: OWNER,
  memberCount: 3,
  status: "ACTIVE",
  moderationStatus: "ACTIVE",
  statusClosedReasonCode: null,
  category: { id: "cat", name: "Cat" },
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  lastActivityAt: new Date("2026-09-01T00:00:00.000Z"),
};
const closed = { ...open, status: "CLOSED" };

const pending = (id: string, userId: string, over: object = {}) => ({
  id,
  communityId: CID,
  userId,
  status: "PENDING",
  message: null,
  inviteCode: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date("2026-09-30T08:00:00.000Z"),
  updatedAt: new Date("2026-09-30T08:00:00.000Z"),
  ...over,
});

/** Requester-side `community:join_request:update` frames, by requester. */
const requesterFrames = () =>
  pubNotify.mock.calls
    .filter(([, , evt]) => evt === "community:join_request:update")
    .map(([, userId, , payload]) => ({ userId, ...payload }));

/** Admin-list `community:join_request:updated` frames sent to the room. */
const roomListFrames = () =>
  pubRoom.mock.calls
    .filter(([, , evt]) => evt === "community:join_request:updated")
    .map(([, , , payload]) => payload);

beforeEach(() => {
  repo.findById.mockResolvedValue(open);
  repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  repo.findActiveMemberIds.mockResolvedValue([OWNER, MOD]);
  repo.findActiveMemberIdsByRoles.mockImplementation(
    async (_cid: string, roles: string[]) =>
      roles.includes("MODERATOR") ? [OWNER, MOD] : [OWNER]
  );
  repo.updateCommunity.mockImplementation(
    async (_id: string, data: object) => ({
      ...open,
      ...data,
    })
  );
  repo.expirePendingJoinRequests.mockResolvedValue([
    { id: R1, userId: U1 },
    { id: R2, userId: U2 },
  ]);
});

// ===========================================================================
// CLOSED
// ===========================================================================
describe("owner close", () => {
  it("expires every pending request AFTER the status write (never before)", async () => {
    await communityService.closeCommunity(CID, OWNER, null);

    expect(repo.expirePendingJoinRequests).toHaveBeenCalledWith(CID, OWNER);
    expect(repo.updateCommunity.mock.invocationCallOrder[0]).toBeLessThan(
      repo.expirePendingJoinRequests.mock.invocationCallOrder[0]
    );
  });

  it("clears Cancel Request for EVERY requester, not just the latest", async () => {
    await communityService.closeCommunity(CID, OWNER, null);

    const frames = requesterFrames();
    expect(frames.map((f) => f.userId).sort()).toEqual([U1, U2].sort());
    for (const f of frames) {
      expect(f).toMatchObject({
        communityId: CID,
        status: "EXPIRED",
        reason: "COMMUNITY_CLOSED",
      });
    }
  });

  it("drops the rows from every open Accept Requests list", async () => {
    await communityService.closeCommunity(CID, OWNER, null);

    const frames = roomListFrames();
    expect(frames.map((f) => f.requestId).sort()).toEqual([R1, R2].sort());
    expect(frames.every((f) => f.status === "EXPIRED")).toBe(true);
    expect(frames.every((f) => f.reason === "COMMUNITY_CLOSED")).toBe(true);
    // Moderators still get the list sync (they can act) on their own channel.
    const personal = pubUser.mock.calls.filter(
      ([, , evt]) => evt === "community:join_request:updated"
    );
    expect(new Set(personal.map((c) => c[1]))).toEqual(new Set([OWNER, MOD]));
  });

  it("retracts the admin-only inbox/tray card for each request (never to moderators)", async () => {
    await communityService.closeCommunity(CID, OWNER, null);

    expect(pubRetracted).toHaveBeenCalledTimes(2);
    for (const [payload] of pubRetracted.mock.calls) {
      expect(payload).toMatchObject({
        communityId: CID,
        resolution: "EXPIRED",
        adminRecipientIds: [OWNER],
      });
    }
  });

  it("zero pending requests: the close still succeeds and announces nothing", async () => {
    repo.expirePendingJoinRequests.mockResolvedValue([]);
    await expect(
      communityService.closeCommunity(CID, OWNER, null)
    ).resolves.toBeUndefined();
    expect(requesterFrames()).toEqual([]);
    expect(pubRetracted).not.toHaveBeenCalled();
  });

  it("is idempotent — closing an already-closed community expires nothing twice", async () => {
    repo.findById.mockResolvedValue(closed);
    await communityService.closeCommunity(CID, OWNER, null);
    expect(repo.expirePendingJoinRequests).not.toHaveBeenCalled();
    expect(requesterFrames()).toEqual([]);
  });

  it("a failing sweep never fails the close itself", async () => {
    repo.expirePendingJoinRequests.mockRejectedValue(new Error("mongo down"));
    await expect(
      communityService.closeCommunity(CID, OWNER, null)
    ).resolves.toBeUndefined();
  });
});

describe("platform suspension and system-ban close", () => {
  it("Super Admin suspension expires the pending requests", async () => {
    repo.adminSetModerationStatus.mockResolvedValue({
      ok: true,
      status: "CLOSED",
      closedAt: Date.now(),
      errorCode: "",
    });
    await communityService.adminSetModerationStatus(
      CID,
      "SUSPENDED" as never,
      "SPAM",
      PLATFORM_ADMIN
    );
    expect(repo.expirePendingJoinRequests).toHaveBeenCalledWith(
      CID,
      PLATFORM_ADMIN
    );
    expect(requesterFrames()).toHaveLength(2);
  });

  it("un-suspending does not touch requests", async () => {
    repo.adminSetModerationStatus.mockResolvedValue({
      ok: true,
      status: "ACTIVE",
      closedAt: 0,
      errorCode: "",
    });
    await communityService.adminSetModerationStatus(
      CID,
      "ACTIVE" as never,
      null,
      PLATFORM_ADMIN
    );
    expect(repo.expirePendingJoinRequests).not.toHaveBeenCalled();
  });

  it("an owner's system ban closes the community and expires its requests", async () => {
    await communityService.closeCommunityForSystemBan(
      CID,
      OWNER,
      PLATFORM_ADMIN,
      null
    );
    expect(repo.expirePendingJoinRequests).toHaveBeenCalledWith(
      CID,
      PLATFORM_ADMIN
    );
  });
});

describe("reopen", () => {
  it("sweeps leftover PENDING rows while still closed, so none revive with the community", async () => {
    repo.findById.mockResolvedValue(closed);
    await communityService.reopenCommunity(CID, OWNER);

    expect(repo.expirePendingJoinRequests).toHaveBeenCalledWith(CID, OWNER);
    const flip = repo.updateCommunity.mock.calls.findIndex(
      ([, data]) => data.status === "ACTIVE"
    );
    expect(
      repo.expirePendingJoinRequests.mock.invocationCallOrder[0]
    ).toBeLessThan(repo.updateCommunity.mock.invocationCallOrder[flip]);
  });

  it("after a reopen the user files a NEW attempt: EXPIRED row recycled, new lifecycle, admin notified", async () => {
    const expiredAt = new Date("2026-09-30T08:00:00.000Z");
    const recycledAt = new Date("2026-09-30T09:00:00.000Z");
    repo.findMemberByUserId.mockResolvedValue(null);
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue(
      pending(R1, U1, { status: "EXPIRED", updatedAt: expiredAt })
    );
    repo.recyclePendingJoinRequest.mockResolvedValue(
      pending(R1, U1, { updatedAt: recycledAt })
    );

    const res = await communityService.createJoinRequest(CID, U1, null);

    expect(res.status).toBe("PENDING");
    expect(repo.recyclePendingJoinRequest).toHaveBeenCalled();
    expect(pubRequested).toHaveBeenCalledTimes(1);
    // The old card's token can never decide the new attempt.
    expect(pubRequested.mock.calls[0][0].lifecycle).toBe(
      `${R1}:${recycledAt.getTime()}`
    );
    expect(pubRequested.mock.calls[0][0].lifecycle).not.toBe(
      `${R1}:${expiredAt.getTime()}`
    );
  });
});

// ===========================================================================
// DELETED
// ===========================================================================
describe("delete", () => {
  it("expires requests after the soft-delete and BEFORE the admins are evicted", async () => {
    await communityService.deleteCommunity(CID, OWNER);

    const [deleteWrite] = repo.updateCommunity.mock.invocationCallOrder;
    const [sweep] = repo.expirePendingJoinRequests.mock.invocationCallOrder;
    const [evict] = repo.markAllActiveMembersLeft.mock.invocationCallOrder;
    expect(deleteWrite).toBeLessThan(sweep);
    expect(sweep).toBeLessThan(evict);
  });

  it("still reaches the (about to be evicted) admin with the retraction, and says DELETED", async () => {
    // After eviction nobody holds a role — a late lookup would find no one.
    repo.markAllActiveMembersLeft.mockImplementation(async () => {
      repo.findActiveMemberIdsByRoles.mockResolvedValue([]);
    });
    await communityService.deleteCommunity(CID, OWNER);

    expect(pubRetracted).toHaveBeenCalledTimes(2);
    for (const [payload] of pubRetracted.mock.calls) {
      expect(payload.adminRecipientIds).toEqual([OWNER]);
    }
    for (const f of requesterFrames()) {
      expect(f).toMatchObject({
        status: "EXPIRED",
        reason: "COMMUNITY_DELETED",
      });
    }
  });

  it("a deleted community takes no new request", async () => {
    repo.findById.mockResolvedValue(null);
    await expect(
      communityService.createJoinRequest(CID, U1, null)
    ).rejects.toMatchObject({ message: "COMMUNITY_NOT_FOUND" });
    expect(repo.createJoinRequest).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Stale decisions — enforced by the backend, not by hidden buttons
// ===========================================================================
describe("stale Accept / Reject", () => {
  beforeEach(() => {
    repo.findJoinRequestById.mockResolvedValue(pending(R1, U1));
    repo.findMemberByUserId.mockResolvedValue(null);
  });

  it("Accept on a closed community → COMMUNITY_IS_CLOSED, nobody admitted", async () => {
    repo.findById.mockResolvedValue(closed);
    await expect(
      communityService.approveJoinRequest(CID, OWNER, R1)
    ).rejects.toMatchObject({ message: "COMMUNITY_IS_CLOSED" });
    expect(repo.settleJoinRequestToMember).not.toHaveBeenCalled();
    expect(pubApproved).not.toHaveBeenCalled();
  });

  it("Accept on a deleted community → COMMUNITY_NOT_FOUND", async () => {
    repo.findById.mockResolvedValue(null);
    await expect(
      communityService.approveJoinRequest(CID, OWNER, R1)
    ).rejects.toMatchObject({ message: "COMMUNITY_NOT_FOUND" });
    expect(repo.settleJoinRequestToMember).not.toHaveBeenCalled();
  });

  it("Accept on an EXPIRED request (old push after a reopen) → NOT_PENDING", async () => {
    repo.findJoinRequestById.mockResolvedValue(
      pending(R1, U1, { status: "EXPIRED" })
    );
    await expect(
      communityService.approveJoinRequest(CID, OWNER, R1)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_REQUEST_NOT_PENDING" });
    expect(repo.settleJoinRequestToMember).not.toHaveBeenCalled();
  });

  it("Reject on a closed community → COMMUNITY_IS_CLOSED, nothing rewritten", async () => {
    repo.findById.mockResolvedValue(closed);
    await expect(
      communityService.rejectJoinRequest(CID, OWNER, R1)
    ).rejects.toMatchObject({ message: "COMMUNITY_IS_CLOSED" });
    expect(repo.settlePendingJoinRequest).not.toHaveBeenCalled();
    expect(pubRejected).not.toHaveBeenCalled();
  });

  it("Accept racing a close: the transaction loses → COMMUNITY_IS_CLOSED, no approval side effects", async () => {
    // Open when read; closed by the time the guarded transaction runs.
    repo.findById.mockResolvedValueOnce(open).mockResolvedValue(closed);
    repo.settleJoinRequestToMember.mockResolvedValue({
      outcome: "COMMUNITY_UNAVAILABLE",
    });
    await expect(
      communityService.approveJoinRequest(CID, OWNER, R1)
    ).rejects.toMatchObject({ message: "COMMUNITY_IS_CLOSED" });
    expect(pubApproved).not.toHaveBeenCalled();
    expect(repo.setMemberCount).not.toHaveBeenCalled();
  });

  it("Accept racing a delete → COMMUNITY_NOT_FOUND", async () => {
    repo.findById.mockResolvedValueOnce(open).mockResolvedValue(null);
    repo.settleJoinRequestToMember.mockResolvedValue({
      outcome: "COMMUNITY_UNAVAILABLE",
    });
    await expect(
      communityService.approveJoinRequest(CID, OWNER, R1)
    ).rejects.toMatchObject({ message: "COMMUNITY_NOT_FOUND" });
    expect(pubApproved).not.toHaveBeenCalled();
  });

  it("Accept that finds the request expired mid-flight → NOT_PENDING", async () => {
    repo.settleJoinRequestToMember.mockResolvedValue({
      outcome: "NOT_PENDING",
    });
    await expect(
      communityService.approveJoinRequest(CID, OWNER, R1)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_REQUEST_NOT_PENDING" });
    expect(pubApproved).not.toHaveBeenCalled();
  });

  it("bulk Accept racing a close approves nobody and reports them skipped", async () => {
    repo.findJoinRequestsByIds.mockResolvedValue([
      pending(R1, U1),
      pending(R2, U2),
    ]);
    repo.settleJoinRequestToMember.mockResolvedValue({
      outcome: "COMMUNITY_UNAVAILABLE",
    });
    const res = await communityService.bulkApproveJoinRequests(CID, OWNER, [
      R1,
      R2,
    ]);
    expect(res.approved).toEqual([]);
    expect(res.skipped.sort()).toEqual([R1, R2].sort());
    expect(pubApproved).not.toHaveBeenCalled();
  });

  it("bulk Reject never overwrites a request the close expired meanwhile", async () => {
    repo.findJoinRequestsByIds.mockResolvedValue([
      pending(R1, U1),
      pending(R2, U2),
    ]);
    // R1 was expired between the read and the write; R2 is still pending.
    repo.settlePendingJoinRequest.mockImplementation(async (id: string) =>
      id === R1 ? null : pending(R2, U2, { status: "REJECTED" })
    );
    const res = await communityService.bulkRejectJoinRequests(CID, OWNER, [
      R1,
      R2,
    ]);
    expect(res.rejected).toEqual([R2]);
    expect(res.skipped).toContain(R1);
    expect(pubRejected).toHaveBeenCalledTimes(1);
    expect(pubRejected.mock.calls[0][0].userId).toBe(U2);
  });
});

// ===========================================================================
// A request filed while the community is being closed
// ===========================================================================
describe("createJoinRequest racing a close", () => {
  beforeEach(() => {
    repo.findMemberByUserId.mockResolvedValue(null);
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue(null);
    repo.createJoinRequest.mockResolvedValue(pending(R1, U1));
  });

  it("a request that lands after the close committed is expired on the spot, never announced", async () => {
    repo.findById.mockResolvedValueOnce(open).mockResolvedValue(closed);
    await expect(
      communityService.createJoinRequest(CID, U1, null)
    ).rejects.toMatchObject({ message: "COMMUNITY_IS_CLOSED" });

    expect(repo.settlePendingJoinRequest).toHaveBeenCalledWith(
      R1,
      expect.objectContaining({ status: "EXPIRED" })
    );
    expect(pubRequested).not.toHaveBeenCalled();
  });

  it("…and after a delete, the same with COMMUNITY_NOT_FOUND", async () => {
    repo.findById.mockResolvedValueOnce(open).mockResolvedValue(null);
    await expect(
      communityService.createJoinRequest(CID, U1, null)
    ).rejects.toMatchObject({ message: "COMMUNITY_NOT_FOUND" });
    expect(repo.settlePendingJoinRequest).toHaveBeenCalledWith(
      R1,
      expect.objectContaining({ status: "EXPIRED" })
    );
    expect(pubRequested).not.toHaveBeenCalled();
  });

  it("a request on an open community is unaffected", async () => {
    await expect(
      communityService.createJoinRequest(CID, U1, null)
    ).resolves.toMatchObject({ status: "PENDING" });
    expect(repo.settlePendingJoinRequest).not.toHaveBeenCalled();
    expect(pubRequested).toHaveBeenCalledTimes(1);
  });
});
