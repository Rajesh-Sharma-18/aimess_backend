import { z } from "zod";

/**
 * Zod schemas + inferred types for the Livestream Management admin API.
 * Contract: docs/LIVESTREAM-MANAGEMENT-API-SPEC.md.
 *
 * Mirrors moderation.validator.ts. Query coercion + `z.iso.date()` date filters
 * match the reports slice so both slices behave identically.
 */

// ---------------------------------------------------------------------------
// Enums (reused across schemas).
// ---------------------------------------------------------------------------
export const livestreamStatusEnum = z.enum(["LIVE", "ENDED", "CANCELLED"]);

export const endReasonCodeEnum = z.enum([
  "POLICY_VIOLATION",
  "COMMUNITY_GUIDELINES",
  "SPAM",
  "HARASSMENT",
  "COPYRIGHT",
  "NUDITY",
  "VIOLENCE",
  "MANUAL_ADMIN",
]);

export const livestreamReportTypeEnum = z.enum([
  "HARASSMENT",
  "SPAM",
  "COPYRIGHT",
  "NUDITY",
  "VIOLENCE",
  "HATE_SPEECH",
  "OTHER",
]);

export const livestreamReportStatusEnum = z.enum([
  "OPEN",
  "REVIEWING",
  "RESOLVED",
  "DISMISSED",
]);

/** Subset of report statuses an admin may transition a report TO. */
export const reviewReportStatusEnum = z.enum([
  "REVIEWING",
  "RESOLVED",
  "DISMISSED",
]);

/** Whitelisted sort fields + direction (always tiebroken on livestreamId in repo). */
const SORT_FIELDS = [
  "createdAt",
  "viewerCount",
  "reportCount",
  "duration",
] as const;
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")}):(asc|desc)$`);

/** Reports list sorts on createdAt only. */
const REPORT_SORT_PATTERN = /^createdAt:(asc|desc)$/;

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listLivestreamsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  status: livestreamStatusEnum.optional(),
  hasReports: z.coerce.boolean().optional(),
  minReports: z.coerce.number().int().min(0).optional(),
  communityId: z.string().trim().min(1).optional(),
  creatorId: z.string().trim().min(1).optional(),
  sort: z
    .string()
    .regex(SORT_PATTERN, "Sort must be in the format field:asc or field:desc")
    .default("createdAt:desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
});
export type ListLivestreamsQueryInput = z.infer<
  typeof listLivestreamsQuerySchema
>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const livestreamIdParamSchema = z.object({
  // Lenient: real ids look like LS-2026-00001 but we don't hard-fail on shape.
  livestreamId: z.string().trim().min(1).max(64),
});
export type LivestreamIdParam = z.infer<typeof livestreamIdParamSchema>;

// ---------------------------------------------------------------------------
// End livestream.
// ---------------------------------------------------------------------------
export const endLivestreamSchema = z.object({
  reasonCode: endReasonCodeEnum,
  note: z.string().max(2000).optional(),
  notifyCreator: z.boolean().default(false),
  issueStrike: z.boolean().default(false),
  takedownRecording: z.boolean().default(false),
});
export type EndLivestreamInput = z.infer<typeof endLivestreamSchema>;

// ---------------------------------------------------------------------------
// Per-stream reports list query.
// ---------------------------------------------------------------------------
export const listLivestreamReportsQuerySchema = z.object({
  status: livestreamReportStatusEnum.optional(),
  reportType: livestreamReportTypeEnum.optional(),
  sort: z
    .string()
    .regex(
      REPORT_SORT_PATTERN,
      "Sort must be in the format createdAt:asc or createdAt:desc"
    )
    .default("createdAt:desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).optional(),
});
export type ListLivestreamReportsQueryInput = z.infer<
  typeof listLivestreamReportsQuerySchema
>;

// ---------------------------------------------------------------------------
// Review reports.
// ---------------------------------------------------------------------------
export const reviewReportsSchema = z.object({
  status: reviewReportStatusEnum,
  note: z.string().max(2000).optional(),
});
export type ReviewReportsInput = z.infer<typeof reviewReportsSchema>;

// ---------------------------------------------------------------------------
// Bulk.
// ---------------------------------------------------------------------------
const livestreamIdsField = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(100);
const reportIdsField = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(100);

export const bulkEndSchema = endLivestreamSchema.extend({
  livestreamIds: livestreamIdsField,
});
export type BulkEndInput = z.infer<typeof bulkEndSchema>;

export const bulkReviewReportsSchema = reviewReportsSchema.extend({
  reportIds: reportIdsField,
});
export type BulkReviewReportsInput = z.infer<typeof bulkReviewReportsSchema>;

// ---------------------------------------------------------------------------
// Thumbnail upload (two-step presign → confirm).
// ---------------------------------------------------------------------------
const THUMBNAIL_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

export const thumbnailPresignSchema = z.object({
  contentType: z.enum(THUMBNAIL_MIME),
  contentLength: z.coerce
    .number()
    .int()
    .min(1)
    .max(5 * 1024 * 1024),
});
export type ThumbnailPresignInput = z.infer<typeof thumbnailPresignSchema>;

export const thumbnailSaveSchema = z.object({
  objectKey: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((k) => k.startsWith("stream/thumbnail/") && !k.includes(".."), {
      message: "objectKey must be a stream/thumbnail/ key",
    }),
});
export type ThumbnailSaveInput = z.infer<typeof thumbnailSaveSchema>;
