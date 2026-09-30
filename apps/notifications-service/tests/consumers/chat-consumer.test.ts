/**
 * Push-notification coverage for the chat message consumer (chat.consumer.ts).
 *
 * Verifies the COMMUNITY conversationType branch added alongside T7:
 *
 *   - COMMUNITY messages use category:"chatEnabled", same as PRIVATE and GROUP —
 *     the account-level Chat toggle covers "1-1, group, community messages"
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

// Mock push.service — the FCM/APNs delivery boundary. Delivery now happens one
// recipient at a time, from the burst coalescer, so `pushToUser` is the seam
// these specs assert on; `pushToUsers` stays mocked for any other importer.
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
  pushToUsers: jest.fn(async () => undefined),
}));

// The coalescer asks Redis whether the recipient is currently reading the room
// (a pipeline of EXISTS), and the mention-row writer claims each row with a
// pipeline of SET NX. Nobody has a room open and nothing is claimed unless a
// spec puts keys into `mockRedisState`.
const mockRedisState = {
  open: new Set<string>(),
  claimed: new Set<string>(),
  claimError: false,
};
const mockRedisDel = jest.fn(async (..._keys: string[]) => 0);
jest.mock("../../src/config/redis.js", () => ({
  redis: {
    status: "ready",
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: mockRedisDel,
    // Per-(user, room) viewers hash. Nobody is looking at anything here — the
    // coalescer's session-level suppression has its own suite.
    hgetall: jest.fn(async () => ({})),
    pipeline: () => {
      const replies: Array<[null, unknown]> = [];
      let claims = false;
      const pipeline = {
        exists: (key: string) => {
          replies.push([null, mockRedisState.open.has(key) ? 1 : 0]);
          return pipeline;
        },
        get: jest.fn(),
        set: (key: string) => {
          claims = true;
          replies.push([null, mockRedisState.claimed.has(key) ? null : "OK"]);
          mockRedisState.claimed.add(key);
          return pipeline;
        },
        exec: async () => {
          if (claims && mockRedisState.claimError) {
            throw new Error("redis down");
          }
          return replies.length > 0 ? replies : [[null, 0]];
        },
      };
      return pipeline;
    },
  },
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
  filterToNotifiableCommunityMembers: jest.fn(
    async (_communityId: string, userIds: string[]) => userIds
  ),
  // Default: recipient has NOT muted the private room.
  isPrivateRoomMutedBy: jest.fn(async () => false),
  // Default: recipient has NOT muted the group room.
  isGroupMemberMuted: jest.fn(async () => false),
  // Default: nobody in the fan-out has muted the group (batched gate).
  filterOutMutedGroupMembers: jest.fn(
    async (_roomId: string, userIds: string[]) => userIds
  ),
}));

// @all opt-out reads the recipient's account settings. Default: not muted.
jest.mock("../../src/services/notification-settings.service.js", () => ({
  ...jest.requireActual("../../src/services/notification-settings.service.js"),
  getNotificationSettings: jest.fn(async () => ({ mentionAllMuted: false })),
}));

import { startChatConsumer } from "../../src/consumers/chat.consumer.js";
import { getNotificationSettings } from "../../src/services/notification-settings.service.js";
import { pushToUser } from "../../src/services/push.service.js";
import { flushAllChatPushes } from "../../src/services/chat-push-coalescer.js";
import {
  filterOutMutedGroupMembers,
  filterToNotifiableCommunityMembers,
  isCommunityActorMuted,
  isPrivateRoomMutedBy,
} from "../../src/services/notification-eligibility.service.js";

const pushOne = pushToUser as jest.Mock;

/**
 * These specs were written when the consumer dispatched the whole fan-out in one
 * `pushToUsers(recipientIds, build)` call. It now hands each recipient to the
 * burst coalescer, which delivers one push per (recipient, conversation) when
 * its window fires — so the assertions below still describe exactly the right
 * behaviour, they just have to look at it after the window has been flushed.
 * `pushMany` presents the flushed pushes in the original shape.
 */
const pushMany = jest.fn() as jest.Mock;
/**
 * Inbox-only `pushToUser` calls (`skipPush`) are the group mention ROWS, written
 * by the consumer itself before anything reaches the coalescer. They are kept
 * apart so the push assertions above keep seeing pushes only.
 */
