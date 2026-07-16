import { personalizeGroupSocketMessage } from "../../src/sockets/system-message-personalize.js";

describe("personalizeGroupSocketMessage", () => {
  it("leaves a PRIVATE CALL_ENDED system message unchanged", () => {
    const text = "Audio call lasted 1m 33s";
    const message = {
      conversationType: "PRIVATE",
      contentType: "SYSTEM",
      systemEvent: "CALL_ENDED",
      systemData: {
        callId: "call-1",
        callType: "AUDIO",
        durationSec: 93,
      },
      contentText: text,
      content: { text, urls: [], files: [] },
    };

    const result = personalizeGroupSocketMessage(message, "callee-1");

    expect(result).toBe(message);
    expect(result).toEqual(message);
  });

  it("still personalizes a GROUP lifecycle system message", () => {
    const message = {
      conversationType: "GROUP",
      contentType: "SYSTEM",
      systemEvent: "MEMBER_JOINED",
      systemData: {
        actorId: "member-1",
        actorName: "Alice",
      },
      contentText: "Alice joined the group",
      content: { text: "Alice joined the group", urls: [], files: [] },
    };

    expect(personalizeGroupSocketMessage(message, "member-1")).toEqual({
      ...message,
      contentText: "You joined the group",
      content: {
        text: "You joined the group",
        urls: [],
        files: [],
      },
    });
  });
});
