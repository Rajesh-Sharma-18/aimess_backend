/**
 * Section D3: the membership write and the join-request resolution must commit
 * as ONE unit. If they were two sequential writes there would be a window — however
 * short — in which a user is already a member AND still holds a PENDING request
 * an admin could accept, which is exactly the bug this work closes.
 *
 * These tests run the REAL repository against a mocked Prisma boundary and assert
 * the two operations are handed to a single `$transaction` call, in the right
 * shape. A failure between them therefore rolls both back: there is no code path
 * that can write one without the other.
 *
 * `tests/setup/global-mocks.ts` auto-mocks the whole repository module for every
 * suite, so `jest.unmock` opts this file back into the real implementation.
 */

jest.unmock("../../src/repositories/community.repository.js");

const tx = jest.fn();
const memberCreate = jest.fn();
const memberCreateMany = jest.fn();
const memberUpdate = jest.fn();
const muteDeleteMany = jest.fn();
const warningDeleteMany = jest.fn();
const joinRequestUpdateMany = jest.fn();
const joinRequestFindMany = jest.fn();

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => tx(...args),
    communityMember: {
      create: (...a: unknown[]) => memberCreate(...a),
      createMany: (...a: unknown[]) => memberCreateMany(...a),
      update: (...a: unknown[]) => memberUpdate(...a),
    },
    communityMemberMute: { deleteMany: (...a: unknown[]) => muteDeleteMany(...a) },
    communityMemberWarning: {
      deleteMany: (...a: unknown[]) => warningDeleteMany(...a),
    },
    communityJoinRequest: {
      updateMany: (...a: unknown[]) => joinRequestUpdateMany(...a),
      findMany: (...a: unknown[]) => joinRequestFindMany(...a),
    },
  },
}));

jest.mock("../../src/messaging/publish-community-chat.js", () => ({
  publishCommunityMemberSyncedForChatSafe: jest.fn(),
  publishCommunityMemberMuteSyncedForChatSafe: jest.fn(),
  publishCommunityMemberMuteRetractedForChatSafe: jest.fn(),
  publishCommunitySystemMessageForChatSafe: jest.fn(),
  publishCommunityCreatedForChatSafe: jest.fn(),
  publishCommunityDeletedForChatSafe: jest.fn(),
  publishCommunityMetaSyncedForChatSafe: jest.fn(),
  publishCommunityStatusChangedForChatSafe: jest.fn(),
  publishCommunityVisibilityChangedForChatSafe: jest.fn(),
  publishCommunityInviteLinkSharedForChatSafe: jest.fn(),
}));

import { communityRepository } from "../../src/repositories/community.repository.js";

const CID = "c".repeat(24);
const B = "99999999-9999-4999-8999-999999999999";
const ADMIN = "11111111-1111-4111-8111-111111111111";

/** Marker objects standing in for the (lazy) Prisma operations. */
const CREATE_OP = { __op: "member.create" };
const CREATE_MANY_OP = { __op: "member.createMany" };
const UPDATE_OP = { __op: "member.update" };
const MUTE_OP = { __op: "mute.deleteMany" };
const WARN_OP = { __op: "warning.deleteMany" };
const RESOLVE_OP = { __op: "joinRequest.updateMany" };

const memberFixture = { userId: B, role: "MEMBER", joinedAt: new Date() };

beforeEach(() => {
  jest.clearAllMocks();
  memberCreate.mockReturnValue(CREATE_OP);
  memberCreateMany.mockReturnValue(CREATE_MANY_OP);
  memberUpdate.mockReturnValue(UPDATE_OP);
  muteDeleteMany.mockReturnValue(MUTE_OP);
  warningDeleteMany.mockReturnValue(WARN_OP);
  joinRequestUpdateMany.mockReturnValue(RESOLVE_OP);
  // Batch $transaction resolves an array of results, positionally.
  tx.mockImplementation(async (ops: unknown[]) =>
    ops.map((op) =>
      op === CREATE_OP || op === UPDATE_OP
        ? memberFixture
        : { count: op === RESOLVE_OP ? 1 : 0 }
    )
  );
});

/** The single argument array handed to `$transaction`. */
const txOps = () => tx.mock.calls[0][0] as unknown[];

