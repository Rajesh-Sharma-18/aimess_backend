/**
 * Issue #74 — "last activity not updating for fast typing".
 *
 * Five messages typed in a burst are five INDEPENDENT concurrent handlers, so
 * nothing ordered their room-snapshot writes. The unguarded write let message
 * #4 land after message #5 and rewind the conversation's preview/timestamp to
 * an intermediate message, which then survived a refresh because the database
 * itself was wrong.
 *
 * Every FORWARD bump is now conditional on being newer than what is stored,
 * ordered by `seq` — the per-room atomic `$inc`, which is the ordering the
 * clients render the transcript in. `createdAt` is stamped a round trip after
 * the sequence is taken, so a burst genuinely hands out the two in different
 * orders and a timestamp-ordered snapshot previewed a different message from
 * the one at the bottom of the open chat. These tests pin that contract on all
 * three chat-service surfaces plus the shared predicate, and pin the two things
 * the guard must NOT break: an in-place refresh of the message already stored,
 * and the unread counter (a losing race still delivered a real, unread
 * message).
 */
import {
  newerSnapshotWhere,
  newerSnapshotMongoQuery,
} from "../../src/lib/last-activity-guard.js";
import { PrivateRoomRepository } from "../../src/repositories/private-room.repository.js";
import { GroupRoomRepository } from "../../src/repositories/group-room.repository.js";
import { GeneralRoomRepository } from "../../src/repositories/general-room.repository.js";

const AT = new Date("2026-08-13T10:00:00.000Z");

/**
 * Evaluate the Prisma `where` fragment against a stored row, the way MongoDB
 * would: a range filter never matches an absent field, and `{ field: null }` /
 * `{ isSet: false }` are what a row without a stored sequence matches.
 */
function matches(
  where: ReturnType<typeof newerSnapshotWhere>,
  row: { lastMessageAt?: Date | null; lastMessageSeq?: number | null }
): boolean {
  const storedAt = row.lastMessageAt ?? null;
  const storedSeq = row.lastMessageSeq ?? null;
  return where.OR.some((clause) => {
    if ("AND" in clause) {
      // Legacy branch: only a row with NO stored sequence falls through to the
      // timestamp comparison.
      if (storedSeq !== null) return false;
      const [, atClause] = clause.AND;
      return atClause.OR.some((c) =>
        c.lastMessageAt === null
          ? storedAt === null
          : storedAt !== null &&
            storedAt.getTime() <= c.lastMessageAt.lte.getTime()
      );
    }
    return storedSeq !== null && storedSeq <= clause.lastMessageSeq.lte;
  });
}

