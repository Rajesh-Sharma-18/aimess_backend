import { z } from "zod";

/** POST /streams body — go-live request. */
export const createStreamSchema = z.object({
  communityId: z.string().min(1),
  title: z.string().min(1).max(256),
  description: z.string().max(1000).optional(),
  sourceType: z.enum(["PHONE_CAMERA", "URL"]).default("PHONE_CAMERA"),
  sourceUrl: z.string().min(1).optional(),
});

/** GET /streams query — filterable, cursor-paginated list. */
export const listStreamsQuerySchema = z.object({
  communityId: z.string().min(1).optional(),
  status: z.enum(["PENDING", "LIVE", "ENDED", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

/** GET /streams/:id/comments query — newest-first cursor page. */
export const commentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().min(1).optional(),
});

export type CreateStreamInput = z.infer<typeof createStreamSchema>;
export type ListStreamsQuery = z.infer<typeof listStreamsQuerySchema>;
export type CommentsQuery = z.infer<typeof commentsQuerySchema>;
