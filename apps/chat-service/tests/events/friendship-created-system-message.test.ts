/**
 * FriendshipEventConsumer — `friendship.created` is never chat activity: no "now friends" row and no
 * inbox bump for any pair; earlier FRIENDSHIP_CREATED rows are pruned and the room snapshot repaired.
 */

const post = jest.fn(async () => undefined);
const update = jest.fn(async () => ({}));
const findUnique = jest.fn();
const findFirst = jest.fn();
const findMany = jest.fn(async () => []);
const updateMany = jest.fn(async () => ({ count: 1 }));

jest.mock("../../src/config/redis.js", () => ({
  redis: { publish: jest.fn(async () => 1), on: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    privateRoom: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
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

describe("friendship.created — never chat activity", () => {
  it("leaves a first-ever friendship with no conversation off both inboxes", async () => {
    await accept(0, false);
    expect(post).not.toHaveBeenCalled();
    // GET /chat/inbox skips NULL lastMessageAt; stamping it listed an empty chat.
    expect(update).not.toHaveBeenCalled();
  });

  it("posts NO row on re-friend when the pair never exchanged anything", async () => {
    await accept(0, true);
    expect(post).not.toHaveBeenCalled();
  });

  it("posts NO row and does not bump the list when the pair has history", async () => {
    await accept(4, true);
    expect(post).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("prunes earlier FRIENDSHIP_CREATED rows even when posting none", async () => {
    // Self-heals rooms that got the bubble under the old "any re-friend posts
    // it" rule: the stale row is removed and nothing replaces it.
    await accept(2, true, false);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("unlists a never-talked room whose only preview was a pruned bubble", async () => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue({
      roomId: "prv_1",
      lastSequence: 1,
      lastMessageId: "sys_old",
      lastMessageAt: new Date(),
    });
    findFirst.mockResolvedValue(null);
    const fake = makeFakeConnection();
    const consumer = new FriendshipEventConsumer();
    await consumer.start(fake.connection as never);
    await fake.deliver(
      JSON.stringify({ type: "friendship.created", userA: A, userB: B, timestamp: Date.now() })
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastMessageId: null, lastMessageAt: null }),
      })
    );
    expect(update).not.toHaveBeenCalled();
  });
});