type RowWrite = {
  userId: string;
  type: string;
  category: string;
  skipPush?: boolean;
  bypassSettings?: boolean;
  actorId?: string;
  inboxTitle?: string | null;
  copy?: (locale: string) => { title: string; body: string };
  data: Record<string, string>;
};
const rowWrites: RowWrite[] = [];
async function flushPushes(): Promise<void> {
  await flushAllChatPushes();
  const all = pushOne.mock.calls.map(
    (c) => c[0] as { userId: string } & Record<string, unknown>
  );
  pushOne.mockClear();
  rowWrites.push(
    ...(all.filter((i) => i.skipPush === true) as unknown as RowWrite[])
  );
  const inputs = all.filter((i) => i.skipPush !== true);
  if (inputs.length === 0) return;
  pushMany(
    inputs.map((i) => i.userId),
    (id: string) => inputs.find((i) => i.userId === id)
  );
}
const isMutedMock = isCommunityActorMuted as jest.Mock;
const filterNotifiableMock = filterToNotifiableCommunityMembers as jest.Mock;
const isPrivateMutedMock = isPrivateRoomMutedBy as jest.Mock;
const groupMuteFilterMock = filterOutMutedGroupMembers as jest.Mock;

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
const flush = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await flushPushes();
};

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
    pushOne.mockClear();
    channelMock.ack.mockClear();
    channelMock.nack.mockClear();
    isMutedMock.mockReset();
    isMutedMock.mockResolvedValue(false); // default: not muted
    filterNotifiableMock.mockReset();
    filterNotifiableMock.mockImplementation(
      async (_communityId: string, userIds: string[]) => userIds
    );
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false); // default: not muted
    groupMuteFilterMock.mockReset();
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    ); // default: not muted
  });

  it("COMMUNITY → category:chatEnabled + communityId in FCM data", async () => {
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
    expect(push.category).toBe("chatEnabled");
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
    pushOne.mockClear();
    channelMock.ack.mockClear();
    channelMock.nack.mockClear();
    isMutedMock.mockReset();
    isMutedMock.mockResolvedValue(false);
    filterNotifiableMock.mockReset();
    filterNotifiableMock.mockImplementation(
      async (_communityId: string, userIds: string[]) => userIds
    );
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false); // default: not muted
    groupMuteFilterMock.mockReset();
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    ); // default: not muted
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
  // that defeats fail-open), the consumer must neither fan out nor spin. The queue
  // has NO dead-letter exchange, so requeue=false DESTROYS the notification —
  // hence retry exactly once via redelivery, then drop. Bounded by the broker's
  // `redelivered` flag, so a deterministic failure still can't loop.
  it("ADVERSARIAL: gate throws on first delivery → requeued once (no fan-out)", async () => {
    isMutedMock.mockRejectedValue(new Error("eligibility blew up"));
    const msg = makeMsg({
      ...BASE,
      conversationType: "COMMUNITY",
      communityId: "comm1",
    });
    consume(msg);
    await flush();

    expect(pushMany).not.toHaveBeenCalled();
    expect(channelMock.nack).toHaveBeenCalledWith(msg, false, true);
    expect(channelMock.ack).not.toHaveBeenCalled();
  });

  it("ADVERSARIAL: gate throws on a REDELIVERED message → dropped (no spin)", async () => {
    isMutedMock.mockRejectedValue(new Error("eligibility blew up"));
    const msg = {
      ...makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
      }),
      fields: { redelivered: true },
    };
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
    expect(filterNotifiableMock).toHaveBeenCalledWith(
      BASE.conversationId,
      ["recipient-uuid"],
      "chatEnabled"
    );
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
    filterNotifiableMock.mockResolvedValue(["still-active"]);
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
        recipientIds: ["still-active", "left-user", "banned-user"],
      })
    );
    await flush();

    expect(filterNotifiableMock).toHaveBeenCalledWith(
      "comm1",
      ["still-active", "left-user", "banned-user"],
      "chatEnabled"
    );
    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients] = pushMany.mock.calls[0] as [string[], unknown];
    expect(recipients).toEqual(["still-active"]);
  });

  it("COMMUNITY → no FCM when ACTIVE-roster filter removes everyone", async () => {
    filterNotifiableMock.mockResolvedValue([]);
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
    pushOne.mockClear();
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

  /**
   * The private gate used to run for GROUP too, because `checkPrivateMute`
   * answers a group room id by missing PrivateRoom and falling through to the
   * very `GroupMember.notificationSettings` read the group gate performs — the
   * same verdict, reached in three queries per recipient instead of one. A
   * group message is now decided solely by the group gate; the suppression it
   * produces is asserted in the "group room mute suppression" block below.
   */
  it("GROUP → private gate NOT invoked (the group gate decides, in one query)", async () => {
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(isPrivateMutedMock).not.toHaveBeenCalled();
    expect(pushMany).toHaveBeenCalledTimes(1);
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
    pushOne.mockClear();
    isMutedMock.mockReset();
    isMutedMock.mockResolvedValue(false);
    filterNotifiableMock.mockReset();
    filterNotifiableMock.mockImplementation(
      async (_communityId: string, userIds: string[]) => userIds
    );
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false);
    groupMuteFilterMock.mockReset();
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    );
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

  it("GROUP → the group avatar rides the data map under BOTH the generic and the group-specific key (never the sender's)", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        groupName: "Testing Vasundhara",
        conversationAvatar: "https://cdn.example.com/group.png",
      })
    );
    await flush();

    const push = pushFor();
    expect(push.data.conversationAvatar).toBe(
      "https://cdn.example.com/group.png"
    );
    // Android MESSAGE pushes are data-only, so the data map is the only place a
    // picture can reach the tray — and a client keyed on the same name group
    // lifecycle events use must find it there too.
    expect(push.data.groupAvatarUrl).toBe("https://cdn.example.com/group.png");
    // The actor's avatar is still carried for the in-app row, but it is NOT
    // what represents the conversation.
    expect(push.data.senderAvatar).toBe("https://cdn.example.com/alice.png");
    expect(push.data.communityAvatarUrl).toBeUndefined();
  });

  it("GROUP with no avatar → no avatar keys at all (empty string would be a broken image, not a fallback)", async () => {
    consume(
      makeMsg({ ...BASE, conversationType: "GROUP", groupName: "No Photo" })
    );
    await flush();

    const push = pushFor();
    expect(push.data.conversationAvatar).toBeUndefined();
    expect(push.data.groupAvatarUrl).toBeUndefined();
  });

  it("COMMUNITY → the room logo rides under communityAvatarUrl, the key every other community push uses", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
        conversationAvatar: "https://cdn.example.com/community.png",
      })
    );
    await flush();

    const push = pushFor();
    expect(push.data.communityAvatarUrl).toBe(
      "https://cdn.example.com/community.png"
    );
    expect(push.data.conversationAvatar).toBe(
      "https://cdn.example.com/community.png"
    );
    expect(push.data.groupAvatarUrl).toBeUndefined();
  });

  it("PRIVATE → no conversation avatar (the sender IS the entity — unchanged behaviour)", async () => {
    consume(makeMsg({ ...BASE, conversationType: "PRIVATE" }));
    await flush();

    const push = pushFor();
    expect(push.data.conversationAvatar).toBeUndefined();
    expect(push.data.groupAvatarUrl).toBeUndefined();
    expect(push.data.communityAvatarUrl).toBeUndefined();
    expect(push.data.senderAvatar).toBe("https://cdn.example.com/alice.png");
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
    pushOne.mockClear();
    channelMock.ack.mockClear();
    channelMock.nack.mockClear();
    groupMuteFilterMock.mockReset();
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    );
  });

  it("GROUP + member muted the room → pushToUsers NOT called, message still ACKed", async () => {
    groupMuteFilterMock.mockResolvedValue([]);
    const msg = makeMsg({ ...BASE, conversationType: "GROUP" });
    consume(msg);
    await flush();

    expect(groupMuteFilterMock).toHaveBeenCalledWith(BASE.conversationId, [
      "recipient-uuid",
    ]);
    expect(pushMany).not.toHaveBeenCalled();
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  it("GROUP + member did NOT mute the room → push still sent", async () => {
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    );
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  it("GROUP, multiple recipients — only the muted one is dropped from fan-out", async () => {
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) =>
        userIds.filter((id) => id !== "muted-user")
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

    expect(groupMuteFilterMock).not.toHaveBeenCalled();
    expect(pushMany).toHaveBeenCalledTimes(1);
  });

  it("FAIL-OPEN: oracle resolves not-muted on outage → push still sent (not dropped)", async () => {
    // The breaker fallback returns an empty muted set: every candidate survives.
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    );
    consume(makeMsg({ ...BASE, conversationType: "GROUP" }));
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
  });
});

