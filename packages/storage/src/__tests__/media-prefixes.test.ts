/**
 * Unit tests for the shared bucket→key-prefix mapping. Pure logic, no infra.
 * Run via `tsx --test "src/**\/*.test.ts"` (matches the package convention).
 *
 * The routing table here is the SAME contract chat-service asserts in
 * apps/chat-service/tests/lib/media-resolve.test.ts — kept in lockstep so the
 * lifted helper stays byte-identical to the logic it replaced.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MEDIA_PREFIXES,
  bucketForKey,
  type BucketForKeyOptions,
} from "../media-prefixes.js";

const BUCKETS: BucketForKeyOptions = {
  avatarsBucket: "aimess-avatars",
  communityBucket: "aimess-community",
  chatBucket: "aimess-chat",
};

describe("MEDIA_PREFIXES", () => {
  it("pins the canonical prefix lists per bucket", () => {
    assert.deepEqual(MEDIA_PREFIXES.avatars, ["avatars", "group-avatars"]);
    assert.deepEqual(MEDIA_PREFIXES.userAvatars, ["avatars"]);
    assert.deepEqual(MEDIA_PREFIXES.community, [
      "community/avatar",
      "community/cover",
    ]);
    assert.deepEqual(MEDIA_PREFIXES.chat, [
      "chat-uploads",
      "group-chat-uploads",
      "community-chat-uploads",
    ]);
  });
});

describe("bucketForKey", () => {
  const cases: Array<[string, string]> = [
    ["avatars/u1/a.png", BUCKETS.avatarsBucket],
    ["group-avatars/g1/icon.webp", BUCKETS.avatarsBucket],
    ["community/avatar/c1/logo.png", BUCKETS.communityBucket],
    ["community/cover/c1/banner.jpg", BUCKETS.communityBucket],
    ["chat-uploads/u1/file.pdf", BUCKETS.chatBucket],
    ["group-chat-uploads/g1/clip.mp4", BUCKETS.chatBucket],
    ["community-chat-uploads/c1/img.png", BUCKETS.chatBucket],
    ["legacy-unknown/x.bin", BUCKETS.chatBucket], // unrecognized → chat fallback
  ];

  for (const [key, bucket] of cases) {
    it(`routes ${key} → ${bucket}`, () => {
      assert.equal(bucketForKey(key, BUCKETS), bucket);
    });
  }

  it("does not mistake the bare `community` segment for a community key", () => {
    // No trailing `/avatar` or `/cover` boundary → falls through to chat.
    assert.equal(bucketForKey("community/x.bin", BUCKETS), BUCKETS.chatBucket);
  });

  it("treats a key with no slash as unrecognized (chat fallback)", () => {
    assert.equal(bucketForKey("avatar", BUCKETS), BUCKETS.chatBucket);
  });
});
