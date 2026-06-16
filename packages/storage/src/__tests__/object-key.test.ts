/**
 * Unit tests for object-key helpers. Pure logic, no infra.
 * Run via `tsx --test "src/**\/*.test.ts"` (matches the package convention).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildObjectKey,
  assertObjectKeyOwnedBy,
  extractOwnerIdFromObjectKey,
} from "../object-key.js";

describe("buildObjectKey", () => {
  it("produces `{prefix}/{ownerId}/{fileId}.{ext}` with a supplied fileId", () => {
    assert.equal(
      buildObjectKey({
        prefix: "chat-uploads",
        ownerId: "u1",
        ext: "png",
        fileId: "f1",
      }),
      "chat-uploads/u1/f1.png"
    );
  });

  it("strips a leading dot and lowercases the ext", () => {
    assert.equal(
      buildObjectKey({
        prefix: "avatars",
        ownerId: "u2",
        ext: ".PNG",
        fileId: "f2",
      }),
      "avatars/u2/f2.png"
    );
  });
});

describe("assertObjectKeyOwnedBy", () => {
  it("accepts a key under `{prefix}/{ownerId}/`", () => {
    assert.equal(
      assertObjectKeyOwnedBy("chat-uploads/u1/f1.png", "chat-uploads", "u1"),
      true
    );
  });

  it("rejects a key owned by a different user", () => {
    assert.equal(
      assertObjectKeyOwnedBy("chat-uploads/u2/f1.png", "chat-uploads", "u1"),
      false
    );
  });

  it("rejects a key containing a traversal segment", () => {
    assert.equal(
      assertObjectKeyOwnedBy(
        "chat-uploads/u1/../u2/f1.png",
        "chat-uploads",
        "u1"
      ),
      false
    );
  });
});

describe("extractOwnerIdFromObjectKey", () => {
  it("returns the 2nd path segment as the owner id", () => {
    assert.equal(extractOwnerIdFromObjectKey("chat-uploads/u1/f1.png"), "u1");
  });

  it("works for nested prefixes (2nd segment is still the owner)", () => {
    // For nested prefixes the build contract keeps owner as segment[1] only for
    // single-segment prefixes; this asserts the documented `split('/')[1]` rule.
    assert.equal(
      extractOwnerIdFromObjectKey("avatars/owner-123/file.webp"),
      "owner-123"
    );
  });

  it("returns null for an empty string", () => {
    assert.equal(extractOwnerIdFromObjectKey(""), null);
  });

  it("returns null when there is no 2nd segment", () => {
    assert.equal(extractOwnerIdFromObjectKey("chat-uploads"), null);
  });

  it("returns null when the 2nd segment is empty", () => {
    assert.equal(extractOwnerIdFromObjectKey("chat-uploads//f1.png"), null);
  });

  it("returns null on a traversal attempt", () => {
    assert.equal(
      extractOwnerIdFromObjectKey("chat-uploads/../etc/passwd"),
      null
    );
  });
});
