/**
 * Unit tests for the admin password-reset Zod validators. Pure schema checks —
 * no env / DB / Redis needed. Run via `tsx --test src/**\/*.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resetPasswordSchema,
  verifyOtpSchema,
} from "../password-reset.validator.js";

const STRONG = "BrandNewP@ss1"; // 13 chars, upper+lower+digit+special

describe("resetPasswordSchema", () => {
  it("accepts a strong password with matching confirmation", () => {
    const r = resetPasswordSchema.safeParse({
      resetToken: "x".repeat(43),
      password: STRONG,
      confirmPassword: STRONG,
    });
    assert.equal(r.success, true);
  });

  it("rejects passwords shorter than 12 chars", () => {
    const short = "Ab1!cdef"; // 8 chars
    const r = resetPasswordSchema.safeParse({
      resetToken: "x".repeat(43),
      password: short,
      confirmPassword: short,
    });
    assert.equal(r.success, false);
  });

  it("rejects a missing uppercase letter (char-class rule)", () => {
    const pw = "lowercase1!!!"; // no uppercase
    const r = resetPasswordSchema.safeParse({
      resetToken: "x".repeat(43),
      password: pw,
      confirmPassword: pw,
    });
    assert.equal(r.success, false);
  });

  it("rejects a missing special character (char-class rule)", () => {
    const pw = "NoSpecial123"; // upper+lower+digit, no special
    const r = resetPasswordSchema.safeParse({
      resetToken: "x".repeat(43),
      password: pw,
      confirmPassword: pw,
    });
    assert.equal(r.success, false);
  });

  it("rejects a missing digit (char-class rule)", () => {
    const pw = "NoDigitsHere!!"; // upper+lower+special, no digit
    const r = resetPasswordSchema.safeParse({
      resetToken: "x".repeat(43),
      password: pw,
      confirmPassword: pw,
    });
    assert.equal(r.success, false);
  });

  it("rejects mismatched confirmPassword", () => {
    const r = resetPasswordSchema.safeParse({
      resetToken: "x".repeat(43),
      password: STRONG,
      confirmPassword: `${STRONG}x`,
    });
    assert.equal(r.success, false);
    if (!r.success) {
      assert.ok(
        r.error.issues.some((i) => i.path.includes("confirmPassword")),
        "mismatch error is attached to confirmPassword"
      );
    }
  });

  it("rejects a too-short reset token", () => {
    const r = resetPasswordSchema.safeParse({
      resetToken: "short",
      password: STRONG,
      confirmPassword: STRONG,
    });
    assert.equal(r.success, false);
  });
});

describe("verifyOtpSchema", () => {
  it("accepts a 6-digit code and lowercases the email", () => {
    const r = verifyOtpSchema.safeParse({
      email: "Admin@Example.com",
      code: "123456",
    });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.email, "admin@example.com");
      assert.equal(r.data.code, "123456");
    }
  });

  it("rejects a non-6-digit code (too short)", () => {
    const r = verifyOtpSchema.safeParse({ email: "a@b.com", code: "12345" });
    assert.equal(r.success, false);
  });

  it("rejects a code with non-digit characters", () => {
    const r = verifyOtpSchema.safeParse({ email: "a@b.com", code: "12a456" });
    assert.equal(r.success, false);
  });

  it("rejects a 7-digit code (too long)", () => {
    const r = verifyOtpSchema.safeParse({ email: "a@b.com", code: "1234567" });
    assert.equal(r.success, false);
  });

  it("rejects an invalid email", () => {
    const r = verifyOtpSchema.safeParse({
      email: "not-an-email",
      code: "123456",
    });
    assert.equal(r.success, false);
  });
});
