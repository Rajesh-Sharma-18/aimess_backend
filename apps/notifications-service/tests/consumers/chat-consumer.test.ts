/**
 * Push-notification coverage for the chat message consumer (chat.consumer.ts).
 *
 * Verifies the COMMUNITY conversationType branch added alongside T7:
 *
 *   - COMMUNITY messages use category:"communityEnabled" (not "chatEnabled")
 *   - communityId is forwarded in the FCM data map so the client can deep-link
 *     to the correct community chat screen
 *   - PRIVATE and GROUP messages continue to use category:"chatEnabled"
 *   - No push is sent when recipientIds is empty after sender-exclusion
 *
 * amqplib and push.service are faked; the consume callback is captured and fed
 * directly so tests run without a real RabbitMQ connection.
 */

// Fake amqplib — capture the consume callback so we can inject messages.
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

// Mock push.service — the FCM/APNs delivery boundary.
jest.mock("../../src/services/push.service.js", () => ({
  pushToUsers: jest.fn(async () => undefined),
}));

import { startChatConsumer } from "../../src/consumers/chat.consumer.js";
import { pushToUsers } from "../../src/services/push.service.js";

const pushMany = pushToUsers as jest.Mock;

type ConsumeCallback = (msg: { content: Buffer } | null) => void;

async function setupConsumer(): Promise<ConsumeCallback> {
  await startChatConsumer();
  // consume(queue, callback) — grab the most-recently-registered callback.
  const calls = channelMock.consume.mock.calls as Array<
    [string, ConsumeCallback]
  >;
  return calls[calls.length - 1][1];
}

function makeMsg(data: object) {
  return {
    content: Buffer.from(JSON.stringify({ type: "chat.message_sent", data })),
  };
}

/** Flush promise micro-tasks so the void async IIFE inside consume resolves. */
const flush = () => new Promise((r) => setImmediate(r));

const BASE = {
  conversationId: "conv1",
  messageId: "msg1",
  clientMessageId: "c1",
  senderId: "sender-uuid",
  senderName: "Alice",
  senderAvatar: "https://cdn.example.com/alice.png",
  preview: "Hello!",
  messageType: "TEXT",
  sentAt: 1749000000000,
  recipientIds: ["recipient-uuid"],
};

describe("startChatConsumer — conversationType routing (T7)", () => {
  let consume: ConsumeCallback;

  beforeAll(async () => {
    consume = await setupConsumer();
  });

  beforeEach(() => {
    pushMany.mockClear();
    channelMock.ack.mockClear();
  });

  it("COMMUNITY → category:communityEnabled + communityId in FCM data", async () => {
    consume(
      makeMsg({ ...BASE, conversationType: "COMMUNITY", communityId: "comm1" })
    );
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => { category: string; data: Record<string, string> },
    ];
    const push = builderFn("recipient-uuid");
    expect(push.category).toBe("communityEnabled");
    expect(push.data.communityId).toBe("comm1");
    expect(push.data.conversationType).toBe("COMMUNITY");
  });

  it("PRIVATE → category:chatEnabled, no communityId in data map", async () => {
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => { category: string; data: Record<string, string> },
    ];
    const push = builderFn("recipient-uuid");
    expect(push.category).toBe("chatEnabled");
    expect(push.data.communityId).toBeUndefined();
  });

  it("GROUP → category:chatEnabled", async () => {
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => { category: string },
    ];
    const push = builderFn("recipient-uuid");
    expect(push.category).toBe("chatEnabled");
  });

  it("skips push when all recipientIds are filtered out (sender === recipient)", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
        senderId: "recipient-uuid", // sender IS the only recipient → excluded
      })
    );
    await flush();

    expect(pushMany).not.toHaveBeenCalled();
  });

  it("skips push when recipientIds is empty", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
        recipientIds: [],
      })
    );
    await flush();

    expect(pushMany).not.toHaveBeenCalled();
  });

  it("acks the message after successful processing", async () => {
    const msg = makeMsg({
      ...BASE,
      conversationType: "COMMUNITY",
      communityId: "comm1",
    });
    consume(msg);
    await flush();

    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });
});
