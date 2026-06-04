import { z } from "zod";

/**
 * Zod schemas + inferred types for the Admin User Management API.
 *
 * Repeatable query enums (`status`): Express 5 yields a single string when the
 * param appears once and a string[] when repeated. We accept both and normalize
 * to an array — same pattern as moderation.validator.ts.
 */

// ---------------------------------------------------------------------------
// Enums.
// ---------------------------------------------------------------------------
export const userStatusEnum = z.enum([
  "ACTIVE",
  "SUSPENDED",
  "BANNED",
  "DELETED",
]);

/** Moderation reason vocabulary — subset of the report reportType values. */
export const moderationReasonEnum = z.enum([
  "SPAM",
  "HARASSMENT",
  "HATE_SPEECH",
  "NUDITY",
  "VIOLENCE",
  "IMPERSONATION",
  "MISINFORMATION",
  "ILLEGAL_CONTENT",
  "OTHER",
]);

export const reportsBucketEnum = z.enum(["none", "has", "gte_5", "gte_10"]);

/** Whitelisted sort fields + direction (always tiebroken on userId in repo). */
const SORT_FIELDS = [
  "joinedAt",
  "username",
  "email",
  "status",
  "reportCount",
] as const;
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")}):(asc|desc)$`);

/** Accept `?x=A` (single) or `?x=A&x=B` (repeated) → always an array. */
function repeatableEnum<T extends z.ZodEnum>(schema: T) {
  return z
    .union([schema, z.array(schema)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional();
}

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listUsersQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  status: repeatableEnum(userStatusEnum),
  reports: reportsBucketEnum.optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  sort: z
    .string()
    .regex(SORT_PATTERN, "sort must be <field>:<asc|desc> from the whitelist")
    .default("joinedAt:desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).optional(),
});
export type ListUsersQueryInput = z.infer<typeof listUsersQuerySchema>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const userIdParamSchema = z.object({
  userId: z.string().trim().min(1).max(64),
});
export type UserIdParam = z.infer<typeof userIdParamSchema>;

// ---------------------------------------------------------------------------
// Ban.
// ---------------------------------------------------------------------------
export const banUserSchema = z.object({
  reason: moderationReasonEnum,
  note: z.string().max(2000).optional(),
  // durationDays>0 turns a "ban" into a time-boxed suspend (see service docs).
  durationDays: z.number().int().positive().nullable().default(null),
  reportId: z.string().uuid().optional(),
  notifyUser: z.boolean().default(false),
  forceLogout: z.boolean().default(true),
});
export type BanUserInput = z.infer<typeof banUserSchema>;

// ---------------------------------------------------------------------------
// Suspend.
// ---------------------------------------------------------------------------
export const suspendUserSchema = z.object({
  reason: moderationReasonEnum,
  durationDays: z.number().int().positive(),
  note: z.string().max(2000).optional(),
  notifyUser: z.boolean().default(false),
});
export type SuspendUserInput = z.infer<typeof suspendUserSchema>;

// ---------------------------------------------------------------------------
// Unban.
// ---------------------------------------------------------------------------
export const unbanUserSchema = z.object({
  note: z.string().max(2000).optional(),
});
export type UnbanUserInput = z.infer<typeof unbanUserSchema>;

// ---------------------------------------------------------------------------
// Bulk.
// ---------------------------------------------------------------------------
const userIdsField = z.array(z.string().trim().min(1).max(64)).min(1).max(100);

export const bulkBanSchema = banUserSchema.extend({
  userIds: userIdsField,
});
export type BulkBanInput = z.infer<typeof bulkBanSchema>;

export const bulkActivateSchema = z.object({
  userIds: userIdsField,
  note: z.string().max(2000).optional(),
});
export type BulkActivateInput = z.infer<typeof bulkActivateSchema>;
