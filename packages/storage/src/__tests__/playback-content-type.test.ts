/**
 * Unit tests for the presigned-GET playback Content-Type override. Pure logic,
 * no infra. Run via `tsx --test "src/**\/*.test.ts"` (package convention).
 *
 * The contract: QuickTime-family containers are relabelled video/mp4 so a
 * browser will actually demux them; foreign containers are left alone, because
 * mislabelling those trades "won't play" for "plays garbage".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { playbackContentTypeForKey } from "../media-url-strategy.js";

describe("playbackContentTypeForKey", () => {
  it("relabels QuickTime-family containers as video/mp4", () => {
    assert.equal(
      playbackContentTypeForKey("chat-uploads/u1/clip.mov"),
      "video/mp4"
    );
    assert.equal(
      playbackContentTypeForKey("chat-uploads/u1/clip.MOV"),
      "video/mp4"
    );
    assert.equal(
      playbackContentTypeForKey("chat-uploads/u1/clip.m4v"),
      "video/mp4"
    );
  });

  it("leaves already-playable and foreign containers untouched", () => {
    for (const key of [
      "chat-uploads/u1/clip.mp4",
      "chat-uploads/u1/clip.webm",
      "chat-uploads/u1/clip.mkv",
      "chat-uploads/u1/clip.avi",
      "chat-uploads/u1/photo.jpg",
      "chat-uploads/u1/notes.pdf",
      "chat-uploads/u1/noextension",
    ]) {
      assert.equal(playbackContentTypeForKey(key), undefined, key);
    }
  });

  it("ignores a query string on an already-signed URL", () => {
    assert.equal(
      playbackContentTypeForKey("chat-uploads/u1/clip.mov?X-Amz-Signature=abc"),
      "video/mp4"
    );
  });
});
