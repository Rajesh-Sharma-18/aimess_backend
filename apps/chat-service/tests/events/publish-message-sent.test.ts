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

// Room rows the publisher reads for the GROUP/COMMUNITY push header. Both
// columns hold RAW object keys — resolveMediaUrl (real) signs them.
const findGroupRoom = jest.fn(async () => ({
  name: "Family Group",
  avatar: "group-avatars/grp_1/a.jpg",
}));
const findGeneralRoom = jest.fn(async () => ({
  name: "Dubai Ice Rink",
  logo: "community/avatar/comm_1/a.jpg",
}));
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    groupRoom: { findUnique: (...a: unknown[]) => findGroupRoom(...a) },
    generalRoom: { findUnique: (...a: unknown[]) => findGeneralRoom(...a) },
  },
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

/**
 * Conversation identity for GROUP/COMMUNITY pushes.
 *
 * A group/community push must represent the CONVERSATION — its name as the
 * title, its avatar as the tray image — not the sender. Every producer
 * (REST/socket orchestrator, gRPC send, community system-message bridge, call
 * rows, group-invite DMs) publishes through this one function, and none of them
 * supplied a community avatar, so the resolution lives HERE. Name and image come
 * from the SAME row, so a rename or a new picture can never desync them.
 */
describe("publishMessageSentSafe — conversation identity", () => {
  const COMMUNITY_BUCKET = "aimess-community"; // MINIO_BUCKET_COMMUNITY test default

  const base = {
    messageId: "m-9",
    clientMessageId: "c-9",
    senderId: "u-sender",
    senderName: "Spider Man",
    senderAvatar: "",
    preview: "hi",
    messageType: "TEXT",
    sentAt: 1_700_000_000_002,
    recipientIds: ["u-recipient"],
  };

  it("COMMUNITY: title name + tray image both come from the mirrored room row", async () => {
    publishMessageSentSafe({
      ...base,
      conversationId: "comm_1",
      conversationType: "COMMUNITY",
      communityId: "comm_1",
      // Stale name off the request body — the mirror must win.
      communityName: "Your Community",
    });
    await flush();

    const data = lastQueuedPayload().data as Record<string, unknown>;
    expect(data.communityName).toBe("Dubai Ice Rink");
    expect(data.conversationAvatar).toBe(
      `https://media.test/${COMMUNITY_BUCKET}/community/avatar/comm_1/a.jpg`
    );
  });

  it("COMMUNITY: a changed avatar is picked up on the very next push", async () => {
    findGeneralRoom.mockResolvedValueOnce({
      name: "Dubai Ice Rink",
      logo: "community/avatar/comm_1/B.jpg",
    });
    publishMessageSentSafe({
      ...base,
      conversationId: "comm_1",
      conversationType: "COMMUNITY",
      communityId: "comm_1",
    });
    await flush();

    const data = lastQueuedPayload().data as Record<string, unknown>;
    expect(data.conversationAvatar).toBe(
      `https://media.test/${COMMUNITY_BUCKET}/community/avatar/comm_1/B.jpg`
    );
  });

  it("GROUP: carries the group name + avatar even when the producer sent neither", async () => {
    publishMessageSentSafe({
      ...base,
      conversationId: "grp_1",
      conversationType: "GROUP",
    });
    await flush();

    const data = lastQueuedPayload().data as Record<string, unknown>;
    expect(data.groupName).toBe("Family Group");
    expect(data.conversationAvatar).toBe(
      "https://media.test/aimess-avatars/group-avatars/grp_1/a.jpg"
    );
  });

  it("no avatar on the room → the field is omitted, never an empty string", async () => {
    findGeneralRoom.mockResolvedValueOnce({ name: "No Picture", logo: "" });
    publishMessageSentSafe({
      ...base,
      conversationId: "comm_1",
      conversationType: "COMMUNITY",
      communityId: "comm_1",
    });
    await flush();

    const data = lastQueuedPayload().data as Record<string, unknown>;
    expect(data).not.toHaveProperty("conversationAvatar");
  });

  it("PRIVATE: no room lookup, no conversation avatar (1:1 keeps its behaviour)", async () => {
    findGroupRoom.mockClear();
    findGeneralRoom.mockClear();
    publishMessageSentSafe({
      ...base,
      conversationId: "conv-3",
      conversationType: "PRIVATE",
    });
    await flush();

    expect(findGroupRoom).not.toHaveBeenCalled();
    expect(findGeneralRoom).not.toHaveBeenCalled();
    const data = lastQueuedPayload().data as Record<string, unknown>;
    expect(data).not.toHaveProperty("conversationAvatar");
    expect(data).not.toHaveProperty("groupName");
  });
});
