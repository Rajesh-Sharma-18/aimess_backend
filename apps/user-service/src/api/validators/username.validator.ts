import { z } from "zod";

import { TEXT_NAME_MAX_LENGTH } from "@aimess/constants";

import { normalizeUsername } from "../../lib/username.util.js";

/**
 * The ONE username rule, exported because `profile.validator` held a
 * byte-identical copy — the pair had to be edited together to stay in step, and
 * a limit that lives in two places is how "registration validates 30 but
 * profile edit allows 50" happens. Trim + lowercase first, then floor, ceiling
 * and charset; only the ceiling changed (32 -> 30).
 */
export const usernameSchema = z
  .string()
  .trim()
  .transform((s) => normalizeUsername(s))
  .pipe(
    z
      .string()
      .min(3, "Username must be at least 3 characters")
      .max(TEXT_NAME_MAX_LENGTH, "VALIDATION_USERNAME_MAX_LENGTH")
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

export const validateUsernameQuerySchema = z.object({
  username: usernameSchema,
});

export type GenerateUsernameInput = z.infer<typeof generateUsernameSchema>;
export type ValidateUsernameInput = z.infer<typeof validateUsernameSchema>;
export type ValidateUsernameQuery = z.infer<typeof validateUsernameQuerySchema>;
