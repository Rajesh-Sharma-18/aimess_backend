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
  "CANCELLED",
]);
export const announcementDeviceTypeEnum = z.enum([
  "ALL",
  "ANDROID",
  "IOS",
  "WEB",
]);
export const announcementTypeEnum = z.enum(["IMMEDIATE", "SCHEDULED"]);
export const announcementKindEnum = z.enum([
  "ANNOUNCEMENT",
  "MAINTENANCE",
  "UPDATE_REQUIRED",
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
    kind: announcementKindEnum.default("ANNOUNCEMENT"),
    deviceType: announcementDeviceTypeEnum.default("ALL"),
    // Optional for backward compatibility with the pre-existing contract, where
    // "scheduled" was expressed purely by sending a scheduledAt.
    announcementType: announcementTypeEnum.optional(),
    communityId: z.string().uuid().optional(),
    scheduledAt: z.iso.datetime().optional(),
  })
  .transform((v) => ({
    ...v,
    announcementType:
      v.announcementType ?? (v.scheduledAt ? "SCHEDULED" : "IMMEDIATE"),
  }))
  .refine((v) => v.target !== "COMMUNITY" || !!v.communityId, {
    message: "communityId is required when target is COMMUNITY",
    path: ["communityId"],
  })
  .refine((v) => v.target !== "ALL" || !v.communityId, {
    message: "communityId must not be set when target is ALL",
    path: ["communityId"],
  })
  .refine((v) => v.announcementType !== "SCHEDULED" || !!v.scheduledAt, {
    message: "scheduledAt is required when announcementType is SCHEDULED",
    path: ["scheduledAt"],
  })
  .refine(
    (v) => !v.scheduledAt || new Date(v.scheduledAt).getTime() > Date.now(),
    { message: "scheduledAt must be in the future", path: ["scheduledAt"] }
  )
  // An IMMEDIATE announcement ignores scheduledAt rather than 400ing on it, so
  // a client that leaves a stale picker value in the payload still sends now.
  .transform((v) =>
    v.announcementType === "IMMEDIATE" ? { ...v, scheduledAt: undefined } : v
  );
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

// ---------------------------------------------------------------------------
// Update (SCHEDULED announcements only).
//
// target/kind/communityId are intentionally NOT editable: the audience an
// announcement was created for is part of its identity, and changing it would
// make the create audit entry a lie.
// ---------------------------------------------------------------------------
export const updateAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5000),
    deviceType: announcementDeviceTypeEnum,
    scheduledAt: z.iso.datetime(),
  })
  .refine((v) => new Date(v.scheduledAt).getTime() > Date.now(), {
    message: "scheduledAt must be in the future",
    path: ["scheduledAt"],
  });
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listAnnouncementsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  target: announcementTargetEnum.optional(),
  status: repeatableEnum(announcementStatusEnum),
  deviceType: announcementDeviceTypeEnum.optional(),
  sort: z
    .string()
    .regex(SORT_PATTERN, "Sort must be in the format field:asc or field:desc")
    .default("createdAt:desc"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
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
