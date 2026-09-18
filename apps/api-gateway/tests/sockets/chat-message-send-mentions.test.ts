/**
 * `message:send` group @mention contract at the gateway.
 *
 * The gateway only shape-checks mentions (coarse 200-entry transport cap) and
 * forwards them into `contentJson`; chat-service owns the authoritative 50 limit
 * and per-entry validation. A client that sends no mentions must produce the
 * byte-identical `contentJson` it always did.
 */
import * as grpc from "@grpc/grpc-js";
import {
  MessageSendSchema,
  buildSendMessageContent,
} from "../../src/sockets/namespaces/chat.ns.js";
import { ackError, resolveGrpcAckError } from "../../src/sockets/ack.js";

const base = {
  conversationId: "grp_room1",
  contentType: "text",
  conversationType: "GROUP",
};

const mention = (i: number) => ({
  userId: `user-${i}`,
  username: `user_${i}`,
  offset: i * 10,
  length: 7,
});

function contentJsonOf(payload: unknown): string {
  const r = MessageSendSchema.safeParse(payload);
  if (!r.success) throw new Error(r.error.message);
  return JSON.stringify(buildSendMessageContent(r.data));
}

describe("message:send mentions — gateway schema + contentJson", () => {
  it("forwards flat top-level mentions into content", () => {
    const content = JSON.parse(
      contentJsonOf({
        ...base,
        contentText: "hi @kristi",
        mentions: [{ userId: "u1", username: "kristi", offset: 3, length: 7 }],
      })
    );
    expect(content).toEqual({
      text: "hi @kristi",
      urls: [],
      files: [],
      mentions: [{ userId: "u1", username: "kristi", offset: 3, length: 7 }],
    });
  });

  it("accepts content.mentions as an alias (with content.text)", () => {
    const content = JSON.parse(
      contentJsonOf({
        ...base,
        content: {
          text: "@kristi",
          mentions: [{ userId: "u1", offset: 0, length: 7 }],
        },
      })
    );
    expect(content.text).toBe("@kristi");
    expect(content.mentions).toEqual([{ userId: "u1", offset: 0, length: 7 }]);
  });

  it("flat mentions win over content.mentions when both are sent", () => {
    const content = JSON.parse(
      contentJsonOf({
        ...base,
        contentText: "@a @b",
        mentions: [{ userId: "flat", offset: 0, length: 2 }],
        content: { mentions: [{ userId: "alias", offset: 3, length: 2 }] },
      })
    );
    expect(content.mentions).toEqual([
      { userId: "flat", offset: 0, length: 2 },
    ]);
  });

  it("absent or empty mentions add no key — byte-identical to the legacy body", () => {
    const legacy = JSON.stringify({ text: "hello", urls: [], files: [] });
    expect(contentJsonOf({ ...base, contentText: "hello" })).toBe(legacy);
    expect(contentJsonOf({ ...base, contentText: "hello", mentions: [] })).toBe(
      legacy
    );
  });

  it("strips unknown keys on mention entries but keeps `type`", () => {
    const content = JSON.parse(
      contentJsonOf({
        ...base,
        contentText: "@kristi",
        mentions: [
          { type: "USER", userId: "u1", offset: 0, length: 7, evil: "x" },
        ],
      })
    );
    expect(content.mentions).toEqual([
      { type: "USER", userId: "u1", offset: 0, length: 7 },
    ]);
  });

  it("forwards an ALL entry (no userId) with its type, mixed with USER entries", () => {
    const content = JSON.parse(
      contentJsonOf({
        ...base,
        contentText: "@all @kristi",
        mentions: [
          { type: "ALL", offset: 0, length: 4 },
          { userId: "u1", username: "kristi", offset: 5, length: 7 },
        ],
      })
    );
    expect(content.mentions).toEqual([
      { type: "ALL", offset: 0, length: 4 },
      { userId: "u1", username: "kristi", offset: 5, length: 7 },
    ]);
  });

  it("strips user fields from an ALL entry instead of rejecting it", () => {
    const content = JSON.parse(
      contentJsonOf({
        ...base,
        content: {
          text: "@all",
          mentions: [
            { type: "ALL", userId: "u1", username: "all", offset: 0, length: 4 },
          ],
        },
      })
    );
    expect(content.mentions).toEqual([{ type: "ALL", offset: 0, length: 4 }]);
  });

  it("mixed USER/ALL entries share the 200 transport cap", () => {
    const mixed = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        i % 2 ? mention(i) : { type: "ALL", offset: i * 10, length: 4 }
      );
    const parse = (n: number) =>
      MessageSendSchema.safeParse({
        ...base,
        contentText: "x",
        mentions: mixed(n),
      }).success;
    expect(parse(200)).toBe(true);
    expect(parse(201)).toBe(false);
  });

  it("51..200 entries pass the gateway (chat-service enforces 50)", () => {
    for (const n of [51, 200]) {
      const mentions = Array.from({ length: n }, (_, i) => mention(i));
      expect(
        MessageSendSchema.safeParse({ ...base, contentText: "x", mentions })
          .success
      ).toBe(true);
    }
  });

  it("more than 200 entries is rejected (INVALID_PAYLOAD path)", () => {
    const mentions = Array.from({ length: 201 }, (_, i) => mention(i));
    expect(
      MessageSendSchema.safeParse({ ...base, contentText: "x", mentions })
        .success
    ).toBe(false);
    expect(
      MessageSendSchema.safeParse({
        ...base,
        content: { text: "x", mentions },
      }).success
    ).toBe(false);
  });

  it.each([
    ["negative offset", { userId: "u1", offset: -1, length: 2 }],
    ["missing userId", { offset: 0, length: 2 }],
    ["empty userId", { userId: "", offset: 0, length: 2 }],
    ["userId over 100 chars", { userId: "u".repeat(101), offset: 0, length: 2 }],
    ["non-integer offset", { userId: "u1", offset: 1.5, length: 2 }],
    ["non-integer length", { userId: "u1", offset: 0, length: 2.5 }],
    ["zero length", { userId: "u1", offset: 0, length: 0 }],
    ["length over 64", { userId: "u1", offset: 0, length: 65 }],
    ["username over 64", { userId: "u1", username: "a".repeat(65), offset: 0, length: 2 }],
    ["string offset", { userId: "u1", offset: "0", length: 2 }],
    ["unknown type", { type: "BOGUS", userId: "u1", offset: 0, length: 2 }],
    ["lowercase all type", { type: "all", offset: 0, length: 4 }],
    ["ALL with negative offset", { type: "ALL", offset: -1, length: 4 }],
    ["ALL with zero length", { type: "ALL", offset: 0, length: 0 }],
  ])("rejects a malformed entry: %s", (_label, entry) => {
    expect(
      MessageSendSchema.safeParse({
        ...base,
        contentText: "@a",
        mentions: [entry],
      }).success
    ).toBe(false);
  });

  it("rejects a non-array mentions value", () => {
    expect(
      MessageSendSchema.safeParse({
        ...base,
        contentText: "@a",
        mentions: { userId: "u1", offset: 0, length: 2 },
      }).success
    ).toBe(false);
  });

  it("leaves files/urls/location/contact/sticker/mediaKey handling unchanged", () => {
    const content = JSON.parse(
      contentJsonOf({
        ...base,
        contentText: "see",
        mediaKey: "chat/legacy.jpg",
        urls: ["https://example.com/a"],
        location: { lat: 1, lng: 2, placeName: "P" },
        contact: { name: "N", phone: "123" },
        sticker: { packId: "p", stickerId: "s", objectKey: "stk/1.webp" },
        mentions: [{ userId: "u1", offset: 0, length: 2 }],
      })
    );
    expect(content).toEqual({
      text: "see",
      urls: ["https://example.com/a"],
      files: [{ objectKey: "chat/legacy.jpg", name: "", size: 0, mime: "" }],
      location: { lat: 1, lng: 2, placeName: "P" },
      contact: { name: "N", phone: "123" },
      sticker: { packId: "p", stickerId: "s", objectKey: "stk/1.webp" },
      mentions: [{ userId: "u1", offset: 0, length: 2 }],
    });
  });

  it("CHAT_MENTION_LIMIT_EXCEEDED from chat-service surfaces as a specific INVALID_PAYLOAD ack", () => {
    const calls: unknown[] = [];
    const { code, detailKey } = resolveGrpcAckError({
      code: grpc.status.INVALID_ARGUMENT,
      details: "CHAT_MENTION_LIMIT_EXCEEDED",
      message: "3 INVALID_ARGUMENT: CHAT_MENTION_LIMIT_EXCEEDED",
    });
    ackError((res) => calls.push(res), code, "en", detailKey);
    expect(calls[0]).toEqual({
      success: false,
      error: "INVALID_PAYLOAD",
      retryable: false,
      message: "A message can mention at most 50 people",
      detail: "CHAT_MENTION_LIMIT_EXCEEDED",
    });
  });

  it.each([
    [
      "en",
      "You're using @all too often. Please wait a few minutes and try again.",
    ],
    ["vi", "Bạn dùng @all quá thường xuyên. Vui lòng đợi vài phút rồi thử lại."],
  ] as const)(
    "CHAT_MENTION_ALL_RATE_LIMITED from chat-service surfaces as a RATE_LIMITED ack with detail (%s)",
    (locale, message) => {
      const calls: unknown[] = [];
      const { code, detailKey } = resolveGrpcAckError({
        code: grpc.status.RESOURCE_EXHAUSTED,
        details: "CHAT_MENTION_ALL_RATE_LIMITED",
        message: "8 RESOURCE_EXHAUSTED: CHAT_MENTION_ALL_RATE_LIMITED",
      });
      ackError((res) => calls.push(res), code, locale, detailKey);
      expect(calls[0]).toEqual({
        success: false,
        error: "RATE_LIMITED",
        retryable: true,
        message,
        detail: "CHAT_MENTION_ALL_RATE_LIMITED",
      });
    }
  );

  it("a send throttle carries chat-service's retry-after seconds into the ack", () => {
    const metadata = new grpc.Metadata();
    metadata.set("retry-after", "12");
    const calls: unknown[] = [];
    const { code, detailKey, retryAfter } = resolveGrpcAckError({
      code: grpc.status.RESOURCE_EXHAUSTED,
      details: "RATE_LIMITED",
      metadata,
    });
    ackError((res) => calls.push(res), code, "en", detailKey, retryAfter);
    expect(calls[0]).toMatchObject({
      success: false,
      error: "RATE_LIMITED",
      retryable: true,
      retryAfter: 12,
    });
  });
});
