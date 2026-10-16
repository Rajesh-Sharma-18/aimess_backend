/**
 * Delete-for-everyone of an OLDER message: the shared row does not move, but
 * the recipient's badge does — every non-loser gets the unchanged row repeated
 * with the post-delete count and the removed message's id.
 */
import { publishConvEffectiveLastLoss } from "../../src/events/publish-effective-last-loss.js";

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

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("publishConvEffectiveLastLoss — older unread delete", () => {
  it("repeats the unchanged row with the post-delete count", async () => {
    const { redis, publishCalls } = makeFakeRedis();
    await publishConvEffectiveLastLoss({
      redis,
      type: "PRIVATE",
      roomId: "room-1",
      recipientIds: async () => ["sender", "receiver"],
      deletedMessageSeq: 3,
      resolveLosers: async () => new Map(),
      deletedMessageId: "msg-old",
      resolveUnreadCounts: async () => ({ sender: 0, receiver: 1 }),
      snapshot: async () => ({
        lastMessageId: "msg-new",
        lastMessageAt: 5_000,
        senderId: "sender",
        content: { text: "latest" },
        messageType: "TEXT",
      }),
    });
    await settle();
    const data = JSON.parse(
      publishCalls.find((c) => c.channel === "user:receiver")!.payload
    ).data;
    expect(data.deleteRecalc).toBe(true);
    expect(data.deleteRecalcId).toBe("msg-old");
    expect(data.unreadCount).toBe(1);
    expect(data.unread).toBe(false);
    expect(data.lastMessageId).toBe("msg-new");
    expect(data.lastMessageAt).toBe(5_000);
  });

  it("publishes nothing extra without counts (legacy callers)", async () => {
    const { redis, publishCalls } = makeFakeRedis();
    await publishConvEffectiveLastLoss({
      redis,
      type: "PRIVATE",
      roomId: "room-1",
      recipientIds: async () => ["sender", "receiver"],
      deletedMessageSeq: 3,
      resolveLosers: async () => new Map(),
    });
    await settle();
    expect(publishCalls).toHaveLength(0);
  });
});
