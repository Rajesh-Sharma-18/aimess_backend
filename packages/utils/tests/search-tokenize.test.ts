import {
  handleRank,
  rankByHandle,
  normalizeForSearch,
  tokenizeAndNormalize,
  tokenizeSearchQuery,
} from "../src/search-tokenize.js";

describe("normalizeForSearch", () => {
  it("folds case and strips formatting", () => {
    expect(normalizeForSearch("Dr. Jhatka")).toBe("drjhatka");
    expect(normalizeForSearch("dr_jhatka")).toBe("drjhatka");
    expect(normalizeForSearch("Dr-Jhatka")).toBe("drjhatka");
  });

  // The whole point of the fold: Vietnamese is typed without diacritics far
  // more often than with them, so a name must be findable either way.
  it("folds Vietnamese diacritics, including the standalone letter d-stroke", () => {
    expect(normalizeForSearch("Nguyễn Minh Anh")).toBe("nguyenminhanh");
    expect(normalizeForSearch("Đặng Văn")).toBe("dangvan");
    expect(normalizeForSearch("nguyen")).toBe("nguyen");
  });

  it("folds Latin diacritics", () => {
    expect(normalizeForSearch("José")).toBe("jose");
    expect(normalizeForSearch("Müller")).toBe("muller");
  });

  // Thai vowel and tone marks are marks, not letters, so they were already
  // dropped. Query and stored shadow run through the same function, so the
  // match stays symmetric — this pins that it did not change.
  it("keeps Thai consonants and folds Thai marks symmetrically", () => {
    expect(normalizeForSearch("ทดสอบ")).toBe("ทดสอบ");
    expect(normalizeForSearch("กิน")).toBe(normalizeForSearch("กิน"));
    expect(normalizeForSearch("กิน")).toBe("กน");
  });

  it("leaves Han and Hangul composed and intact", () => {
    expect(normalizeForSearch("日本語")).toBe("日本語");
    expect(normalizeForSearch("한국어")).toBe("한국어");
  });

  it("is idempotent, so a re-backfilled shadow never drifts", () => {
    for (const value of ["Nguyễn", "Đặng", "กิน", "한국어", "Dr. Jhatka"]) {
      expect(normalizeForSearch(normalizeForSearch(value))).toBe(
        normalizeForSearch(value)
      );
    }
  });

  it("returns empty for punctuation-only input", () => {
    expect(normalizeForSearch("...")).toBe("");
    expect(normalizeForSearch("   ")).toBe("");
  });
});

describe("tokenizeSearchQuery", () => {
  it("splits on any run of whitespace and drops empties", () => {
    expect(tokenizeSearchQuery("  john   doe ")).toEqual(["john", "doe"]);
    expect(tokenizeSearchQuery("   ")).toEqual([]);
  });
});

describe("tokenizeAndNormalize", () => {
  it("pairs each token with its normalized form", () => {
    expect(tokenizeAndNormalize("Nguyễn Anh")).toEqual([
      { raw: "Nguyễn", normalized: "nguyen" },
      { raw: "Anh", normalized: "anh" },
    ]);
  });

  it("drops tokens that normalize to nothing", () => {
    expect(tokenizeAndNormalize("... john")).toEqual([
      { raw: "john", normalized: "john" },
    ]);
  });
});

describe("handleRank", () => {
  it("tiers exact over prefix over substring over no-match", () => {
    expect(handleRank("cat", "cat")).toBe(0);
    expect(handleRank("catloversonly", "cat")).toBe(1);
    expect(handleRank("thecatlover", "cat")).toBe(2);
    expect(handleRank("dogperson", "cat")).toBe(3);
  });

  it("treats @Handle, handle and hand le as one query", () => {
    for (const q of [
      "@Smiley_Creatures",
      "smiley creatures",
      "smileycreatures",
    ]) {
      expect(handleRank("Smiley_Creatures", normalizeForSearch(q))).toBe(0);
    }
  });

  it("ranks nothing when the query normalizes away", () => {
    expect(handleRank("cat", "")).toBe(3);
  });
});

describe("rankByHandle", () => {
  const rows = [
    { handle: "dogperson" }, // name-only match, tier 3
    { handle: "thecatlover" }, // substring, tier 2
    { handle: "cat" }, // exact, tier 0
    { handle: "catloversonly" }, // prefix, tier 1
  ];

  it("puts the exact handle first and keeps every row", () => {
    expect(
      rankByHandle(rows, "@CAT", (r) => r.handle).map((r) => r.handle)
    ).toEqual(["cat", "catloversonly", "thecatlover", "dogperson"]);
  });

  it("holds the page order within a tier", () => {
    const sameTier = [
      { handle: "catz" },
      { handle: "cataz" },
      { handle: "catbz" },
    ];
    expect(
      rankByHandle(sameTier, "cat", (r) => r.handle).map((r) => r.handle)
    ).toEqual(["catz", "cataz", "catbz"]);
  });

  it("leaves the page untouched when there is no query", () => {
    expect(rankByHandle(rows, undefined, (r) => r.handle)).toBe(rows);
  });
});
