/**
 * Repository half of PRIVATE → PUBLIC auto-resolve and of the conditional
 * request transitions. Runs the REAL repository against a mocked Prisma
 * boundary and pins the shape that makes the writes race-safe:
 *   - the request is CLAIMED with a status-conditional write inside the same
 *     interactive transaction as the membership write;
 *   - a banned member aborts the transaction (the claim rolls back);
 *   - cancel / reject / approve-fallback only move a request that is STILL
 *     PENDING, so nothing overwrites a terminal state.
 */

jest.unmock("../../src/repositories/community.repository.js");

const communityUpdateMany = jest.fn();
const joinRequestUpdateMany = jest.fn();
const joinRequestUpdate = jest.fn();
const joinRequestFindUnique = jest.fn();
const joinRequestFindMany = jest.fn();
const memberFindUnique = jest.fn();
const memberCreate = jest.fn();
const memberUpdate = jest.fn();
const muteDeleteMany = jest.fn();
const warningDeleteMany = jest.fn();

const txClient = {
  community: { updateMany: communityUpdateMany },
  communityJoinRequest: {
    updateMany: joinRequestUpdateMany,
    update: joinRequestUpdate,
  },
  communityMember: {
    findUnique: memberFindUnique,
    create: memberCreate,
    update: memberUpdate,
  },
  communityMemberMute: { deleteMany: muteDeleteMany },
  communityMemberWarning: { deleteMany: warningDeleteMany },
};

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    // Interactive form: run the callback against the tx client; a throw inside
    // it is what rolls the whole unit back in Prisma.
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(txClient),
    communityJoinRequest: {
      updateMany: (...a: unknown[]) => joinRequestUpdateMany(...a),
      findUnique: (...a: unknown[]) => joinRequestFindUnique(...a),
      findMany: (...a: unknown[]) => joinRequestFindMany(...a),
    },
  },
}));

jest.mock("../../src/messaging/publish-community-chat.js", () => ({
  publishCommunityMemberSyncedForChatSafe: jest.fn(),
  publishCommunityMemberMuteSyncedForChatSafe: jest.fn(),
}));

import { communityRepository } from "../../src/repositories/community.repository.js";
import { publishCommunityMemberSyncedForChatSafe } from "../../src/messaging/publish-community-chat.js";

const CID = "c".repeat(24);
const U = "99999999-9999-4999-8999-999999999999";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const RID = "r".repeat(24);
const snapshot = {
  snapshotUsername: "u",
  snapshotDisplayName: "U",
  snapshotAvatarKey: null,
};
const args = {
  requestId: RID,
  communityId: CID,
  userId: U,
  snapshot,
  status: "AUTO_RESOLVED" as never,
  resolvedBy: ADMIN,
  inviteCode: "code1",
};

beforeEach(() => {
  jest.clearAllMocks();
  communityUpdateMany.mockResolvedValue({ count: 1 });
  joinRequestUpdateMany.mockResolvedValue({ count: 1 });
  muteDeleteMany.mockResolvedValue({ count: 0 });
  warningDeleteMany.mockResolvedValue({ count: 0 });
});

