import { z } from "zod";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email address");

export const requestChangeEmailSchema = z.object({
  oldEmail: emailSchema,
  newEmail: emailSchema,
});

export type RequestChangeEmailInput = z.infer<typeof requestChangeEmailSchema>;

export const verifyChangeEmailSchema = z.object({
  oldEmail: emailSchema,
  newEmail: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "OTP must be a 6-digit code"),
});

export type VerifyChangeEmailInput = z.infer<typeof verifyChangeEmailSchema>;
