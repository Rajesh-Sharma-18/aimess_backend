import { z } from "zod";

import { fcmTokensSchema } from "./auth.validator.js";

export const googleLoginSchema = z.object({
  idToken: z.string().trim().min(1, "Google ID token is required"),
  fcmTokens: fcmTokensSchema.optional().default([]),
});

export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

/**
 * Apple returns the name ONLY in the first authorization response, as the
 * structured `PersonNameComponents` (`givenName` / `familyName`). Accept that
 * object as well as the legacy joined string so older clients keep working —
 * both shapes normalize to the same (firstName, lastName) pair.
 *
 * Every part is nullish-tolerant: Apple sends explicit `null`s on every login
 * after the first, and those must parse fine and then be IGNORED, not written.
 */
const appleFullNameSchema = z.union([
  z.string().trim().min(1).max(100),
  z.object({
    givenName: z.string().trim().max(50).nullish(),
    familyName: z.string().trim().max(50).nullish(),
  }),
]);

export const appleLoginSchema = z.object({
  identityToken: z.string().trim().min(1, "Apple identity token is required"),
  /**
   * Accepted for backward compatibility with existing clients that still send
   * it, and then IGNORED. The account email comes only from the signed Apple
   * identity token — a client-supplied address here was an account
   * pre-hijacking primitive (see the note in `social-auth.service.ts`). Kept in
   * the schema rather than rejected so shipped apps do not start failing
   * validation on a field the server simply no longer reads.
   */
  email: z.string().trim().toLowerCase().email("Email is invalid").optional(),
  fullName: appleFullNameSchema.nullish(),
  fcmTokens: fcmTokensSchema.optional().default([]),
});

export type AppleLoginInput = z.infer<typeof appleLoginSchema>;
