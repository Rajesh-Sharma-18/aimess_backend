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
  // The entity the file belongs to (roomId / groupId / communityId for chat
  // categories). Recorded in the media registry so downloads can be authorized
  // against membership of that resource. Optional for public avatars/covers.
  resourceId: z.string().min(1).max(200).optional(),
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

/**
 * POST /media/confirm — called by the client after it has PUT the file to
 * MinIO. Triggers magic-byte validation, ZIP inspection, and AV scan.
 */
export const confirmUploadSchema = z.object({
  objectKey: z.string().min(1).max(500),
  category: z.enum(VALID_CATEGORIES),
  /** MIME type declared at upload-url time — must match what the client PUT. */
  contentType: z.string().min(1).max(128),
});

/** GET /media/scan-status?objectKey=...&category=... — poll async scan status. */
export const scanStatusQuerySchema = z.object({
  objectKey: z.string().min(1).max(500),
  category: z.enum(VALID_CATEGORIES),
});
