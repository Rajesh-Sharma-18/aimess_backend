import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMessagePreview } from "../events/publish-message-sent.js";

import { buildCanonicalQuote } from "./chat-message.serializer.js";

/**
 * Unit coverage for the two pure helpers behind the community `message:new`
 * broadcast (grpc/server.ts §community): `buildCanonicalQuote` (the reply
 * snapshot) and `buildMessagePreview` (the list/notification placeholder).
 * Deterministic, infra-free — no Mongo/Redis/gateway.
 *
 * Assertions match the ACTUAL implementation, not the prose spec: notably
 * `buildCanonicalQuote({})` is NON-null (the empty object passes the
 * `typeof === "object"` guard and yields a quote with empty-string fields).
 * Only a genuinely missing quote (null/undefined/non-object) collapses to null,
 * which is what a top-level (non-reply) community message persists.
 */
describe("buildCanonicalQuote", () => {
  it("returns null for a missing quote (top-level message)", () => {
    assert.equal(buildCanonicalQuote(null), null);
    assert.equal(buildCanonicalQuote(undefined), null);
  });

  it("returns null for non-object scalars", () => {
    assert.equal(buildCanonicalQuote(""), null);
    assert.equal(buildCanonicalQuote("hi"), null);
    assert.equal(buildCanonicalQuote(0), null);
    assert.equal(buildCanonicalQuote(false), null);
  });

  it("returns a non-null EMPTY-field quote for `{}` (object passes the guard)", () => {
    // Documents real behavior: an empty object is a present-but-blank quote,
    // NOT collapsed to null. A top-level message must therefore persist
    // null/undefined quoteData (which it does) to get a null quote on the wire.
    const q = buildCanonicalQuote({});
    assert.notEqual(q, null);
    assert.deepEqual(q, {
      messageId: "",
      senderId: "",
      senderName: "",
      messageType: "",
      preview: "",
      isDeleted: false,
    });
  });

  it("normalizes a community-shaped reply quote (reads message + messageType)", () => {
    // Matches the REAL fields buildCanonicalQuote reads: messageId, senderId,
    // senderName, messageType, and preview←message. This is the shape the
    // community persisted `quoteData` carries for a reply.
    const q = buildCanonicalQuote({
      messageId: "m1",
      senderId: "u1",
      senderName: "Alice",
      message: "hi",
      messageType: "TEXT",
    });
    assert.notEqual(q, null);
    assert.equal(q!.messageId, "m1");
    assert.equal(q!.senderId, "u1");
    assert.equal(q!.senderName, "Alice");
    assert.equal(q!.preview, "hi");
    assert.equal(q!.messageType, "TEXT");
    assert.equal(q!.isDeleted, false);
  });

  it("upper-cases the quoted messageType and prefers `preview` over message/text", () => {
    const q = buildCanonicalQuote({
      messageId: "m2",
      senderName: "Bob",
      messageType: "image",
      preview: "📷 Photo",
      message: "ignored when preview present",
    });
    assert.equal(q!.messageType, "IMAGE");
    assert.equal(q!.preview, "📷 Photo");
  });

  it("tolerates the group legacy shape (text + parentMessageId + deletedForAll)", () => {
    const q = buildCanonicalQuote({
      parentMessageId: "pm9",
      senderId: "u9",
      senderName: "Carol",
      text: "older reply",
      messageType: "TEXT",
      deletedForAll: true,
    });
    assert.equal(q!.messageId, "pm9"); // falls back to parentMessageId
    assert.equal(q!.preview, "older reply"); // falls back to text
    assert.equal(q!.isDeleted, true); // mapped from deletedForAll
  });
});

describe("buildMessagePreview", () => {
  it("TEXT → body slice (first 200 chars), empty body → 'Sent a message'", () => {
    assert.equal(
      buildMessagePreview("TEXT", { text: "hello world" }),
      "hello world"
    );
    const long = "x".repeat(250);
    assert.equal(buildMessagePreview("TEXT", { text: long }), "x".repeat(200));
    assert.equal(buildMessagePreview("TEXT", { text: "" }), "Sent a message");
    // content may be a bare string (community stores the body as a string)
    assert.equal(buildMessagePreview("TEXT", "from string"), "from string");
  });

  it("media types → labelled placeholders", () => {
    assert.equal(buildMessagePreview("IMAGE", {}), "📷 Photo");
    assert.equal(buildMessagePreview("VIDEO", {}), "🎥 Video");
    assert.equal(buildMessagePreview("GIF", {}), "🎞 GIF");
    assert.equal(buildMessagePreview("AUDIO", {}), "🎵 Audio");
    assert.equal(buildMessagePreview("VOICE", {}), "🎤 Voice Message");
    assert.equal(buildMessagePreview("STICKER", {}), "😊 Sticker");
  });

  it("DOCUMENT → '📄 <name>' when a filename is present, else '📄 Document'", () => {
    assert.equal(
      buildMessagePreview("DOCUMENT", { files: [{ name: "report.pdf" }] }),
      "📄 report.pdf"
    );
    assert.equal(buildMessagePreview("DOCUMENT", { files: [] }), "📄 Document");
    assert.equal(buildMessagePreview("DOCUMENT", {}), "📄 Document");
  });

  it("LOCATION → '📍 <place>' when placeName is present, else '📍 Location'", () => {
    assert.equal(
      buildMessagePreview("LOCATION", {
        location: { placeName: "Eiffel Tower" },
      }),
      "📍 Eiffel Tower"
    );
    assert.equal(
      buildMessagePreview("LOCATION", { location: {} }),
      "📍 Location"
    );
    assert.equal(buildMessagePreview("LOCATION", {}), "📍 Location");
  });

  it("CONTACT → '👤 <name>' when a name is present, else '👤 Contact'", () => {
    assert.equal(
      buildMessagePreview("CONTACT", { contact: { name: "Dave" } }),
      "👤 Dave"
    );
    assert.equal(buildMessagePreview("CONTACT", { contact: {} }), "👤 Contact");
    assert.equal(buildMessagePreview("CONTACT", {}), "👤 Contact");
  });

  it("SYSTEM → body text verbatim (empty string when no text)", () => {
    assert.equal(
      buildMessagePreview("SYSTEM", { text: "Alice joined" }),
      "Alice joined"
    );
    assert.equal(buildMessagePreview("SYSTEM", {}), "");
  });

  it("is case-insensitive on the content type and falls back for unknown types", () => {
    assert.equal(buildMessagePreview("image", {}), "📷 Photo");
    assert.equal(buildMessagePreview("MYSTERY", { text: "body" }), "body");
    assert.equal(buildMessagePreview("MYSTERY", {}), "New message");
  });
});
