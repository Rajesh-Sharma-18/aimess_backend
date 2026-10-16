import {
  updateCommunitySchema,
  updateGroupSchema,
} from "../../src/api/validators/space-edit.validator.js";

const BLANKS = ["   ", "\t\n", "​​​", "⠀⠀⠀", "ㅤﾠㅤ", " ​⠀﻿ "];

describe("admin space edit", () => {
  it.each(BLANKS)("rejects visually blank community and group names %j", (name) => {
    expect(updateCommunitySchema.safeParse({ name }).success).toBe(false);
    expect(updateGroupSchema.safeParse({ name }).success).toBe(false);
  });

  it("strips invisible padding from names and descriptions", () => {
    expect(updateCommunitySchema.parse({ name: "​Nhóm Việt⠀" }).name).toBe("Nhóm Việt");
    expect(updateGroupSchema.parse({ description: "ㅤ " }).description).toBe("");
  });
});
