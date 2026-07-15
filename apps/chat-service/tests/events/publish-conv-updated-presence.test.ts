/**
 * conv:updated `isOffline` — real-time peer presence appended to the PRIVATE
 * list-bump payload. Reuses PresenceService via a caller-supplied
 * `getIsOnline` callback; GROUP payloads and callers that don't supply
 * `getIsOnline` are untouched (existing payload shape unchanged).
 */
import { publishConvUpdated } from "../../src/events/publish-conv-updated.js";

interface PublishCall {
  channel: string;
  payload: string;
}

function makeFakeRedis() {
  const publishCalls: PublishCall[] = [];
  const pipeline = {
    publish(channel: string, payload: string) {
      publishCalls.push({ channel, payload });
      return pipeline;
    },
    async exec() {
      return [];
    },
  };
  return {
    redis: { pipeline: () => pipeline } as any,
    publishCalls,
  };
}

const basePreview = { contentType: "text", text: "hi" };

describe("publishConvUpdated — isOffline", () => {
  it("appends isOffline per recipient for PRIVATE, negating the OTHER participant's presence", async () => {
    const { redis, publishCalls } = makeFakeRedis();
    const online = new Set(["sender"]); // sender online, other offline

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: "room-presence",
      recipientIds: ["sender", "other"],
      senderId: "sender",
      lastMessageId: "msg-1",
      lastMessageAt: 1,
      preview: basePreview,
      getIsOnline: async (id: string) => online.has(id),
    });

    const senderMsg = JSON.parse(
      publishCalls.find((c) => c.channel === "user:sender")!.payload
    );
    const otherMsg = JSON.parse(
      publishCalls.find((c) => c.channel === "user:other")!.payload
    );

    // "sender" recipient's peer is "other" (offline) -> isOffline true.
    expect(senderMsg.data.isOffline).toBe(true);
    // "other" recipient's peer is "sender" (online) -> isOffline false.
    expect(otherMsg.data.isOffline).toBe(false);
    // Existing fields untouched.
    expect(senderMsg.data.lastMessageId).toBe("msg-1");
    expect(senderMsg.data.lastMessage).toEqual(basePreview);
  });

  it("omits isOffline for GROUP even when getIsOnline is supplied", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      redis,
      type: "GROUP",
      roomId: "room-group-presence",
      recipientIds: ["u1", "u2"],
      senderId: "u1",
      lastMessageId: "m",
      lastMessageAt: 1,
      preview: basePreview,
      getIsOnline: async () => true,
    });

    for (const call of publishCalls) {
      expect("isOffline" in JSON.parse(call.payload).data).toBe(false);
    }
  });

  it("omits isOffline when getIsOnline is not supplied (existing payload shape unchanged)", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: "room-no-presence",
      recipientIds: ["sender", "other"],
      senderId: "sender",
      lastMessageId: "msg-1",
      lastMessageAt: 1,
      preview: basePreview,
    });

    for (const call of publishCalls) {
      expect("isOffline" in JSON.parse(call.payload).data).toBe(false);
    }
  });

  it("keeps a private SYSTEM audit bump sender-less and unread for nobody", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: "room-call",
      recipientIds: ["caller", "callee"],
      senderId: "",
      senderName: "",
      lastMessageId: "call-message",
      lastMessageAt: 1,
      preview: { contentType: "SYSTEM", text: "Voice call lasted 02:05" },
      countInUnread: false,
    });

    for (const call of publishCalls) {
      expect(JSON.parse(call.payload).data).toMatchObject({
        senderId: "",
        senderName: "",
        unread: false,
      });
    }
  });
});
