import { z } from "zod";

import { fcmTokensSchema } from "./auth.validator.js";

export const googleLoginSchema = z.object({
  idToken: z.string().trim().min(1, "Google ID token is required"),
  fcmTokens: fcmTokensSchema,
});

export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

export const appleLoginSchema = z.object({
  identityToken: z.string().trim().min(1, "Apple identity token is required"),
  /** Apple only sends email on first authorization — pass it from the client when needed. */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address")
    .optional(),
  fullName: z.string().trim().min(1).max(100).optional(),
});

export type AppleLoginInput = z.infer<typeof appleLoginSchema>;