/**
 * Group @mentions: a mention bypasses the recipient's GroupMember mute (the
 * shipped mute copy promises it), is flagged through to the coalescer, and is
 * ignored entirely for PRIVATE/COMMUNITY.
 */
describe("startChatConsumer — group @mentions", () => {
  let consume: ConsumeCallback;

  type PushShape = {
    userId: string;
    collapseKey?: string;
    data: Record<string, string>;
  };
  const flushed = (): PushShape[] => {
    if (pushMany.mock.calls.length === 0) return [];
    const [ids, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => PushShape,
    ];
    return ids.map((id) => builderFn(id));
  };

  beforeAll(async () => {
    consume = await setupConsumer();
  });

  beforeEach(() => {
    pushMany.mockClear();
    pushOne.mockClear();
    channelMock.ack.mockClear();
    isMutedMock.mockReset();
    isMutedMock.mockResolvedValue(false);
    filterNotifiableMock.mockReset();
    filterNotifiableMock.mockImplementation(
      async (_communityId: string, userIds: string[]) => userIds
    );
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false);
    groupMuteFilterMock.mockReset();
    // Everyone handed to the gate has muted the group.
    groupMuteFilterMock.mockResolvedValue([]);
  });

  it("muted + mentioned → still pushed, flagged as a mention; muted + not mentioned → dropped", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        groupName: "Weekend Trip",
        recipientIds: ["mentioned-user", "plain-user"],
        mentionedUserIds: ["mentioned-user"],
      })
    );
    await flush();

    // The gate only ever sees the NON-mentioned recipients.
    expect(groupMuteFilterMock).toHaveBeenCalledTimes(1);
    expect(groupMuteFilterMock).toHaveBeenCalledWith(BASE.conversationId, [
      "plain-user",
    ]);
    const pushes = flushed();
    expect(pushes.map((p) => p.userId)).toEqual(["mentioned-user"]);
    expect(pushes[0]!.data.notificationType).toBe("MENTION");
    expect(pushes[0]!.data.mentioned).toBe("true");
    expect(pushes[0]!.collapseKey).toBe(`mention:${BASE.conversationId}`);
  });

  it("every recipient mentioned → the mute gate is not called at all", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["a", "b"],
        mentionedUserIds: ["a", "b"],
      })
    );
    await flush();

    expect(groupMuteFilterMock).not.toHaveBeenCalled();
    expect(flushed().map((p) => p.userId)).toEqual(["a", "b"]);
  });

  it("a mentioned id that is not in recipientIds is never added", async () => {
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    );
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["recipient-uuid"],
        mentionedUserIds: ["outsider", BASE.senderId],
      })
    );
    await flush();

    const pushes = flushed();
    expect(pushes.map((p) => p.userId)).toEqual(["recipient-uuid"]);
    expect(pushes[0]!.data.notificationType).toBeUndefined();
    expect(pushes[0]!.collapseKey).toBe(`conv:${BASE.conversationId}`);
  });

  it("the sender is never notified even when listed as mentioned", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: [BASE.senderId],
        mentionedUserIds: [BASE.senderId],
      })
    );
    await flush();

    expect(pushMany).not.toHaveBeenCalled();
  });

  it("PRIVATE → mentionedUserIds ignored: the private mute still suppresses, no mention flag", async () => {
    isPrivateMutedMock.mockResolvedValue(true);
    consume(
      makeMsg({
        ...BASE,
        conversationType: "PRIVATE",
        mentionedUserIds: ["recipient-uuid"],
      })
    );
    await flush();
    expect(pushMany).not.toHaveBeenCalled();

    isPrivateMutedMock.mockResolvedValue(false);
    consume(
      makeMsg({
        ...BASE,
        conversationType: "PRIVATE",
        messageId: "msg2",
        mentionedUserIds: ["recipient-uuid"],
      })
    );
    await flush();
    const pushes = flushed();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.data.notificationType).toBeUndefined();
    expect(pushes[0]!.data.mentioned).toBeUndefined();
  });

  it("COMMUNITY → mentionedUserIds ignored (no mention flag, group gate untouched)", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "COMMUNITY",
        communityId: "comm1",
        mentionedUserIds: ["recipient-uuid"],
      })
    );
    await flush();

    expect(groupMuteFilterMock).not.toHaveBeenCalled();
    const pushes = flushed();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.data.notificationType).toBeUndefined();
    expect(pushes[0]!.collapseKey).toBe(`conv:${BASE.conversationId}`);
  });
});

