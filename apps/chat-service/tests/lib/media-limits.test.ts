/**
 * assertAttachmentsValid / enforceMediaLimits (apps/chat-service/src/constants/media-limits.ts)
 *
 * Root cause under test: chat-service's `MEDIA_LIMITS.AUDIO`/`DOCUMENT` used to
 * alias the VIDEO (100 MB) / GENERIC (50 MB) caps instead of a dedicated 25 MB
 * cap, and every file inside a DOCUMENT/CUSTOM (generic file-picker) message
 * was checked against the flat document cap regardless of its own real type —
 * so a video/audio file attached via a generic file picker got the WRONG
 * limit applied (and, post-fix, the wrong limit would now be the stricter one,
 * rejecting a legitimate video/audio send).
 *
 * Env defaults (see config/env.ts): image/audio/document = 25 MB, video = 100 MB.
 */
process.env.CHAT_IMAGE_MAX_BYTES = String(25 * 1024 * 1024);
process.env.CHAT_AUDIO_MAX_BYTES = String(25 * 1024 * 1024);
process.env.CHAT_DOCUMENT_MAX_BYTES = String(25 * 1024 * 1024);
process.env.CHAT_VIDEO_MAX_BYTES = String(100 * 1024 * 1024);
process.env.CHAT_UPLOAD_MAX_BYTES = String(50 * 1024 * 1024);

import {
  assertAttachmentsValid,
  enforceMediaLimits,
} from "../../src/constants/media-limits.js";

const MB = 1024 * 1024;

/** Collect every Zod issue message `enforceMediaLimits` would add. */
function collectIssues(messageType: string, files: unknown[]): string[] {
  const messages: string[] = [];
  const ctx = {
    addIssue: (issue: { message: string }) => messages.push(issue.message),
  } as never;
  enforceMediaLimits(messageType, files as never, ctx);
  return messages;
}

/** The BadRequestError's messageKey thrown by assertAttachmentsValid, or null. */
function thrownCode(messageType: string, files: unknown[]): string | null {
  try {
    assertAttachmentsValid(messageType, files as never);
    return null;
  } catch (err) {
    return (err as { messageKey?: string }).messageKey ?? null;
  }
}

describe("media-limits — per-type byte caps", () => {
  it("VIDEO: 100 MB passes, 100 MB + 1 byte fails as CHAT_VIDEO_TOO_LARGE", () => {
    expect(thrownCode("VIDEO", [{ size: 100 * MB }])).toBeNull();
    expect(thrownCode("VIDEO", [{ size: 100 * MB + 1 }])).toBe(
      "CHAT_VIDEO_TOO_LARGE"
    );
  });

  it("AUDIO: 25 MB passes, 25 MB + 1 byte fails as CHAT_AUDIO_TOO_LARGE (not the old 100 MB video cap)", () => {
    expect(thrownCode("AUDIO", [{ size: 25 * MB }])).toBeNull();
    expect(thrownCode("AUDIO", [{ size: 25 * MB + 1 }])).toBe(
      "CHAT_AUDIO_TOO_LARGE"
    );
    // Would have passed under the old bug (AUDIO aliased to the 100 MB video cap).
    expect(thrownCode("AUDIO", [{ size: 60 * MB }])).toBe(
      "CHAT_AUDIO_TOO_LARGE"
    );
  });

  it("DOCUMENT: 25 MB passes, 25 MB + 1 byte fails as CHAT_DOCUMENT_TOO_LARGE (not the old 50 MB generic cap)", () => {
    expect(
      thrownCode("DOCUMENT", [{ size: 25 * MB, mime: "application/pdf" }])
    ).toBeNull();
    expect(
      thrownCode("DOCUMENT", [{ size: 25 * MB + 1, mime: "application/pdf" }])
    ).toBe("CHAT_DOCUMENT_TOO_LARGE");
    // Would have passed under the old bug (DOCUMENT aliased to the 50 MB generic cap).
    expect(
      thrownCode("DOCUMENT", [{ size: 30 * MB, mime: "application/pdf" }])
    ).toBe("CHAT_DOCUMENT_TOO_LARGE");
  });

  it("IMAGE: count capped at 10, size capped at 25 MB", () => {
    const tenImages = Array.from({ length: 10 }, () => ({ size: 1 * MB }));
    expect(thrownCode("IMAGE", tenImages)).toBeNull();
    expect(thrownCode("IMAGE", [...tenImages, { size: 1 * MB }])).toBe(
      "CHAT_IMAGE_COUNT_EXCEEDED"
    );
    expect(thrownCode("IMAGE", [{ size: 25 * MB + 1 }])).toBe(
      "CHAT_IMAGE_TOO_LARGE"
    );
  });
});

describe("media-limits — detected-type validation for the generic (DOCUMENT/CUSTOM) bucket", () => {
  it("a video file sent as DOCUMENT is checked against the VIDEO cap, not the document cap", () => {
    // 40 MB: over the 25 MB document cap, well under the 100 MB video cap.
    expect(
      thrownCode("DOCUMENT", [{ size: 40 * MB, mime: "video/mp4" }])
    ).toBeNull();
    // 150 MB: over the video cap too — now correctly rejected as a video, not a document.
    expect(
      thrownCode("DOCUMENT", [{ size: 150 * MB, mime: "video/mp4" }])
    ).toBe("CHAT_VIDEO_TOO_LARGE");
  });

  it("an audio file sent as CUSTOM is checked against the AUDIO cap, not the document cap", () => {
    expect(
      thrownCode("CUSTOM", [{ size: 25 * MB, mime: "audio/mpeg" }])
    ).toBeNull();
    expect(
      thrownCode("CUSTOM", [{ size: 25 * MB + 1, mime: "audio/mpeg" }])
    ).toBe("CHAT_AUDIO_TOO_LARGE");
  });

  it("an image file sent as DOCUMENT is checked against the IMAGE cap", () => {
    expect(
      thrownCode("DOCUMENT", [{ size: 25 * MB, mime: "image/jpeg" }])
    ).toBeNull();
    expect(
      thrownCode("DOCUMENT", [{ size: 25 * MB + 1, mime: "image/jpeg" }])
    ).toBe("CHAT_IMAGE_TOO_LARGE");
  });

  it("a file with no/unknown mime in the generic bucket falls back to the document cap", () => {
    expect(thrownCode("DOCUMENT", [{ size: 25 * MB }])).toBeNull();
    expect(thrownCode("DOCUMENT", [{ size: 25 * MB + 1 }])).toBe(
      "CHAT_DOCUMENT_TOO_LARGE"
    );
  });
});

describe("enforceMediaLimits — Zod superRefine mirrors the same caps", () => {
  it("reports the video-cap violation for a video sent under DOCUMENT, not a document-cap message", () => {
    const issues = collectIssues("DOCUMENT", [
      { size: 150 * MB, mime: "video/mp4" },
    ]);
    expect(issues).toEqual(["Video exceeds the maximum allowed size"]);
  });

  it("reports no issues for a within-limit audio file", () => {
    expect(collectIssues("AUDIO", [{ size: 10 * MB }])).toEqual([]);
  });
});
