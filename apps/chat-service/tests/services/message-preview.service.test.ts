/**
 * Unit coverage for the centralized MessagePreviewService
 * (src/services/message-preview.service.ts), the single source of truth for
 * every conversation / community-list bump preview and every push preview.
 *
 * Regression context: community-list previews for non-text messages
 * (image/video/gif/sticker/voice/audio/document/location/contact) were rendering
 * BLANK because the publish sites used `messageText.slice(0,80)` on a body that
 * is empty for media. Both `community.activity` publish sites now persist
 * `convertMessageToPreview(messageType, {text, files, location, contact})` — the
 * exact expression these tests pin. Every test below maps to a spec scenario:
 * "<Kind> preview in the community list".
 *
 * Infra-free pure-function tests — no mocks needed. CONTENT_TYPES is imported
 * from @aimess/constants so the "every member is non-blank" guard tracks the
 * canonical list automatically if a new kind is added.
 */

import { CONTENT_TYPES } from "@aimess/constants";

import {
  convertMessageToPreview,
  buildMessagePreview,
  buildPushPreview,
} from "../../src/services/message-preview.service.js";

describe("convertMessageToPreview — TEXT/SYSTEM body handling", () => {
  it("[Text preview] returns the body text for a TEXT message", () => {
    expect(convertMessageToPreview("TEXT", { text: "hello world" })).toBe(
      "hello world"
    );
  });

  it("[Text preview] accepts a plain string content (community stores body as string)", () => {
    expect(convertMessageToPreview("TEXT", "plain body")).toBe("plain body");
  });

  it("[Text preview] truncates a long TEXT body to 200 chars", () => {
    const long = "a".repeat(500);
    const out = convertMessageToPreview("TEXT", { text: long });
    expect(out).toHaveLength(200);
    expect(out).toBe("a".repeat(200));
  });

  it("[Text preview] empty TEXT body falls back to 'Sent a message' (NON-BLANK)", () => {
    expect(convertMessageToPreview("TEXT", { text: "" })).toBe(
      "Sent a message"
    );
    expect(convertMessageToPreview("TEXT", "")).toBe("Sent a message");
    expect(convertMessageToPreview("TEXT", {})).toBe("Sent a message");
  });

  it("[System preview] SYSTEM returns its body text", () => {
    expect(convertMessageToPreview("SYSTEM", { text: "User joined" })).toBe(
      "User joined"
    );
  });
});

describe("convertMessageToPreview — media placeholders (the bug-fix scenarios)", () => {
  it("[Image preview] IMAGE → '📷 Photo' even with empty body", () => {
    expect(convertMessageToPreview("IMAGE", { text: "" })).toBe("📷 Photo");
  });

  it("[Video preview] VIDEO → '🎥 Video'", () => {
    expect(convertMessageToPreview("VIDEO", { text: "" })).toBe("🎥 Video");
  });

  it("[GIF preview] GIF → '🎞 GIF'", () => {
    expect(convertMessageToPreview("GIF", { text: "" })).toBe("🎞 GIF");
  });

  it("[Voice preview] VOICE → '🎤 Voice Message'", () => {
    expect(convertMessageToPreview("VOICE", { text: "" })).toBe(
      "🎤 Voice Message"
    );
  });

  it("[Audio preview] AUDIO → '🎵 Audio'", () => {
    expect(convertMessageToPreview("AUDIO", { text: "" })).toBe("🎵 Audio");
  });

  it("[Sticker preview] STICKER → 'Sticker'", () => {
    expect(convertMessageToPreview("STICKER", { text: "" })).toBe("Sticker");
  });
});

describe("convertMessageToPreview — DOCUMENT (filename interpolation)", () => {
  it("[Document/File preview] DOCUMENT with files[0].name → '📄 <name>'", () => {
    expect(
      convertMessageToPreview("DOCUMENT", { files: [{ name: "report.pdf" }] })
    ).toBe("📄 report.pdf");
  });

  it("[Document preview] DOCUMENT with no files → '📄 Document'", () => {
    expect(convertMessageToPreview("DOCUMENT", { text: "" })).toBe(
      "📄 Document"
    );
    expect(convertMessageToPreview("DOCUMENT", { files: [] })).toBe(
      "📄 Document"
    );
  });

  it("[Document preview] file entry without a name → '📄 Document' (NON-BLANK)", () => {
    expect(convertMessageToPreview("DOCUMENT", { files: [{ size: 10 }] })).toBe(
      "📄 Document"
    );
  });
});

describe("convertMessageToPreview — LOCATION (placeName interpolation)", () => {
  it("[Location preview] LOCATION with placeName → '📍 <place>'", () => {
    expect(
      convertMessageToPreview("LOCATION", { location: { placeName: "Cafe" } })
    ).toBe("📍 Cafe");
  });

  it("[Location preview] LOCATION with no placeName → '📍 Location'", () => {
    expect(convertMessageToPreview("LOCATION", { text: "" })).toBe(
      "📍 Location"
    );
    expect(
      convertMessageToPreview("LOCATION", { location: { lat: 1, lng: 2 } })
    ).toBe("📍 Location");
  });
});

describe("convertMessageToPreview — CONTACT (name interpolation)", () => {
  it("[Contact preview] CONTACT with name → '👤 <name>'", () => {
    expect(
      convertMessageToPreview("CONTACT", { contact: { name: "Sam" } })
    ).toBe("👤 Sam");
  });

  it("[Contact preview] CONTACT with no name → '👤 Contact'", () => {
    expect(convertMessageToPreview("CONTACT", { text: "" })).toBe("👤 Contact");
    expect(
      convertMessageToPreview("CONTACT", { contact: { phone: "123" } })
    ).toBe("👤 Contact");
  });
});

