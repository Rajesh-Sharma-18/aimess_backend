import {
  createStreamSchema,
  reportCommentSchema,
  updateStreamSchema,
} from "../../src/api/validators/index.js";

const BLANKS = ["   ", "\t\n", "​", "⠀", "ㅤﾠ", " ​⠀﻿　 "];

describe("stream title", () => {
  it.each(BLANKS)("rejects visually blank %j on create and update", (title) => {
    expect(createStreamSchema.safeParse({ communityId: "C-1", title }).success).toBe(false);
    expect(updateStreamSchema.safeParse({ title }).success).toBe(false);
  });

  it("strips invisible padding and keeps international titles", () => {
    const parsed = createStreamSchema.parse({ communityId: "C-1", title: "​Live สด 🎥⠀", description: "ㅤ " });
    expect(parsed.title).toBe("Live สด 🎥");
    expect(parsed.description).toBe("");
  });
});

describe("comment report details", () => {
  it.each(BLANKS)("requires visible details for OTHER %j", (details) => {
    expect(reportCommentSchema.safeParse({ reason: "OTHER", details }).success).toBe(false);
  });

  it("accepts real details", () => {
    expect(reportCommentSchema.safeParse({ reason: "OTHER", details: "spam" }).success).toBe(true);
  });
});
