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
  // Default: pass recipients through unchanged so existing routing specs stay
  // focused. Specs that assert LEFT-member filtering re-mock this explicitly.
  filterToActiveCommunityMembers: jest.fn(
    async (_communityId: string, userIds: string[]) => userIds
  ),
  // Default: recipient has NOT muted the private room.
  isPrivateRoomMutedBy: jest.fn(async () => false),
  // Default: recipient has NOT muted the group room.
  isGroupMemberMuted: jest.fn(async () => false),
}));

import { startChatConsumer } from "../../src/consumers/chat.consumer.js";
import { pushToUsers } from "../../src/services/push.service.js";
import {
  filterToActiveCommunityMembers,
  isCommunityActorMuted,
  isGroupMemberMuted,
  isPrivateRoomMutedBy,
} from "../../src/services/notification-eligibility.service.js";

const pushMany = pushToUsers as jest.Mock;
const isMutedMock = isCommunityActorMuted as jest.Mock;
const filterActiveMock = filterToActiveCommunityMembers as jest.Mock;
const isPrivateMutedMock = isPrivateRoomMutedBy as jest.Mock;
const isGroupMutedMock = isGroupMemberMuted as jest.Mock;

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
    filterActiveMock.mockReset();
    filterActiveMock.mockImplementation(
      async (_communityId: string, userIds: string[]) => userIds
    );
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false); // default: not muted
    isGroupMutedMock.mockReset();
    isGroupMutedMock.mockResolvedValue(false); // default: not muted
  });

  it("COMMUNITY → category:communityEnabled + communityId in FCM data", async () => {
    consume(
      makeMsg({ ...BASE, conversationType: "COMMUNITY", communityId: "comm1" })
    );
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => {
        category: string;
        data: Record<string, string>;
        apnsThreadId?: string;
        chatType?: string;
      },
    ];
    const push = builderFn("recipient-uuid");
    expect(push.category).toBe("communityEnabled");
    expect(push.data.communityId).toBe("comm1");
    expect(push.data.conversationType).toBe("COMMUNITY");
    // Regression: conversation-based grouping (thread-id) keyed by communityId,
    // NOT senderId — every community member's message groups under one thread.
    expect(push.apnsThreadId).toBe("community_comm1");
    expect(push.chatType).toBe("COMMUNITY");
  });

  it("PRIVATE → category:chatEnabled, no communityId in data map", async () => {
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => {
        category: string;
        data: Record<string, string>;
        apnsThreadId?: string;
        chatType?: string;
      },
    ];
    const push = builderFn("recipient-uuid");
    expect(push.category).toBe("chatEnabled");
    expect(push.data.communityId).toBeUndefined();
    // Regression: personal chat thread-id is keyed by conversationId, stable
    // across every message in the conversation regardless of sender.
    expect(push.apnsThreadId).toBe("chat_conv1");
    // Wire conversationType "PRIVATE" maps to chatType "PERSONAL" per the
    // documented grouping contract (chat_{conversationId} thread-id family).
    expect(push.chatType).toBe("PERSONAL");
  });

  it("GROUP → category:chatEnabled", async () => {
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => {
        category: string;
        apnsThreadId?: string;
        chatType?: string;
      },
    ];
    const push = builderFn("recipient-uuid");
    expect(push.category).toBe("chatEnabled");
    // Regression: group thread-id is keyed by conversationId (groupId), stable
    // regardless of which member sends the message.
    expect(push.apnsThreadId).toBe("group_conv1");
    expect(push.chatType).toBe("GROUP");
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
    filterActiveMock.mockReset();
    filterActiveMock.mockImplementation(
      async (_communityId: string, userIds: string[]) => userIds
    );
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false); // default: not muted
    isGroupMutedMock.mockReset();
    isGroupMutedMock.mockResolvedValue(false); // default: not muted
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

  // (3) PRIVATE invokes the community mute gate never (that's COMMUNITY-only);
  // the private mute gate (isPrivateRoomMutedBy) is exercised in the
  // dedicated "private mute suppression" describe block below.
  it("PRIVATE → community mute gate NEVER called; push still sent when not muted", async () => {
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE" }));
    await flush();

    expect(isMutedMock).not.toHaveBeenCalled();
    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  // (4) NEGATIVE — GROUP never invokes the COMMUNITY mute gate (it has its own,
  // exercised in the "group room mute suppression" describe block below).
  it("GROUP → community mute gate NEVER called; push still sent", async () => {
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

  // (6) EDGE — conversationType COMMUNITY but communityId MISSING → fall back
  // to conversationId (roomId === communityId) so the mute + ACTIVE-roster
  // gates still run.
  it("COMMUNITY + communityId undefined → falls back to conversationId for gates", async () => {
    const msg = makeMsg({ ...BASE, conversationType: "COMMUNITY" }); // no communityId
    consume(msg);
    await flush();

    expect(isMutedMock).toHaveBeenCalledWith(
      BASE.senderId,
      BASE.conversationId
    );
    expect(filterActiveMock).toHaveBeenCalledWith(BASE.conversationId, [
      "recipient-uuid",
    ]);
    expect(pushMany).toHaveBeenCalledTimes(1);
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });

  // (6b) ADVERSARIAL — EMPTY-STRING communityId. "" is falsy and is NOT nullish,
  // so we do NOT fall back to conversationId; gates stay skipped.
  it("COMMUNITY + communityId === '' → gate skipped (falsy guard), push sent", async () => {
    isMutedMock.mockResolvedValue(true); // even if the user WERE muted...
    consume(
      makeMsg({ ...BASE, conversationType: "COMMUNITY", communityId: "" })
    );
    await flush();

    expect(isMutedMock).not.toHaveBeenCalled(); // "" is falsy → gate bypassed
    expect(pushMany).toHaveBeenCalledTimes(1); // ...message still fans out
  });

  // (6c) LEFT/removed members must be stripped from FCM recipients even when
  // chat-service's stale RoomMember mirror still listed them.
  it("COMMUNITY → filters recipientIds to ACTIVE members only before FCM", async () => {
    filterActiveMock.mockResolvedValue(["still-active"]);
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
        recipientIds: ["still-active", "left-user", "banned-user"],
      })
    );
    await flush();

    expect(filterActiveMock).toHaveBeenCalledWith("comm1", [
      "still-active",
      "left-user",
      "banned-user",
    ]);
    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients] = pushMany.mock.calls[0] as [string[], unknown];
    expect(recipients).toEqual(["still-active"]);
  });

  it("COMMUNITY → no FCM when ACTIVE-roster filter removes everyone", async () => {
    filterActiveMock.mockResolvedValue([]);
    const msg = makeMsg({
      ...BASE,
      conversationType: "COMMUNITY",
      communityId: "comm1",
      recipientIds: ["left-user"],
    });
    consume(msg);
    await flush();

    expect(pushMany).not.toHaveBeenCalled();
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
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

/**
 * Private 1-to-1 mute must suppress push notifications ONLY — this consumer
 * is the sole push-decision chokepoint (see chat.consumer.ts), so gating here
 * is sufficient; persistence, unread counts, ordering, and socket events all
 * happen upstream in chat-service and are unaffected by this consumer.
 */
describe("startChatConsumer — private room mute suppression", () => {
  let consume: ConsumeCallback;

  beforeAll(async () => {
    consume = await setupConsumer();
  });

  beforeEach(() => {
    pushMany.mockClear();
    channelMock.ack.mockClear();
    channelMock.nack.mockClear();
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false);
  });

  it("PRIVATE + recipient muted the room → pushToUsers NOT called, message still ACKed", async () => {
    isPrivateMutedMock.mockResolvedValue(true);
    const msg = makeMsg({ ...BASE, conversationType: "PRIVATE" });
    consume(msg);
    await flush();

    expect(isPrivateMutedMock).toHaveBeenCalledWith(
      "recipient-uuid",
      BASE.conversationId
    );
    expect(pushMany).not.toHaveBeenCalled();
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  it("PRIVATE + recipient did NOT mute the room → push still sent", async () => {
    isPrivateMutedMock.mockResolvedValue(false);
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  it("PRIVATE, multiple recipients — only the muted one is dropped from fan-out", async () => {
    isPrivateMutedMock.mockImplementation(
      async (userId: string) => userId === "muted-user"
    );
    consume(
      makeMsg({
        ...BASE,
        conversationType: "PRIVATE",
        recipientIds: ["muted-user", "unmuted-user"],
      })
    );
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients] = pushMany.mock.calls[0] as [string[], unknown];
    expect(recipients).toEqual(["unmuted-user"]);
  });

  it("GROUP → mute gate IS invoked (a muted group must not push)", async () => {
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(isPrivateMutedMock).toHaveBeenCalled();
    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  it("GROUP, muted recipient → dropped from fan-out", async () => {
    isPrivateMutedMock.mockImplementation(
      async (userId: string) => userId === "muted-user"
    );
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["muted-user", "unmuted-user"],
      })
    );
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients] = pushMany.mock.calls[0] as [string[], unknown];
    expect(recipients).toEqual(["unmuted-user"]);
  });

  it("COMMUNITY → per-room mute gate not invoked (community mute is its own gate)", async () => {
    consume(makeMsg({ ...BASE, conversationType: "COMMUNITY" }));
    await flush();

    expect(isPrivateMutedMock).not.toHaveBeenCalled();
  });

  it("FAIL-OPEN: oracle resolves not-muted on outage → push still sent (not dropped)", async () => {
    isPrivateMutedMock.mockResolvedValue(false); // fail-open value from the gRPC client
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  it("unmute (mute gate flips back to false) → very next message resumes push, no restart needed", async () => {
    isPrivateMutedMock.mockResolvedValue(true);
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE", messageId: "m1" }));
    await flush();
    expect(pushMany).not.toHaveBeenCalled();

    // User unmutes — the gate is re-evaluated live on the next message, no
    // cache to invalidate and no reconnect/restart required.
    isPrivateMutedMock.mockResolvedValue(false);
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE", messageId: "m2" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
  });
});

/**
 * Push TITLE = the room name carried by THIS event.
 *
 * The stale-name bug: chat-service resolved the community name from a mirror
 * that was never updated on rename, so every later push repeated the old name.
 * This consumer is the last hop before FCM/APNs, so the lock here is "whatever
 * name arrives on the event is what the push says" — a renamed community/group
 * publishes the new name and the title follows it, with no cached name of its
 * own to go stale.
 */
describe("startChatConsumer — push title tracks the event's room name", () => {
  let consume: ConsumeCallback;

  type PushShape = {
    copy: (locale: string) => { title: string; body: string };
    data: Record<string, string>;
    showPreviewOverride?: (locale: string) => string;
  };

  const pushFor = (recipient = "recipient-uuid"): PushShape => {
    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => PushShape,
    ];
    return builderFn(recipient);
  };

  beforeAll(async () => {
    consume = await setupConsumer();
  });

  beforeEach(() => {
    pushMany.mockClear();
    isMutedMock.mockReset();
    isMutedMock.mockResolvedValue(false);
    filterActiveMock.mockReset();
    filterActiveMock.mockImplementation(
      async (_communityId: string, userIds: string[]) => userIds
    );
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false);
    isGroupMutedMock.mockReset();
    isGroupMutedMock.mockResolvedValue(false);
  });

  it("COMMUNITY renamed → title is the NEW name from the event, body is 'Sender: preview'", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
        communityName: "Mot u Patlu Community Official",
      })
    );
    await flush();

    const push = pushFor();
    expect(push.copy("en").title).toBe("Mot u Patlu Community Official");
    expect(push.copy("en").body).toBe("Alice: Hello!");
    expect(push.data.communityName).toBe("Mot u Patlu Community Official");
    // Preview-off recipients still get the CURRENT name, never the old one.
    expect(push.showPreviewOverride?.("en")).toBe(
      "New message in Mot u Patlu Community Official"
    );
  });

  it("GROUP renamed → title is the NEW group name (regression: groupName was dropped on the wire)", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        groupName: "Family Group 2026",
      })
    );
    await flush();

    const push = pushFor();
    expect(push.copy("en").title).toBe("Family Group 2026");
    expect(push.copy("en").body).toBe("Alice: Hello!");
    expect(push.data.groupName).toBe("Family Group 2026");
    expect(push.showPreviewOverride?.("en")).toBe(
      "New message in Family Group 2026"
    );
  });

  it("PRIVATE → still titles on the sender (no room name involved)", async () => {
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE" }));
    await flush();

    const push = pushFor();
    expect(push.copy("en").title).toBe("Alice");
    expect(push.copy("en").body).toBe("Hello!");
    expect(push.showPreviewOverride?.("en")).toBe("New message");
  });

  it("GROUP with no name on the event → falls back to the sender, never a stale name", async () => {
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(pushFor().copy("en").title).toBe("Alice");
  });
});

