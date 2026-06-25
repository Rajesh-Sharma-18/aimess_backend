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

jest.mock("../../src/config/redis.js", () => ({
  redis: { del, on: jest.fn() },
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
  beforeEach(() => del.mockClear());

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
