import { TEXT_NAME_MAX_LENGTH } from "@aimess/constants";

import {
  loginSchema,
  registerSchema,
  validateAccountSchema,
} from "../../src/api/validators/auth.validator.js";

/**
 * The 30-character rule for the account name (the handle the FE calls both
 * "Account ID" and "Account Name" — one field, two labels).
 *
 * The interesting half is what must NOT change: nine live accounts were created
 * at 31-32 characters before this rule, and tightening the LOGIN shape would
 * have locked their owners out. Only the claim path is capped.
 */
const MAX = TEXT_NAME_MAX_LENGTH;
const chars = (n: number) => "a".repeat(n);
const password = "Str0ng!Passw0rd";

describe("registration claims a NEW account name", () => {
  it.each([3, 29, MAX])("accepts %i characters", (n) => {
    expect(registerSchema.safeParse({ account: chars(n), password }).success).toBe(
      true
    );
  });

  it.each([MAX + 1, 32, 50])("rejects %i characters", (n) => {
    const result = registerSchema.safeParse({ account: chars(n), password });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some(
        (i) => i.message === "VALIDATION_ACCOUNT_MAX_LENGTH"
      )
    ).toBe(true);
  });

  it("keeps the rules the limit change was not about", () => {
    expect(registerSchema.safeParse({ account: "ab", password }).success).toBe(
      false
    );
    expect(
      registerSchema.safeParse({ account: "has space", password }).success
    ).toBe(false);
    expect(
      registerSchema.safeParse({ account: "My-Name_1", password }).success
    ).toBe(true);
  });
});

describe("existing account names stay usable", () => {
  const legacy = chars(32);

  it("signs in", () => {
    expect(
      loginSchema.safeParse({ account: legacy, password }).success
    ).toBe(true);
  });

  it("answers the does-this-account-exist step", () => {
    expect(validateAccountSchema.safeParse({ account: legacy }).success).toBe(
      true
    );
  });
});
