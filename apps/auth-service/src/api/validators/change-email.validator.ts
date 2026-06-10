import { z } from "zod";

const emailSchema = z.string().trim().toLowerCase().email("Email is invalid");

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
    .regex(/^\d{6}$/, "Verification code must be exactly 6 digits"),
});

export type VerifyChangeEmailInput = z.infer<typeof verifyChangeEmailSchema>;
