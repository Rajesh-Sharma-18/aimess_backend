import { z } from "zod";

import { passwordSchema } from "./auth.validator.js";

const emailSchema = z.string().trim().toLowerCase().email("Email is invalid");

export const requestPasswordResetOtpSchema = z.object({
  email: emailSchema,
});

export type RequestPasswordResetOtpInput = z.infer<
  typeof requestPasswordResetOtpSchema
>;

export const verifyPasswordResetOtpSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Verification code must be exactly 6 digits"),
});

export type VerifyPasswordResetOtpInput = z.infer<
  typeof verifyPasswordResetOtpSchema
>;

export const resetPasswordSchema = z.object({
  resetToken: z.string().trim().min(32, "Reset token is invalid"),
  password: passwordSchema,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