describe("convertMessageToPreview — case-insensitivity (contentType normalized to UPPER)", () => {
  it.each([
    ["image", "📷 Photo"],
    ["Image", "📷 Photo"],
    ["vIdEo", "🎥 Video"],
    ["sticker", "Sticker"],
    ["document", "📄 Document"],
  ])("maps lowercase/mixed-case '%s' → '%s'", (type, expected) => {
    expect(convertMessageToPreview(type, { text: "" })).toBe(expected);
  });
});

describe("convertMessageToPreview — adversarial / negative", () => {
  it("[Unknown kind] unknown type with body → returns the (truncated) text", () => {
    expect(convertMessageToPreview("POLL", { text: "Vote now" })).toBe(
      "Vote now"
    );
  });

  it("[Unknown kind] unknown type with NO body → 'New message' (NON-BLANK)", () => {
    expect(convertMessageToPreview("POLL", { text: "" })).toBe("New message");
    expect(convertMessageToPreview("POLL", {})).toBe("New message");
  });

  it("tolerates null/undefined content without throwing", () => {
    expect(convertMessageToPreview("IMAGE", null)).toBe("📷 Photo");
    expect(convertMessageToPreview("IMAGE", undefined)).toBe("📷 Photo");
    expect(convertMessageToPreview("TEXT", null)).toBe("Sent a message");
  });

  it("tolerates null/undefined/empty contentType (→ default branch, NON-BLANK)", () => {
    expect(convertMessageToPreview(null, { text: "hi" })).toBe("hi");
    expect(convertMessageToPreview(undefined, {})).toBe("New message");
    expect(convertMessageToPreview("", {})).toBe("New message");
  });

  it("GUARD: NO media/structured kind ever yields a blank preview with an empty body", () => {
    // The exact bug: non-text messages must never persist "". Drive every
    // canonical CONTENT_TYPES member with an empty content object and assert the
    // preview is a non-empty string. SYSTEM is the one legitimate ""→"" kind
    // (server lifecycle text), so it is asserted separately and excluded here.
    for (const type of CONTENT_TYPES) {
      if (type === "SYSTEM") continue;
      const preview = convertMessageToPreview(type, { text: "" });
      expect(typeof preview).toBe("string");
      expect(preview.length).toBeGreaterThan(0);
    }
    // SYSTEM with empty body is intentionally "" (no user-facing lifecycle text).
    expect(convertMessageToPreview("SYSTEM", { text: "" })).toBe("");
  });
});

describe("buildMessagePreview alias === convertMessageToPreview", () => {
  it("is the same function reference", () => {
    expect(buildMessagePreview).toBe(convertMessageToPreview);
  });

  it.each([
    ["TEXT", { text: "hi" }],
    ["IMAGE", { text: "" }],
    ["DOCUMENT", { files: [{ name: "x.pdf" }] }],
    ["LOCATION", { location: { placeName: "Park" } }],
    ["CONTACT", { contact: { name: "Sam" } }],
  ])("produces identical output to canonical for %s", (type, content) => {
    expect(buildMessagePreview(type, content)).toBe(
      convertMessageToPreview(type, content)
    );
  });
});

describe("buildPushPreview (push path — type + body text only)", () => {
  it("[Image push] buildPushPreview('IMAGE','') → '📷 Photo' (NON-BLANK)", () => {
    expect(buildPushPreview("IMAGE", "")).toBe("📷 Photo");
  });

  it("[Text push] buildPushPreview('TEXT','hello') → 'hello'", () => {
    expect(buildPushPreview("TEXT", "hello")).toBe("hello");
  });

  it("[Text push] buildPushPreview('TEXT','') → 'Sent a message'", () => {
    expect(buildPushPreview("TEXT", "")).toBe("Sent a message");
  });

  it("media push types are non-blank even with no body text", () => {
    expect(buildPushPreview("VIDEO", "")).toBe("🎥 Video");
    expect(buildPushPreview("VOICE", "")).toBe("🎤 Voice Message");
    expect(buildPushPreview("STICKER", "")).toBe("Sticker");
  });
});

describe("REGRESSION: the exact expression persisted as community.activity messagePreview", () => {
  // Both publish sites (grpc/service-impl.ts ~1738 + services/chat-message-
  // orchestrator.ts ~430) now persist:
  //   convertMessageToPreview(saved.messageType, { text, files, location, contact })
  // This pins that an IMAGE / STICKER community message — whose stored body is
  // empty — produces a NON-BLANK messagePreview, which was the shipped bug.
  it("IMAGE community message → non-blank messagePreview", () => {
    const messagePreview = convertMessageToPreview("IMAGE", {
      text: "",
      files: [],
    });
    expect(messagePreview).not.toBe("");
    expect(messagePreview).toBe("📷 Photo");
  });

  it("STICKER community message → non-blank messagePreview", () => {
    const messagePreview = convertMessageToPreview("STICKER", {
      text: "",
      files: [],
    });
    expect(messagePreview).not.toBe("");
    expect(messagePreview).toBe("Sticker");
  });

  it("DOCUMENT community message carries the filename through", () => {
    const messagePreview = convertMessageToPreview("DOCUMENT", {
      text: "",
      files: [{ name: "invoice.pdf" }],
    });
    expect(messagePreview).toBe("📄 invoice.pdf");
  });
});
