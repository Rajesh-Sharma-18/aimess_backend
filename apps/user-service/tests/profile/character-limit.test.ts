import { TEXT_NAME_MAX_LENGTH } from "@aimess/constants";

import { updateProfileSchema } from "../../src/api/validators/profile.validator.js";
import { validateUsernameSchema } from "../../src/api/validators/username.validator.js";

/**
 * The 30-character rule at the user-service write boundary.
 *
 * These go straight at the schemas `validateBody`/`validateQuery` mount, which
 * is the authority: the website's clamping is UX, and a request built by hand,
 * by an older client or by another platform reaches exactly this code. Every
 * field is checked at 29 / 30 / 31 / 50 so a fencepost cannot pass unnoticed.
 */
const MAX = TEXT_NAME_MAX_LENGTH;
const chars = (n: number, unit = "a") => unit.repeat(n);

describe("username", () => {
  it.each([3, 29, MAX])("accepts %i characters", (n) => {
    expect(updateProfileSchema.safeParse({ username: chars(n) }).success).toBe(
      true
    );
    expect(validateUsernameSchema.safeParse({ username: chars(n) }).success).toBe(
      true
    );
  });

  it.each([MAX + 1, 50])("rejects %i characters", (n) => {
    const result = updateProfileSchema.safeParse({ username: chars(n) });
    expect(result.success).toBe(false);
    // The message is a KEY; `validateBody` renders it per-locale. Asserting on
    // the key is what proves the client gets a localized sentence rather than
    // zod's raw "Too big: expected string to have <=30 characters".
    expect(result.error?.issues[0]?.message).toBe(
      "VALIDATION_USERNAME_MAX_LENGTH"
    );
    expect(validateUsernameSchema.safeParse({ username: chars(n) }).success).toBe(
      false
    );
  });

  it("keeps the rules the limit change was not about", () => {
    expect(updateProfileSchema.safeParse({ username: "ab" }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ username: "has space" }).success).toBe(
      false
    );
    expect(updateProfileSchema.safeParse({ username: "MiXeD" }).success).toBe(
      true
    );
  });

  it("uses the SAME schema on create and on edit", () => {
    // Both entry points must be the one object, or the two drift apart — the
    // "registration validates 30, profile edit allows 50" bug.
    const long = { username: chars(MAX + 1) };
    expect(updateProfileSchema.safeParse(long).success).toBe(
      validateUsernameSchema.safeParse(long).success
    );
  });
});

describe.each([
  ["firstName", "VALIDATION_FIRST_NAME_MAX_LENGTH"],
  ["lastName", "VALIDATION_LAST_NAME_MAX_LENGTH"],
])("%s", (field, messageKey) => {
  const parse = (value: string) =>
    updateProfileSchema.safeParse({ [field]: value });

  it.each([1, 29, MAX])("accepts %i characters", (n) => {
    expect(parse(chars(n)).success).toBe(true);
  });

  it.each([MAX + 1, 50, 200])("rejects %i characters", (n) => {
    const result = parse(chars(n));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(messageKey);
  });

  it("counts characters, not code units, for Thai, Vietnamese and emoji", () => {
    // Each of these is 30 CHARACTERS but far more than 30 code units.
    expect(parse("กิ".repeat(MAX)).success).toBe(true);
    expect(parse("ễ".repeat(MAX)).success).toBe(true);
    expect(parse("😀".repeat(MAX)).success).toBe(true);

    expect(parse("กิ".repeat(MAX + 1)).success).toBe(false);
    expect(parse("😀".repeat(MAX + 1)).success).toBe(false);
  });

  it("measures the TRIMMED value, as stored", () => {
    expect(parse(`  ${chars(MAX)}  `).success).toBe(true);
    expect(parse(`  ${chars(MAX + 1)}  `).success).toBe(false);
  });

  it("still requires a non-empty value", () => {
    expect(parse("").success).toBe(false);
    expect(parse("   ").success).toBe(false);
  });
});
