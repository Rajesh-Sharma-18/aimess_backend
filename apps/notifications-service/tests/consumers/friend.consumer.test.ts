/**
 * notifications-service `friend.consumer.ts` — friendship.queue → push.
 *
 * Verifies:
 *   - FRIEND_REQUESTED pushes to the addressee with the requester's name
 *   - FRIEND_ACCEPTED pushes to BOTH parties with distinct copy
 *   - FRIEND_REJECTED pushes to the requester
 *   - FRIEND_CANCELLED pushes to the addressee
 *   - FRIEND_UNFRIENDED remains a no-op (silent policy unchanged)
 *   - missing display names fall back to "Someone" (bulk auto-connect never sends them)
 */
const channelMock = {
  assertQueue: jest.fn(async () => undefined),
  prefetch: jest.fn(async () => undefined),
  consume: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
};
const connectionMock = {
  createChannel: jest.fn(async () => channelMock),
};
jest.mock("amqplib", () => ({
  __esModule: true,
  default: { connect: jest.fn(async () => connectionMock) },
  connect: jest.fn(async () => connectionMock),
}));

jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
}));

import { FriendshipEvents } from "@aimess/shared-types";

import { startFriendConsumer } from "../../src/consumers/friend.consumer.js";
import { pushToUser } from "../../src/services/push.service.js";

const push = pushToUser as jest.Mock;

const REQUESTER = "11111111-1111-4111-8111-111111111111";
const ADDRESSEE = "22222222-2222-4222-8222-222222222222";
const FRIENDSHIP_ID = "33333333-3333-4333-8333-333333333333";

async function deliver(type: string, data: unknown): Promise<void> {
  channelMock.consume.mockClear();
  await startFriendConsumer();
  const onMessage = channelMock.consume.mock.calls[0][1] as (
    msg: { content: Buffer } | null
  ) => void;
  onMessage({ content: Buffer.from(JSON.stringify({ type, data })) });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  push.mockClear();
});

describe("FRIEND_REQUESTED", () => {
  it("pushes to the addressee with the requester's name", async () => {
    await deliver(FriendshipEvents.FRIEND_REQUESTED, {
      friendshipId: FRIENDSHIP_ID,
      requesterId: REQUESTER,
      addresseeId: ADDRESSEE,
      requesterName: "John",
      createdAt: "2026-07-17T10:00:00.000Z",
    });

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(ADDRESSEE);
    expect(arg.body).toBe("John sent you a friend request.");
  });

  it("falls back to 'Someone' when requesterName is absent", async () => {
    await deliver(FriendshipEvents.FRIEND_REQUESTED, {
      friendshipId: FRIENDSHIP_ID,
      requesterId: REQUESTER,
      addresseeId: ADDRESSEE,
      createdAt: "2026-07-17T10:00:00.000Z",
    });

    expect(push.mock.calls[0][0].body).toBe(
      "Someone sent you a friend request."
    );
  });
});

describe("FRIEND_ACCEPTED", () => {
  it("pushes to BOTH parties with distinct copy", async () => {
    await deliver(FriendshipEvents.FRIEND_ACCEPTED, {
      friendshipId: FRIENDSHIP_ID,
      requesterId: REQUESTER,
      addresseeId: ADDRESSEE,
      requesterName: "John",
      addresseeName: "Alex",
      acceptedAt: "2026-07-17T10:05:00.000Z",
    });

    expect(push).toHaveBeenCalledTimes(2);

    const toRequester = push.mock.calls.find(
      (c) => c[0].userId === REQUESTER
    )?.[0];
    expect(toRequester.title).toBe("Friend Request");
    expect(toRequester.body).toBe("You sent Alex a friend request.");
    expect(toRequester.data.resolution).toBe(
      "Alex accepted your friend request."
    );

    const toAddressee = push.mock.calls.find(
      (c) => c[0].userId === ADDRESSEE
    )?.[0];
    expect(toAddressee.title).toBe("Friend Request");
    expect(toAddressee.body).toBe("John has sent you a friend request.");
    expect(toAddressee.data.resolution).toBe("You are now friends!");
  });
});

describe("FRIEND_REJECTED", () => {
  it("pushes to the requester", async () => {
    await deliver(FriendshipEvents.FRIEND_REJECTED, {
      friendshipId: FRIENDSHIP_ID,
      requesterId: REQUESTER,
      addresseeId: ADDRESSEE,
      addresseeName: "Alex",
      rejectedAt: "2026-07-17T10:05:00.000Z",
    });

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(REQUESTER);
    expect(arg.title).toBe("Friend Request");
    expect(arg.body).toBe("You sent Alex a friend request.");
    expect(arg.data.resolution).toBe("Declined your friend request");
    expect(arg.data.resolutionTone).toBe("danger");
  });
});

describe("FRIEND_CANCELLED", () => {
  it("pushes to the addressee", async () => {
    await deliver(FriendshipEvents.FRIEND_CANCELLED, {
      friendshipId: FRIENDSHIP_ID,
      requesterId: REQUESTER,
      addresseeId: ADDRESSEE,
      requesterName: "John",
      cancelledAt: "2026-07-17T10:05:00.000Z",
    });

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(ADDRESSEE);
    expect(arg.body).toBe("John cancelled their friend request.");
  });
});

describe("FRIEND_UNFRIENDED", () => {
  it("remains a silent no-op", async () => {
    await deliver(FriendshipEvents.FRIEND_UNFRIENDED, {
      friendshipId: FRIENDSHIP_ID,
      unfriendedById: REQUESTER,
      otherUserId: ADDRESSEE,
      unfriendedAt: "2026-07-17T10:05:00.000Z",
    });

    expect(push).not.toHaveBeenCalled();
  });
});
