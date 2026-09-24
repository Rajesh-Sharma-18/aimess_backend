import { TEXT_NAME_MAX_LENGTH } from "@aimess/constants";

import {
  createCommunitySchema,
  handleAvailableQuerySchema,
  handleParamsSchema,
  updateCommunitySchema,
} from "../../src/api/validators/community.validator.js";

/**
 * The 30-character rule for a community's name and handle, at the schemas the
 * create and update routes mount. Create and update are asserted side by side —
 * "create validates 30 but edit allows 100" is the bug this rule invites.
 *
 * The handle is measured WITHOUT the "@": that is decoration the clients render,
 * and the stored column has never carried it.
 */
const MAX = TEXT_NAME_MAX_LENGTH;
const chars = (n: number, unit = "a") => unit.repeat(n);

const base = {
  type: "PUBLIC" as const,
  categoryId: "a".repeat(24),
};
const create = (over: Record<string, unknown>) =>
  createCommunitySchema.safeParse({
    name: "Valid name",
    handle: "valid_handle",
    ...base,
    ...over,
  });

describe("community name", () => {
  it.each([3, 29, MAX])("accepts %i characters on create and on edit", (n) => {
    expect(create({ name: chars(n) }).success).toBe(true);
    expect(updateCommunitySchema.safeParse({ name: chars(n) }).success).toBe(
      true
    );
  });

  it.each([MAX + 1, 50, 100])("rejects %i characters on create and on edit", (n) => {
    const created = create({ name: chars(n) });
    expect(created.success).toBe(false);
    expect(created.error?.issues[0]?.message).toBe(
      "VALIDATION_COMMUNITY_NAME_MAX_LENGTH"
    );
    expect(updateCommunitySchema.safeParse({ name: chars(n) }).success).toBe(
      false
    );
  });

  it("counts characters, not code units", () => {
    expect(create({ name: chars(MAX, "กิ") }).success).toBe(true);
    expect(create({ name: chars(MAX, "😀") }).success).toBe(true);
    expect(create({ name: chars(MAX + 1, "😀") }).success).toBe(false);
  });

  it("keeps the floor of 3 and the trimming", () => {
    expect(create({ name: "ab" }).success).toBe(false);
    expect(create({ name: `  ${chars(MAX)}  ` }).success).toBe(true);
    expect(create({ name: `  ${chars(MAX + 1)}  ` }).success).toBe(false);
  });
});

describe("community handle", () => {
  it.each([3, 29, MAX])("accepts %i characters on create and on edit", (n) => {
    expect(create({ handle: chars(n) }).success).toBe(true);
    expect(updateCommunitySchema.safeParse({ handle: chars(n) }).success).toBe(
      true
    );
  });

  it.each([MAX + 1, 32, 50])("rejects %i characters on create and on edit", (n) => {
    const created = create({ handle: chars(n) });
    expect(created.success).toBe(false);
    expect(created.error?.issues[0]?.message).toBe(
      "VALIDATION_COMMUNITY_HANDLE_MAX_LENGTH"
    );
    expect(updateCommunitySchema.safeParse({ handle: chars(n) }).success).toBe(
      false
    );
  });

  it("keeps normalization, the floor of 3 and the charset", () => {
    expect(create({ handle: "MiXeD_Case" }).data?.handle).toBe("mixed_case");
    expect(create({ handle: "ab" }).success).toBe(false);
    expect(create({ handle: "has space" }).success).toBe(false);
    expect(create({ handle: "dots.not.allowed" }).success).toBe(false);
  });

  it("caps the availability check the create form calls", () => {
    expect(
      handleAvailableQuerySchema.safeParse({ handle: chars(MAX) }).success
    ).toBe(true);
    expect(
      handleAvailableQuerySchema.safeParse({ handle: chars(MAX + 1) }).success
    ).toBe(false);
  });

  it("still RESOLVES a handle that predates the limit", () => {
    // A community created at 32 characters must keep opening from a shared
    // link — the cap belongs on claiming a handle, not on looking one up.
    expect(handleParamsSchema.safeParse({ handle: chars(32) }).success).toBe(
      true
    );
  });
});
