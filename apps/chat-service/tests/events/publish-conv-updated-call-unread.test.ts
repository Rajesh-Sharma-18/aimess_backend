/**
 * conv:updated `unread` for SENDER-LESS rows (call cards).
 *
 * A call row has `senderId: ""`, so the "is this row mine?" test
 * (`recipientId !== senderId`) is true for BOTH participants — which flagged the
 * CALLER's own unanswered outgoing call as unread on their own inbox row. Where
 * the authoritative per-recipient count is supplied it now vetoes the flag.
 */
import { publishConvUpdated } from "../../src/events/publish-conv-updated.js";

function makeFakeRedis() {
  const publishCalls: Array<{ channel: string; payload: string }> = [];
  const pipeline = {
    publish(channel: string, payload: string) {
      publishCalls.push({ channel, payload });
      return pipeline;
    },
    async exec() {
      return [];
    },
  };
  return { redis: { pipeline: () => pipeline } as never, publishCalls };
}

const read = (
  calls: Array<{ channel: string; payload: string }>,
  userId: string
): { unread: boolean; unreadCount?: number } =>
  JSON.parse(calls.find((c) => c.channel === `user:${userId}`)!.payload).data;

describe("publishConvUpdated — unread on a sender-less call row", () => {
  it("does not flag the caller's own missed outgoing call as unread", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: "room-call",
      recipientIds: ["caller", "callee"],
      senderId: "", // a call row is sender-less
      lastMessageId: "msg-call",
      lastMessageAt: 1,
      preview: {
        contentType: "VOICE_CALL",
        text: "Voice call was not answered",
      },
      countInUnread: true, // MISSED is the one call state that raises a badge
      unreadCountByRecipient: { caller: 0, callee: 1 },
    });

    expect(read(publishCalls, "caller").unread).toBe(false);
    expect(read(publishCalls, "callee").unread).toBe(true);
    expect(read(publishCalls, "callee").unreadCount).toBe(1);
  });

  it("leaves rows without absolute counts exactly as they were", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: "room-text",
      recipientIds: ["sender", "peer"],
      senderId: "sender",
      lastMessageId: "msg-text",
      lastMessageAt: 1,
      preview: { contentType: "TEXT", text: "hi" },
    });

    expect(read(publishCalls, "sender").unread).toBe(false);
    expect(read(publishCalls, "peer").unread).toBe(true);
  });
});
