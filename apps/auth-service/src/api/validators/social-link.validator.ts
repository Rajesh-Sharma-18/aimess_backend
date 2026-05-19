import { z } from "zod";

export const linkGoogleSchema = z.object({
  idToken: z.string().trim().min(1, "idToken is required"),
});

export type LinkGoogleInput = z.infer<typeof linkGoogleSchema>;

export const linkAppleSchema = z.object({
  identityToken: z.string().trim().min(1, "identityToken is required"),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address")
    .optional(),
  fullName: z.string().trim().max(120).optional(),
});

export type LinkAppleInput = z.infer<typeof linkAppleSchema>;

export const unlinkSocialSchema = z.object({
  provider: z.enum(["GOOGLE", "APPLE"]),
});

export type UnlinkSocialInput = z.infer<typeof unlinkSocialSchema>;
