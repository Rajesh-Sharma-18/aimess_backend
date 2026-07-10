import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMessagePreview } from "../events/publish-message-sent.js";

import {
  buildCanonicalQuote,
  buildReplyQuoteSnapshot,
  buildReplyPreviewText,
} from "./chat-message.serializer.js";

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
      thumbnail: null,
      mimeType: null,
      mediaId: null,
      durationMs: 0,
      attachmentCount: 0,
    });
  });

  it("passes through thumbnail/mimeType/durationMs/attachmentCount when stored", () => {
    const q = buildCanonicalQuote({
      messageId: "m5",
      senderId: "u5",
      senderName: "Eve",
      messageType: "VOICE",
      preview: "🎤 Voice message",
      thumbnail: "avatars/u5/note.png",
      mimeType: "audio/m4a",
      durationMs: 3100,
      attachmentCount: 1,
      isDeleted: false,
    });
    assert.equal(q!.thumbnail, "avatars/u5/note.png");
    assert.equal(q!.mimeType, "audio/m4a");
    assert.equal(q!.durationMs, 3100);
    assert.equal(q!.attachmentCount, 1);
  });

  it("overrides preview to 'Message deleted' whenever isDeleted is true, regardless of stored text", () => {
    const q = buildCanonicalQuote({
      messageId: "m6",
      senderName: "Frank",
      messageType: "TEXT",
      preview: "stale pre-delete text",
      isDeleted: true,
    });
    assert.equal(q!.preview, "Message deleted");
    // senderName is NEVER replaced with "You", even for the viewer's own reply.
    assert.equal(q!.senderName, "Frank");
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
    // isDeleted always wins over the stored text — "Message deleted" everywhere.
    assert.equal(q!.preview, "Message deleted");
    assert.equal(q!.isDeleted, true); // mapped from deletedForAll
  });
});

describe("buildReplyPreviewText — WhatsApp-style reply preview rules", () => {
  it("TEXT → actual text", () => {
    assert.equal(buildReplyPreviewText("TEXT", { text: "hello" }, 0), "hello");
  });
  it("IMAGE (single) → '📷 Photo'", () => {
    assert.equal(buildReplyPreviewText("IMAGE", {}, 1), "📷 Photo");
  });
  it("ALBUM (IMAGE, count > 1) → '📷 N Photos'", () => {
    assert.equal(buildReplyPreviewText("IMAGE", {}, 3), "📷 3 Photos");
  });
  it("VIDEO → '🎥 Video'", () => {
    assert.equal(buildReplyPreviewText("VIDEO", {}, 1), "🎥 Video");
  });
  it("VOICE → '🎤 Voice message'", () => {
    assert.equal(buildReplyPreviewText("VOICE", {}, 1), "🎤 Voice message");
  });
  it("AUDIO → '🎵 Audio'", () => {
    assert.equal(buildReplyPreviewText("AUDIO", {}, 1), "🎵 Audio");
  });
  it("DOCUMENT → '📄 filename.pdf' (or '📄 Document' with no filename)", () => {
    assert.equal(
      buildReplyPreviewText(
        "DOCUMENT",
        { files: [{ name: "filename.pdf" }] },
        1
      ),
      "📄 filename.pdf"
    );
    assert.equal(buildReplyPreviewText("DOCUMENT", {}, 1), "📄 Document");
  });
  it("GIF → 'GIF'", () => {
    assert.equal(buildReplyPreviewText("GIF", {}, 1), "GIF");
  });
  it("STICKER → 'Sticker'", () => {
    assert.equal(buildReplyPreviewText("STICKER", {}, 1), "Sticker");
  });
  it("CONTACT → 'Contact' (never the contact's name)", () => {
    assert.equal(
      buildReplyPreviewText("CONTACT", { contact: { name: "Dave" } }, 0),
      "Contact"
    );
  });
  it("LOCATION → 'Location' (never the place name)", () => {
    assert.equal(
      buildReplyPreviewText(
        "LOCATION",
        { location: { placeName: "Paris" } },
        0
      ),
      "Location"
    );
  });
});

