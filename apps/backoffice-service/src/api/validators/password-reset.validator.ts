import { z } from "zod";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email address");

/** Admin password policy: min 12 chars with upper + lower + digit + special. */
const adminPasswordSchema = z
  .string()
  .min(6, "Password must be at least 6 characters")
  .refine((v) => /[A-Z]/.test(v), {
    message: "Password must contain an uppercase letter",
  })
  .refine((v) => /[a-z]/.test(v), {
    message: "Password must contain a lowercase letter",
  })
  .refine((v) => /\d/.test(v), {
    message: "Password must contain a digit",
  })
  .refine((v) => /[^A-Za-z0-9]/.test(v), {
    message: "Password must contain a special character",
  });

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const verifyOtpSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "OTP must be a 6-digit code"),
});
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

export const resendOtpSchema = z.object({
  email: emailSchema,
});
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;

export const resetPasswordSchema = z
  .object({
    resetToken: z.string().trim().min(32, "Invalid reset token"),
    password: adminPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
