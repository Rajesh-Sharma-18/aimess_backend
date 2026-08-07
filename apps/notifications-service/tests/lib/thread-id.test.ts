import {
  generateThreadId,
  generateEventThreadId,
} from "../../src/lib/thread-id.js";

describe("generateThreadId — conversation-based notification grouping", () => {
  it("PERSONAL chat → chat_{conversationId}", () => {
    expect(generateThreadId("PERSONAL", "conv_123")).toBe("chat_conv_123");
  });

  it("GROUP chat → group_{conversationId}", () => {
    expect(generateThreadId("GROUP", "group_789")).toBe("group_group_789");
  });

  it("COMMUNITY chat → community_{communityId}, not conversationId", () => {
    expect(generateThreadId("COMMUNITY", "room_id_x", "community_456")).toBe(
      "community_community_456"
    );
  });

  it("COMMUNITY chat falls back to conversationId when communityId is omitted", () => {
    expect(generateThreadId("COMMUNITY", "community_456")).toBe(
      "community_community_456"
    );
  });

  it("is stable across different senders for the same conversation", () => {
    const aliceMsg = generateThreadId("GROUP", "group_789");
    const bobMsg = generateThreadId("GROUP", "group_789");
    expect(aliceMsg).toBe(bobMsg);
  });

  it("differs for different conversations of the same type", () => {
    expect(generateThreadId("PERSONAL", "conv_1")).not.toBe(
      generateThreadId("PERSONAL", "conv_2")
    );
  });
});

describe("generateEventThreadId", () => {
  it("groups by event type", () => {
    expect(generateEventThreadId("CALL_INCOMING")).toBe("event_CALL_INCOMING");
  });
});
