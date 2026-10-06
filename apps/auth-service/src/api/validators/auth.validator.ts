import { z } from "zod";

import { TEXT_NAME_MAX_LENGTH } from "@aimess/constants";

import { checkPasswordPolicy } from "../../lib/password-policy.js";
import { deviceInfoField } from "./device-info.validator.js";

/** Everything about an account name EXCEPT how long it may be. */
const accountShape = z
  .string()
  .trim()
  // Not lowercased here: this shape also reads EXISTING handles, and legacy
  // ones keep the case they were created with. New ones: `newAccountSchema`.
  .min(3, "Account name must be at least 3 characters")
  .regex(
    /^[-a-zA-Z0-9_]+$/,
    "Account name can only contain letters, numbers, hyphens, and underscores"
  );

/**
 * The SHAPE of an account name, used wherever an EXISTING handle is read:
 * sign-in, and the "does this account exist?" step.
 *
 * Deliberately still 32. Live accounts were created at 31-32 characters before
 * the 30-character product rule existed; tightening this schema would not
 * shorten them, it would only refuse their owners a login. New handles go
 * through `newAccountSchema` below.
 */
export const accountSchema = accountShape.max(
  32,
  "Account name must be at most 32 characters"
);

/**
 * The account name a NEW registration may claim: the same shape, lowercased
 * (the canonical form — see `findByAccount` for why "Rajesh_Sharma" and
 * "rajesh_sharma" are one identity), capped at the shared 30
 * (`TEXT_NAME_MAX_LENGTH`). The charset is ASCII-only, so UTF-16
 * length and character count are the same thing here, and this `.max()` agrees
 * exactly with the website's character counter. The message is a message KEY —
 * `validateBody` renders it in the caller's locale.
 *
 * Built from `accountShape` rather than from `accountSchema` so that a
 * 50-character handle is answered with THIS sentence; layered over the 32 cap it
 * would have reported "at most 32 characters" to someone being held to 30.
 */
export const newAccountSchema = accountShape
  .max(TEXT_NAME_MAX_LENGTH, "VALIDATION_ACCOUNT_MAX_LENGTH")
  .toLowerCase();

/**
 * Proof-of-work credential.
 *
 * Required on the two endpoints that were free to call at scale: account
 * creation and handle availability. `challenge` is the server-issued token from
 * `POST /auth/challenge`; `solution` is the nonce the client found. See
 * `lib/signup-challenge.ts` for why this rather than a captcha.
 *
 * Carried by REGISTRATION only. The handle-availability check used to require
 * one too, which made a signup form's "is this name free?" keystroke depend on
 * fetching and solving a challenge first — and answer an unsolved one with a
 * validation error instead of the yes/no it exists to give. Availability is now
 * throttled per-IP and nothing else; see the route for what that gives up.
 *
 * Marked OPTIONAL so that `requireSignupChallenge` — not `validateBody` —
 * answers a request that omits it. A required field here made the gate report
 * `VALIDATION_FAILED` with Zod's raw "expected object, received undefined",
 * which tells a client nothing about the step it skipped; the middleware
 * answers `AUTH_CHALLENGE_REQUIRED`, which a client can act on. Optional
 * narrows nothing: the route that carries this also mounts that middleware.
 */
export const challengeSchema = z.object({
  challenge: z.string().min(1).max(512),
  solution: z.string().min(1).max(128),
});

/** Login handle: username (`account`) or verified linked email. */
export const loginIdentifierSchema = z
  .string()
  .trim()
  .min(3, "Please enter your account name or email address")
  .max(254, "Account name or email address is too long")
  .refine(
    (value) => {
      const asEmail = z.string().email().safeParse(value.toLowerCase());
      const asAccount = accountSchema.safeParse(value);
      return asEmail.success || asAccount.success;
    },
    { message: "Please enter a valid account name or email address" }
  );

/**
 * Body of `POST /auth/accounts/validate` — "does an account already exist for
 * this handle?".
 *
 * Accepts the full LOGIN identifier, not just a username. The endpoint is step 1
 * of the two-step login form as well as the signup form's availability check,
 * and while it took `accountSchema` alone a user whose only handle is a linked
 * email could never get past that step: the address failed validation with 400
 * before any credential was ever checked. The signup form only ever sends a
 * username-shaped value (it gates on its own regex first), so widening this
 * changes nothing there.
 */
export const validateAccountSchema = z.object({
  account: loginIdentifierSchema,
  // Opt-in, so the signup form and every existing client keep the plain
  // 409 AUTH_ACCOUNT_TAKEN. A login form sends "login" to also learn, before
  // it shows a password field, that the account cannot use one.
  purpose: z.literal("login").optional(),
});

export type ValidateAccountInput = z.infer<typeof validateAccountSchema>;

/**
 * The CREATION policy for a password: register, reset and change all use it.
 *
 * Login deliberately does NOT (see `loginPasswordSchema` below), so an account
 * whose password predates the current rule keeps signing in and is only asked
 * to satisfy the rule when it next SETS a password.
 *
 * The rules live in `lib/password-policy.ts`; this schema is the boundary that
 * applies them and maps each failure to its own message key, so the client can
 * say what to fix rather than repeating a generic "invalid password".
 */
export const passwordSchema = z.string().superRefine((value, ctx) => {
  const failure = checkPasswordPolicy(value);
  if (failure) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: failure });
  }
});

/**
 * FCM device push tokens — optional, captured on register/login when available.
 * Clients that cannot obtain push tokens (permission denied, web, emulator) can omit this field
 * or pass an empty array. Individual tokens (when provided) must be non-empty strings.
 */
export const fcmTokensSchema = z
  .array(z.string().trim().min(1, "FCM token is required"))
  .optional();

export const registerSchema = z
  .object({
    account: newAccountSchema,
    password: passwordSchema,
    fcmTokens: fcmTokensSchema.optional().default([]),
    proof: challengeSchema.optional(),
    // Optional by contract — see device-info.validator.ts. A client that sends
    // nothing (or an explicit null) registers no device row and keeps the
    // server-derived session metadata it has always had.
    device: deviceInfoField,
  })
  // Re-checked at the object level because the account name is only known
  // here: a password that merely restates the public account name is guessable
  // by anyone who can see the profile.
  .superRefine((value, ctx) => {
    const failure = checkPasswordPolicy(value.password, value.account);
    if (failure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: failure,
      });
    }
  });

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Login deliberately does NOT reuse `passwordSchema`. That schema is the
 * CREATION policy (min 8); applying it here would lock out any account created
 * before the rule with a shorter password — they would get a validation error
 * instead of a login. This only has to keep non-strings and absurd lengths away
 * from the repository and bcrypt; whether the value is correct is bcrypt's job.
 *
 * Both bounds carry their own sentence for the same reason every other field
 * here does: the client shows `message` verbatim, so a bare `.max(128)` reached
 * the sign-in form as zod's own "Too big: expected string to have <=128
 * characters".
 */
export const existingPasswordSchema = z
  .string()
  .min(1, "Please enter your password")
  .max(128, "Password is too long");

/** Alias kept for the login schema below, which reads better with this name. */
const loginPasswordSchema = existingPasswordSchema;

export const loginSchema = z.object({
  account: loginIdentifierSchema,
  password: loginPasswordSchema,
  fcmTokens: fcmTokensSchema.optional().default([]),
  rememberMe: z.boolean().optional().default(false),
  device: deviceInfoField,
});

export type LoginInput = z.infer<typeof loginSchema>;
