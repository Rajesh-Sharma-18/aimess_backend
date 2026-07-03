import { z } from "zod";

/**
 * Zod schemas + inferred types for the Announcements admin API.
 * Mirrors the pattern in moderation.validator.ts (repeatable enums, whitelisted
 * sort, offset pagination).
 */

export const announcementTargetEnum = z.enum(["ALL", "COMMUNITY"]);
export const announcementStatusEnum = z.enum([
  "SCHEDULED",
  "PROCESSING",
  "SENT",
  "FAILED",
]);

/** Accept `?x=A` (single) or `?x=A&x=B` (repeated) → always an array. */
function repeatableEnum<T extends z.ZodEnum>(schema: T) {
  return z
    .union([schema, z.array(schema)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional();
}

const SORT_FIELDS = ["createdAt", "scheduledAt", "sentAt", "title"] as const;
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")}):(asc|desc)$`);

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------
export const createAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5000),
    target: announcementTargetEnum,
    communityId: z.string().uuid().optional(),
    scheduledAt: z.iso.datetime().optional(),
  })
  .refine((v) => v.target !== "COMMUNITY" || !!v.communityId, {
    message: "communityId is required when target is COMMUNITY",
    path: ["communityId"],
  })
  .refine((v) => v.target !== "ALL" || !v.communityId, {
    message: "communityId must not be set when target is ALL",
    path: ["communityId"],
  })
  .refine(
    (v) => !v.scheduledAt || new Date(v.scheduledAt).getTime() > Date.now(),
    { message: "scheduledAt must be in the future", path: ["scheduledAt"] }
  );
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listAnnouncementsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  target: announcementTargetEnum.optional(),
  status: repeatableEnum(announcementStatusEnum),
  sort: z
    .string()
    .regex(SORT_PATTERN, "Sort must be in the format field:asc or field:desc")
    .default("createdAt:desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
});
export type ListAnnouncementsQueryInput = z.infer<
  typeof listAnnouncementsQuerySchema
>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const announcementIdParamSchema = z.object({
  announcementId: z.string().uuid(),
});
export type AnnouncementIdParam = z.infer<typeof announcementIdParamSchema>;
