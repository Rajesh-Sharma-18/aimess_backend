import { normalizeCatchupEvent } from "../../src/sockets/namespaces/chat.ns.js";

const base = {
  messageId: "message-1",
  conversationId: "room-1",
  senderId: "",
  contentType: "SYSTEM",
  contentText: "Voice call lasted 02:05",
  contentJson: JSON.stringify({
    text: "Voice call lasted 02:05",
    files: [],
    urls: [],
  }),
  sentAt: 1_700_000_000_000,
  sequenceNumber: 7,
  isDeleted: false,
  deletedType: "",
  editedAt: 0,
  systemEvent: "CALL_ENDED",
  systemData: JSON.stringify({ callId: "call-1", durationSec: 125 }),
};

describe("normalizeCatchupEvent", () => {
  it("restores a private call SYSTEM row to the live message:new shape", () => {
    expect(normalizeCatchupEvent(base, "private")).toMatchObject({
      id: "message-1",
      roomId: "room-1",
      conversationType: "PRIVATE",
      contentType: "SYSTEM",
      content: { text: "Voice call lasted 02:05" },
      systemEvent: "CALL_ENDED",
      systemData: { callId: "call-1", durationSec: 125 },
      serverTs: 1_700_000_000_000,
      sequenceNumber: 7,
    });
  });

  it("falls back to contentText when optional JSON is malformed", () => {
    const normalized = normalizeCatchupEvent(
      { ...base, contentJson: "{", systemData: "{" },
      "private"
    );

    expect(normalized.content).toEqual({
      text: "Voice call lasted 02:05",
      urls: [],
      files: [],
    });
    expect(normalized).not.toHaveProperty("systemData");
  });
});
