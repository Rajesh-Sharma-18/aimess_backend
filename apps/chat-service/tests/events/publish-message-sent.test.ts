/**
 * Resolve-on-read coverage for the push-notification publish boundary
 * (src/events/publish-message-sent.ts → publishMessageSentSafe).
 *
 * The push fan-out (notifications-service consumes this queue and forwards the
 * payload into an FCM data message) MUST carry a full, usable avatar URL — never
 * a raw MinIO object key. This asserts that a raw `senderAvatar` object key is
 * resolved through the shared media-url strategy before the message is enqueued.
 *
 * `amqplib` is mocked so no real broker is needed; the resolved avatar is read
 * back off the captured `sendToQueue` Buffer. `resolveMediaUrl` runs for real,
 * driven by the global `config/storage.js` mock (tests/setup/global-mocks.ts)
 * whose strategy returns `https://media.test/<bucket>/<key>`.
 *
 * `MINIO_BUCKET` = `aimess-chat-test` (tests/setup/env.ts); an `avatars/...` key
 * routes to the avatars bucket via media-resolve's prefix map.
 */

// Capture the enqueued payload. `amqplib.connect` is mocked to hand back a
// channel whose sendToQueue records the (queue, Buffer) it is given.
const sentToQueue = jest.fn();
const assertQueue = jest.fn(async () => undefined);

jest.mock("amqplib", () => ({
  __esModule: true,
  connect: jest.fn(async () => ({
    on: jest.fn(),
    createChannel: jest.fn(async () => ({
      assertQueue,
      sendToQueue: sentToQueue,
    })),
  })),
}));

import {
  publishMessageSentSafe,
  CHAT_MESSAGE_SENT_EVENT,
} from "../../src/events/publish-message-sent.js";

const AVATARS_BUCKET = "aimess-avatars"; // MINIO_BUCKET_AVATARS test default

/** Let the fire-and-forget IIFE inside publishMessageSentSafe settle. */
async function flush(): Promise<void> {
  // a few macro/microtask turns: connect → createChannel → resolveMediaUrl → send
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

function lastQueuedPayload(): Record<string, unknown> {
  expect(sentToQueue).toHaveBeenCalled();
  const buf = sentToQueue.mock.calls.at(-1)![1] as Buffer;
  return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
}

describe("publishMessageSentSafe — senderAvatar resolve-on-read", () => {
  it("resolves a raw object-key avatar to a full URL in the queued push payload", async () => {
    publishMessageSentSafe({
      conversationId: "conv-1",
      conversationType: "PRIVATE",
      messageId: "m-1",
      clientMessageId: "c-1",
      senderId: "u-sender",
      senderName: "Alice",
      senderAvatar: "avatars/u-sender/a.png", // raw MinIO key, NOT a URL
      preview: "hi",
      messageType: "TEXT",
      sentAt: 1_700_000_000_000,
      recipientIds: ["u-recipient"],
    });

    await flush();

    const env = lastQueuedPayload();
    expect(env.type).toBe(CHAT_MESSAGE_SENT_EVENT);
    const data = env.data as Record<string, unknown>;
    // The raw key must be signed into a full URL via the strategy.
    expect(data.senderAvatar).toBe(
      `https://media.test/${AVATARS_BUCKET}/avatars/u-sender/a.png`
    );
    // sender excluded; recipient retained.
    expect(data.recipientIds).toEqual(["u-recipient"]);
  });

  it("passes a full http(s) avatar URL through unchanged", async () => {
    publishMessageSentSafe({
      conversationId: "conv-2",
      conversationType: "PRIVATE",
      messageId: "m-2",
      clientMessageId: "c-2",
      senderId: "u-sender",
      senderName: "Alice",
      senderAvatar: "https://cdn.example.com/legacy.png",
      preview: "hi",
      messageType: "TEXT",
      sentAt: 1_700_000_000_001,
      recipientIds: ["u-recipient"],
    });

    await flush();

    const data = lastQueuedPayload().data as Record<string, unknown>;
    expect(data.senderAvatar).toBe("https://cdn.example.com/legacy.png");
  });
});
