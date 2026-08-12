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

/**
 * Categories whose download authorization is membership-based. For these the
 * registry's `resourceId` is the ONLY thing that can answer "may this user
 * fetch this file" — the object key carries the uploader's id, not the room's
 * — so an upload that omits it produces a file nothing can authorize later.
 */
export const MEMBERSHIP_SCOPED_CATEGORIES = new Set<string>([
  "CHAT_ATTACHMENT",
  "COMMUNITY_CHAT_ATTACHMENT",
  "GROUP_CHAT_ATTACHMENT",
]);

export const uploadUrlSchema = z
  .object({
    category: z.enum(VALID_CATEGORIES),
    contentType: z.string().min(1).max(128),
    contentLength: z.coerce.number().int().positive(),
    // The entity the file belongs to (roomId / groupId / communityId for chat
    // categories). Recorded in the media registry so downloads can be authorized
    // against membership of that resource. Optional for public avatars/covers,
    // REQUIRED for the chat categories (see below).
    resourceId: z.string().min(1).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    // Chat attachments used to accept a missing resourceId and store null.
    // The download guard then had nothing to check membership against and fell
    // back to a prefix-only check that let ANY authenticated user fetch the
    // object. Requiring it here is what makes the download side able to fail
    // closed without breaking well-formed uploads.
    if (MEMBERSHIP_SCOPED_CATEGORIES.has(v.category) && !v.resourceId) {
      ctx.addIssue({
        code: "custom",
        path: ["resourceId"],
        message: "resourceId is required for chat attachment uploads",
      });
    }
  });

export const downloadUrlSchema = z.object({
  // Normally an internal storage key; also accepts an external http(s) URL
  // (e.g. a Giphy/Tenor GIF/sticker a client forwards as objectKey) — the
  // service passes that straight through as the downloadUrl instead of
  // trying to sign it. See media.service.ts#generateDownloadUrl.
  objectKey: z.string().min(1).max(2000),
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
