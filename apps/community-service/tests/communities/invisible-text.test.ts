import {
  createCommunitySchema,
  createReportSchema,
  leaveReasonSchema,
  updateCommunitySchema,
} from "../../src/api/validators/community.validator.js";

const BLANKS = ["   ", "\t\n", "​​​", "⠀⠀⠀", "ㅤㅤㅤ", " ​⠀﻿　 "];

const create = (over: Record<string, unknown>) =>
  createCommunitySchema.safeParse({
    name: "Valid name",
    handle: "valid_handle",
    type: "PUBLIC",
    categoryId: "a".repeat(24),
    ...over,
  });

describe("community name", () => {
  it.each(BLANKS)("rejects visually blank %j on create and edit", (name) => {
    expect(create({ name }).success).toBe(false);
    expect(updateCommunitySchema.safeParse({ name }).success).toBe(false);
  });

  it("rejects a name padded to the minimum with invisible characters", () => {
    expect(create({ name: "a​​" }).success).toBe(false);
  });

  it("strips invisible padding and keeps international names", () => {
    const parsed = create({ name: "⠀ชุมชนไทย​" });
    expect(parsed.success && parsed.data.name).toBe("ชุมชนไทย");
  });

  it("collapses a visually blank description to empty", () => {
    const parsed = create({ description: "​ㅤ " });
    expect(parsed.success && parsed.data.description).toBe("");
  });
});

describe("report and leave reasons", () => {
  it.each(BLANKS)("requires a visible otherReason %j", (otherReason) => {
    expect(createReportSchema.safeParse({ reason: "OTHER", otherReason }).success).toBe(false);
  });

  it.each(BLANKS)("requires visible reasonText for OTHER %j", (reasonText) => {
    expect(leaveReasonSchema.safeParse({ reason: "OTHER", reasonText }).success).toBe(false);
  });

  it("accepts a real other reason", () => {
    expect(createReportSchema.safeParse({ reason: "OTHER", otherReason: "rude" }).success).toBe(true);
  });
});
