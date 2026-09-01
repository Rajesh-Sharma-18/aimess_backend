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

  // Regression: an invitation card is addressed content one person sent to
  // another; it only rides a `systemEvent` because that is how the card's link
  // identity is carried. Excluding it made the delivery path (which $inc'd the
  // recipient's counter) and the mark-read recompute (which filtered it back
  // out) disagree, so the badge could only be cleared by entering the room.
  it("counts invitation cards — they are messages, not audit lines", () => {
    expect(
      shouldCountInUnread({
        messageType: "COMMUNITY_INVITE",
        systemEvent: "COMMUNITY_INVITE",
      })
    ).toBe(true);
    expect(
      shouldCountInUnread({
        messageType: "GROUP_INVITE",
        systemEvent: "GROUP_INVITE",
      })
    ).toBe(true);
    // …but the community LIFECYCLE line about an invite link is still a system
    // message and still must not raise a badge.
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemMessageType: "COMMUNITY_INVITE_CREATED",
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