describe("buildReplyQuoteSnapshot", () => {
  it("TEXT: no media fields (null/0 defaults)", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m1",
      senderId: "u1",
      senderName: "Alice",
      messageType: "text",
      content: { text: "hello there" },
      isDeleted: false,
    });
    assert.equal(q.messageId, "m1");
    assert.equal(q.messageType, "TEXT");
    assert.equal(q.preview, "hello there");
    assert.equal(q.isDeleted, false);
    assert.equal(q.thumbnail, null);
    assert.equal(q.mimeType, null);
    assert.equal(q.durationMs, 0);
    assert.equal(q.attachmentCount, 0);
  });

  it("IMAGE: extracts raw thumbnail key + mimeType, single file → '📷 Photo'", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m2",
      senderId: "u2",
      senderName: "Bob",
      messageType: "IMAGE",
      content: {
        files: [{ objectKey: "chat-uploads/c1/img1.png", mime: "image/png" }],
      },
      isDeleted: false,
    });
    assert.equal(q.preview, "📷 Photo");
    // Raw objectKey — NEVER a resolved URL — is what gets persisted; resolution
    // to a full CDN URL happens on read via resolveQuoteThumbnail.
    assert.equal(q.thumbnail, "chat-uploads/c1/img1.png");
    assert.equal(q.mimeType, "image/png");
    assert.equal(q.attachmentCount, 1);
  });

  it("IMAGE: passes through mediaId from the first file, null when absent", () => {
    const withId = buildReplyQuoteSnapshot({
      messageId: "m2c",
      senderId: "u2",
      senderName: "Bob",
      messageType: "IMAGE",
      content: {
        files: [
          {
            objectKey: "chat-uploads/c1/img1.png",
            mime: "image/png",
            mediaId: "media-abc123",
          },
        ],
      },
      isDeleted: false,
    });
    assert.equal(withId.mediaId, "media-abc123");

    const legacy = buildReplyQuoteSnapshot({
      messageId: "m2d",
      senderId: "u2",
      senderName: "Bob",
      messageType: "IMAGE",
      content: {
        files: [{ objectKey: "chat-uploads/c1/img1.png", mime: "image/png" }],
      },
      isDeleted: false,
    });
    assert.equal(legacy.mediaId, null);
  });

  it("ALBUM: attachmentCountOverride (true sibling-row count) drives '📷 N Photos'", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m2b",
      senderId: "u2",
      senderName: "Bob",
      messageType: "IMAGE",
      content: { files: [{ objectKey: "chat-uploads/c1/img1.png" }] },
      isDeleted: false,
      attachmentCountOverride: 3,
    });
    assert.equal(q.preview, "📷 3 Photos");
    assert.equal(q.attachmentCount, 3);
  });

  it("VIDEO: mimeType + no durationMs when absent", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m3",
      senderId: "u3",
      senderName: "Carol",
      messageType: "VIDEO",
      content: {
        files: [{ objectKey: "chat-uploads/c1/clip.mp4", mime: "video/mp4" }],
      },
      isDeleted: false,
    });
    assert.equal(q.preview, "🎥 Video");
    assert.equal(q.mimeType, "video/mp4");
    assert.equal(q.durationMs, 0);
  });

  it("VOICE: extracts durationMs", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m4",
      senderId: "u4",
      senderName: "Dave",
      messageType: "VOICE",
      content: {
        files: [
          {
            objectKey: "chat-uploads/c1/note.m4a",
            mime: "audio/m4a",
            durationMs: 4200,
          },
        ],
      },
      isDeleted: false,
    });
    assert.equal(q.preview, "🎤 Voice message");
    assert.equal(q.durationMs, 4200);
    assert.equal(q.attachmentCount, 1);
  });

  it("AUDIO: extracts durationMs", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m5",
      senderId: "u5",
      senderName: "Eve",
      messageType: "AUDIO",
      content: {
        files: [{ objectKey: "chat-uploads/c1/song.mp3", durationMs: 9000 }],
      },
      isDeleted: false,
    });
    assert.equal(q.preview, "🎵 Audio");
    assert.equal(q.durationMs, 9000);
  });

  it("DOCUMENT: filename in preview", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m6",
      senderId: "u6",
      senderName: "Frank",
      messageType: "DOCUMENT",
      content: {
        files: [
          { objectKey: "chat-uploads/c1/report.pdf", name: "report.pdf" },
        ],
      },
      isDeleted: false,
    });
    assert.equal(q.preview, "📄 report.pdf");
  });

  it("GIF: preview 'GIF'", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m7",
      senderId: "u7",
      senderName: "Grace",
      messageType: "GIF",
      content: { files: [{ objectKey: "chat-uploads/c1/fun.gif" }] },
      isDeleted: false,
    });
    assert.equal(q.preview, "GIF");
  });

  it("STICKER: preview 'Sticker', no attachmentCount (no files[])", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m8",
      senderId: "u8",
      senderName: "Heidi",
      messageType: "STICKER",
      content: { sticker: { id: "s1" } },
      isDeleted: false,
    });
    assert.equal(q.preview, "Sticker");
    assert.equal(q.attachmentCount, 0);
  });

  it("CONTACT: preview 'Contact' (name never leaked into preview)", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m9",
      senderId: "u9",
      senderName: "Ivan",
      messageType: "CONTACT",
      content: { contact: { name: "Judy" } },
      isDeleted: false,
    });
    assert.equal(q.preview, "Contact");
  });

  it("LOCATION: preview 'Location' (place name never leaked into preview)", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m10",
      senderId: "u10",
      senderName: "Kevin",
      messageType: "LOCATION",
      content: { location: { placeName: "Eiffel Tower" } },
      isDeleted: false,
    });
    assert.equal(q.preview, "Location");
  });

  it("sender name is the ORIGINAL sender, never 'You'", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m11",
      senderId: "viewer-1",
      senderName: "Laura",
      messageType: "TEXT",
      content: { text: "hi" },
      isDeleted: false,
    });
    assert.equal(q.senderName, "Laura");
    assert.notEqual(q.senderName, "You");
  });

  it("marks isDeleted true when the parent is already deleted", () => {
    const q = buildReplyQuoteSnapshot({
      messageId: "m12",
      senderId: "u12",
      senderName: "Mallory",
      messageType: "TEXT",
      content: { text: "gone" },
      isDeleted: true,
    });
    assert.equal(q.isDeleted, true);
    // buildCanonicalQuote (the read-time normalizer) is what renders "Message
    // deleted" — round-trip through it here to prove edited-then-deleted and
    // deleted-only snapshots both resolve to the same on-read text.
    assert.equal(buildCanonicalQuote(q)!.preview, "Message deleted");
  });

  it("EDITED parent: refreshReplyQuotes' preview patch (buildReplyPreviewText on the new text) updates the reply everywhere", () => {
    // Simulates the send-time snapshot, then the `refreshReplyQuotes` patch a
    // TEXT edit applies (see private/group/community `editMessage`) — the
    // patched preview must be exactly what a fresh reply-to-this-message would
    // compute, so every read (not just new replies) shows the edited text.
    const original = buildReplyQuoteSnapshot({
      messageId: "m13",
      senderId: "u13",
      senderName: "Niaj",
      messageType: "TEXT",
      content: { text: "original text" },
      isDeleted: false,
    });
    assert.equal(original.preview, "original text");

    const editedPreview = buildReplyPreviewText(
      "TEXT",
      { text: "edited text" },
      0
    );
    const refreshed = { ...original, preview: editedPreview };
    assert.equal(buildCanonicalQuote(refreshed)!.preview, "edited text");
    // senderName/messageId/messageType are untouched by an edit refresh.
    assert.equal(buildCanonicalQuote(refreshed)!.senderName, "Niaj");
    assert.equal(buildCanonicalQuote(refreshed)!.messageId, "m13");
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
    assert.equal(buildMessagePreview("STICKER", {}), "Sticker");
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
