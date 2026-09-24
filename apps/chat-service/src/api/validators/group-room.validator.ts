import { z } from "zod";

import {
  countCharacters,
  TEXT_NAME_MAX_LENGTH,
  TEXT_NAME_MAX_RAW_LENGTH,
} from "@aimess/constants";

// Phase 1 group size: 1–256 members. Was 2..5000; the hard 256 ceiling is a
// product decision (parity with WhatsApp/Signal-scale groups), keeps member
// list, roster fan-out, and read-receipt joins on a bounded working set.
const GROUP_MEMBER_MIN = 1;
const GROUP_MEMBER_MAX = 256;

/**
 * Group name: at most 30 CHARACTERS as the person sees them (the shared
 * `TEXT_NAME_MAX_LENGTH`, was 100 code units). The raw cap only bounds what the
 * grapheme segmenter has to walk; the message is a message KEY that
 * `validateBody` renders in the caller's locale. Trimmed first, so the count
 * matches the value that is stored.
 */
const groupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TEXT_NAME_MAX_RAW_LENGTH, "VALIDATION_GROUP_NAME_MAX_LENGTH")
  .refine(
    (v) => countCharacters(v) <= TEXT_NAME_MAX_LENGTH,
    "VALIDATION_GROUP_NAME_MAX_LENGTH"
  );

export const createGroupSchema = z.object({
  name: groupNameSchema,
  description: z.string().max(1000).default(""),
  avatar: z.string().default(""),
  memberLimit: z
    .number()
    .int()
    .min(GROUP_MEMBER_MIN)
    .max(GROUP_MEMBER_MAX)
    .default(GROUP_MEMBER_MAX),
});

export const updateGroupSchema = z.object({
  name: groupNameSchema.optional(),
  description: z.string().max(1000).optional(),
  avatar: z.string().optional(),
  memberLimit: z
    .number()
    .int()
    .min(GROUP_MEMBER_MIN)
    .max(GROUP_MEMBER_MAX)
    .optional(),
});
