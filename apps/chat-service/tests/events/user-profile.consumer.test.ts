/**
 * UserProfileEventConsumer — invalidates the cached user snapshot on
 * `user.profile_updated`.
 *
 * Why this exists: chat-service stamps the sender's `displayName` (read from the
 * `user:snapshot:<id>` Redis cache, 1h TTL) onto every persisted message, the
 * socket bumps, the push, and the community-list activity denormalization. The
 * cache was never refreshed on a rename, so a renamed user's OLD name stayed
 * frozen on those surfaces for up to an hour — the "Vasu Himanshu: 📷 Photo"
 * community-list bug. This consumer deletes the cache key so the next send
 * refetches the live name.
 *
 * `config/redis.js` is mocked to a fake client (no broker / Redis needed); the
 * consumer is driven by a fake amqplib connection that captures the consume
 * callback so we can hand it crafted messages.
 */

const del = jest.fn(async () => 1);
const publish = jest.fn(async () => 1);
const getActiveRoomIds = jest.fn(async () => [] as string[]);

jest.mock("../../src/config/redis.js", () => ({
  redis: { del, publish, on: jest.fn() },
}));

jest.mock("../../src/config/prisma.js", () => ({ prisma: {} }));

jest.mock("../../src/repositories/group-member.repository.js", () => ({
  GroupMemberRepository: class {
    getActiveRoomIds = getActiveRoomIds;
  },
}));

const findPeersForUser = jest.fn(async () => [] as Array<{ peerId: string; roomId: string }>);
jest.mock("../../src/repositories/private-room.repository.js", () => ({
  PrivateRoomRepository: class {
    findPeersForUser = findPeersForUser;
  },
}));

import { UserEvents } from "@aimess/shared-types";

import { UserProfileEventConsumer } from "../../src/events/user-profile.consumer.js";

const USER = "11111111-1111-4111-8111-111111111111";

/** Build a fake amqplib connection that records the consume callback. */
function makeFakeConnection() {
  const ack = jest.fn();
  const nack = jest.fn();
  let onMessage: ((msg: unknown) => unknown) | null = null;

  const channel = {
    assertExchange: jest.fn(async () => undefined),
    assertQueue: jest.fn(async () => undefined),
    bindQueue: jest.fn(async () => undefined),
    consume: jest.fn(async (_q: string, cb: (msg: unknown) => unknown) => {
      onMessage = cb;
      return { consumerTag: "t" };
    }),
    cancel: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    ack,
    nack,
  };

  return {
    connection: { createChannel: jest.fn(async () => channel) },
    channel,
    deliver: (body: unknown) =>
      onMessage?.({ content: Buffer.from(String(body)) }),
  };
}

const msg = (type: string, data: Record<string, unknown>) =>
  JSON.stringify({ type, data });

