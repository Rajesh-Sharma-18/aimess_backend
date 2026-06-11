import { z } from "zod";

import {
  isValidProfileDateOfBirth,
  PROFILE_GENDER_VALUES,
} from "../../lib/profile-fields.util.js";
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

const dateOfBirthSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "Date of birth must be in YYYY-MM-DD format (e.g. 1995-06-15)"
  )
  .refine(isValidProfileDateOfBirth, {
    message: "You must be at least 13 years old to use this app",
  });

const genderSchema = z.enum(PROFILE_GENDER_VALUES);

export const updateProfileSchema = z
  .object({
    firstName: z
      .string()
      .trim()
      .min(1, "First name is required")
      .max(50, "First name must be at most 50 characters")
      .optional(),
    lastName: z
      .string()
      .trim()
      .min(1, "Last name is required")
      .max(50, "Last name must be at most 50 characters")
      .optional(),
    username: usernameSchema.optional(),
    bio: z
      .string()
      .trim()
      .max(280, "Bio must be at most 280 characters")
      .nullable()
      .optional(),
    dateOfBirth: dateOfBirthSchema.optional(),
    gender: genderSchema.nullable().optional(),
    avatarObjectKey: z.string().trim().min(1).max(512).nullable().optional(),
  })
  .refine(
    (body) =>
      body.firstName !== undefined ||
      body.lastName !== undefined ||
      body.username !== undefined ||
      body.bio !== undefined ||
      body.dateOfBirth !== undefined ||
      body.gender !== undefined ||
      body.avatarObjectKey !== undefined,
    { message: "Please provide at least one field to update" }
  );

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
