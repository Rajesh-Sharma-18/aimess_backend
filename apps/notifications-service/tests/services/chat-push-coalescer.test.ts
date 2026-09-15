/**
 * Burst coalescing for chat pushes.
 *
 * The reported symptom was one tray entry per message: ten messages typed at
 * someone in a few seconds produced ten notifications. These tests pin the four
 * decisions that fix it, all of which are made when the window FIRES rather than
 * when a message arrives — which is what lets "the recipient opened the chat
 * meanwhile" and "the sender deleted it meanwhile" cancel a notification that
 * was never sent.
 */
const redisMock = {
  status: "ready",
  on: jest.fn(),
  once: jest.fn(),
  off: jest.fn(),
  get: jest.fn(async () => null as string | null),
  set: jest.fn(async () => "OK"),
  del: jest.fn(async () => 0),
  pipeline: jest.fn(),
};
jest.mock("../../src/config/redis.js", () => ({ redis: redisMock }));

jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
}));

import { pushToUser } from "../../src/services/push.service.js";
import {
  enqueueChatPush,
  dropPendingChatMessage,
  updatePendingChatMessage,
  flushAllChatPushes,
  type ChatPushContext,
  type ChatPushMessage,
} from "../../src/services/chat-push-coalescer.js";

const push = pushToUser as unknown as jest.Mock;

const USER = "11111111-1111-4111-8111-111111111111";
const ROOM = "prv_burst_room";

/** `usersWithRoomOpen` reads through a pipeline of EXISTS; 0 = not looking. */
function roomOpen(open: boolean) {
  redisMock.pipeline.mockReturnValue({
    exists: jest.fn(),
    get: jest.fn(),
    exec: jest.fn(async () => [[null, open ? 1 : 0]]),
  });
}

const context = (over: Partial<ChatPushContext> = {}): ChatPushContext => ({
  userId: USER,
  conversationId: ROOM,
  conversationType: "PRIVATE",
  deepLink: `aimess://conversation/${ROOM}`,
  threadId: `chat_${ROOM}`,
  communityGatesPreResolved: false,
  ...over,
});

const message = (
  n: number,
  over: Partial<ChatPushMessage> = {}
): ChatPushMessage => ({
  messageId: `m${n}`,
  clientMessageId: `c${n}`,
  senderId: "sender-1",
  senderName: "Ana",
  senderAvatar: "",
  preview: `line ${n}`,
  messageType: "TEXT",
  sentAt: 1_700_000_000_000 + n,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  roomOpen(false);
});

afterEach(async () => {
  await flushAllChatPushes();
  jest.clearAllMocks();
});