/**
 * Group @all: server-resolved `mentionAllUserIds` bypass the group mute unless
 * the recipient muted @all account-wide; `mentionOnly` (edit publish) restricts
 * the push to the mentioned sets.
 */
describe("startChatConsumer — group @all", () => {
  let consume: ConsumeCallback;
  const settingsMock = getNotificationSettings as jest.Mock;

  type PushShape = {
    userId: string;
    collapseKey?: string;
    data: Record<string, string>;
  };
  const flushed = (): PushShape[] => {
    if (pushMany.mock.calls.length === 0) return [];
    const [ids, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => PushShape,
    ];
    return ids.map((id) => builderFn(id));
  };
  const pushTo = (id: string) => flushed().find((p) => p.userId === id);
  const muteAllFor = (...ids: string[]) =>
    settingsMock.mockImplementation(async (id: string) => ({
      mentionAllMuted: ids.includes(id),
    }));

  beforeAll(async () => {
    consume = await setupConsumer();
  });

  beforeEach(() => {
    pushMany.mockClear();
    pushOne.mockClear();
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false);
    filterNotifiableMock.mockReset();
    filterNotifiableMock.mockImplementation(
      async (_communityId: string, userIds: string[]) => userIds
    );
    groupMuteFilterMock.mockReset();
    // Everyone handed to the gate has muted the group.
    groupMuteFilterMock.mockResolvedValue([]);
    settingsMock.mockReset();
    muteAllFor();
  });

  it("@all recipients who did not mute @all bypass the group mute, flagged ALL", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        groupName: "Weekend Trip",
        recipientIds: ["a", "b"],
        mentionAllUserIds: ["a", "b"],
      })
    );
    await flush();

    expect(groupMuteFilterMock).not.toHaveBeenCalled();
    const pushes = flushed();
    expect(pushes.map((p) => p.userId)).toEqual(["a", "b"]);
    for (const p of pushes) {
      expect(p.data.notificationType).toBe("MENTION");
      expect(p.data.mentionType).toBe("ALL");
      expect(p.collapseKey).toBe(`mention:${BASE.conversationId}`);
    }
  });

  it("a muted-@all user goes through the group mute gate like a plain member", async () => {
    muteAllFor("opted-out");
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    );
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["opted-out"],
        mentionAllUserIds: ["opted-out"],
      })
    );
    await flush();

    expect(groupMuteFilterMock).toHaveBeenCalledWith(BASE.conversationId, [
      "opted-out",
    ]);
    const push = pushTo("opted-out")!;
    expect(push.data.notificationType).toBeUndefined();
    expect(push.data.mentioned).toBeUndefined();
    expect(push.collapseKey).toBe(`conv:${BASE.conversationId}`);
  });

  it("a muted-@all user who also muted the group gets nothing", async () => {
    muteAllFor("opted-out");
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["opted-out"],
        mentionAllUserIds: ["opted-out"],
      })
    );
    await flush();

    expect(pushMany).not.toHaveBeenCalled();
  });

  it("individual + @all for the same user → one push, individual mention wins, no settings read", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["a"],
        mentionedUserIds: ["a"],
        mentionAllUserIds: ["a"],
      })
    );
    await flush();

    expect(settingsMock).not.toHaveBeenCalled();
    const pushes = flushed();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.data.mentionType).toBe("USER");
  });

  it("the sender and ids outside recipientIds are never notified or looked up", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: [BASE.senderId, "a"],
        mentionAllUserIds: [BASE.senderId, "outsider", "a"],
      })
    );
    await flush();

    expect(settingsMock.mock.calls.map((c) => c[0])).toEqual(["a"]);
    expect(flushed().map((p) => p.userId)).toEqual(["a"]);
  });

  it("mentionOnly restricts the push to the mentioned sets (opted-out user gets nothing)", async () => {
    muteAllFor("opted-out");
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    );
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["named", "everyone", "opted-out", "plain"],
        mentionedUserIds: ["named"],
        mentionAllUserIds: ["everyone", "opted-out"],
        mentionOnly: true,
      })
    );
    await flush();

    expect(groupMuteFilterMock).not.toHaveBeenCalled();
    expect(flushed().map((p) => p.userId)).toEqual(["named", "everyone"]);
    expect(pushTo("named")!.data.mentionType).toBe("USER");
    expect(pushTo("everyone")!.data.mentionType).toBe("ALL");
  });

  it("a settings read failure treats the user as allowed", async () => {
    settingsMock.mockRejectedValue(new Error("settings down"));
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["a"],
        mentionAllUserIds: ["a"],
      })
    );
    await flush();

    expect(groupMuteFilterMock).not.toHaveBeenCalled();
    expect(pushTo("a")!.data.mentionType).toBe("ALL");
  });

  it("PRIVATE ignores @all fields: no settings read, no mention flag, mentionOnly ignored", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "PRIVATE",
        mentionAllUserIds: ["recipient-uuid"],
        mentionOnly: true,
      })
    );
    await flush();

    expect(settingsMock).not.toHaveBeenCalled();
    const pushes = flushed();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.data.notificationType).toBeUndefined();
  });
});