/**
 * Group-room mute must suppress push notifications ONLY — mirrors the
 * private-room mute describe block above, but the mute setting lives on the
 * per-membership GroupMember row (checked via isGroupMemberMuted) rather than
 * the room itself.
 */
describe("startChatConsumer — group room mute suppression", () => {
  let consume: ConsumeCallback;

  beforeAll(async () => {
    consume = await setupConsumer();
  });

  beforeEach(() => {
    pushMany.mockClear();
    channelMock.ack.mockClear();
    channelMock.nack.mockClear();
    isGroupMutedMock.mockReset();
    isGroupMutedMock.mockResolvedValue(false);
  });

  it("GROUP + member muted the room → pushToUsers NOT called, message still ACKed", async () => {
    isGroupMutedMock.mockResolvedValue(true);
    const msg = makeMsg({ ...BASE, conversationType: "GROUP" });
    consume(msg);
    await flush();

    expect(isGroupMutedMock).toHaveBeenCalledWith(
      "recipient-uuid",
      BASE.conversationId
    );
    expect(pushMany).not.toHaveBeenCalled();
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  it("GROUP + member did NOT mute the room → push still sent", async () => {
    isGroupMutedMock.mockResolvedValue(false);
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  it("GROUP, multiple recipients — only the muted one is dropped from fan-out", async () => {
    isGroupMutedMock.mockImplementation(
      async (userId: string) => userId === "muted-user"
    );
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["muted-user", "unmuted-user"],
      })
    );
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients] = pushMany.mock.calls[0] as [string[], unknown];
    expect(recipients).toEqual(["unmuted-user"]);
  });

  it("PRIVATE → group mute gate never invoked (group-only check)", async () => {
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE" }));
    await flush();

    expect(isGroupMutedMock).not.toHaveBeenCalled();
    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  it("FAIL-OPEN: oracle resolves not-muted on outage → push still sent (not dropped)", async () => {
    isGroupMutedMock.mockResolvedValue(false); // fail-open value from the gRPC client
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
  });
});