describe("chat push coalescing", () => {
  it("D1: a 10-message burst produces exactly ONE push carrying the count and the newest line", async () => {
    for (let i = 1; i <= 10; i++) enqueueChatPush(context(), message(i));

    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(1);
    const sent = push.mock.calls[0][0];
    const copy = sent.copy("en");
    expect(copy.body).toContain("10 new messages");
    expect(copy.body).toContain("line 10");
    expect(sent.data.messageCount).toBe("10");
    expect(sent.data.messageId).toBe("m10");
  });

  it("D2: a second burst collapses onto the SAME tray entry instead of stacking", async () => {
    enqueueChatPush(context(), message(1));
    enqueueChatPush(context(), message(2));
    await flushAllChatPushes();
    enqueueChatPush(context(), message(3));
    enqueueChatPush(context(), message(4));
    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(2);
    const [first, second] = push.mock.calls.map((c) => c[0]);
    expect(first.collapseKey).toBe(`conv:${ROOM}`);
    expect(second.collapseKey).toBe(first.collapseKey);
  });

  it("D3/D5: nothing is pushed when the recipient has the room open at flush time", async () => {
    for (let i = 1; i <= 5; i++) enqueueChatPush(context(), message(i));
    roomOpen(true); // they opened the chat while the window was running

    await flushAllChatPushes();

    expect(push).not.toHaveBeenCalled();
  });

  it("D4: delivery skips sessions whose app is foregrounded", async () => {
    enqueueChatPush(context(), message(1));
    await flushAllChatPushes();

    expect(push.mock.calls[0][0].suppressForegroundSessions).toBe(true);
  });

  it("D6: a message deleted inside the window is never pushed", async () => {
    enqueueChatPush(context(), message(1));
    enqueueChatPush(context(), message(2));
    dropPendingChatMessage("m2");

    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(1);
    const copy = push.mock.calls[0][0].copy("en");
    expect(copy.body).toContain("line 1");
    expect(copy.body).not.toContain("line 2");
  });

  it("D6: deleting the only pending message cancels the notification entirely", async () => {
    enqueueChatPush(context(), message(1));
    dropPendingChatMessage("m1");

    await flushAllChatPushes();

    expect(push).not.toHaveBeenCalled();
  });

  it("D6: an edit inside the window is what gets pushed, not the original text", async () => {
    enqueueChatPush(context(), message(1));
    updatePendingChatMessage("m1", "corrected text");

    await flushAllChatPushes();

    const copy = push.mock.calls[0][0].copy("en");
    expect(copy.body).toContain("corrected text");
    expect(copy.body).not.toContain("line 1");
  });

  it("a single message keeps the ordinary one-message copy — no phantom count", async () => {
    enqueueChatPush(context(), message(7));

    await flushAllChatPushes();

    const copy = push.mock.calls[0][0].copy("en");
    expect(copy.title).toBe("Ana");
    expect(copy.body).toBe("line 7");
  });

  it("D8: the coalesced copy is a builder, so it renders in each recipient's language", async () => {
    for (let i = 1; i <= 3; i++) enqueueChatPush(context(), message(i));

    await flushAllChatPushes();

    const copy = push.mock.calls[0][0].copy;
    expect(copy("en").body).toContain("3 new messages");
    expect(copy("vi").body).toContain("3 tin nhắn mới");
    expect(copy("th").body).toContain("3 ข้อความใหม่");
  });

  it("H2: two rooms never share a window", async () => {
    enqueueChatPush(context(), message(1));
    enqueueChatPush(context({ conversationId: "grp_other" }), message(2));

    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(2);
    const rooms = push.mock.calls.map((c) => c[0].data.conversationId).sort();
    expect(rooms).toEqual(["grp_other", "prv_burst_room"]);
  });

  it("a group burst titles on the group and still carries the count", async () => {
    const ctx = context({
      conversationType: "GROUP",
      groupName: "Weekend Trip",
    });
    for (let i = 1; i <= 4; i++) enqueueChatPush(ctx, message(i));

    await flushAllChatPushes();

    const copy = push.mock.calls[0][0].copy("en");
    expect(copy.title).toBe("Weekend Trip");
    expect(copy.body).toContain("4 new messages");
    expect(copy.body).toContain("Ana");
  });
});