describe("createMember", () => {
  it("D3: membership insert and request resolution go into ONE transaction", async () => {
    await communityRepository.createMember(
      {
        communityId: CID,
        userId: B,
        role: "MEMBER" as never,
        status: "ACTIVE" as never,
        snapshotUsername: "b",
        snapshotDisplayName: "B",
        snapshotAvatarKey: null,
      },
      ADMIN
    );

    expect(tx).toHaveBeenCalledTimes(1);
    expect(txOps()).toEqual([CREATE_OP, RESOLVE_OP]);
  });

  it("resolves ONLY this user's PENDING rows in THIS community, stamped with the actor", async () => {
    await communityRepository.createMember(
      {
        communityId: CID,
        userId: B,
        role: "MEMBER" as never,
        status: "ACTIVE" as never,
        snapshotUsername: "b",
        snapshotDisplayName: "B",
        snapshotAvatarKey: null,
      },
      ADMIN
    );

    expect(joinRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        communityId: CID,
        userId: { in: [B] },
        // Only PENDING: a request another path already decided is left alone,
        // which is what makes concurrent activations collapse to one outcome.
        status: "PENDING",
      },
      data: {
        status: "AUTO_RESOLVED",
        decidedBy: ADMIN,
        decidedAt: expect.any(Date),
      },
    });
  });

  it("defaults the resolver to the member themself for self-service joins", async () => {
    await communityRepository.createMember({
      communityId: CID,
      userId: B,
      role: "MEMBER" as never,
      status: "ACTIVE" as never,
      snapshotUsername: "b",
      snapshotDisplayName: "B",
      snapshotAvatarKey: null,
    });

    expect(joinRequestUpdateMany.mock.calls[0][0].data.decidedBy).toBe(B);
  });

  it("a failing transaction writes neither side", async () => {
    tx.mockRejectedValue(new Error("write conflict"));

    await expect(
      communityRepository.createMember({
        communityId: CID,
        userId: B,
        role: "MEMBER" as never,
        status: "ACTIVE" as never,
        snapshotUsername: "b",
        snapshotDisplayName: "B",
        snapshotAvatarKey: null,
      })
    ).rejects.toThrow("write conflict");

    // Both operations were only ever handed to the transaction — neither was
    // awaited on its own, so there is nothing to half-commit.
    expect(tx).toHaveBeenCalledTimes(1);
    expect(txOps()).toEqual([CREATE_OP, RESOLVE_OP]);
  });
});

describe("reactivateMemberWithSnapshot", () => {
  it("D3: rejoin reactivation carries the request resolution in the same transaction", async () => {
    tx.mockResolvedValue([memberFixture, { count: 0 }, { count: 0 }, { count: 1 }]);

    await communityRepository.reactivateMemberWithSnapshot(
      CID,
      B,
      {
        snapshotUsername: "b",
        snapshotDisplayName: "B",
        snapshotAvatarKey: null,
      },
      ADMIN
    );

    expect(tx).toHaveBeenCalledTimes(1);
    expect(txOps()).toEqual([UPDATE_OP, MUTE_OP, WARN_OP, RESOLVE_OP]);
    expect(joinRequestUpdateMany.mock.calls[0][0].data.decidedBy).toBe(ADMIN);
  });
});

describe("createManyMembers", () => {
  it("D3: bulk insert resolves every inserted user's request in the same transaction", async () => {
    tx.mockResolvedValue([{ count: 2 }, { count: 1 }]);

    await communityRepository.createManyMembers(
      CID,
      [
        {
          userId: B,
          role: "MEMBER" as never,
          status: "ACTIVE" as never,
          snapshotUsername: "b",
          snapshotDisplayName: "B",
          snapshotAvatarKey: null,
        },
        {
          userId: ADMIN,
          role: "ADMIN" as never,
          status: "ACTIVE" as never,
          snapshotUsername: "a",
          snapshotDisplayName: "A",
          snapshotAvatarKey: null,
        },
      ],
      ADMIN
    );

    expect(txOps()).toEqual([CREATE_MANY_OP, RESOLVE_OP]);
    expect(joinRequestUpdateMany.mock.calls[0][0].where.userId).toEqual({
      in: [B, ADMIN],
    });
  });
});

describe("resolvePendingJoinRequests (repair path)", () => {
  it("is a no-op query when there is nothing to repair", async () => {
    await expect(
      communityRepository.resolvePendingJoinRequests(CID, [], ADMIN)
    ).resolves.toEqual({ count: 0 });
    expect(joinRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("uses the same PENDING-guarded update as the atomic path", async () => {
    await communityRepository.resolvePendingJoinRequests(CID, [B], ADMIN);

    expect(joinRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PENDING" }),
        data: expect.objectContaining({ status: "AUTO_RESOLVED" }),
      })
    );
    // Repair rides alone — it has no membership write to be atomic with.
    expect(tx).not.toHaveBeenCalled();
  });
});

describe("findPendingJoinRequestsForUsers", () => {
  it("skips the query entirely for an empty candidate list", async () => {
    await expect(
      communityRepository.findPendingJoinRequestsForUsers(CID, [])
    ).resolves.toEqual([]);
    expect(joinRequestFindMany).not.toHaveBeenCalled();
  });

  it("returns id + userId for the community's PENDING rows only", async () => {
    joinRequestFindMany.mockResolvedValue([{ id: "r1", userId: B }]);

    await expect(
      communityRepository.findPendingJoinRequestsForUsers(CID, [B])
    ).resolves.toEqual([{ id: "r1", userId: B }]);

    expect(joinRequestFindMany).toHaveBeenCalledWith({
      where: { communityId: CID, userId: { in: [B] }, status: "PENDING" },
      select: { id: true, userId: true },
    });
  });
});
