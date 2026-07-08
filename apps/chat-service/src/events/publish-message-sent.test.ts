import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMessagePreview,
  buildPushPreview,
} from "./publish-message-sent.js";

/**
 * Locks the `ListBumpLastMessage.text` contract (asyncapi `ListBumpLastMessage`
 * + SOCKET_EVENTS §4.2): every non-text kind must yield a rendered placeholder,
 * never an empty string or the raw body. Regression guard for the list-bump
 * `lastMessage.text` (conv:updated / community:updated).
 */
describe("buildMessagePreview", () => {
  it("returns the body for TEXT (truncated), placeholder when empty", () => {
    assert.equal(
      buildMessagePreview("TEXT", { text: "hello there" }),
      "hello there"
    );
    assert.equal(buildMessagePreview("TEXT", { text: "" }), "Sent a message");
    assert.equal(
      buildMessagePreview("TEXT", { text: "x".repeat(500) }).length,
      200
    );
  });

  it("maps media kinds to labelled placeholders (never empty)", () => {
    assert.equal(buildMessagePreview("IMAGE", { text: "" }), "📷 Photo");
    assert.equal(buildMessagePreview("VIDEO", {}), "🎥 Video");
    assert.equal(buildMessagePreview("GIF", {}), "🎞 GIF");
    assert.equal(buildMessagePreview("VOICE", {}), "🎤 Voice Message");
    assert.equal(buildMessagePreview("AUDIO", {}), "🎵 Audio");
    assert.equal(buildMessagePreview("STICKER", {}), "😊 Sticker");
  });

  it("interpolates filename / placeName / contactName when present", () => {
    assert.equal(
      buildMessagePreview("DOCUMENT", { files: [{ name: "report.pdf" }] }),
      "📄 report.pdf"
    );
    assert.equal(buildMessagePreview("DOCUMENT", { files: [] }), "📄 Document");
    assert.equal(
      buildMessagePreview("LOCATION", {
        location: { placeName: "Central Park" },
      }),
      "📍 Central Park"
    );
    assert.equal(buildMessagePreview("LOCATION", {}), "📍 Location");
    assert.equal(
      buildMessagePreview("CONTACT", { contact: { name: "Alice" } }),
      "👤 Alice"
    );
    assert.equal(buildMessagePreview("CONTACT", {}), "👤 Contact");
  });

  it("normalizes lower-case contentType and accepts a plain string body", () => {
    // community stores the kind lower-case and the body as a plain string
    assert.equal(buildMessagePreview("image", "ignored caption"), "📷 Photo");
    assert.equal(
      buildMessagePreview("text", "community body"),
      "community body"
    );
  });

  it("SYSTEM returns the rendered sentence; unknown kinds fall back to body", () => {
    assert.equal(
      buildMessagePreview("SYSTEM", { text: "Alice joined" }),
      "Alice joined"
    );
    assert.equal(buildMessagePreview("WEIRD", { text: "raw" }), "raw");
    assert.equal(buildMessagePreview("WEIRD", {}), "New message");
  });

  it("buildPushPreview delegates to the same vocabulary", () => {
    assert.equal(buildPushPreview("IMAGE", ""), "📷 Photo");
    assert.equal(buildPushPreview("TEXT", "hi"), "hi");
  });
});
