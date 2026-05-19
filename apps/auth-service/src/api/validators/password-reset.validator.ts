import { z } from "zod";

import { passwordSchema } from "./auth.validator.js";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email address");

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
    .regex(/^\d{6}$/, "OTP must be a 6-digit code"),
});

export type VerifyPasswordResetOtpInput = z.infer<
  typeof verifyPasswordResetOtpSchema
>;

export const resetPasswordSchema = z.object({
  resetToken: z.string().trim().min(32, "Invalid reset token"),
  password: passwordSchema,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
