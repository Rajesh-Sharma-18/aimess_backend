import { z } from "zod";

/** POST /streams body — go-live request. */
export const createStreamSchema = z.object({
  communityId: z.string().min(1),
  title: z.string().min(1).max(256),
  description: z.string().max(1000).optional(),
  thumbnail: z.string().url().optional(),
  sourceType: z
    .enum(["PHONE_CAMERA", "OBS_RTMP", "URL", "YOUTUBE"])
    .default("PHONE_CAMERA"),
  sourceUrl: z.string().min(1).optional(),
});

/** GET /streams query — filterable, cursor-paginated list. */
export const listStreamsQuerySchema = z.object({
  communityId: z.string().min(1).optional(),
  status: z.enum(["PENDING", "LIVE", "ENDED", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

/** PATCH /streams/:id body — owner updates stream metadata. At least one field required. */
export const updateStreamSchema = z
  .object({
    title: z.string().min(1).max(256).optional(),
    description: z.string().max(1000).optional(),
    thumbnail: z.string().url().optional(),
  })
  .refine(
    (d) => Object.values(d).some((v) => v !== undefined),
    "At least one field is required"
  );

/** GET /streams/:id/comments query — newest-first cursor page. */
export const commentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().min(1).optional(),
});

/** POST /streams/:id/ban body — owner bars a user from the stream. */
export const banUserSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

/** PATCH /streams/:id/comment-status body — owner enables/disables live chat. */
export const setCommentStatusSchema = z.object({
  enabled: z.boolean(),
});

/** POST /streams/:id/comments/:commentId/report body — user reports a comment. */
export const reportCommentSchema = z
  .object({
    reason: z.enum([
      "OFFENSIVE_LANGUAGE",
      "SPAM",
      "INAPPROPRIATE_CONTENT",
      "SCAM_OR_FRAUD",
      "IMPERSONATION",
      "OTHER",
    ]),
    details: z.string().max(500).optional(),
  })
  .refine(
    (d) => d.reason !== "OTHER" || (!!d.details && d.details.trim().length > 0),
    { message: "Details are required when reason is OTHER", path: ["details"] }
  );

/** GET /streams/:id/comments/reports query — newest-first cursor page. */
export const reportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().min(1).optional(),
});

export type CreateStreamInput = z.infer<typeof createStreamSchema>;
export type ListStreamsQuery = z.infer<typeof listStreamsQuerySchema>;
export type UpdateStreamInput = z.infer<typeof updateStreamSchema>;
export type CommentsQuery = z.infer<typeof commentsQuerySchema>;
export type BanUserInput = z.infer<typeof banUserSchema>;
export type SetCommentStatusInput = z.infer<typeof setCommentStatusSchema>;
export type ReportCommentInput = z.infer<typeof reportCommentSchema>;
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;