describe("settleJoinRequestToMember", () => {
  it("claims the request only while PENDING, as AUTO_RESOLVED by the admin", async () => {
    memberFindUnique.mockResolvedValue(null);
    memberCreate.mockResolvedValue({ userId: U, role: "MEMBER" });

    const res = await communityRepository.settleJoinRequestToMember(args);

    expect(res.outcome).toBe("ACTIVATED");
    expect(joinRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: RID, status: "PENDING" },
      data: expect.objectContaining({
        status: "AUTO_RESOLVED",
        decidedBy: ADMIN,
      }),
    });
    expect(memberCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        communityId: CID,
        userId: U,
        status: "ACTIVE",
        role: "MEMBER",
        joinedViaInviteCode: "code1",
      }),
    });
    expect(publishCommunityMemberSyncedForChatSafe).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when a concurrent cancel/reject/approve already settled it", async () => {
    joinRequestUpdateMany.mockResolvedValue({ count: 0 });
    const res = await communityRepository.settleJoinRequestToMember(args);
    expect(res.outcome).toBe("NOT_PENDING");
    expect(memberFindUnique).not.toHaveBeenCalled();
    expect(memberCreate).not.toHaveBeenCalled();
  });

  it("aborts (rolls the claim back) for a BANNED member — a privacy change never lifts a ban", async () => {
    memberFindUnique.mockResolvedValue({ userId: U, status: "BANNED" });
    const res = await communityRepository.settleJoinRequestToMember(args);
    expect(res.outcome).toBe("BANNED");
    expect(memberCreate).not.toHaveBeenCalled();
    expect(memberUpdate).not.toHaveBeenCalled();
    expect(publishCommunityMemberSyncedForChatSafe).not.toHaveBeenCalled();
  });

  it("an already-ACTIVE member just closes the request — no membership write", async () => {
    memberFindUnique.mockResolvedValue({ userId: U, status: "ACTIVE" });
    const res = await communityRepository.settleJoinRequestToMember(args);
    expect(res.outcome).toBe("ALREADY_MEMBER");
    expect(memberCreate).not.toHaveBeenCalled();
    expect(memberUpdate).not.toHaveBeenCalled();
  });

  it("a LEFT/removed member gets a fresh cycle via the guarded update", async () => {
    memberFindUnique.mockResolvedValue({ userId: U, status: "LEFT" });
    memberUpdate.mockResolvedValue({ userId: U, role: "MEMBER" });
    const res = await communityRepository.settleJoinRequestToMember(args);
    expect(res.outcome).toBe("ACTIVATED");
    const call = memberUpdate.mock.calls[0][0];
    expect(call.where).toEqual({
      communityId_userId: { communityId: CID, userId: U },
      status: { not: "ACTIVE" },
    });
    expect(call.data).toMatchObject({
      status: "ACTIVE",
      role: "MEMBER",
      joinedViaInviteCode: "code1",
      removedAt: { unset: true },
    });
    expect(muteDeleteMany).toHaveBeenCalled();
    expect(warningDeleteMany).toHaveBeenCalled();
  });

  it("propagates a write conflict so the caller treats it as 'someone else settled it'", async () => {
    memberFindUnique.mockResolvedValue(null);
    memberCreate.mockRejectedValue(
      Object.assign(new Error("dup"), { code: "P2002" })
    );
    await expect(
      communityRepository.settleJoinRequestToMember(args)
    ).rejects.toThrow("dup");
    expect(publishCommunityMemberSyncedForChatSafe).not.toHaveBeenCalled();
  });
});

