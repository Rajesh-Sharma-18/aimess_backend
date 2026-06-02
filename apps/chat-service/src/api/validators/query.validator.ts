import { z } from "zod";

/** Shared query-param schemas for message list + search endpoints. */

export const messageListQuerySchema = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const messageSearchQuerySchema = z.object({
  q: z.string().max(100).optional(),
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Query schema for the shared media/docs listing endpoints. */
export const mediaListQuerySchema = z.object({
  type: z
    .enum(["IMAGE", "VIDEO", "GIF", "VOICE", "DOCUMENT", "STICKER"])
    .optional(),
  cursor: z.string().nullish(),
  limit: z.coerce.number().min(1).max(100).default(30),
});

/**
 * Query schema for the offset-paginated "conversation" endpoint (group +
 * community). The client sends a 1-based pageNumber, a page limit, and an
 * optional `timestamp` (epoch milliseconds) used as the `createdAt <` boundary.
 */
export const conversationQuerySchema = z.object({
  pageNumber: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  timestamp: z.coerce.number().int().positive().optional(),
});
