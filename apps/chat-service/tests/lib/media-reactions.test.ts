/**
 * Per-MEDIA reactions — the bucket arithmetic behind "react to photo #4 of a collage".
 *
 * The load-bearing property in every case below is ISOLATION: a write aimed at one attachment must
 * leave the other attachments' buckets, and the message's own `reactions`, byte-for-byte alone.
 * That is the whole defect this storage exists to fix (a reaction on one photo showing up under all
 * ten), so it is the thing a future edit must not be able to reintroduce quietly.
 *
 * `resolveMediaReactionIndex` carries the second rule: a message addressed WITHOUT an index stays
 * message-level, because a lone photo's reaction has lived on the message since before per-media
 * reactions existed and moving it would blank every reaction already on one. A single-attachment
 * message addressed WITH index 0 is the photo of a web-sent album member, which has to be
 * distinguishable from the collage the member belongs to.
 */
import {
  buildMediaReactionGroups,
  mediaReactionBucket,
  replaceMediaReactionBucket,
  resolveMediaReactionIndex,
  setStoredMediaReaction,
  toggleStoredMediaReaction,
} from "../../src/lib/chat-message.serializer.js";

const reactor = (userId: string) => ({
  userId,
  userName: "",
  avatar: "",
  memberId: "",
});

/** Two photos of one album, each already reacted to by a different person. */
const ALBUM = {
  "0": { "❤️": [reactor("alice")] },
  "3": { "👍": [reactor("bob")] },
};

const files = (count: number) => ({ files: Array.from({ length: count }) });

describe("mediaReactionBucket", () => {
  it("returns the named attachment's bucket and {} for every other input", () => {
    expect(mediaReactionBucket(ALBUM, 0)).toEqual({ "❤️": [reactor("alice")] });
    expect(mediaReactionBucket(ALBUM, 7)).toEqual({});
    expect(mediaReactionBucket(null, 0)).toEqual({});
    expect(mediaReactionBucket("nonsense", 0)).toEqual({});
  });
});

describe("toggleStoredMediaReaction", () => {
  it("adds to ONE attachment and leaves its siblings untouched", () => {
    const next = toggleStoredMediaReaction(ALBUM, 3, "carol", "😂");
    expect(next["3"]).toEqual({
      "👍": [reactor("bob")],
      "😂": [reactor("carol")],
    });
    // The isolation property: photo #0 is exactly what it was.
    expect(next["0"]).toEqual({ "❤️": [reactor("alice")] });
  });

  it("toggles OFF on a repeat and drops the bucket once it empties", () => {
    const next = toggleStoredMediaReaction(ALBUM, 0, "alice", "❤️");
    expect(next["0"]).toBeUndefined();
    expect(next["3"]).toEqual({ "👍": [reactor("bob")] });
  });

  it("replaces rather than stacks when the same user picks a different emoji", () => {
    const next = toggleStoredMediaReaction(ALBUM, 0, "alice", "🔥");
    expect(next["0"]).toEqual({ "🔥": [reactor("alice")] });
  });

  it("creates a bucket for an attachment nobody has reacted to yet", () => {
    const next = toggleStoredMediaReaction(ALBUM, 9, "dave", "🎉");
    expect(next["9"]).toEqual({ "🎉": [reactor("dave")] });
    expect(Object.keys(next).sort()).toEqual(["0", "3", "9"]);
  });
});

describe("setStoredMediaReaction", () => {
  it("lands the caller on exactly one emoji within its own attachment", () => {
    const stacked = { "0": { "❤️": [reactor("alice")], "👍": [reactor("alice")] } };
    expect(setStoredMediaReaction(stacked, 0, "alice", "🔥")["0"]).toEqual({
      "🔥": [reactor("alice")],
    });
  });

  it("clears when the caller re-sets the emoji they already hold", () => {
    expect(setStoredMediaReaction(ALBUM, 0, "alice", "❤️")["0"]).toBeUndefined();
  });
});

describe("replaceMediaReactionBucket", () => {
  it("swaps one attachment's bucket wholesale and keeps the rest", () => {
    const next = replaceMediaReactionBucket(ALBUM, 0, {
      "🎉": [reactor("erin")],
    });
    expect(next["0"]).toEqual({ "🎉": [reactor("erin")] });
    expect(next["3"]).toEqual({ "👍": [reactor("bob")] });
  });

  it("removes the attachment when the replacement is empty", () => {
    expect(replaceMediaReactionBucket(ALBUM, 3, {})["3"]).toBeUndefined();
  });
});

describe("resolveMediaReactionIndex", () => {
  it("is message-level when no index is asked for", () => {
    expect(resolveMediaReactionIndex(files(4), undefined)).toBeNull();
    expect(resolveMediaReactionIndex(files(4), null)).toBeNull();
  });

  it("is message-level for a message carrying no attachment at all", () => {
    expect(resolveMediaReactionIndex({ files: [] }, 0)).toBeNull();
    expect(resolveMediaReactionIndex(null, 0)).toBeNull();
  });

  it("addresses the lone photo of an album member, not its message", () => {
    // Message-level on such a message means the COLLAGE it belongs to, so index 0 has to reach
    // the photo — otherwise both write to the same bucket and a collage reaction lands on a photo.
    expect(resolveMediaReactionIndex(files(1), 0)).toBe(0);
    expect(resolveMediaReactionIndex(files(1), 1)).toBe(false);
  });

  it("scopes to the attachment for a message holding several", () => {
    expect(resolveMediaReactionIndex(files(10), 0)).toBe(0);
    expect(resolveMediaReactionIndex(files(10), 9)).toBe(9);
  });

  it("refuses an index the message has no attachment at", () => {
    // `false`, not null: silently falling back to message-level would react to the whole collage.
    expect(resolveMediaReactionIndex(files(3), 3)).toBe(false);
    expect(resolveMediaReactionIndex(files(3), -1)).toBe(false);
    expect(resolveMediaReactionIndex(files(3), 1.5)).toBe(false);
  });
});

describe("buildMediaReactionGroups", () => {
  it("groups per attachment and drops the empties", () => {
    expect(buildMediaReactionGroups(ALBUM, (key) => key)).toEqual({
      "0": [{ emoji: "❤️", count: 1, users: [{ userId: "alice", displayName: "", avatarUrl: "" }] }],
      "3": [{ emoji: "👍", count: 1, users: [{ userId: "bob", displayName: "", avatarUrl: "" }] }],
    });
    expect(buildMediaReactionGroups({ "2": {} }, (key) => key)).toEqual({});
    expect(buildMediaReactionGroups(undefined, (key) => key)).toEqual({});
  });
});
