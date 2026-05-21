import { z } from "zod";

import { normalizeUsername } from "../../lib/username.util.js";

const usernameSchema = z
  .string()
  .trim()
  .transform((s) => normalizeUsername(s))
  .pipe(
    z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z0-9_]+$/)
  );

export const generateUsernameSchema = z.object({
  account: z.string().trim().min(1).max(128),
});

export const validateUsernameSchema = z.object({
  username: usernameSchema,
});

export type GenerateUsernameInput = z.infer<typeof generateUsernameSchema>;
export type ValidateUsernameInput = z.infer<typeof validateUsernameSchema>;
