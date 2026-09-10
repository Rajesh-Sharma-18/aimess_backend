/**
 * `user.settings_updated` consumer — what happens to a message it cannot act
 * on.
 *
 * Busting the cached entry is the only thing that makes a settings change
 * visible before NOTIF_SETTINGS_CACHE_TTL_SEC (300s) elapses. The consumer
 * dead-lettered ANY error, and the invalidation swallowed its own, so a failed
 * Redis DEL was acked as a success: the user's new mute / quiet-hours /
 * category choice was ignored for the rest of the TTL with nothing left
 * anywhere that knew a change was owed.
 *
 * The split under test: an unreadable body is poison and goes to the DLQ
 * immediately, while a failed invalidation is transient and gets one requeue.
 */
jest.mock("../../src/services/notification-settings.service.js", () => ({
  invalidateNotificationSettings: jest.fn(async () => undefined),
}));

let onMessage: ((message: unknown) => void) | undefined;
const channel = {
  assertExchange: jest.fn(async () => undefined),
  assertQueue: jest.fn(async () => undefined),
  prefetch: jest.fn(async () => undefined),
  consume: jest.fn(async (_queue: string, handler: (m: unknown) => void) => {
    onMessage = handler;
    return { consumerTag: "t" };
  }),
  ack: jest.fn(),
  nack: jest.fn(),
};

jest.mock("amqplib", () => ({
  __esModule: true,
  default: {
    connect: jest.fn(async () => ({
      createChannel: jest.fn(async () => channel),
    })),
  },
}));

import { UserEvents } from "@aimess/shared-types";

import { startSettingsConsumer } from "../../src/consumers/settings.consumer.js";
import { invalidateNotificationSettings } from "../../src/services/notification-settings.service.js";

const invalidate = invalidateNotificationSettings as unknown as jest.Mock;
const USER_ID = "11111111-1111-4111-8111-111111111111";

/** A delivery carrying `body`, marked as a first attempt or a redelivery. */
function delivery(body: unknown, redelivered = false): unknown {
  return {
    content: Buffer.from(
      typeof body === "string" ? body : JSON.stringify(body)
    ),
    fields: { redelivered },
  };
}

const settingsUpdated = {
  type: UserEvents.SETTINGS_UPDATED,
  data: { userId: USER_ID, updatedAt: "2026-09-09T00:00:00.000Z" },
};

/** Feed one delivery through the consumer and let its async work settle. */
async function deliver(message: unknown): Promise<void> {
  onMessage?.(message);
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ["setImmediate"] });
  invalidate.mockResolvedValue(undefined);
  await startSettingsConsumer();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("settings cache-bust consumer", () => {
  it("invalidates the user's entry and acks", async () => {
    await deliver(delivery(settingsUpdated));

    expect(invalidate).toHaveBeenCalledWith(USER_ID);
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("acks an unrelated event without touching the cache", async () => {
    await deliver(delivery({ type: "user.something_else", data: {} }));

    expect(invalidate).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it("dead-letters an unreadable body immediately", async () => {
    // Poison: replaying it fails the same way forever.
    await deliver(delivery("{ not json"));

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it("requeues a failed invalidation rather than dropping it", async () => {
    // The finding: this used to be acked, leaving the entry stale for the rest
    // of the TTL with no record that a change was owed.
    invalidate.mockRejectedValueOnce(new Error("redis down"));

    await deliver(delivery(settingsUpdated));
    jest.runAllTimers();

    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });

  it("dead-letters on the second failure, so a retry cannot spin", async () => {
    invalidate.mockRejectedValueOnce(new Error("redis down"));

    await deliver(delivery(settingsUpdated, true));
    jest.runAllTimers();

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it("acks a redelivery that succeeds", async () => {
    await deliver(delivery(settingsUpdated, true));

    expect(invalidate).toHaveBeenCalledWith(USER_ID);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });
});
