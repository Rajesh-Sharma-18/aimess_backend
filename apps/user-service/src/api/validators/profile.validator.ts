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

/**
 * `GET /users/:userId`. Every sibling route that takes a user id validates it
 * (see `unfriendParamsSchema`); this one did not, so any non-UUID string went
 * straight to Prisma and surfaced as a 500 plus `invalid input syntax for type
 * uuid` in the logs instead of a 400.
 *
 * `me` is allowed through as the documented self alias — the controller swaps
 * it for the caller's own id.
 */
export const publicProfileParamsSchema = z.object({
  userId: z.union([z.literal("me"), z.string().uuid("User ID is invalid")]),
});

export type PublicProfileParams = z.infer<typeof publicProfileParamsSchema>;

// The shared space a profile was opened from (a group or community member
// list). Only consulted for a platform-banned target, and only as a HINT: the
// service re-checks that viewer and target are both ACTIVE members of it, so
// naming a space the viewer does not share with the target opens nothing.
export const publicProfileQuerySchema = z.object({
  groupId: z.string().trim().min(1).max(64).optional(),
  communityId: z.string().trim().min(1).max(64).optional(),
});

export type PublicProfileQuery = z.infer<typeof publicProfileQuerySchema>;

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
