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
