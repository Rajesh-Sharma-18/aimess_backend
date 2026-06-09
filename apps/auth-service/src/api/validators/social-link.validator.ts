import { z } from "zod";

export const linkGoogleSchema = z.object({
  idToken: z.string().trim().min(1, "Google ID token is required."),
});

export type LinkGoogleInput = z.infer<typeof linkGoogleSchema>;

export const linkAppleSchema = z.object({
  identityToken: z.string().trim().min(1, "Apple identity token is required."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Please enter a valid email address.")
    .optional(),
  fullName: z.string().trim().max(100).optional(),
});

export type LinkAppleInput = z.infer<typeof linkAppleSchema>;

export const unlinkSocialSchema = z.object({
  provider: z.enum(["GOOGLE", "APPLE"]),
});

export type UnlinkSocialInput = z.infer<typeof unlinkSocialSchema>;
