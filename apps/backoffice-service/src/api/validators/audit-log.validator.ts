import { z } from "zod";

/**
 * Zod schemas + inferred types for the Audit Logs admin API (read-only).
 * Mirrors the pattern in announcement.validator.ts (repeatable enum, whitelisted
 * sort, offset pagination, whole-day date range).
 */

/** Accept `?x=A` (single) or `?x=A&x=B` (repeated) → always an array. */
function repeatableString<T extends z.ZodTypeAny>(schema: T) {
  return z
    .union([schema, z.array(schema)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional();
}

/** "Sort by latest" is the default; action is also whitelisted. */
const SORT_FIELDS = ["createdAt", "action"] as const;
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")}):(asc|desc)$`);

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listAuditLogsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  // Action names are free-form domain strings (e.g. "user.banned"); filter by
  // one or many. Bound the length so a rogue query can't blow up the IN clause.
  action: repeatableString(z.string().trim().min(1).max(100)),
  sort: z
    .string()
    .regex(SORT_PATTERN, "Sort must be in the format field:asc or field:desc")
    .default("createdAt:desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
});
export type ListAuditLogsQueryInput = z.infer<typeof listAuditLogsQuerySchema>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const auditLogIdParamSchema = z.object({
  auditLogId: z.string().uuid(),
});
export type AuditLogIdParam = z.infer<typeof auditLogIdParamSchema>;
