import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";

/** WHERE clause for pending requests, filtered by direction relative to `userId`. */
function pendingRequestsWhere(
  userId: string,
  direction: "incoming" | "outgoing" | "all"
): Prisma.FriendshipWhereInput {
  if (direction === "incoming") {
    return { status: "PENDING", addresseeId: userId };
  }
  if (direction === "outgoing") {
    return { status: "PENDING", requesterId: userId };
  }
  return {
    status: "PENDING",
    OR: [{ requesterId: userId }, { addresseeId: userId }],
  };
}

/**
 * Max direct friends used as seeds when expanding the friend-of-friend set.
 * Bounds the worst-case row count of a single one-hop expansion; a viewer with
 * more friends than this gets FoF resolved from their first N friendships,
 * which can only ever UNDER-admit (never leak).
 */
const FRIEND_EXPANSION_CAP = 1000;

const FRIENDSHIP_SELECT = {
  id: true,
  requesterId: true,
  addresseeId: true,
  status: true,
  acceptedAt: true,
  firstAcceptedAt: true,
  rejectedAt: true,
  cancelledAt: true,
  unfriendedAt: true,
  unfriendedBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

type FriendshipRow = Prisma.FriendshipGetPayload<{
  select: typeof FRIENDSHIP_SELECT;
}>;

export const friendshipRepository = {
  findById(id: string) {
    return prisma.friendship.findUnique({
      where: { id },
      select: FRIENDSHIP_SELECT,
    });
  },

  /** Find any friendship row for the pair, regardless of who sent it. */
  findByPair(userA: string, userB: string) {
    return prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: userA, addresseeId: userB },
          { requesterId: userB, addresseeId: userA },
        ],
      },
      select: FRIENDSHIP_SELECT,
    });
  },

  /** Find an ACCEPTED friendship for a pair — used to validate unfriend. */
  findActivePair(userA: string, userB: string) {
    return prisma.friendship.findFirst({
      where: {
        status: "ACCEPTED",
        OR: [
          { requesterId: userA, addresseeId: userB },
          { requesterId: userB, addresseeId: userA },
        ],
      },
      select: FRIENDSHIP_SELECT,
    });
  },

  create(requesterId: string, addresseeId: string) {
    return prisma.friendship.create({
      data: { requesterId, addresseeId, status: "PENDING" },
      select: FRIENDSHIP_SELECT,
    });
  },

  /**
   * Reset an existing row to PENDING with a new requester/addressee.
   * Used when re-sending after REJECTED / CANCELLED / UNFRIENDED.
   *
   * `firstAcceptedAt` is deliberately NOT reset — it is the only record that
   * this pair was ever friends, and the recycled row is the same relationship.
   */
  resetToPending(id: string, requesterId: string, addresseeId: string) {
    return prisma.friendship.update({
      where: { id },
      data: {
        requesterId,
        addresseeId,
        status: "PENDING",
        acceptedAt: null,
        rejectedAt: null,
        cancelledAt: null,
        unfriendedAt: null,
        unfriendedBy: null,
        createdAt: new Date(),
      },
      select: FRIENDSHIP_SELECT,
    });
  },

  /** Accept a pending request: PENDING → ACCEPTED + bump friendsCount on both sides. */
  acceptWithCounters(id: string, requesterId: string, addresseeId: string) {
    const now = new Date();
    return prisma.$transaction([
      prisma.friendship.update({
        where: { id },
        data: { status: "ACCEPTED", acceptedAt: now },
        select: FRIENDSHIP_SELECT,
      }),
      prisma.userProfile.update({
        where: { userId: requesterId },
        data: { friendsCount: { increment: 1 } },
        select: { userId: true, friendsCount: true },
      }),
      prisma.userProfile.update({
        where: { userId: addresseeId },
        data: { friendsCount: { increment: 1 } },
        select: { userId: true, friendsCount: true },
      }),
      // Stamp the pair's FIRST-EVER acceptance, once. `where.firstAcceptedAt:
      // null` makes it write-once without a read: a re-friendship leaves the
      // original timestamp alone, so the flag survives every later
      // `resetToPending` (which nulls `acceptedAt`) and every unfriend cycle.
      // Callers read the PRE-accept value to decide first-time vs re-friend,
      // so the row returned at index 0 not carrying it is deliberate.
      prisma.friendship.updateMany({
        where: { id, firstAcceptedAt: null },
        data: { firstAcceptedAt: now },
      }),
    ]);
  },

  reject(id: string) {
    return prisma.friendship.update({
      where: { id },
      data: { status: "REJECTED", rejectedAt: new Date() },
      select: FRIENDSHIP_SELECT,
    });
  },

  cancel(id: string) {
    return prisma.friendship.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: FRIENDSHIP_SELECT,
    });
  },

  /** Unfriend: ACCEPTED → UNFRIENDED + decrement friendsCount on both sides. */
  unfriendWithCounters(
    id: string,
    unfriendedById: string,
    requesterId: string,
    addresseeId: string
  ) {
    const now = new Date();
    return prisma.$transaction([
      prisma.friendship.update({
        where: { id },
        data: {
          status: "UNFRIENDED",
          unfriendedAt: now,
          unfriendedBy: unfriendedById,
        },
        select: FRIENDSHIP_SELECT,
      }),
      prisma.userProfile.update({
        where: { userId: requesterId },
        data: { friendsCount: { decrement: 1 } },
        select: { userId: true, friendsCount: true },
      }),
      prisma.userProfile.update({
        where: { userId: addresseeId },
        data: { friendsCount: { decrement: 1 } },
        select: { userId: true, friendsCount: true },
      }),
    ]);
  },

  /**
   * Creates N ACCEPTED friendship rows in a single atomic transaction. All pairs
   * must share the same requesterId (the calling user). Uses createMany + bulk
   * counter updates so the total DB round-trips are O(1) regardless of batch size.
   *
   * skipDuplicates: true makes the batch idempotent against concurrent inserts for
   * the same (requesterId, addresseeId) pair.
   */
  async autoAcceptBatch(
    pairs: { requesterId: string; addresseeId: string }[]
  ): Promise<FriendshipRow[]> {
    if (pairs.length === 0) return [];
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const requesterId = pairs[0].requesterId;
      const addresseeIds = pairs.map((p) => p.addresseeId);

      // 1. Batch-insert all friendship rows (skip any duplicate from a concurrent request).
      await tx.friendship.createMany({
        data: pairs.map(({ addresseeId }) => ({
          requesterId,
          addresseeId,
          status: "ACCEPTED",
          acceptedAt: now,
          firstAcceptedAt: now,
        })),
        skipDuplicates: true,
      });

      // 2. Increment counters in bulk: requester once by N, each addressee once by 1.
      await Promise.all([
        tx.userProfile.update({
          where: { userId: requesterId },
          data: { friendsCount: { increment: pairs.length } },
          select: { userId: true },
        }),
        tx.userProfile.updateMany({
          where: { userId: { in: addresseeIds } },
          data: { friendsCount: { increment: 1 } },
        }),
      ]);

      // 3. Return the inserted rows so callers can read IDs for event publishing.
      return tx.friendship.findMany({
        where: {
          requesterId,
          addresseeId: { in: addresseeIds },
          status: "ACCEPTED",
        },
        select: FRIENDSHIP_SELECT,
      });
    });
  },

  /**
   * Bulk-unfriends N ACCEPTED friendship rows belonging to `userId` in one
   * atomic transaction — the disconnect-side mirror of {@link autoAcceptBatch}
   * (updateMany + counter decrement instead of createMany + counter increment).
   * `peerIds` is the parallel other-side-userId array for `friendshipIds`
   * (index-for-index), used only for the bulk per-peer counter decrement.
   * Returns the number of rows actually flipped to UNFRIENDED (may be less
   * than `friendshipIds.length` if a row was concurrently unfriended first).
   */
  async autoDisconnectBatch(
    userId: string,
    friendshipIds: string[],
    peerIds: string[]
  ): Promise<number> {
    if (friendshipIds.length === 0) return 0;
    return prisma.$transaction(async (tx) => {
      const now = new Date();

      const { count } = await tx.friendship.updateMany({
        where: { id: { in: friendshipIds }, status: "ACCEPTED" },
        data: { status: "UNFRIENDED", unfriendedAt: now, unfriendedBy: userId },
      });

      await Promise.all([
        tx.userProfile.update({
          where: { userId },
          data: { friendsCount: { decrement: count } },
          select: { userId: true },
        }),
        tx.userProfile.updateMany({
          where: { userId: { in: peerIds } },
          data: { friendsCount: { decrement: 1 } },
        }),
      ]);

      return count;
    });
  },

  /**
   * One batch of a PLATFORM-WIDE disconnect sweep (admin-triggered, see
   * `friendshipService.disconnectAllPlatform`): flips up to `batchSize`
   * ACCEPTED friendships anywhere on the platform to UNFRIENDED
   * (`unfriendedBy: null` — no single initiating user, this is a system
   * sweep) and decrements BOTH sides' `friendsCount` by 1 each. Unlike
   * {@link autoDisconnectBatch}, there is no shared `userId` here — every row
   * has two independent users, so a user appearing in more than one row this
   * batch gets decremented once per row.
   *
   * No cursor needed: since matched rows leave the ACCEPTED set immediately,
   * repeatedly calling this with `status: "ACCEPTED"` naturally drains the
   * whole table without ever revisiting a row. Returns `[]` once nothing is
   * left — the caller's loop condition.
   */
  async disconnectAllAcceptedBatch(
    batchSize: number
  ): Promise<Array<{ id: string; requesterId: string; addresseeId: string }>> {
    const rows = await prisma.friendship.findMany({
      where: { status: "ACCEPTED" },
      take: batchSize,
      select: { id: true, requesterId: true, addresseeId: true },
    });
    if (rows.length === 0) return [];

    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const ids = rows.map((r) => r.id);

      await tx.friendship.updateMany({
        where: { id: { in: ids }, status: "ACCEPTED" },
        data: { status: "UNFRIENDED", unfriendedAt: now, unfriendedBy: null },
      });
      // A concurrent unfriend/block on one of these ids between the read and
      // this updateMany is the same rare race autoDisconnectBatch accepts for
      // its peer-side decrement (unconditional -1 per requested peer, not
      // per row actually flipped) — mirrored here rather than re-querying
      // which exact ids landed, since `friendsCount` is a display counter,
      // not a source of truth.
      const decrementByUser = new Map<string, number>();
      for (const r of rows) {
        decrementByUser.set(
          r.requesterId,
          (decrementByUser.get(r.requesterId) ?? 0) + 1
        );
        decrementByUser.set(
          r.addresseeId,
          (decrementByUser.get(r.addresseeId) ?? 0) + 1
        );
      }
      await Promise.all(
        [...decrementByUser.entries()].map(([userId, dec]) =>
          tx.userProfile.update({
            where: { userId },
            data: { friendsCount: { decrement: dec } },
            select: { userId: true },
          })
        )
      );

      return rows;
    });
  },

  /** All ACCEPTED friendships for a user — returns peer userId + friendship id. */
  findAcceptedFriends(userId: string) {
    return prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      select: {
        id: true,
        requesterId: true,
        addresseeId: true,
        acceptedAt: true,
      },
    });
  },

  /** All friendship rows for a user (any status) — used for relationship labelling in discovery. */
  findAllForUser(userId: string) {
    return prisma.friendship.findMany({
      where: {
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      select: { id: true, requesterId: true, addresseeId: true, status: true },
    });
  },

  /**
   * Friendship rows between `callerId` and any of `candidateIds` (either
   * direction), plus the ids `callerId` has personally blocked — the two
   * reads the gRPC `CheckFriendships` relationship contract needs. Bounded by
   * caller (candidateIds is capped upstream, same as
   * {@link findAcceptedFriendIdsForUser}).
   *
   * `blockedIds` is directional (`callerId` → candidate) ONLY — it feeds
   * `buildFriendshipView`'s `isBlockedByViewer`, which must answer "did THIS
   * viewer block them", never "is there a block somewhere in this pair".
   * Including the reverse direction (candidate blocked callerId) would make
   * the blocked party's own relationship view come back BLOCKED too, which is
   * exactly the symmetric-block bug this method must not reintroduce.
   */
  async findRelationshipsForUser(
    callerId: string,
    candidateIds: string[]
  ): Promise<{
    rows: FriendshipRow[];
    blockedIds: Set<string>;
    /**
     * Candidates who blocked the CALLER. Deliberately kept apart from
     * `blockedIds`: the viewer-facing relationship status must never reveal an
     * incoming block (that is why `blockedIds` is one-directional). Only
     * action gates that must fail either way — invite sending — read this.
     */
    blockedByIds: Set<string>;
  }> {
    if (candidateIds.length === 0) {
      return { rows: [], blockedIds: new Set(), blockedByIds: new Set() };
    }
    const [rows, blocks, incomingBlocks] = await Promise.all([
      prisma.friendship.findMany({
        where: {
          OR: [
            { requesterId: callerId, addresseeId: { in: candidateIds } },
            { addresseeId: callerId, requesterId: { in: candidateIds } },
          ],
        },
        select: FRIENDSHIP_SELECT,
      }),
      prisma.block.findMany({
        where: { blockerId: callerId, blockedId: { in: candidateIds } },
        select: { blockedId: true },
      }),
      prisma.block.findMany({
        where: { blockedId: callerId, blockerId: { in: candidateIds } },
        select: { blockerId: true },
      }),
    ]);
    const blockedIds = new Set(blocks.map((b) => b.blockedId));
    const blockedByIds = new Set(incomingBlocks.map((b) => b.blockerId));
    return { rows, blockedIds, blockedByIds };
  },

  /**
   * Returns the subset of `candidateIds` that are ACCEPTED friends with `callerId`,
   * regardless of who sent the original request. Bounded by caller (≤500 ids).
   * Used by community-service for server-side friend validation on add-members.
   */
  async findAcceptedFriendIdsForUser(
    callerId: string,
    candidateIds: string[]
  ): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const rows = await prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [
          { requesterId: callerId, addresseeId: { in: candidateIds } },
          { addresseeId: callerId, requesterId: { in: candidateIds } },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });
    const friends = new Set<string>();
    for (const r of rows) {
      friends.add(r.requesterId === callerId ? r.addresseeId : r.requesterId);
    }
    return [...friends];
  },

  /**
   * Does `userA` share at least one mutual friend with `userB`?
   *
   * This is the `FRIENDS_OF_FRIENDS` predicate: exactly one hop past a direct
   * friend (A↔M↔B). Two hops is NOT friend-of-friend.
   *
   * Pairwise, so it stops at the first mutual friend rather than materialising
   * the whole one-hop set — use this for single-target decisions (friend
   * request, profile read). For filtering a LIST of candidates, use
   * {@link findFriendsOfFriendIds} instead; calling this per row is an N+1.
   */
  async hasMutualFriend(userA: string, userB: string): Promise<boolean> {
    const aRows = await this.findAcceptedFriends(userA);
    const aFriendIds = aRows.map((f) =>
      f.requesterId === userA ? f.addresseeId : f.requesterId
    );
    if (aFriendIds.length === 0) return false;
    const mutual = await prisma.friendship.findFirst({
      where: {
        status: "ACCEPTED",
        OR: [
          { requesterId: userB, addresseeId: { in: aFriendIds } },
          { addresseeId: userB, requesterId: { in: aFriendIds } },
        ],
      },
      select: { id: true },
    });
    return mutual !== null;
  },

  /**
   * One-hop expansion of `viewerFriendIds`: every user who is a friend of one of
   * the viewer's friends, excluding the viewer and their direct friends (those
   * are already known and are handled by the FRIENDS branch).
   *
   * ponytail: expands the whole set in one indexed query and de-dupes in memory.
   * At 500 friends × 500 friends each that is 250k rows — fine at current scale,
   * and `FRIEND_EXPANSION_CAP` bounds the worst case. If the friend graph grows
   * past that, move this to a recursive CTE or a materialised FoF table rather
   * than paging this query.
   */
  async findFriendsOfFriendIds(
    viewerId: string,
    viewerFriendIds: string[]
  ): Promise<string[]> {
    if (viewerFriendIds.length === 0) return [];
    const seeds = viewerFriendIds.slice(0, FRIEND_EXPANSION_CAP);
    const rows = await prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: { in: seeds } }, { addresseeId: { in: seeds } }],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const directFriends = new Set(viewerFriendIds);
    const friendsOfFriends = new Set<string>();
    for (const r of rows) {
      // A row can have BOTH sides in the seed set (two of the viewer's friends
      // are friends with each other) — then neither side is a new FoF.
      if (directFriends.has(r.requesterId)) friendsOfFriends.add(r.addresseeId);
      if (directFriends.has(r.addresseeId)) friendsOfFriends.add(r.requesterId);
    }
    friendsOfFriends.delete(viewerId);
    for (const id of directFriends) friendsOfFriends.delete(id);
    return [...friendsOfFriends];
  },

  /**
   * The viewer's friend graph as every discovery query needs it: direct friends
   * plus their one-hop expansion.
   *
   * Pass `knownFriendIds` when the caller has already loaded them (most search
   * paths have), so this costs ONE extra query per request rather than two.
   */
  async resolveViewerGraph(
    viewerId: string,
    knownFriendIds?: string[]
  ): Promise<{ friendIds: string[]; friendOfFriendIds: string[] }> {
    let friendIds = knownFriendIds;
    if (!friendIds) {
      const rows = await this.findAcceptedFriends(viewerId);
      friendIds = rows.map((f) =>
        f.requesterId === viewerId ? f.addresseeId : f.requesterId
      );
    }
    const friendOfFriendIds = await this.findFriendsOfFriendIds(
      viewerId,
      friendIds
    );
    return { friendIds, friendOfFriendIds };
  },

  /** Pending requests for a user, paginated, newest first. */
  findPendingRequests(params: {
    userId: string;
    direction: "incoming" | "outgoing" | "all";
    skip: number;
    take: number;
  }) {
    return prisma.friendship.findMany({
      where: pendingRequestsWhere(params.userId, params.direction),
      orderBy: { createdAt: "desc" },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        requesterId: true,
        addresseeId: true,
        createdAt: true,
      },
    });
  },

  /** Count of pending requests for a user in the given direction. */
  countPendingRequests(
    userId: string,
    direction: "incoming" | "outgoing" | "all"
  ) {
    return prisma.friendship.count({
      where: pendingRequestsWhere(userId, direction),
    });
  },

  /** All block rows where the user is either blocker or blocked. */
  findAllBlocks(userId: string) {
    return prisma.block.findMany({
      where: {
        OR: [{ blockerId: userId }, { blockedId: userId }],
      },
      select: { blockerId: true, blockedId: true },
    });
  },

  /** Users that `blockerId` has blocked (outgoing blocks only), newest first. */
  findBlockedByUser(blockerId: string) {
    return prisma.block.findMany({
      where: { blockerId },
      select: { blockedId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
  },

  /** Directional lookup — did `blockerId` specifically block `blockedId`? */
  findBlock(blockerId: string, blockedId: string) {
    return prisma.block.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      select: { id: true, blockerId: true, blockedId: true, createdAt: true },
    });
  },

  createBlock(blockerId: string, blockedId: string) {
    return prisma.block.create({
      data: { blockerId, blockedId },
      select: { id: true, blockerId: true, blockedId: true, createdAt: true },
    });
  },

  async deleteBlock(blockerId: string, blockedId: string): Promise<void> {
    await prisma.block.delete({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    });
  },
};
