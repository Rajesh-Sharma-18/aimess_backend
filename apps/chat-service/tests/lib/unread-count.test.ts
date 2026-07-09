import { shouldCountInUnread } from "../../src/lib/unread-count.js";

describe("shouldCountInUnread", () => {
  it("counts normal text and media messages", () => {
    expect(shouldCountInUnread({ messageType: "TEXT" })).toBe(true);
    expect(shouldCountInUnread({ messageType: "IMAGE" })).toBe(true);
    expect(shouldCountInUnread({ messageType: "VIDEO" })).toBe(true);
  });

  it("counts important group/private system messages", () => {
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemEvent: "MEMBER_ADDED",
      })
    ).toBe(true);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemEvent: "MESSAGE_PINNED",
      })
    ).toBe(true);
  });

  it("counts important community system messages", () => {
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "COMMUNITY_CREATED",
      })
    ).toBe(true);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "ROLE_CHANGED",
      })
    ).toBe(true);
  });

  it("does not count background/internal system messages", () => {
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemEvent: "TYPING",
      })
    ).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "COMMUNITY_INVITE_CREATED",
      })
    ).toBe(false);
  });

  it("preserves legacy behavior when no explicit background mapping exists", () => {
    expect(shouldCountInUnread({ messageType: "SYSTEM" })).toBe(true);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemEvent: "FUTURE_IMPORTANT_EVENT",
      })
    ).toBe(true);
  });

  it("honors explicit persisted flags", () => {
    expect(shouldCountInUnread({ messageType: "TEXT", explicit: false })).toBe(
      false
    );
    expect(shouldCountInUnread({ messageType: "SYSTEM", explicit: true })).toBe(
      true
    );
  });
});
