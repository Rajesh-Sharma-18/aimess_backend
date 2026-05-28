import { z } from "zod";

export const accountSchema = z
  .string()
  .trim()
  // .toLowerCase()
  .min(3, "Account name must be at least 3 characters long")
  .max(32, "Account name cannot be longer than 32 characters")
  .regex(
    /^[-a-zA-Z0-9_]+$/,
    "Account name can only contain letters, numbers, and underscores"
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
 * When provided, the array must contain at least one non-empty token; clients
 * that cannot obtain a push token (permission denied, web, emulator) omit it.
 */
export const fcmTokensSchema = z
  .array(z.string().trim().min(1, "FCM token cannot be empty"))
  .min(1, "At least one FCM token is required")
  .optional();

export const registerSchema = z.object({
  account: accountSchema,
  password: passwordSchema,
  fcmTokens: fcmTokensSchema,
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

export const loginSchema = z.object({
  account: loginIdentifierSchema,
  password: passwordSchema,
  fcmTokens: fcmTokensSchema.optional().default([]),
});

export type LoginInput = z.infer<typeof loginSchema>;
