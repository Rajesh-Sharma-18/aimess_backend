import { GoneError, NotFoundError, ForbiddenError } from "@aimess/errors";

import {
  buildAvailableContext,
  buildUnavailableContext,
  isMessageContentError,
} from "../../src/lib/message-context.js";

describe("buildAvailableContext", () => {
  it("builds a compound cursor anchor from a Date createdAt, with sequenceNumber", () => {
    const result = buildAvailableContext({
      messageId: "m1",
      roomId: "room1",
      conversationType: "PRIVATE",
      sequenceNumber: 5,
      createdAt: new Date(1717000000000),
    });

    expect(result).toEqual({
      messageId: "m1",
      roomId: "room1",
      conversationType: "PRIVATE",
      isAvailable: true,
      anchor: {
        sequenceNumber: 5,
        beforeCursor: "1717000000000_m1",
        afterCursor: "1717000000000_m1",
      },
    });
  });

  it("omits sequenceNumber when not provided (community)", () => {
    const result = buildAvailableContext({
      messageId: "m2",
      roomId: "room2",
      conversationType: "COMMUNITY",
      createdAt: new Date(1000),
    });

    expect(result.anchor).toEqual({
      beforeCursor: "1000_m2",
      afterCursor: "1000_m2",
    });
    expect(result.anchor).not.toHaveProperty("sequenceNumber");
  });

  it("accepts a numeric epoch-ms createdAt (not just a Date)", () => {
    const result = buildAvailableContext({
      messageId: "m3",
      roomId: "room3",
      conversationType: "GROUP",
      createdAt: 2000,
    });

    expect(result.anchor?.beforeCursor).toBe("2000_m3");
  });
});

describe("buildUnavailableContext", () => {
  it("returns isAvailable:false with a MESSAGE_NOT_FOUND error", () => {
    const result = buildUnavailableContext({
      messageId: "m1",
      roomId: "room1",
      conversationType: "GROUP",
    });

    expect(result).toEqual({
      messageId: "m1",
      roomId: "room1",
      conversationType: "GROUP",
      isAvailable: false,
      error: { code: "MESSAGE_NOT_FOUND", message: "Message doesn't exist" },
    });
  });
});

describe("isMessageContentError", () => {
  it("is true for GoneError (deleted)", () => {
    expect(isMessageContentError(new GoneError("CHAT_MESSAGE_DELETED"))).toBe(
      true
    );
  });

  it("is true for NotFoundError with CHAT_MESSAGE_NOT_FOUND", () => {
    expect(
      isMessageContentError(new NotFoundError("CHAT_MESSAGE_NOT_FOUND"))
    ).toBe(true);
  });

  it("is false for NotFoundError with a different key (e.g. room not found)", () => {
    expect(
      isMessageContentError(new NotFoundError("CHAT_ROOM_NOT_FOUND"))
    ).toBe(false);
  });

  it("is false for access errors (ForbiddenError)", () => {
    expect(isMessageContentError(new ForbiddenError("CHAT_NOT_A_MEMBER"))).toBe(
      false
    );
  });

  it("is false for a generic Error", () => {
    expect(isMessageContentError(new Error("boom"))).toBe(false);
  });
});
