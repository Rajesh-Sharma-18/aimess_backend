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
/**
 * Filterable user statuses surfaced by the admin panel's "Select Status"
 * dropdown. The platform's internal account model also has a SUSPENDED state
 * (produced by the ban-with-duration / suspend flows), but it is intentionally
 * NOT a list filter option — the panel exposes only these three.
 */
export const userStatusEnum = z.enum(["ACTIVE", "BANNED", "DELETED"]);

/**
 * Tolerant status filter. The admin panel's "Select Status" dropdown sends the
 * value with inconsistent casing (`active` vs `ACTIVE`) and uses
 * `pending_deletion` for the deleted bucket. Normalize case + that alias before
 * the enum check, and accept a single value or a repeated `?status=A&status=B`
 * list → always a string[]. Without this, a lowercase value 400s the whole
 * request and the list comes back empty, which reads as "the filter is broken".
 */
const STATUS_ALIASES: Record<string, z.infer<typeof userStatusEnum>> = {
  ACTIVE: "ACTIVE",
  BANNED: "BANNED",
  DELETED: "DELETED",
  PENDING_DELETION: "DELETED",
};

const userStatusFilter = z
  .preprocess((v) => {
    if (v == null) return undefined;
    const arr = Array.isArray(v) ? v : [v];
    return arr.map((s) => {
      if (typeof s !== "string") return s;
      const norm = s.trim().toUpperCase();
      return STATUS_ALIASES[norm] ?? norm;
    });
  }, z.array(userStatusEnum).optional())
  .optional();

/**
 * A calendar day accepted as `YYYY-MM-DD` OR a full ISO datetime (the date
 * picker may emit either), normalized to `YYYY-MM-DD` since the repository
 * builds the day-boundary range from it (`${date}T00:00:00.000Z`).
 */
const dateOnly = z
  .string()
  .trim()
  .transform((s, ctx) => {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
    const day = m?.[1];
    if (!day || Number.isNaN(new Date(`${day}T00:00:00.000Z`).getTime())) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid date (expected YYYY-MM-DD or an ISO datetime)",
      });
      return z.NEVER;
    }
    return day;
  })
  .optional();

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

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listUsersQuerySchema = z
  .object({
    // `q` is the public search param (case-insensitive partial match over
    // username + email). `search` is kept as a backward-compatible alias.
    q: z.string().trim().min(1).optional(),
    search: z.string().trim().min(1).optional(),
    status: userStatusFilter,
    reports: reportsBucketEnum.optional(),
    dateFrom: dateOnly,
    dateTo: dateOnly,
    // `createdAfter` / `createdBefore` are accepted as aliases for the date
    // range (the OpenAPI contract + some panel builds use these names).
    createdAfter: dateOnly,
    createdBefore: dateOnly,
    sort: z
      .string()
      .regex(SORT_PATTERN, "sort must be <field>:<asc|desc> from the whitelist")
      .default("joinedAt:desc"),
    // `order` is a direction-only alias that overrides the sort direction
    // (e.g. `?sort=username:asc&order=desc` → username:desc).
    order: z.enum(["asc", "desc"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().trim().min(1).optional(),
  })
  // Normalize the public params (`q`, `order`, `createdAfter`/`createdBefore`)
  // onto the canonical fields the service/repository consume (`search`, `sort`,
  // `dateFrom`/`dateTo`) so downstream code is unchanged.
  .transform(({ q, order, createdAfter, createdBefore, ...rest }) => ({
    ...rest,
    search: q ?? rest.search,
    dateFrom: rest.dateFrom ?? createdAfter,
    dateTo: rest.dateTo ?? createdBefore,
    sort: order ? rest.sort.replace(/:(asc|desc)$/, `:${order}`) : rest.sort,
  }));
export type ListUsersQueryInput = z.infer<typeof listUsersQuerySchema>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const userIdParamSchema = z.object({
  userId: z.string().trim().min(1).max(64),
});
export type UserIdParam = z.infer<typeof userIdParamSchema>;

// ---------------------------------------------------------------------------
// Reported-details list query (GET /users/:userId/reports).
// ---------------------------------------------------------------------------
export const userReportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type UserReportsQueryInput = z.infer<typeof userReportsQuerySchema>;

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
