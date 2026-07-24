import {
  buildCommunitySearchFilter,
  normalizeForSearch,
  tokenizeSearchQuery,
} from "../../src/lib/community-search.util.js";

describe("tokenizeSearchQuery", () => {
  it("returns a single token for a single-word query", () => {
    expect(tokenizeSearchQuery("text")).toEqual(["text"]);
  });

  it("splits a multi-word query into individual tokens", () => {
    expect(tokenizeSearchQuery("text text1")).toEqual(["text", "text1"]);
  });

  it("trims leading/trailing whitespace", () => {
    expect(tokenizeSearchQuery("   text   ")).toEqual(["text"]);
  });

  it("collapses multiple internal spaces into a single separator", () => {
    expect(tokenizeSearchQuery("text     text1")).toEqual(["text", "text1"]);
  });

  it("collapses leading/trailing AND internal whitespace together", () => {
    expect(tokenizeSearchQuery("  text   text1  text2  ")).toEqual([
      "text",
      "text1",
      "text2",
    ]);
  });

  it("returns an empty array for a blank/whitespace-only query", () => {
    expect(tokenizeSearchQuery("")).toEqual([]);
    expect(tokenizeSearchQuery("   ")).toEqual([]);
  });

  it("also splits on tabs/newlines (any whitespace run)", () => {
    expect(tokenizeSearchQuery("text\t\ntext1")).toEqual(["text", "text1"]);
  });
});

describe("normalizeForSearch", () => {
  it("lowercases", () => {
    expect(normalizeForSearch("TeXt")).toBe("text");
    expect(normalizeForSearch("DR JHATKA")).toBe("drjhatka");
  });

  it("strips spaces", () => {
    expect(normalizeForSearch("dr jhatka")).toBe("drjhatka");
  });

  it("strips underscores", () => {
    expect(normalizeForSearch("dr_jhatka")).toBe("drjhatka");
  });

  it("strips hyphens", () => {
    expect(normalizeForSearch("dr-jhatka")).toBe("drjhatka");
  });

  it("strips dots", () => {
    expect(normalizeForSearch("Dr. Jhatka")).toBe("drjhatka");
  });

  it("strips a mix of formatting characters in one string", () => {
    expect(normalizeForSearch("Dr._Jhatka-2.0")).toBe("drjhatka20");
  });

  it("leaves digits intact", () => {
    expect(normalizeForSearch("Community123")).toBe("community123");
  });

  it("collapses runs of punctuation to nothing (not a single separator)", () => {
    expect(normalizeForSearch("a...b")).toBe("ab");
  });

  it("returns an empty string for pure punctuation/whitespace", () => {
    expect(normalizeForSearch("...")).toBe("");
    expect(normalizeForSearch("   ")).toBe("");
  });

  it("preserves non-Latin letters instead of stripping them", () => {
    expect(normalizeForSearch("Café")).toBe("café");
  });
});

describe("buildCommunitySearchFilter", () => {
  it("single-word query: OR over normalized + raw name/handle", () => {
    expect(buildCommunitySearchFilter("text")).toEqual([
      {
        OR: [
          { normalizedName: { contains: "text" } },
          { normalizedHandle: { contains: "text" } },
          { name: { contains: "text", mode: "insensitive" } },
          { handle: { contains: "text", mode: "insensitive" } },
        ],
      },
    ]);
  });

  it("multi-word query: one AND-ed OR clause per token, in order", () => {
    const filter = buildCommunitySearchFilter("text text1");

    expect(filter).toHaveLength(2);
    expect(filter[0]).toEqual({
      OR: [
        { normalizedName: { contains: "text" } },
        { normalizedHandle: { contains: "text" } },
        { name: { contains: "text", mode: "insensitive" } },
        { handle: { contains: "text", mode: "insensitive" } },
      ],
    });
    expect(filter[1]).toEqual({
      OR: [
        { normalizedName: { contains: "text1" } },
        { normalizedHandle: { contains: "text1" } },
        { name: { contains: "text1", mode: "insensitive" } },
        { handle: { contains: "text1", mode: "insensitive" } },
      ],
    });
  });

  it("is case-insensitive via both normalized token and raw mode:insensitive", () => {
    const filter = buildCommunitySearchFilter("TeXt");
    expect(filter[0]).toEqual({
      OR: [
        { normalizedName: { contains: "text" } },
        { normalizedHandle: { contains: "text" } },
        { name: { contains: "TeXt", mode: "insensitive" } },
        { handle: { contains: "TeXt", mode: "insensitive" } },
      ],
    });
  });

  it("strips formatting characters WITHIN a token for the normalized arms", () => {
    expect(buildCommunitySearchFilter("dr_jhatka")).toEqual([
      {
        OR: [
          { normalizedName: { contains: "drjhatka" } },
          { normalizedHandle: { contains: "drjhatka" } },
          { name: { contains: "dr_jhatka", mode: "insensitive" } },
          { handle: { contains: "dr_jhatka", mode: "insensitive" } },
        ],
      },
    ]);
  });

  it("ignores extra internal/leading/trailing whitespace", () => {
    const filter = buildCommunitySearchFilter("  text    text1  ");
    expect(filter).toHaveLength(2);
  });

  it("returns an empty array for a blank query (no filter added)", () => {
    expect(buildCommunitySearchFilter("")).toEqual([]);
    expect(buildCommunitySearchFilter("   ")).toEqual([]);
  });

  it("drops tokens that normalize to nothing (pure punctuation)", () => {
    expect(buildCommunitySearchFilter("...")).toEqual([]);
    expect(buildCommunitySearchFilter("text ...")).toHaveLength(1);
  });

  it("a 3-token query produces 3 independent AND-ed OR clauses", () => {
    const filter = buildCommunitySearchFilter("alpha beta gamma");
    expect(filter).toHaveLength(3);
  });
});
