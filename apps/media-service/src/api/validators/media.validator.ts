import { z } from "zod/v4";

export const VALID_CATEGORIES = [
  "USER_AVATAR",
  "COMMUNITY_AVATAR",
  "COMMUNITY_COVER",
  "CHAT_ATTACHMENT",
  "COMMUNITY_CHAT_ATTACHMENT",
  "GROUP_AVATAR",
  "GROUP_CHAT_ATTACHMENT",
] as const;

export const uploadUrlSchema = z.object({
  category: z.enum(VALID_CATEGORIES),
  contentType: z.string().min(1).max(128),
  contentLength: z.coerce.number().int().positive(),
  ownerId: z.string().uuid().optional(),
  // Optional display metadata; sanitized server-side and checked against the
  // MIME-derived extension. The stored object key never uses this value.
  originalFileName: z.string().max(255).optional(),
});

export const downloadUrlSchema = z.object({
  objectKey: z.string().min(1).max(500),
  category: z.enum(VALID_CATEGORIES),
});

// Route params for DELETE /uploads/:objectKey?category=...
export const cancelUploadSchema = z.object({
  objectKey: z.string().min(1).max(500),
  category: z.enum(VALID_CATEGORIES),
});