describe("newerSnapshotWhere — the sequence ordering predicate", () => {
  it("accepts a strictly newer sequence", () => {
    const where = newerSnapshotWhere(new Date(AT.getTime() + 1), 9);
    expect(matches(where, { lastMessageAt: AT, lastMessageSeq: 4 })).toBe(true);
  });

  it("rejects an older sequence — the out-of-order send that caused the bug", () => {
    const where = newerSnapshotWhere(new Date(AT.getTime() - 1), 4);
    expect(matches(where, { lastMessageAt: AT, lastMessageSeq: 5 })).toBe(
      false
    );
  });

  it("REGRESSION: a LATER timestamp with a LOWER sequence loses", () => {
    // The burst inversion itself: send A takes seq 6 and stamps createdAt .408,
    // send B takes seq 5 and stamps .412. B is later on the clock but earlier in
    // the room's real order, and the clients render seq order — so letting B
    // win made the list preview a message that is NOT the bottom of the chat.
    const where = newerSnapshotWhere(new Date(AT.getTime() + 4), 5);
    expect(matches(where, { lastMessageAt: AT, lastMessageSeq: 6 })).toBe(
      false
    );
  });

  it("accepts an EARLIER timestamp when the sequence is higher", () => {
    // The mirror of the case above — seq is the authority in both directions.
    const where = newerSnapshotWhere(new Date(AT.getTime() - 4), 6);
    expect(matches(where, { lastMessageAt: AT, lastMessageSeq: 5 })).toBe(true);
  });

  it("higher seq wins inside one millisecond", () => {
    const where = newerSnapshotWhere(AT, 5);
    expect(matches(where, { lastMessageAt: AT, lastMessageSeq: 4 })).toBe(true);
  });

  it("lower seq is rejected inside one millisecond", () => {
    const where = newerSnapshotWhere(AT, 4);
    expect(matches(where, { lastMessageAt: AT, lastMessageSeq: 5 })).toBe(
      false
    );
  });

  it("allows an IN-PLACE refresh of the exact message already stored", () => {
    // A call card transitioning RINGING→ENDED rewrites the same row with its
    // own createdAt/seq. Two different messages can never share a seq.
    const where = newerSnapshotWhere(AT, 5);
    expect(matches(where, { lastMessageAt: AT, lastMessageSeq: 5 })).toBe(true);
  });

  it("accepts the first message of an empty room (no stored snapshot)", () => {
    const where = newerSnapshotWhere(AT, 1);
    expect(matches(where, { lastMessageAt: null, lastMessageSeq: null })).toBe(
      true
    );
  });

  it("falls back to the timestamp for a legacy row whose lastMessageSeq was never written", () => {
    // A MongoDB range filter never matches a missing field, so without the
    // explicit null/isSet branch a pre-backfill room could never be bumped at
    // all once the predicate leads with the sequence.
    const where = newerSnapshotWhere(AT, 3);
    expect(matches(where, { lastMessageAt: AT })).toBe(true);
    expect(matches(where, { lastMessageAt: new Date(AT.getTime() + 1) })).toBe(
      false
    );
  });
});

describe("newerSnapshotMongoQuery — same predicate as raw Mongo operators", () => {
  it("leads with the sequence and keeps the legacy timestamp fallback", () => {
    expect(newerSnapshotMongoQuery(AT, 5)).toEqual({
      $or: [
        { lastMessageSeq: { $lte: 5 } },
        {
          $and: [
            { lastMessageSeq: null },
            {
              $or: [
                { lastMessageAt: { $lte: { $date: AT.toISOString() } } },
                { lastMessageAt: null },
              ],
            },
          ],
        },
      ],
    });
  });

  it("defaults a missing seq to 0 rather than dropping the branch", () => {
    const q = newerSnapshotMongoQuery(AT, null) as {
      $or: { lastMessageSeq?: { $lte?: number } }[];
    };
    expect(q.$or[0]?.lastMessageSeq?.$lte).toBe(0);
  });
});

