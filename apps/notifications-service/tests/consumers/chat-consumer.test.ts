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

// Mock the notification-eligibility gate (the COMMUNITY mute oracle). This is
// the consumer's direct seam for suppression. Mocking it here ALSO stops the
// real `src/grpc/community.client.js` from being pulled into the require graph —
// that module proto-loads via `import.meta.url`, which CJS-mode Jest cannot
// parse (it crashes the whole suite at import). Each test drives `isMuted`.
jest.mock("../../src/services/notification-eligibility.service.js", () => ({
  isCommunityActorMuted: jest.fn(async () => false),
}));

import { startChatConsumer } from "../../src/consumers/chat.consumer.js";
import { pushToUsers } from "../../src/services/push.service.js";
import { isCommunityActorMuted } from "../../src/services/notification-eligibility.service.js";

const pushMany = pushToUsers as jest.Mock;
const isMutedMock = isCommunityActorMuted as jest.Mock;

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
    channelMock.nack.mockClear();
    isMutedMock.mockReset();
    isMutedMock.mockResolvedValue(false); // default: not muted
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

/**
 * Community-level notification suppression for moderator-muted members.
 *
 * Spec coverage note (READ THIS before adding "Reacts/Replies/Mentions/Edits/
 * Deletes" tests): the ONLY community-action that produces a notification today
 * is **message-send** (this consumer). Reactions, replies, mentions, edits and
 * deletes generate NO notification flow yet — `notification-eligibility.service`
 * is the documented single chokepoint those future flows MUST route through, but
 * they have no call site, so a "muted user reacts → no notification" test would
 * be vacuous (it asserts the absence of a flow that doesn't exist). The
 * meaningful, non-vacuous lock is therefore: muted member sends a community
 * message → zero fan-out. Gating the only live path satisfies every spec row
 * ("no notification / no push / no counter") for the muted user.
 */
describe("startChatConsumer — community mute suppression", () => {
  let consume: ConsumeCallback;

  beforeAll(async () => {
    consume = await setupConsumer();
  });

  beforeEach(() => {
    pushMany.mockClear();
    channelMock.ack.mockClear();
    channelMock.nack.mockClear();
    isMutedMock.mockReset();
    isMutedMock.mockResolvedValue(false);
  });

  // (1) POSITIVE CORE — muted sender in a COMMUNITY → fan-out fully suppressed,
  // but the message is still ACKed (suppression is a SUCCESS, not a nack/requeue).
  it("COMMUNITY + sender muted → pushToUsers NOT called, message ACKed (no nack)", async () => {
    isMutedMock.mockResolvedValue(true);
    const msg = makeMsg({
      ...BASE,
      conversationType: "COMMUNITY",
      communityId: "comm1",
    });
    consume(msg);
    await flush();

    expect(isMutedMock).toHaveBeenCalledWith(BASE.senderId, "comm1");
    expect(pushMany).not.toHaveBeenCalled(); // no push, no inbox row, no badge
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  // (2) COMMUNITY + sender NOT muted → fan-out proceeds, recipients exclude sender.
  it("COMMUNITY + sender NOT muted → pushToUsers called with sender excluded", async () => {
    isMutedMock.mockResolvedValue(false);
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
        recipientIds: ["recipient-uuid", BASE.senderId], // sender present → must be filtered
      })
    );
    await flush();

    expect(isMutedMock).toHaveBeenCalledWith(BASE.senderId, "comm1");
    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients] = pushMany.mock.calls[0] as [string[], unknown];
    expect(recipients).toEqual(["recipient-uuid"]); // sender excluded
  });

  // (3) NEGATIVE — PRIVATE never invokes the mute gate; fan-out unchanged.
  it("PRIVATE → mute gate NEVER called; push still sent", async () => {
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE" }));
    await flush();

    expect(isMutedMock).not.toHaveBeenCalled();
    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  // (4) NEGATIVE — GROUP never invokes the mute gate.
  it("GROUP → mute gate NEVER called; push still sent", async () => {
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(isMutedMock).not.toHaveBeenCalled();
    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  // (5) FAIL-OPEN — if the mute oracle path resolves to "not muted" on outage,
  // notifications must NOT be dropped. (community.client.ts is fail-open by
  // construction; here the eligibility service returns false, which is the
  // fail-open value, and we assert the consumer still fans out.)
  it("FAIL-OPEN: oracle resolves not-muted on error → push still sent (not dropped)", async () => {
    isMutedMock.mockResolvedValue(false); // fail-open value
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
      })
    );
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  // (5b) ADVERSARIAL — if the eligibility service itself THROWS (a regression
  // that defeats fail-open), the consumer's try/catch nacks the message with
  // requeue=false (drop). This documents the ACTUAL behavior: a throwing gate
  // does NOT silently fan out — but it also does NOT requeue-storm. The
  // production code is fail-open at the gRPC client, so the gate should never
  // throw; this guards the consumer-level contract if that ever changes.
  it("ADVERSARIAL: gate throws → message nacked without requeue (no fan-out, no spin)", async () => {
    isMutedMock.mockRejectedValue(new Error("eligibility blew up"));
    const msg = makeMsg({
      ...BASE,
      conversationType: "COMMUNITY",
      communityId: "comm1",
    });
    consume(msg);
    await flush();

    expect(pushMany).not.toHaveBeenCalled();
    expect(channelMock.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channelMock.ack).not.toHaveBeenCalled();
  });

  // (6) EDGE — conversationType COMMUNITY but communityId MISSING → gate skipped
  // (fail-open), message still fans out and is ACKed. Documents the falsy-guard.
  it("COMMUNITY + communityId undefined → gate skipped, push sent, ACKed", async () => {
    const msg = makeMsg({ ...BASE, conversationType: "COMMUNITY" }); // no communityId
    consume(msg);
    await flush();

    expect(isMutedMock).not.toHaveBeenCalled();
    expect(pushMany).toHaveBeenCalledTimes(1);
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });

  // (6b) ADVERSARIAL — EMPTY-STRING communityId. "" is falsy, so the gate is
  // SKIPPED and a muted user's message WOULD fan out. Confirms whether an empty
  // communityId is a bypass vector. With current code the gate is not called.
  // (See BUG LIST: this is the documented fail-open seam, not a defect, BECAUSE
  // chat-service always emits a real communityId for COMMUNITY messages; flagged
  // for awareness.)
  it("COMMUNITY + communityId === '' → gate skipped (falsy guard), push sent", async () => {
    isMutedMock.mockResolvedValue(true); // even if the user WERE muted...
    consume(
      makeMsg({ ...BASE, conversationType: "COMMUNITY", communityId: "" })
    );
    await flush();

    expect(isMutedMock).not.toHaveBeenCalled(); // "" is falsy → gate bypassed
    expect(pushMany).toHaveBeenCalledTimes(1); // ...message still fans out
  });

  // (7) BADGE / COUNTER LOCK — when suppressed, pushToUsers (the SOLE path that
  // creates the inbox row + emits notification:count_update badge) is not invoked
  // at all. Asserting zero invocation is what proves "no counter increment".
  it("suppressed → pushToUsers NOT invoked at all (locks inbox row + badge count)", async () => {
    isMutedMock.mockResolvedValue(true);
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
        recipientIds: ["r1", "r2", "r3"], // multiple recipients — none must be notified
      })
    );
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(0);
  });
});
