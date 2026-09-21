/**
 * What the read-only Backoffice viewer is allowed to carry.
 *
 * The transcript reuses the canonical enriched rows, and those rows hold the
 * full reactor list inline. These assert the one thing that must not regress:
 * the admin payload keeps the COUNTS and drops the identities, whichever of the
 * two stored shapes the row happens to be in.
 */
import { adminMentions, adminReactionCounts } from "../../src/lib/admin-wire.js";

describe("adminReactionCounts", () => {
  it("keeps emoji + count and drops the reactor identities", () => {
    const counts = adminReactionCounts([
      {
        emoji: "❤️",
        count: 2,
        users: [
          { userId: "u1", displayName: "Tom", avatarUrl: "https://x/1" },
          { userId: "u2", displayName: "Kristi", avatarUrl: "https://x/2" },
        ],
      },
      { emoji: "👍", count: 3, users: [] },
    ]);

    expect(counts).toEqual([
      { emoji: "❤️", count: 2 },
      { emoji: "👍", count: 3 },
    ]);
    expect(JSON.stringify(counts)).not.toContain("u1");
    expect(JSON.stringify(counts)).not.toContain("avatarUrl");
  });

  it("reads the stored reactor map when the canonical array is absent", () => {
    expect(
      adminReactionCounts({
        "😂": [{ userId: "u1" }, { userId: "u2" }],
        "👍": [{ userId: "u3" }],
        // An emptied bucket is not a chip.
        "🔥": [],
      })
    ).toEqual([
      { emoji: "😂", count: 2 },
      { emoji: "👍", count: 1 },
    ]);
  });

  it("falls back to the inline list length when count is missing", () => {
    expect(
      adminReactionCounts([{ emoji: "🎉", users: [{ userId: "u1" }] }])
    ).toEqual([{ emoji: "🎉", count: 1 }]);
  });

  it("is empty for a message with no reactions, in either shape", () => {
    expect(adminReactionCounts([])).toEqual([]);
    expect(adminReactionCounts({})).toEqual([]);
    expect(adminReactionCounts(null)).toEqual([]);
    expect(adminReactionCounts(undefined)).toEqual([]);
  });
});

describe("adminMentions", () => {
  it("passes the stored mention spans through untouched", () => {
    const mentions = [
      { type: "USER", userId: "u1", username: "smiley", offset: 0, length: 7 },
      { type: "ALL", offset: 8, length: 4 },
    ];
    expect(adminMentions({ text: "@smiley @all", mentions })).toEqual(mentions);
  });

  it("is empty for content without mentions", () => {
    expect(adminMentions({ text: "hello" })).toEqual([]);
    expect(adminMentions(null)).toEqual([]);
    expect(adminMentions(undefined)).toEqual([]);
  });
});
