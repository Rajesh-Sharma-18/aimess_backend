import { z } from "zod";

export const deleteAccountSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  otp: z
    .string()
    .regex(/^\d{6}$/, "OTP must be a 6-digit code")
    .optional(),
});

export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
