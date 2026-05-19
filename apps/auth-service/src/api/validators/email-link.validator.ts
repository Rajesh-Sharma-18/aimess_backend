import { z } from "zod";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email address");

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
    .regex(/^\d{6}$/, "OTP must be a 6-digit code"),
});

export type VerifyLinkEmailOtpInput = z.infer<typeof verifyLinkEmailOtpSchema>;
