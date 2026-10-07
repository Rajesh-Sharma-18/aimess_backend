import { z } from "zod";

import {
  countCharacters,
  TEXT_CUSTOM_STATUS_MAX_LENGTH,
  TEXT_CUSTOM_STATUS_MAX_RAW_LENGTH,
  TEXT_NAME_MAX_LENGTH,
  TEXT_NAME_MAX_RAW_LENGTH,
} from "@aimess/constants";

import {
  isValidProfileDateOfBirth,
  PROFILE_GENDER_VALUES,
} from "../../lib/profile-fields.util.js";
import { usernameSchema } from "./username.validator.js";

/**
 * First/last name: at most 30 CHARACTERS as the person sees them.
 *
 * `.max()` alone counts UTF-16 code units, which would hand a Thai or emoji
 * name half the field — so the cheap raw cap only keeps a pathological string
 * away from the segmenter, and the real limit is the grapheme count. Validated
 * AFTER `.trim()`, matching how the value is stored. Both messages are message
 * KEYS: `validateBody` renders them in the caller's locale.
 */
const personNameSchema = (requiredMessage: string, maxMessage: string) =>
  z
    .string()
    .trim()
    .min(1, requiredMessage)
    .max(TEXT_NAME_MAX_RAW_LENGTH, maxMessage)
    .refine((v) => countCharacters(v) <= TEXT_NAME_MAX_LENGTH, maxMessage);

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
    firstName: personNameSchema(
      "First name is required",
      "VALIDATION_FIRST_NAME_MAX_LENGTH"
    ).optional(),
    lastName: personNameSchema(
      "Last name is required",
      "VALIDATION_LAST_NAME_MAX_LENGTH"
    ).optional(),
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

export const CUSTOM_STATUS_MIN_DURATION_SECONDS = 60;
export const CUSTOM_STATUS_MAX_DURATION_SECONDS = 30 * 24 * 60 * 60;

// One grapheme that starts with a pictographic (covers VS16/ZWJ/skin-tone sequences) or is a flag pair.
const EMOJI_START = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})/u;
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/u;

const emptyToNull = (v: string | null | undefined) => (v ? v : null);

export const setCustomStatusSchema = z
  .object({
    emoji: z
      .string({ error: "USER_CUSTOM_STATUS_EMOJI_INVALID" })
      .trim()
      .max(32, "USER_CUSTOM_STATUS_EMOJI_INVALID")
      .refine(
        (v) => v === "" || (countCharacters(v) === 1 && EMOJI_START.test(v)),
        "USER_CUSTOM_STATUS_EMOJI_INVALID"
      )
      .nullish()
      .transform(emptyToNull),
    text: z
      .string({ error: "USER_CUSTOM_STATUS_TEXT_INVALID" })
      .trim()
      .max(TEXT_CUSTOM_STATUS_MAX_RAW_LENGTH, "USER_CUSTOM_STATUS_TEXT_TOO_LONG")
      .refine((v) => !CONTROL_CHARS.test(v), "USER_CUSTOM_STATUS_TEXT_INVALID")
      .refine(
        (v) => countCharacters(v) <= TEXT_CUSTOM_STATUS_MAX_LENGTH,
        "USER_CUSTOM_STATUS_TEXT_TOO_LONG"
      )
      .nullish()
      .transform(emptyToNull),
    durationSeconds: z
      .number({ error: "USER_CUSTOM_STATUS_DURATION_INVALID" })
      .int("USER_CUSTOM_STATUS_DURATION_INVALID")
      .min(CUSTOM_STATUS_MIN_DURATION_SECONDS, "USER_CUSTOM_STATUS_DURATION_INVALID")
      .max(CUSTOM_STATUS_MAX_DURATION_SECONDS, "USER_CUSTOM_STATUS_DURATION_INVALID"),
  })
  .refine((body) => body.emoji !== null || body.text !== null, {
    message: "USER_CUSTOM_STATUS_EMPTY",
  });

export type SetCustomStatusInput = z.infer<typeof setCustomStatusSchema>;