/**
 * Group mention Notification-Center rows: one inbox-only `chat.mention` row per
 * (message, mentioned recipient), written before the push is enqueued, and
 * removed again by `chat.mention_retracted`.
 */
describe("startChatConsumer — group mention inbox rows", () => {
  let consume: ConsumeCallback;
  const settingsMock = getNotificationSettings as jest.Mock;
  const muteAllFor = (...ids: string[]) =>
    settingsMock.mockImplementation(async (id: string) => ({
      mentionAllMuted: ids.includes(id),
    }));
  const claimKey = (userId: string, messageId = BASE.messageId) =>
    `notif:mention-row:{${messageId}}:${userId}`;
  const rowFor = (id: string) => rowWrites.find((r) => r.userId === id);
  const pushedIds = (): string[] =>
    pushMany.mock.calls.length === 0
      ? []
      : (pushMany.mock.calls[0] as [string[]])[0];

  beforeAll(async () => {
    consume = await setupConsumer();
  });

  beforeEach(() => {
    rowWrites.length = 0;
    pushMany.mockClear();
    pushOne.mockClear();
    pushOne.mockImplementation(async () => undefined);
    channelMock.ack.mockClear();
    channelMock.nack.mockClear();
    isPrivateMutedMock.mockReset();
    isPrivateMutedMock.mockResolvedValue(false);
    filterNotifiableMock.mockReset();
    filterNotifiableMock.mockImplementation(
      async (_communityId: string, userIds: string[]) => userIds
    );
    groupMuteFilterMock.mockReset();
    groupMuteFilterMock.mockImplementation(
      async (_roomId: string, userIds: string[]) => userIds
    );
    settingsMock.mockReset();
    muteAllFor();
    mockRedisState.open.clear();
    mockRedisState.claimed.clear();
    mockRedisState.claimError = false;
    mockRedisDel.mockClear();
  });

  it("individual mention → one chat.mention row per mentioned recipient, never the sender or an outsider", async () => {
    // Everyone handed to the group mute gate has muted the group: the mention
    // row, like the push, bypasses it.
    groupMuteFilterMock.mockResolvedValue([]);
    const msg = makeMsg({
      ...BASE,
      conversationType: "GROUP",
      groupName: "Weekend Trip",
      conversationAvatar: "https://cdn.example.com/group.png",
      recipientIds: ["mentioned-user", "plain-user", BASE.senderId],
      mentionedUserIds: ["mentioned-user", "outsider", BASE.senderId],
    });
    consume(msg);
    await flush();

    expect(rowWrites.map((r) => r.userId)).toEqual(["mentioned-user"]);
    const row = rowWrites[0]!;
    expect(row.type).toBe("chat.mention");
    expect(row.category).toBe("chatEnabled");
    expect(row.skipPush).toBe(true);
    expect(row.bypassSettings).toBeUndefined();
    expect(row.actorId).toBe(BASE.senderId);
    expect(row.inboxTitle).toBeNull();
    expect(row.copy!("en")).toEqual({
      title: "Weekend Trip",
      body: "Alice mentioned you in Weekend Trip",
    });
    const { actorSnapshot, navigation, ...rest } = row.data;
    expect(rest).toEqual({
      groupKey: `mention:${BASE.messageId}`,
      mentionType: "USER",
      conversationId: BASE.conversationId,
      conversationType: "GROUP",
      messageId: BASE.messageId,
      groupName: "Weekend Trip",
      groupAvatarUrl: "https://cdn.example.com/group.png",
    });
    expect(JSON.parse(actorSnapshot!)).toEqual({
      userId: BASE.senderId,
      displayName: "Alice",
      avatarUrl: BASE.senderAvatar,
    });
    expect(JSON.parse(navigation!)).toEqual({
      screen: "GROUP_CHAT",
      roomId: BASE.conversationId,
      conversationType: "GROUP",
      messageId: BASE.messageId,
    });
    // The push itself is unchanged.
    expect(pushedIds()).toEqual(["mentioned-user"]);
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });

  it("@all → rows for recipients who did not mute @all only", async () => {
    muteAllFor("opted-out");
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        groupName: "Weekend Trip",
        recipientIds: ["a", "opted-out"],
        mentionAllUserIds: ["a", "opted-out"],
      })
    );
    await flush();

    expect(rowWrites.map((r) => r.userId)).toEqual(["a"]);
    expect(rowFor("a")!.data.mentionType).toBe("ALL");
    // Reached as part of the room, not named: never "mentioned you".
    expect(rowFor("a")!.copy!("en").body).toBe(
      "Alice mentioned @all in Weekend Trip"
    );
    expect(rowFor("a")!.copy!("vi").body).toBe(
      "Alice đã nhắc đến @all trong Weekend Trip"
    );
    expect(rowFor("a")!.copy!("th").body).toBe(
      "Alice กล่าวถึง @all ในWeekend Trip"
    );
    // The opted-out user still gets their ordinary message push.
    expect(pushedIds()).toEqual(["a", "opted-out"]);
  });

  it("@all + individual for the same user → one row, mentionType USER", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        groupName: "Weekend Trip",
        recipientIds: ["a"],
        mentionedUserIds: ["a"],
        mentionAllUserIds: ["a"],
      })
    );
    await flush();

    expect(rowWrites).toHaveLength(1);
    expect(rowWrites[0]!.data.mentionType).toBe("USER");
    // Being named outranks being in the room, and the copy follows the type.
    expect(rowWrites[0]!.copy!("en").body).toBe(
      "Alice mentioned you in Weekend Trip"
    );
  });

  it("named and @all recipients of one message get their own wording", async () => {
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        groupName: "Weekend Trip",
        recipientIds: ["named", "everyone"],
        mentionedUserIds: ["named"],
        mentionAllUserIds: ["named", "everyone"],
      })
    );
    await flush();

    expect(rowFor("named")!.copy!("en").body).toBe(
      "Alice mentioned you in Weekend Trip"
    );
    expect(rowFor("everyone")!.copy!("en").body).toBe(
      "Alice mentioned @all in Weekend Trip"
    );
  });

  it("a recipient with the room open gets the row already read", async () => {
    mockRedisState.open.add(`chat:open:{b}:${BASE.conversationId}`);
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["a", "b"],
        mentionedUserIds: ["a", "b"],
      })
    );
    await flush();

    expect(rowFor("a")!.data.markRead).toBeUndefined();
    expect(rowFor("b")!.data.markRead).toBe("true");
  });

  it("an already-claimed row is not written again (push still enqueued)", async () => {
    mockRedisState.claimed.add(claimKey("a"));
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["a", "b"],
        mentionedUserIds: ["a", "b"],
      })
    );
    await flush();

    expect(rowWrites.map((r) => r.userId)).toEqual(["b"]);
    expect(pushedIds()).toEqual(["a", "b"]);
  });

  it("a claim pipeline error fails open → rows still written", async () => {
    mockRedisState.claimError = true;
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["a"],
        mentionedUserIds: ["a"],
      })
    );
    await flush();

    expect(rowWrites.map((r) => r.userId)).toEqual(["a"]);
    expect(pushedIds()).toEqual(["a"]);
  });

  it("one row write rejects → its claim is released, message requeued, nothing enqueued", async () => {
    pushOne.mockImplementation(async (input: RowWrite) => {
      if (input.skipPush && input.userId === "b") {
        throw new Error("gRPC deadline exceeded");
      }
    });
    const msg = makeMsg({
      ...BASE,
      conversationType: "GROUP",
      recipientIds: ["a", "b"],
      mentionedUserIds: ["a", "b"],
    });
    consume(msg);
    await flush();

    expect(rowWrites.map((r) => r.userId)).toEqual(["a", "b"]);
    expect(mockRedisDel).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).toHaveBeenCalledWith(claimKey("b"));
    expect(pushMany).not.toHaveBeenCalled();
    expect(channelMock.nack).toHaveBeenCalledWith(msg, false, true);
    expect(channelMock.ack).not.toHaveBeenCalled();
  });

  it("a row write that fails again on redelivery → rows lost, push still enqueued, acked", async () => {
    pushOne.mockImplementation(async (input: RowWrite) => {
      if (input.skipPush) throw new Error("breaker open");
    });
    const msg = {
      ...makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["a", "plain"],
        mentionedUserIds: ["a"],
      }),
      fields: { redelivered: true },
    };
    consume(msg);
    await flush();

    expect(pushedIds()).toEqual(["a", "plain"]);
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  it("the push is enqueued only after the rows are written", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pushOne.mockImplementation(async (input: RowWrite) => {
      if (input.skipPush) await gate;
    });
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["a"],
        mentionedUserIds: ["a"],
      })
    );
    await new Promise((r) => setImmediate(r));
    await flushAllChatPushes();
    expect(
      pushOne.mock.calls.filter((c) => (c[0] as RowWrite).skipPush !== true)
    ).toHaveLength(0);

    release();
    await flush();
    expect(rowWrites.map((r) => r.userId)).toEqual(["a"]);
    expect(pushedIds()).toEqual(["a"]);
  });

  it("mentionOnly edit publish → rows only for the mentioned sets", async () => {
    muteAllFor("opted-out");
    consume(
      makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["named", "everyone", "opted-out", "plain"],
        mentionedUserIds: ["named"],
        mentionAllUserIds: ["everyone", "opted-out"],
        mentionOnly: true,
      })
    );
    await flush();

    expect(rowWrites.map((r) => [r.userId, r.data.mentionType])).toEqual([
      ["named", "USER"],
      ["everyone", "ALL"],
    ]);
  });

  it.each(["PRIVATE", "COMMUNITY"])(
    "%s → mention fields never produce a row",
    async (conversationType) => {
      consume(
        makeMsg({
          ...BASE,
          conversationType,
          communityId: conversationType === "COMMUNITY" ? "comm1" : undefined,
          mentionedUserIds: ["recipient-uuid"],
          mentionAllUserIds: ["recipient-uuid"],
        })
      );
      await flush();

      expect(rowWrites).toHaveLength(0);
      expect(pushedIds()).toEqual(["recipient-uuid"]);
    }
  );

  it("chat.mention_retracted → one inbox-only, settings-bypassing removal per user", async () => {
    const msg = {
      content: Buffer.from(
        JSON.stringify({
          type: "chat.mention_retracted",
          data: {
            messageId: "msg9",
            conversationId: BASE.conversationId,
            userIds: ["a", "b", "a"],
          },
        })
      ),
    };
    consume(msg);
    await flush();

    expect(rowWrites).toHaveLength(2);
    for (const [i, userId] of ["a", "b"].entries()) {
      expect(rowWrites[i]).toEqual({
        userId,
        category: "chatEnabled",
        type: "chat.mention_retracted",
        skipPush: true,
        bypassSettings: true,
        data: {
          groupKey: "mention:msg9",
          conversationId: BASE.conversationId,
          messageId: "msg9",
        },
      });
    }
    expect(pushMany).not.toHaveBeenCalled();
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });

  it("chat.mention_retracted with a failed removal → requeued", async () => {
    pushOne.mockRejectedValueOnce(new Error("gRPC down"));
    const msg = {
      content: Buffer.from(
        JSON.stringify({
          type: "chat.mention_retracted",
          data: {
            messageId: "msg9",
            conversationId: BASE.conversationId,
            userIds: ["a"],
          },
        })
      ),
    };
    consume(msg);
    await flush();

    expect(channelMock.nack).toHaveBeenCalledWith(msg, false, true);
  });

  const retractMsg = (data: object) => ({
    content: Buffer.from(
      JSON.stringify({
        type: "chat.mention_retracted",
        data: {
          messageId: "msg9",
          conversationId: BASE.conversationId,
          ...data,
        },
      })
    ),
  });

  it("album: the row keys, claims and navigates on mentionMessageId; the push keeps messageId", async () => {
    consume(
      makeMsg({
        ...BASE,
        messageId: "row2",
        mentionMessageId: "row0",
        conversationType: "GROUP",
        recipientIds: ["a"],
        mentionedUserIds: ["a"],
      })
    );
    await flush();

    expect(mockRedisState.claimed).toEqual(new Set([claimKey("a", "row0")]));
    const row = rowFor("a")!;
    expect(row.data.groupKey).toBe("mention:row0");
    expect(row.data.messageId).toBe("row0");
    expect(JSON.parse(row.data.navigation!).messageId).toBe("row0");
    const [, build] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => { data: Record<string, string> },
    ];
    expect(build("a").data.messageId).toBe("row2");
  });

  it("a redelivery ignores an existing claim and writes every row (groupKey dedupes)", async () => {
    mockRedisState.claimed.add(claimKey("a"));
    const msg = {
      ...makeMsg({
        ...BASE,
        conversationType: "GROUP",
        recipientIds: ["a", "b"],
        mentionedUserIds: ["a", "b"],
      }),
      fields: { redelivered: true },
    };
    consume(msg);
    await flush();

    expect(rowWrites.map((r) => r.userId)).toEqual(["a", "b"]);
    expect(pushedIds()).toEqual(["a", "b"]);
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });

  it("inboxOnly → rows written despite a stale claim, no claim taken, nothing pushed", async () => {
    mockRedisState.claimed.add(claimKey("a"));
    const msg = makeMsg({
      ...BASE,
      conversationType: "GROUP",
      recipientIds: ["a", "b"],
      mentionedUserIds: ["a", "b"],
      mentionOnly: true,
      inboxOnly: true,
    });
    consume(msg);
    await flush();

    expect(rowWrites.map((r) => r.userId)).toEqual(["a", "b"]);
    expect(mockRedisState.claimed).toEqual(new Set([claimKey("a")]));
    expect(pushMany).not.toHaveBeenCalled();
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });

  it("chat.mention_retracted releases the retracted users' row claims", async () => {
    consume(retractMsg({ userIds: ["a", "b"] }));
    await flush();

    expect(mockRedisDel).toHaveBeenCalledWith(
      claimKey("a", "msg9"),
      claimKey("b", "msg9")
    );
  });

  it("ifAllMutedUserIds → only @all-muted users are retracted; a settings error keeps the row", async () => {
    settingsMock.mockImplementation(async (id: string) => {
      if (id === "broken") throw new Error("settings down");
      return { mentionAllMuted: id === "muted" };
    });
    const msg = retractMsg({
      userIds: ["named"],
      ifAllMutedUserIds: ["muted", "allows-all", "broken"],
    });
    consume(msg);
    await flush();

    expect(rowWrites.map((r) => r.userId)).toEqual(["named", "muted"]);
    expect(mockRedisDel).toHaveBeenCalledWith(
      claimKey("named", "msg9"),
      claimKey("muted", "msg9")
    );
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });

  it("ifAllMutedUserIds with nobody muted → no removal, no DEL, acked", async () => {
    const msg = retractMsg({ userIds: [], ifAllMutedUserIds: ["allows-all"] });
    consume(msg);
    await flush();

    expect(rowWrites).toHaveLength(0);
    expect(mockRedisDel).not.toHaveBeenCalled();
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });
});