describe("chat push coalescing — group @mentions", () => {
  const GROUP = "grp_mention_room";
  const groupCtx = (over: Partial<ChatPushContext> = {}) =>
    context({
      conversationId: GROUP,
      conversationType: "GROUP",
      groupName: "Weekend Trip",
      deepLink: `aimess://conversation/${GROUP}`,
      threadId: `group_${GROUP}`,
      ...over,
    });

  it("a single mention uses the mention copy, its own collapse key and MENTION data", async () => {
    enqueueChatPush(
      groupCtx(),
      message(1, { preview: "hi @kristi", mentioned: true })
    );

    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(1);
    const sent = push.mock.calls[0][0];
    expect(sent.copy("en")).toEqual({
      title: "Weekend Trip",
      body: "Ana mentioned you: hi @kristi",
    });
    expect(sent.copy("vi").body).toBe("Ana đã nhắc đến bạn: hi @kristi");
    expect(sent.copy("th").body).toBe("Ana กล่าวถึงคุณ: hi @kristi");
    expect(sent.type).toBe("MESSAGE");
    expect(sent.skipInbox).toBe(true);
    expect(sent.collapseKey).toBe(`mention:${GROUP}`);
    expect(sent.data.type).toBe("MESSAGE");
    expect(sent.data.notificationType).toBe("MENTION");
    expect(sent.data.mentioned).toBe("true");
    expect(sent.data.messageId).toBe("m1");
    expect(sent.data.idempotencyKey).toBe("mention:m1");
    expect(JSON.parse(sent.data.navigation)).toMatchObject({
      screen: "GROUP_CHAT",
      roomId: GROUP,
      messageId: "m1",
    });
    // Preview-off recipients still learn it was a mention, never the text.
    expect(sent.showPreviewOverride("en")).toBe(
      "You were mentioned in Weekend Trip"
    );
    expect(sent.showPreviewOverride("vi")).toBe(
      "Bạn được nhắc đến trong Weekend Trip"
    );
  });

  it("a burst with a mention leads on the mention, not on the newest message", async () => {
    enqueueChatPush(groupCtx(), message(1));
    enqueueChatPush(
      groupCtx(),
      message(2, {
        senderName: "Bo",
        senderId: "bo",
        preview: "hey @kristi",
        mentioned: true,
      })
    );
    enqueueChatPush(groupCtx(), message(3));

    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(1);
    const sent = push.mock.calls[0][0];
    expect(sent.copy("en").body).toBe("Bo mentioned you: hey @kristi");
    expect(sent.actorId).toBe("bo");
    expect(sent.data.messageId).toBe("m2");
    expect(sent.data.senderName).toBe("Bo");
    expect(sent.data.preview).toBe("hey @kristi");
    expect(sent.data.idempotencyKey).toBe("mention:m2");
    expect(JSON.parse(sent.data.navigation).messageId).toBe("m2");
    expect(sent.data.messageCount).toBe("3");
    expect(sent.data.messageIds).toBe("m1,m2,m3");
  });

  it("the same message enqueued twice (send, then an edit that adds a mention) counts once and is a mention", async () => {
    enqueueChatPush(groupCtx(), message(1, { preview: "hi kristi" }));
    enqueueChatPush(
      groupCtx(),
      message(1, { preview: "hi @kristi", mentioned: true })
    );

    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(1);
    const sent = push.mock.calls[0][0];
    expect(sent.data.messageCount).toBe("1");
    expect(sent.data.messageIds).toBe("m1");
    expect(sent.data.notificationType).toBe("MENTION");
    expect(sent.copy("en").body).toBe("Ana mentioned you: hi @kristi");
  });

  it("a re-enqueue WITHOUT the flag never un-mentions a pending mention", async () => {
    enqueueChatPush(groupCtx(), message(1, { mentioned: true }));
    enqueueChatPush(groupCtx(), message(1));

    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].data.mentioned).toBe("true");
    expect(push.mock.calls[0][0].data.messageCount).toBe("1");
  });

  it("a non-mention group push is unchanged: no MENTION keys, conv collapse key, plain idempotency key", async () => {
    enqueueChatPush(groupCtx(), message(1));

    await flushAllChatPushes();

    const sent = push.mock.calls[0][0];
    expect(sent.collapseKey).toBe(`conv:${GROUP}`);
    expect(sent.actorId).toBe("sender-1");
    expect(sent.showPreviewOverride("en")).toBe("New message in Weekend Trip");
    expect(sent.data).toEqual({
      type: "MESSAGE",
      conversationId: GROUP,
      conversationType: "GROUP",
      messageId: "m1",
      clientMessageId: "c1",
      senderId: "sender-1",
      senderName: "Ana",
      senderAvatar: "",
      groupName: "Weekend Trip",
      canReply: "true",
      contentType: "TEXT",
      preview: "line 1",
      sentAt: String(1_700_000_000_001),
      idempotencyKey: "m1",
      messageCount: "1",
      messageIds: "m1",
      deepLink: `aimess://conversation/${GROUP}`,
      navigation: JSON.stringify({
        screen: "GROUP_CHAT",
        roomId: GROUP,
        conversationType: "GROUP",
        messageId: "m1",
      }),
    });
  });

  it("a mention with no group name falls back to generic title and hidden body", async () => {
    enqueueChatPush(
      groupCtx({ groupName: undefined }),
      message(1, { mentioned: true })
    );

    await flushAllChatPushes();

    const sent = push.mock.calls[0][0];
    expect(sent.copy("en").title).toBe("New message");
    expect(sent.showPreviewOverride("en")).toBe("You were mentioned");
  });

  it("room-open suppression still cancels a mention", async () => {
    enqueueChatPush(groupCtx(), message(1, { mentioned: true }));
    roomOpen(true);

    await flushAllChatPushes();

    expect(push).not.toHaveBeenCalled();
  });

  it("an edit that removes the mention cancels a push that was only that mention", async () => {
    enqueueChatPush(
      groupCtx(),
      message(1, { preview: "hi @kristi", mentioned: true })
    );

    updatePendingChatMessage("m1", "hi all", new Set());
    await flushAllChatPushes();

    expect(push).not.toHaveBeenCalled();
  });

  it("an edit that keeps the mention still pushes a mention, with the new text", async () => {
    enqueueChatPush(
      groupCtx(),
      message(1, { preview: "hi @kristi", mentioned: true })
    );

    updatePendingChatMessage("m1", "hey @kristi", new Set([USER]));
    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(1);
    const sent = push.mock.calls[0][0];
    expect(sent.data.notificationType).toBe("MENTION");
    expect(sent.copy("en").body).toBe("Ana mentioned you: hey @kristi");
  });

  it("a removed mention in a burst drops only that message; the rest flush as a normal push", async () => {
    enqueueChatPush(groupCtx(), message(1));
    enqueueChatPush(
      groupCtx(),
      message(2, { preview: "hi @kristi", mentioned: true })
    );

    updatePendingChatMessage("m2", "hi all", new Set());
    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(1);
    const sent = push.mock.calls[0][0];
    expect(sent.collapseKey).toBe(`conv:${GROUP}`);
    expect(sent.data.notificationType).toBeUndefined();
    expect(sent.data.messageIds).toBe("m1");
    expect(sent.copy("en").body).toContain("line 1");
  });

  it("an edit never drops a non-mention copy, and a mention the edit ADDS survives either arrival order", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    enqueueChatPush(groupCtx(), message(1, { preview: "hi kristi" }));
    enqueueChatPush(
      groupCtx({ userId: OTHER }),
      message(1, { preview: "hi kristi" })
    );
    // The edit frame can land before the consumer re-enqueues the mention...
    updatePendingChatMessage("m1", "hi @kristi", new Set([USER]));
    enqueueChatPush(
      groupCtx(),
      message(1, { preview: "hi @kristi", mentioned: true })
    );
    // ...or after it.
    updatePendingChatMessage("m1", "hi @kristi", new Set([USER]));

    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(2);
    const sentTo = (id: string) =>
      push.mock.calls.find((c) => c[0].userId === id)![0];
    expect(sentTo(USER).data.notificationType).toBe("MENTION");
    expect(sentTo(USER).data.messageCount).toBe("1");
    expect(sentTo(OTHER).data.notificationType).toBeUndefined();
    expect(sentTo(OTHER).copy("en").body).toContain("hi @kristi");
  });

  it("a mention push delayed past the edit that removed it is still dropped", async () => {
    updatePendingChatMessage("m1", "hi @kristi", new Set([USER]));
    updatePendingChatMessage("m1", "hi all", new Set());
    enqueueChatPush(
      groupCtx(),
      message(1, { preview: "hi @kristi", mentioned: true })
    );

    await flushAllChatPushes();

    expect(push).not.toHaveBeenCalled();
  });

  it("an update with no mention set (non-GROUP edit) leaves a pending mention flagged", async () => {
    enqueueChatPush(groupCtx(), message(1, { mentioned: true }));

    updatePendingChatMessage("m1", "fixed");
    await flushAllChatPushes();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].data.notificationType).toBe("MENTION");
    expect(push.mock.calls[0][0].data.preview).toBe("fixed");
  });
});