describe("PrivateRoomRepository.updateRoomOnNewMessage", () => {
  const message = {
    _id: "64b7f0c2e13b4a0012345678",
    content: { text: "5" },
    senderId: "sender-1",
    messageType: "TEXT",
    createdAt: AT,
    sequenceNumber: 5,
  };

  function makeRepo(values: (unknown | null)[]) {
    const commands: Record<string, unknown>[] = [];
    let call = 0;
    const prisma = {
      $runCommandRaw: async (cmd: Record<string, unknown>) => {
        commands.push(cmd);
        return { value: values[call++] ?? null };
      },
    };
    const repo = new PrivateRoomRepository(
      prisma as unknown as ConstructorParameters<
        typeof PrivateRoomRepository
      >[0]
    );
    return { repo, commands };
  }

  it("gates the snapshot write on the ordering guard and stamps lastMessageSeq", async () => {
    const { repo, commands } = makeRepo([{ roomId: "room-1" }]);

    await repo.updateRoomOnNewMessage({
      roomId: "room-1",
      message,
      receiverId: "receiver-1",
    });

    expect(commands).toHaveLength(1);
    const query = commands[0]!.query as Record<string, unknown>;
    expect(query.roomId).toBe("room-1");
    expect(query.$or).toEqual(newerSnapshotMongoQuery(AT, 5).$or);
    const update = commands[0]!.update as {
      $set: Record<string, unknown>;
      $inc: Record<string, number>;
    };
    expect(update.$set.lastMessageSeq).toBe(5);
    expect(update.$inc["unreadCountByUser.receiver-1"]).toBe(1);
  });

  it("still increments unread when the guard rejects a late older message", async () => {
    // The losing side of the race: message #4 landing after message #5. Its
    // preview must not win, but it is a real unread message all the same —
    // dropping the whole write would leave the badge short by one.
    const { repo, commands } = makeRepo([null, { roomId: "room-1" }]);

    await repo.updateRoomOnNewMessage({
      roomId: "room-1",
      message,
      receiverId: "receiver-1",
    });

    expect(commands).toHaveLength(2);
    // Fallback targets the room unconditionally — no ordering guard.
    expect(commands[1]!.query).toEqual({ roomId: "room-1" });
    const update = commands[1]!.update as {
      $set?: Record<string, unknown>;
      $inc: Record<string, number>;
    };
    expect(update.$inc["unreadCountByUser.receiver-1"]).toBe(1);
    // …but it must NOT rewind any snapshot or "newest unread" pointer.
    expect(update.$set).not.toHaveProperty("lastMessageAt");
    expect(update.$set).not.toHaveProperty("lastMessageSeq");
    expect(update.$set).not.toHaveProperty("lastMessage");
    expect(update.$set).not.toHaveProperty(
      "lastUnreadMessageIdByUser.receiver-1"
    );
    expect(update.$set?.["hasUnreadByUser.receiver-1"]).toBe(true);
  });

  it("does not issue the fallback when the send carries no unread increment", async () => {
    const { repo, commands } = makeRepo([null]);

    await repo.updateRoomOnNewMessage({
      roomId: "room-1",
      message,
      receiverId: "receiver-1",
      unreadIncrement: 0,
    });

    expect(commands).toHaveLength(1);
  });
});

describe("GroupRoomRepository.updateLastMessage", () => {
  it("writes conditionally and reports 0 when a newer message already won", async () => {
    const calls: Record<string, unknown>[] = [];
    const prisma = {
      groupRoom: {
        updateMany: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { count: 0 };
        },
      },
    };
    const repo = new GroupRoomRepository(
      prisma as unknown as ConstructorParameters<typeof GroupRoomRepository>[0]
    );

    const count = await repo.updateLastMessage("group-1", {
      _id: "64b7f0c2e13b4a0012345678",
      senderId: "sender-1",
      senderName: "Sender",
      messageType: "TEXT",
      content: { text: "5" },
      createdAt: AT,
      sequenceNumber: 5,
    });

    expect(count).toBe(0);
    const where = calls[0]!.where as Record<string, unknown>;
    expect(where.roomId).toBe("group-1");
    expect(where.OR).toEqual(newerSnapshotWhere(AT, 5).OR);
    expect((calls[0]!.data as Record<string, unknown>).lastMessageSeq).toBe(5);
  });
});

describe("GeneralRoomRepository.addLastestMessageToRoom", () => {
  it("applies the same guard to the community chat room", async () => {
    const calls: Record<string, unknown>[] = [];
    const prisma = {
      generalRoom: {
        updateMany: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { count: 1 };
        },
      },
    };
    const repo = new GeneralRoomRepository(
      prisma as unknown as ConstructorParameters<
        typeof GeneralRoomRepository
      >[0]
    );

    const count = await repo.addLastestMessageToRoom("community-1", {
      _id: "64b7f0c2e13b4a0012345678",
      sentBy: "sender-1",
      senderName: "Sender",
      message: "5",
      messageType: "text",
      createdAt: AT,
      sequenceNumber: 5,
    });

    expect(count).toBe(1);
    const where = calls[0]!.where as Record<string, unknown>;
    expect(where.id).toBe("community-1");
    expect(where.OR).toEqual(newerSnapshotWhere(AT, 5).OR);
    expect((calls[0]!.data as Record<string, unknown>).lastMessageSeq).toBe(5);
  });
});
