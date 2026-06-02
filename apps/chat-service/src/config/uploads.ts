import { env } from "./env.js";

/**
 * Upload type registry — one entry per uploadable resource. Each entry defines
 * the target bucket, object-key prefix, max size, and the allowed MIME types
 * mapped to their file extension.
 */
export const UPLOAD_TYPES = {
  CHAT_ATTACHMENT: {
    bucket: env.MINIO_BUCKET,
    keyPrefix: "chat-uploads",
    // Presign uses the largest per-type cap (video) so video uploads succeed;
    // real per-type enforcement happens in the send validators / service guard.
    maxBytes: env.CHAT_VIDEO_MAX_BYTES,
    allowedMime: {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "audio/mpeg": "mp3",
      "audio/ogg": "ogg",
      "audio/wav": "wav",
      "application/pdf": "pdf",
      "application/msword": "doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "docx",
    },
  },
} as const;

export type UploadType = keyof typeof UPLOAD_TYPES;