describe("UserProfileEventConsumer", () => {
  beforeEach(() => {
    del.mockClear();
    publish.mockClear();
    getActiveRoomIds.mockClear();
    getActiveRoomIds.mockResolvedValue([]);
  });

  it("invalidates the user snapshot cache on USER_PROFILE_UPDATED and acks", async () => {
    const fake = makeFakeConnection();
    const consumer = new UserProfileEventConsumer();
    await consumer.start(fake.connection as never);

    await fake.deliver(
      msg(UserEvents.USER_PROFILE_UPDATED, {
        userId: USER,
        username: "himanshu",
        displayName: "Himanshu Vasu",
        avatarObjectKey: null,
        isProfileCompleted: true,
        updatedAt: "2026-06-19T00:00:00.000Z",
      })
    );

    expect(del).toHaveBeenCalledWith(`user:snapshot:${USER}`);
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
    expect(fake.channel.nack).not.toHaveBeenCalled();
  });

  it("pushes the new identity to presence watchers, group rooms and every DM peer on a rename", async () => {
    // `user:<id>` reaches presence watchers, `conv:<roomId>` group rooms, and each DM peer's own
    // `user:<peerId>` room covers 1:1 chats with no presence subscription (AIMESS-236).
    getActiveRoomIds.mockResolvedValue(["grp_a", "grp_b"]);
    findPeersForUser.mockResolvedValue([
      { peerId: "peer-1", roomId: "prv_1" },
      { peerId: "peer-2", roomId: "prv_2" },
    ]);
    const fake = makeFakeConnection();
    const consumer = new UserProfileEventConsumer();
    await consumer.start(fake.connection as never);

    await fake.deliver(
      msg(UserEvents.USER_PROFILE_UPDATED, {
        userId: USER,
        username: "himanshu",
        displayName: "Himanshu Vasu",
        avatarObjectKey: "avatars/new.png",
        isProfileCompleted: true,
        updatedAt: "2026-06-19T00:00:00.000Z",
      })
    );

    const channels = publish.mock.calls.map((c) => c[0] as string);
    expect(channels).toEqual(
      expect.arrayContaining([
        `user:${USER}`,
        "conv:grp_a",
        "conv:grp_b",
        "user:peer-1",
        "user:peer-2",
      ])
    );

    for (const call of publish.mock.calls) {
      const payload = JSON.parse(call[1] as string) as {
        event: string;
        data: Record<string, unknown>;
      };
      expect(payload.event).toBe("user:profile_updated");
      expect(payload.data).toMatchObject({
        userId: USER,
        username: "himanshu",
        displayName: "Himanshu Vasu",
        avatarObjectKey: "avatars/new.png",
      });
      expect(payload.data).not.toHaveProperty("avatarUrl");
    }

    // A rename must never look like a deletion to a client.
    expect(channels).not.toContain("user:account_deleted");
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });

  it("broadcasts user:account_deleted and a roster bump for every group when isDeleted", async () => {
    getActiveRoomIds.mockResolvedValue(["grp_a", "grp_b"]);
    const fake = makeFakeConnection();
    const consumer = new UserProfileEventConsumer();
    await consumer.start(fake.connection as never);

    await fake.deliver(
      msg(UserEvents.USER_PROFILE_UPDATED, {
        userId: USER,
        username: "",
        displayName: "Deleted Account",
        avatarObjectKey: null,
        isProfileCompleted: true,
        updatedAt: "2026-08-13T00:00:00.000Z",
        isDeleted: true,
      })
    );

    // The cache invalidation still has to happen — the socket signal only makes
    // the (already correct) state arrive sooner.
    expect(del).toHaveBeenCalledWith(`user:snapshot:${USER}`);

    const channels = publish.mock.calls.map((c) => c[0] as string);
    expect(channels).toEqual(
      expect.arrayContaining([`user:${USER}`, "conv:grp_a", "conv:grp_b"])
    );

    const selfCall = publish.mock.calls.find((c) => c[0] === `user:${USER}`);
    const selfPayload = JSON.parse(selfCall![1] as string) as {
      event: string;
      data: Record<string, unknown>;
    };
    expect(selfPayload.event).toBe("user:account_deleted");
    expect(selfPayload.data.isDeletedUser).toBe(true);
    // Signal only: the event must carry no identity for a peer to render.
    expect(selfPayload.data).not.toHaveProperty("displayName");
    expect(selfPayload.data).not.toHaveProperty("username");
    expect(selfPayload.data).not.toHaveProperty("avatarUrl");

    const roomCall = publish.mock.calls.find((c) => c[0] === "conv:grp_a");
    const roomPayload = JSON.parse(roomCall![1] as string) as { event: string };
    // Reuses the existing roster event rather than minting a group-specific one.
    expect(roomPayload.event).toBe("group:member:updated");

    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });

  it("acks-without-deleting an unexpected event type (no cache churn)", async () => {
    const fake = makeFakeConnection();
    const consumer = new UserProfileEventConsumer();
    await consumer.start(fake.connection as never);

    await fake.deliver(msg("some.other.event", { userId: USER }));

    expect(del).not.toHaveBeenCalled();
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });

  it("nacks (no requeue) a malformed message body so it can't loop forever", async () => {
    const fake = makeFakeConnection();
    const consumer = new UserProfileEventConsumer();
    await consumer.start(fake.connection as never);

    await fake.deliver("{ not valid json");

    expect(del).not.toHaveBeenCalled();
    expect(fake.channel.nack).toHaveBeenCalledWith(
      expect.anything(),
      false,
      false
    );
    expect(fake.channel.ack).not.toHaveBeenCalled();
  });

  it("binds its own queue to the shared user.profile_updated fanout exchange", async () => {
    const fake = makeFakeConnection();
    const consumer = new UserProfileEventConsumer();
    await consumer.start(fake.connection as never);

    expect(fake.channel.assertExchange).toHaveBeenCalledWith(
      "user.profile_updated",
      "fanout",
      { durable: true }
    );
    expect(fake.channel.bindQueue).toHaveBeenCalledWith(
      "chat-service.user.profile_updated",
      "user.profile_updated",
      ""
    );
  });
});
