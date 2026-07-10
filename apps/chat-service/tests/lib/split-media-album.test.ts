import { describe, expect, it } from "@jest/globals";

import {
  splitCommunityMediaAlbum,
  splitDirectMediaAlbum,
  shouldSplitMediaAlbum,
} from "../../src/lib/split-media-album.js";
import {
  resolveMessageId,
  resolveParentMessageId,
} from "../../src/lib/album-messages.js";

describe("split-media-album", () => {
  it("splits a multi-image private album into one row per file", () => {
    const files = [
      { objectKey: "a.jpg" },
      { objectKey: "b.jpg" },
      { objectKey: "c.jpg" },
    ];
    const parts = splitDirectMediaAlbum(
      "IMAGE",
      { text: "vacation", files },
      "client-1"
    );
    expect(parts).toHaveLength(3);
    expect(parts[0]?.content.text).toBe("vacation");
    expect(parts[1]?.content.text).toBe("");
    expect(parts[2]?.content.text).toBe("");
    expect(parts[0]?.clientMessageId).toBe("client-1");
    expect(parts[1]?.clientMessageId).toBe("client-1:1");
    expect(parts[2]?.clientMessageId).toBe("client-1:2");
    expect(parts.every((p) => p.content.files?.length === 1)).toBe(true);
  });

  it("does not split a caption-only text message", () => {
    const parts = splitDirectMediaAlbum("TEXT", { text: "hi" }, "c1");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.content.text).toBe("hi");
  });

  it("does not split single-file media", () => {
    const parts = splitDirectMediaAlbum(
      "IMAGE",
      { text: "", files: [{ objectKey: "one.jpg" }] },
      "c1"
    );
    expect(parts).toHaveLength(1);
  });

  it("splits mixed image/video album and infers per-file types", () => {
    const files = [
      { objectKey: "a.jpg", mime: "image/jpeg" },
      { objectKey: "b.mp4", mime: "video/mp4" },
    ];
    expect(shouldSplitMediaAlbum("IMAGE", files)).toBe(true);
    const parts = splitDirectMediaAlbum("IMAGE", { text: "", files }, "alb");
    expect(parts[0]?.messageType).toBe("IMAGE");
    expect(parts[1]?.messageType).toBe("VIDEO");
  });

  it("splits community album attachments", () => {
    const attachments = [{ objectKey: "1.jpg" }, { objectKey: "2.jpg" }];
    const parts = splitCommunityMediaAlbum(
      "IMAGE",
      "caption",
      attachments,
      "comm-1"
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]?.message).toBe("caption");
    expect(parts[1]?.message).toBe("");
    expect(parts[0]?.attachments).toHaveLength(1);
  });

  it("does not split when location is bundled with files", () => {
    const attachments = [
      { type: "location", lat: 1, lng: 2 },
      { objectKey: "1.jpg" },
    ];
    const parts = splitCommunityMediaAlbum("IMAGE", "", attachments, "x");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.attachments).toHaveLength(2);
  });
});

describe("resolveMessageId", () => {
  const OBJECT_ID = "6a509a89d59f6ac6cc5fbc19";

  it("strips album- prefix to recover the primary message ObjectId", () => {
    expect(resolveMessageId(`album-${OBJECT_ID}`)).toBe(OBJECT_ID);
  });

  it("returns a plain ObjectId unchanged", () => {
    expect(resolveMessageId(OBJECT_ID)).toBe(OBJECT_ID);
  });

  it("returns empty string for empty input", () => {
    expect(resolveMessageId("")).toBe("");
  });

  it("returns empty string for null/undefined", () => {
    expect(resolveMessageId(null)).toBe("");
    expect(resolveMessageId(undefined)).toBe("");
  });
});

describe("resolveParentMessageId", () => {
  const OBJECT_ID = "6a509a89d59f6ac6cc5fbc19";

  it("strips album- prefix and returns the ObjectId for persistence", () => {
    expect(resolveParentMessageId(`album-${OBJECT_ID}`)).toBe(OBJECT_ID);
  });

  it("returns a plain ObjectId unchanged", () => {
    expect(resolveParentMessageId(OBJECT_ID)).toBe(OBJECT_ID);
  });

  it("returns null for null/undefined/empty — no garbage stored in the column", () => {
    expect(resolveParentMessageId(null)).toBeNull();
    expect(resolveParentMessageId(undefined)).toBeNull();
    expect(resolveParentMessageId("")).toBeNull();
  });

  it("returns null for non-ObjectId strings that would crash Prisma", () => {
    expect(resolveParentMessageId("album-notanobjectid")).toBeNull();
    expect(resolveParentMessageId("mediaId-abc")).toBeNull();
    expect(resolveParentMessageId("clientMsg-xyz")).toBeNull();
    expect(resolveParentMessageId("some-random-string")).toBeNull();
  });

  it("rejects a 24-char hex string prefixed with album- where the suffix is too short", () => {
    expect(resolveParentMessageId("album-tooshort")).toBeNull();
  });
});
