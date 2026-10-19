import {
  personalizeCommunityUpdatedPreview,
  personalizeConvUpdatedPreview,
  personalizeGroupSocketMessage,
} from "../../src/sockets/system-message-personalize.js";

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

  it("personalizes a PRIVATE lifecycle system message", () => {
    const message = {
      conversationType: "PRIVATE",
      contentType: "SYSTEM",
      systemEvent: "MESSAGE_PINNED",
      systemData: {
        actorId: "member-1",
        actorName: "Alice",
      },
      contentText: "Alice pinned a message",
      content: { text: "Alice pinned a message", urls: [], files: [] },
    };

    expect(personalizeGroupSocketMessage(message, "member-1")).toEqual({
      ...message,
      contentText: "You pinned a message",
      content: {
        text: "You pinned a message",
        urls: [],
        files: [],
      },
    });
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

describe("personalizeConvUpdatedPreview — call rows (contract §9)", () => {
  const bump = {
    type: "PRIVATE",
    lastMessage: {
      contentType: "VOICE_CALL",
      text: "Voice call was not answered",
      systemEvent: "CALL_ENDED",
      systemData: { callType: "AUDIO", status: "CANCELLED", callerId: "a", endReason: "declined" },
    },
  };
  const text = (viewer: string, locale: "en" | "vi" | "th") =>
    (personalizeConvUpdatedPreview(bump, viewer, locale) as typeof bump).lastMessage.text;

  it("is per viewer in English too", () => {
    expect(text("a", "en")).toBe("Call declined");
    expect(text("b", "en")).toBe("You declined a voice call");
    expect(text("b", "th")).toBe("คุณปฏิเสธสายสนทนา");
  });
});

describe("reaction overlay bump (AIMESS-369)", () => {
  const reaction = { emoji: "👍", actorId: "actor-1", targetMessageId: "m3" };

  it("re-renders the conv:updated reaction line in the socket's language", () => {
    const bump = {
      type: "PRIVATE",
      lastMessage: { contentType: "SYSTEM", text: 'You reacted 👍 to "Hi"', reaction },
    };
    const out = personalizeConvUpdatedPreview(bump, "actor-1", "vi") as typeof bump;
    expect(out.lastMessage.text).toBe('Bạn đã thả 👍 cho "Hi"');
    expect(out.lastMessage.reaction).toEqual(reaction);
  });

  it("re-renders the community:updated reaction line in the socket's language", () => {
    const bump = {
      lastMessage: { contentType: "SYSTEM", text: 'Alex reacted 👍 to "Hi"', reaction },
    };
    const out = personalizeCommunityUpdatedPreview(bump, "target-1", "vi") as typeof bump;
    expect(out.lastMessage.text).toBe('Alex đã thả 👍 cho "Hi"');
  });
});
