import { z } from "zod";

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

export const validateAccountSchema = z.object({
  account: accountSchema,
});

export type ValidateAccountInput = z.infer<typeof validateAccountSchema>;

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters");

/**
 * FCM device push tokens — optional, captured on register/login when available.
 * Clients that cannot obtain push tokens (permission denied, web, emulator) can omit this field
 * or pass an empty array. Individual tokens (when provided) must be non-empty strings.
 */
export const fcmTokensSchema = z
  .array(z.string().trim().min(1, "FCM token is required"))
  .optional();

export const registerSchema = z.object({
  account: accountSchema,
  password: passwordSchema,
  fcmTokens: fcmTokensSchema.optional().default([]),
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
const loginPasswordSchema = z.string().min(1).max(128);

export const loginSchema = z.object({
  account: loginIdentifierSchema,
  password: loginPasswordSchema,
  fcmTokens: fcmTokensSchema.optional().default([]),
  rememberMe: z.boolean().optional().default(false),
});

export type LoginInput = z.infer<typeof loginSchema>;
