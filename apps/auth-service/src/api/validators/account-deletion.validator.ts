import { z } from "zod";

export const deleteAccountSchema = z.object({
  // Optional at the schema level: the service makes it mandatory only for
  // accounts that actually have a password (social-only accounts can skip it).
  password: z
    .string()
    .min(1, "Password is required to confirm account deletion")
    .optional(),
});

export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
