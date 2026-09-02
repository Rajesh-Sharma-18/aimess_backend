/**
 * AIM-67 — what a NEW password has to be.
 *
 * The policy was length-only at 8 characters, with no blocklist and no check
 * against the account's own name, so "password", "12345678" and the user's own
 * handle were all accepted. Combined with registration that issues full tokens
 * immediately, that made credential stuffing cheap: unaided password choices
 * concentrate on a very short list, and an attacker only has to try that list.
 *
 * The approach is NIST SP 800-63B — length plus a blocklist — rather than
 * composition rules, which push people toward `Password1!`: a string that
 * satisfies "upper, lower, digit, symbol" and sits on every cracking list.
 * Several fixtures in this suite used exactly that shape and had to change,
 * which is the rule doing its job.
 *
 * Login is deliberately NOT subject to this, so accounts created under the old
 * rule keep signing in; that is asserted here too, because it is the property
 * that makes the change safe to ship.
 */
import request from "supertest";

import {
  checkPasswordPolicy,
  containsIdentifier,
  isCommonPassword,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
} from "../../src/lib/password-policy.js";
import { registerSchema } from "../../src/api/validators/auth.validator.js";
import { changePasswordSchema } from "../../src/api/validators/change-password.validator.js";
import { loginSchema } from "../../src/api/validators/auth.validator.js";

const STRONG = "Correct-Horse-Battery-7";

describe("checkPasswordPolicy", () => {
  it("accepts a long, unremarkable passphrase", () => {
    expect(checkPasswordPolicy(STRONG)).toBeNull();
  });

  it("rejects anything under the minimum length", () => {
    expect(checkPasswordPolicy("Sh0rt-Pass")).toBe("AUTH_PASSWORD_TOO_SHORT");
    expect("Sh0rt-Pass".length).toBeLessThan(PASSWORD_MIN_LENGTH);
  });

  it("rejects a password bcrypt would silently truncate", () => {
    // bcrypt stops at 72 bytes. Accepting more meant the tail of a carefully
    // chosen 100-character password was never part of the stored hash, and the
    // user was told nothing.
    const tooLong = "a1B2-".repeat(20);
    expect(Buffer.byteLength(tooLong)).toBeGreaterThan(PASSWORD_MAX_BYTES);
    expect(checkPasswordPolicy(tooLong)).toBe("AUTH_PASSWORD_TOO_LONG");
  });

  it("counts BYTES, not characters, for the bcrypt ceiling", () => {
    // Multi-byte characters hit bcrypt's limit far sooner than their length
    // suggests — 30 emoji is already over 72 bytes.
    const emoji = "🔐".repeat(30);
    expect(emoji.length).toBeLessThan(PASSWORD_MAX_BYTES);
    expect(checkPasswordPolicy(emoji)).toBe("AUTH_PASSWORD_TOO_LONG");
  });

  it.each([
    "password1234",
    "Password1234",
    "P@ssw0rd1234",
    "123456789012",
    "qwertyuiop12",
    "iloveyou1234",
    "aaaaaaaaaaaa",
  ])("rejects the common choice %s", (value) => {
    expect(checkPasswordPolicy(value)).toBe("AUTH_PASSWORD_TOO_COMMON");
  });

  it("sees through the usual decorations", () => {
    // The whole point of normalising: `P@ssw0rd` is not a different password
    // from `password` to anyone running a cracking list.
    expect(isCommonPassword("P@ssw0rd!")).toBe(true);
    expect(isCommonPassword("PASSWORD123")).toBe(true);
    expect(isCommonPassword("l3tm3in")).toBe(true);
  });

  it("rejects a password built from the account name", () => {
    // The account name is public — it is how other users find you.
    expect(checkPasswordPolicy("johndoe-is-here", "johndoe")).toBe(
      "AUTH_PASSWORD_CONTAINS_IDENTIFIER"
    );
    expect(containsIdentifier("MyJohnDoePass1", "johndoe")).toBe(true);
  });

  it("matches the email local part, not the domain", () => {
    // Everyone at a company shares the domain; matching it would reject
    // reasonable passwords for no gain.
    expect(containsIdentifier("alice-and-bob-99", "alice@example.com")).toBe(
      true
    );
    expect(containsIdentifier("example-com-rocks", "alice@example.com")).toBe(
      false
    );
  });

  it("ignores a very short identifier, which would match everything", () => {
    expect(containsIdentifier("some-long-password", "abc")).toBe(false);
  });

  it("does not flag a strong password that merely contains letters", () => {
    expect(checkPasswordPolicy(STRONG, "johndoe")).toBeNull();
  });
});

describe("registerSchema", () => {
  it("accepts a compliant password", () => {
    expect(
      registerSchema.safeParse({
        account: "johndoe",
        password: STRONG,
        // `proof` is required on the schema now (AIM-58); its VALUE is checked
        // by middleware, not Zod, so any well-shaped pair parses.
        proof: { challenge: "c", solution: "s" },
      }).success
    ).toBe(true);
  });

  it("rejects the classic composition-rule password", () => {
    const result = registerSchema.safeParse({
      account: "johndoe",
      password: "Password123",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a password containing the account being registered", () => {
    const result = registerSchema.safeParse({
      account: "johndoe",
      password: "johndoe-secret-1",
    });

    expect(result.success).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  it("does not apply the creation policy to the CURRENT password", () => {
    // An account created under the old 8-character rule must be able to change
    // its password — that is the action that brings it into compliance.
    // Applying the new policy to `currentPassword` would lock it out.
    const result = changePasswordSchema.safeParse({
      currentPassword: "old8char",
      newPassword: STRONG,
    });

    expect(result.success).toBe(true);
  });

  it("applies the creation policy to the NEW password", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "old8char",
      newPassword: "password1234",
    });

    expect(result.success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("still accepts a short legacy password, so existing accounts sign in", () => {
    // The property that makes this change safe to deploy.
    const result = loginSchema.safeParse({
      account: "johndoe",
      password: "old8char",
    });

    expect(result.success).toBe(true);
  });
});

describe("POST /api/auth/register (end to end)", () => {
  it("answers 400 with the specific policy failure, not a generic error", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const app = (await import("../../src/app.js")).default;

    const res = await request(app)
      .post("/api/auth/register")
      .send({ account: "policyprobe", password: "password1234" });

    expect(res.status).toBe(400);
    // The client has to be able to tell the user WHICH rule failed.
    expect(JSON.stringify(res.body)).toContain("AUTH_PASSWORD_TOO_COMMON");
  });
});