describe("settleJoinRequestToMember — community guard (close/delete race)", () => {
  it("guards on an OPEN community with a write, before touching the request", async () => {
    memberFindUnique.mockResolvedValue(null);
    memberCreate.mockResolvedValue({ userId: U, role: "MEMBER" });
    await communityRepository.settleJoinRequestToMember(args);

    const guard = communityUpdateMany.mock.calls[0][0];
    expect(guard.where).toEqual({
      id: CID,
      deletedAt: { isSet: false },
      status: { not: "CLOSED" },
      moderationStatus: { not: "SUSPENDED" },
    });
    // A write, not a read: that is what makes a concurrent close conflict.
    expect(guard.data).toHaveProperty("updatedAt");
    expect(communityUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      joinRequestUpdateMany.mock.invocationCallOrder[0]
    );
  });

  it("closed or deleted → COMMUNITY_UNAVAILABLE: request untouched, nobody admitted", async () => {
    communityUpdateMany.mockResolvedValue({ count: 0 });
    const res = await communityRepository.settleJoinRequestToMember({
      ...args,
      status: "APPROVED" as never,
    });
    expect(res.outcome).toBe("COMMUNITY_UNAVAILABLE");
    expect(joinRequestUpdateMany).not.toHaveBeenCalled();
    expect(memberCreate).not.toHaveBeenCalled();
    expect(memberUpdate).not.toHaveBeenCalled();
    expect(publishCommunityMemberSyncedForChatSafe).not.toHaveBeenCalled();
  });

  it("an approve that finds the user already ACTIVE records AUTO_RESOLVED, not APPROVED", async () => {
    memberFindUnique.mockResolvedValue({ userId: U, status: "ACTIVE" });
    const res = await communityRepository.settleJoinRequestToMember({
      ...args,
      status: "APPROVED" as never,
    });
    expect(res.outcome).toBe("ALREADY_MEMBER");
    expect(joinRequestUpdate).toHaveBeenCalledWith({
      where: { id: RID },
      data: { status: "AUTO_RESOLVED" },
    });
  });

  it("retries a write conflict (P2034) and lands on the re-read truth", async () => {
    // First attempt conflicts with a concurrent close; the retry sees it closed.
    communityUpdateMany
      .mockRejectedValueOnce(
        Object.assign(new Error("conflict"), { code: "P2034" })
      )
      .mockResolvedValueOnce({ count: 0 });
    const res = await communityRepository.settleJoinRequestToMember(args);
    expect(res.outcome).toBe("COMMUNITY_UNAVAILABLE");
    expect(communityUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 conflicting attempts instead of looping", async () => {
    communityUpdateMany.mockRejectedValue(
      Object.assign(new Error("conflict"), { code: "P2034" })
    );
    await expect(
      communityRepository.settleJoinRequestToMember(args)
    ).rejects.toThrow("conflict");
    expect(communityUpdateMany).toHaveBeenCalledTimes(3);
  });
});

describe("settlePendingJoinRequest", () => {
  it("moves the row only while PENDING and returns it", async () => {
    joinRequestFindUnique.mockResolvedValue({ id: RID, status: "CANCELLED" });
    const row = await communityRepository.settlePendingJoinRequest(RID, {
      status: "CANCELLED" as never,
      decidedBy: U,
      decidedAt: new Date(),
    });
    expect(joinRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: RID, status: "PENDING" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(row).toEqual({ id: RID, status: "CANCELLED" });
  });

  it("returns null (and never overwrites) once the request is terminal", async () => {
    joinRequestUpdateMany.mockResolvedValue({ count: 0 });
    const row = await communityRepository.settlePendingJoinRequest(RID, {
      status: "REJECTED" as never,
      decidedBy: ADMIN,
      decidedAt: new Date(),
    });
    expect(row).toBeNull();
    expect(joinRequestFindUnique).not.toHaveBeenCalled();
  });
});

describe("expirePendingJoinRequests (close / suspend / delete sweep)", () => {
  it("moves only PENDING rows to EXPIRED and returns exactly the ones THIS call moved", async () => {
    joinRequestUpdateMany.mockResolvedValue({ count: 2 });
    joinRequestFindMany.mockResolvedValue([
      { id: "r1", userId: "u1" },
      { id: "r2", userId: "u2" },
    ]);
    const rows = await communityRepository.expirePendingJoinRequests(
      CID,
      ADMIN
    );

    const write = joinRequestUpdateMany.mock.calls[0][0];
    expect(write.where).toEqual({ communityId: CID, status: "PENDING" });
    expect(write.data).toMatchObject({ status: "EXPIRED", decidedBy: ADMIN });
    // Read back by the stamp this call wrote — never a row expired earlier.
    expect(joinRequestFindMany.mock.calls[0][0].where).toEqual({
      communityId: CID,
      status: "EXPIRED",
      decidedAt: write.data.decidedAt,
    });
    expect(rows.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("a repeat (nothing PENDING left) is a no-op with no read-back", async () => {
    joinRequestUpdateMany.mockResolvedValue({ count: 0 });
    const rows = await communityRepository.expirePendingJoinRequests(
      CID,
      ADMIN
    );
    expect(rows).toEqual([]);
    expect(joinRequestFindMany).not.toHaveBeenCalled();
  });
});
