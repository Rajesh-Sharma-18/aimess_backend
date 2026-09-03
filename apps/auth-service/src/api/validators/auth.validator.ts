import { z } from "zod";

import { checkPasswordPolicy } from "../../lib/password-policy.js";

export const accountSchema = z
  .string()
  .trim()
  // .toLowerCase()
  .min(3, "Account name must be at least 3 characters")
  .max(32, "Account name must be at most 32 characters")
  .regex(
    /^[-a-zA-Z0-9_]+$/,
    "Account name can only contain letters, numbers, hyphens, and underscores"
  );

/**
 * Proof-of-work credential.
 *
 * Required on the two endpoints that were free to call at scale: account
 * creation and handle availability. `challenge` is the server-issued token from
 * `POST /auth/challenge`; `solution` is the nonce the client found. See
 * `lib/signup-challenge.ts` for why this rather than a captcha.
 */
export const challengeSchema = z.object({
  challenge: z.string().min(1).max(512),
  solution: z.string().min(1).max(128),
});

export const validateAccountSchema = z.object({
  account: accountSchema,
  proof: challengeSchema,
});

export type ValidateAccountInput = z.infer<typeof validateAccountSchema>;

/**
 * The CREATION policy for a password: register, reset and change all use it.
 *
 * Login deliberately does NOT (see `loginPasswordSchema` below), so every
 * account created under the older 8-character rule keeps signing in and is only
 * asked for something stronger when it next sets a password.
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
    account: accountSchema,
    password: passwordSchema,
    fcmTokens: fcmTokensSchema.optional().default([]),
    proof: challengeSchema,
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
 * Login deliberately does NOT reuse `passwordSchema`. That schema is the
 * CREATION policy (min 8); applying it here would lock out any account created
 * before the rule with a shorter password — they would get a validation error
 * instead of a login. This only has to keep non-strings and absurd lengths away
 * from the repository and bcrypt; whether the value is correct is bcrypt's job.
 */
export const existingPasswordSchema = z.string().min(1).max(128);

/** Alias kept for the login schema below, which reads better with this name. */
const loginPasswordSchema = existingPasswordSchema;

export const loginSchema = z.object({
  account: loginIdentifierSchema,
  password: loginPasswordSchema,
  fcmTokens: fcmTokensSchema.optional().default([]),
  rememberMe: z.boolean().optional().default(false),
});

export type LoginInput = z.infer<typeof loginSchema>;
