/**
 * FriendshipEventConsumer — the "You and X are now friends" SYSTEM row is
 * gated on CONVERSATION ACTIVITY, not on whether the pair was friends before.
 *
 * Rule: the row separates a new chapter from an existing conversation. With
 * nothing above it, it is noise — so a pair that never exchanged a message,
 * media or call gets no row, however many times they unfriend and re-friend.
 * A pair that has talked gets it on every re-friend.
 *
 * Activity means a NON-SYSTEM row exists. `lastSequence` (never decremented)
 * is only the cheap "nothing was ever written" pre-filter, so clear/delete
 * cannot reclassify a pair that really did talk, while the app's own SYSTEM
 * rows (auto-delete setting changed, an earlier "now friends") do not fake it.
 */

const post = jest.fn(async () => undefined);
const update = jest.fn(async () => ({}));
const findUnique = jest.fn();
const findFirst = jest.fn();
const findMany = jest.fn(async () => []);

jest.mock("../../src/config/redis.js", () => ({
  redis: { publish: jest.fn(async () => 1), on: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    privateRoom: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
    },
    privateMessage: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

jest.mock("../../src/services/private-room.service.js", () => ({
  ensurePrivateRoom: jest.fn(async () => ({ roomId: "prv_1" })),
}));

jest.mock("../../src/services/private-system-message.service.js", () => ({
  PrivateSystemMessageService: class {
    post = post;
  },
}));

jest.mock("../../src/services/user-snapshot.service.js", () => ({
  UserSnapshotService: class {
    getUserSnapshotsMap = jest.fn(async () => new Map());
  },
}));

jest.mock("../../src/repositories/friendship.repository.js", () => ({
  FriendshipRepository: class {
    createFriendship = jest.fn(async () => undefined);
    deleteFriendship = jest.fn(async () => undefined);
    updateFriendshipStatus = jest.fn(async () => undefined);
  },
}));

import { FriendshipEventConsumer } from "../../src/events/friendship.consumer.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function makeFakeConnection() {
  let onMessage: ((msg: unknown) => unknown) | null = null;
  const channel = {
    assertExchange: jest.fn(async () => undefined),
    assertQueue: jest.fn(async () => undefined),
    bindQueue: jest.fn(async () => undefined),
    consume: jest.fn(async (_q: string, cb: (msg: unknown) => unknown) => {
      onMessage = cb;
      return { consumerTag: "t" };
    }),
    ack: jest.fn(),
    nack: jest.fn(),
  };
  return {
    connection: { createChannel: jest.fn(async () => channel) },
    deliver: (body: unknown) =>
      onMessage?.({ content: Buffer.from(String(body)) }),
  };
}

/**
 * Deliver one `friendship.created` for a room holding `inserts` timeline rows,
 * `humanTalked` of which are real (non-SYSTEM) messages.
 */
async function accept(
  inserts: number,
  isRefriend: boolean,
  humanTalked = inserts > 0
) {
  jest.clearAllMocks();
  findUnique.mockResolvedValue({
    roomId: "prv_1",
    lastSequence: inserts,
    lastMessageAt: inserts > 0 ? new Date() : null,
  });
  findFirst.mockResolvedValue(humanTalked ? { id: "msg_1" } : null);

  const fake = makeFakeConnection();
  const consumer = new FriendshipEventConsumer();
  await consumer.start(fake.connection as never);
  await fake.deliver(
    JSON.stringify({
      type: "friendship.created",
      userA: A,
      userB: B,
      status: "ACTIVE",
      timestamp: Date.now(),
      isRefriend,
    })
  );
}

describe("friendship.created — system message gate", () => {
  it("posts NO row for a first-ever friendship with no conversation", async () => {
    await accept(0, false);
    expect(post).not.toHaveBeenCalled();
    // Hidden in the chat room, but still the room's latest LIST activity:
    // GET /chat/inbox keysets on lastMessageAt and skips NULLs, so without the
    // stamp the new friend's row has no time and sorts last.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lastMessageAt: expect.any(Date) },
      })
    );
  });

  it("does not drag the row backwards when the event is older than the room", async () => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue({
      roomId: "prv_1",
      lastSequence: 0,
      lastMessageAt: new Date(Date.now() + 60_000),
    });
    findFirst.mockResolvedValue(null);
    const fake = makeFakeConnection();
    const consumer = new FriendshipEventConsumer();
    await consumer.start(fake.connection as never);
    await fake.deliver(
      JSON.stringify({
        type: "friendship.created",
        userA: A,
        userB: B,
        timestamp: Date.now(),
      })
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("posts NO row on re-friend when the pair never exchanged anything", async () => {
    await accept(0, true);
    expect(post).not.toHaveBeenCalled();
  });

  it("posts the row on re-friend when the pair has conversation activity", async () => {
    await accept(4, true);
    expect(post).toHaveBeenCalledTimes(1);
    // Activity already put the room on both inboxes — no stamping.
    expect(update).not.toHaveBeenCalled();
  });

  it("posts the row on activity even if the publisher omits isRefriend", async () => {
    await accept(4, false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does NOT count the app's own SYSTEM rows as conversation", async () => {
    // Room holds only SYSTEM rows — an auto-delete setting change, or a "now
    // friends" bubble posted by the older build. Both bump lastSequence.
    await accept(2, true, false);
    expect(post).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ messageType: { not: "SYSTEM" } }),
      })
    );
  });

  it("prunes earlier FRIENDSHIP_CREATED rows even when posting none", async () => {
    // Self-heals rooms that got the bubble under the old "any re-friend posts
    // it" rule: the stale row is removed and nothing replaces it.
    await accept(2, true, false);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
});
