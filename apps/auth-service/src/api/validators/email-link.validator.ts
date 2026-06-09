import { z } from "zod";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Please enter a valid email address.");

export const requestLinkEmailOtpSchema = z.object({
  email: emailSchema,
});

export type RequestLinkEmailOtpInput = z.infer<
  typeof requestLinkEmailOtpSchema
>;

export const verifyLinkEmailOtpSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Verification code must be exactly 6 digits."),
});

export type VerifyLinkEmailOtpInput = z.infer<typeof verifyLinkEmailOtpSchema>;
