import { z } from "zod";

/**
 * Zod schemas + inferred types for the Reports & Moderation admin API.
 * Contract: docs/REPORTS-MODERATION-API-SPEC.md.
 *
 * Repeatable query enums (`reportType`, `status`): Express 5 yields a single
 * string when the param appears once and a string[] when repeated. We accept
 * both and normalize to an array.
 */

// ---------------------------------------------------------------------------
// Enums (reused across schemas).
// ---------------------------------------------------------------------------
export const reportTypeEnum = z.enum([
  "SPAM",
  "HARASSMENT",
  "HATE_SPEECH",
  "NUDITY",
  "VIOLENCE",
  "SELF_HARM",
  "IMPERSONATION",
  "MISINFORMATION",
  "ILLEGAL_CONTENT",
  "CSAM",
  "TERRORISM",
  "OTHER",
]);

export const targetTypeEnum = z.enum([
  "USER",
  "MESSAGE",
  "GROUP",
  "COMMUNITY",
  "POST",
  "COMMENT",
  "MEDIA",
]);

export const reportStatusEnum = z.enum([
  "PENDING",
  "UNDER_REVIEW",
  "RESOLVED",
  "DISMISSED",
  "ESCALATED",
]);

export const resolutionEnum = z.enum([
  "ACTION_TAKEN",
  "WARNING_ISSUED",
  "CONTENT_REMOVED",
]);

export const actionOnReportedUserEnum = z.enum([
  "NONE",
  "WARN",
  "CONTENT_REMOVE",
  "MUTE",
  "SUSPEND_7D",
  "SUSPEND_30D",
  "BAN",
]);

export const dismissReasonEnum = z.enum([
  "NO_VIOLATION",
  "INSUFFICIENT_EVIDENCE",
  "DUPLICATE",
  "FALSE_REPORT",
]);

/** Whitelisted sort fields + direction (always tiebroken on reportId in repo). */
const SORT_FIELDS = [
  "createdAt",
  "status",
  "reportType",
  "priority",
  "updatedAt",
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
export const listReportsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  reportType: repeatableEnum(reportTypeEnum),
  status: repeatableEnum(reportStatusEnum),
  targetType: targetTypeEnum.optional(),
  assignedTo: z.string().trim().min(1).optional(),
  sort: z
    .string()
    .regex(SORT_PATTERN, "sort must be <field>:<asc|desc> from the whitelist")
    .default("createdAt:desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
});
export type ListReportsQueryInput = z.infer<typeof listReportsQuerySchema>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const reportIdParamSchema = z.object({
  // Lenient: real ids look like RPT-2026-0000001 but we don't hard-fail on shape.
  reportId: z.string().trim().min(1).max(64),
});
export type ReportIdParam = z.infer<typeof reportIdParamSchema>;

// ---------------------------------------------------------------------------
// Resolve.
// ---------------------------------------------------------------------------
export const resolveReportSchema = z.object({
  resolution: resolutionEnum,
  actionOnReportedUser: actionOnReportedUserEnum.default("NONE"),
  note: z.string().max(2000).optional(),
  notifyReporter: z.boolean().default(false),
  notifyReportedUser: z.boolean().default(false),
});
export type ResolveReportInput = z.infer<typeof resolveReportSchema>;

// ---------------------------------------------------------------------------
// Dismiss.
// ---------------------------------------------------------------------------
export const dismissReportSchema = z.object({
  reason: dismissReasonEnum,
  note: z.string().max(2000).optional(),
  notifyReporter: z.boolean().default(false),
  flagFalseReport: z.boolean().default(false),
});
export type DismissReportInput = z.infer<typeof dismissReportSchema>;

// ---------------------------------------------------------------------------
// Bulk.
// ---------------------------------------------------------------------------
const reportIdsField = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(100);

export const bulkResolveSchema = resolveReportSchema.extend({
  reportIds: reportIdsField,
});
export type BulkResolveInput = z.infer<typeof bulkResolveSchema>;

export const bulkDismissSchema = dismissReportSchema.extend({
  reportIds: reportIdsField,
});
export type BulkDismissInput = z.infer<typeof bulkDismissSchema>;
