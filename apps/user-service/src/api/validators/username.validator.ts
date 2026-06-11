import { z } from "zod";

import { normalizeUsername } from "../../lib/username.util.js";

const usernameSchema = z
  .string()
  .trim()
  .transform((s) => normalizeUsername(s))
  .pipe(
    z
      .string()
      .min(3, "Username must be at least 3 characters")
      .max(32, "Username must be at most 32 characters")
      .regex(
        /^[a-z0-9_]+$/,
        "Username may only contain lowercase letters, numbers, and underscores"
      )
  );

export const generateUsernameSchema = z.object({
  account: z.string().trim().min(1).max(128),
});

export const validateUsernameSchema = z.object({
  username: usernameSchema,
});

export type GenerateUsernameInput = z.infer<typeof generateUsernameSchema>;
export type ValidateUsernameInput = z.infer<typeof validateUsernameSchema>;
