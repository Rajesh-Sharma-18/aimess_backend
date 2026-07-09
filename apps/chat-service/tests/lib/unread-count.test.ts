import { shouldCountInUnread } from "../../src/lib/unread-count.js";

describe("shouldCountInUnread", () => {
  it("counts normal text and media messages", () => {
    expect(shouldCountInUnread({ messageType: "TEXT" })).toBe(true);
    expect(shouldCountInUnread({ messageType: "IMAGE" })).toBe(true);
    expect(shouldCountInUnread({ messageType: "VIDEO" })).toBe(true);
  });

  it("never counts group/private system messages, regardless of subtype", () => {
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemEvent: "MEMBER_ADDED",
      })
    ).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemEvent: "MESSAGE_PINNED",
      })
    ).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemEvent: "TYPING",
      })
    ).toBe(false);
  });

  it("never counts community system messages, regardless of subtype", () => {
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "COMMUNITY_CREATED",
      })
    ).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "ROLE_CHANGED",
      })
    ).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "COMMUNITY_INVITE_CREATED",
      })
    ).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "LIVE_STREAM_STARTED",
      })
    ).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "LIVE_STREAM_ENDED",
      })
    ).toBe(false);
  });

  it("never counts a bare SYSTEM message, even with an unrecognized/future subtype", () => {
    expect(shouldCountInUnread({ messageType: "SYSTEM" })).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemEvent: "FUTURE_IMPORTANT_EVENT",
      })
    ).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "SOME_FUTURE_TYPE",
      })
    ).toBe(false);
  });

  it("honors explicit persisted flags as an override", () => {
    expect(shouldCountInUnread({ messageType: "TEXT", explicit: false })).toBe(
      false
    );
    expect(shouldCountInUnread({ messageType: "SYSTEM", explicit: true })).toBe(
      true
    );
  });
});
