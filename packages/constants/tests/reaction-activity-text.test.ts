import {
  buildReactionActivityText,
  localizeReactionActivityText,
} from "../src/index";

describe("localizeReactionActivityText", () => {
  const params = {
    actorName: "Rajesh",
    targetMessagePreview: '"QA sync test"',
    emoji: "👍",
    isSelfReaction: false,
  };
  const stored = buildReactionActivityText(params);

  it("re-renders both stored lines exactly as the reader's locale would build them", () => {
    for (const locale of ["vi", "th"] as const) {
      const native = buildReactionActivityText({ ...params, locale });
      expect(localizeReactionActivityText(stored.selfPreview, "👍", locale)).toBe(native.selfPreview);
      expect(localizeReactionActivityText(stored.targetPreview, "👍", locale)).toBe(native.targetPreview);
    }
  });

  it("keeps English and unrecognised lines as stored", () => {
    expect(localizeReactionActivityText(stored.selfPreview, "👍", "en")).toBe(stored.selfPreview);
    expect(localizeReactionActivityText("something else", "👍", "vi")).toBe("something else");
  });
});
