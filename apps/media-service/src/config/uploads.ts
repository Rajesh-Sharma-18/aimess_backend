import type { UploadTypeDef } from "@aimess/storage";

import { env } from "./env.js";

export type MediaCategoryKey =
  | "USER_AVATAR"
  | "COMMUNITY_AVATAR"
  | "COMMUNITY_COVER"
  | "CHAT_ATTACHMENT"
  | "COMMUNITY_CHAT_ATTACHMENT"
  | "GROUP_AVATAR"
  | "GROUP_CHAT_ATTACHMENT";

const MB = 1024 * 1024;

/**
 * Allowed chat-attachment MIME types → file extension. Telegram-parity set:
 * images, animated GIF, the common video and audio containers, voice-note
 * codecs, and office/text documents. HEIC and archives/source-code are
 * intentionally excluded for Phase 1 (HEIC needs a server transcode to render in
 * browsers; archives/code need deep AV) — see docs/MEDIA_ARCHITECTURE_REVIEW.md.
 */
const CHAT_MIME = {
  // Images
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  // Video
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
  "video/x-msvideo": "avi",
  "video/x-m4v": "m4v",
  // Audio + voice notes (ogg-opus / m4a / aac / flac)
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  // Documents (office + text/data)
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
} as const;

/**
 * Per-MIME byte caps for chat attachments. Images/GIFs are capped well below the
 * 100 MB category ceiling so an oversize "image" cannot be uploaded; video,
 * audio and documents fall back to the category `maxBytes`. MIMEs absent here
 * use the category ceiling.
 */
const CHAT_MAX_BYTES_BY_MIME: Record<string, number> = {
  "image/jpeg": 25 * MB,
  "image/png": 25 * MB,
  "image/webp": 25 * MB,
  "image/gif": 30 * MB,
};

/** Avatars / covers are images only. */
const AVATAR_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export const UPLOAD_CATEGORIES: Record<MediaCategoryKey, UploadTypeDef> = {
  USER_AVATAR: {
    bucket: env.MINIO_BUCKET_AVATARS,
    keyPrefix: "avatars",
    maxBytes: env.AVATAR_MAX_UPLOAD_BYTES,
    allowedMime: AVATAR_MIME,
  },
  COMMUNITY_AVATAR: {
    bucket: env.MINIO_BUCKET_COMMUNITY,
    keyPrefix: "community/avatar",
    maxBytes: env.COMMUNITY_IMAGE_MAX_UPLOAD_BYTES,
    allowedMime: AVATAR_MIME,
  },
  COMMUNITY_COVER: {
    bucket: env.MINIO_BUCKET_COMMUNITY,
    keyPrefix: "community/cover",
    maxBytes: env.COMMUNITY_IMAGE_MAX_UPLOAD_BYTES,
    allowedMime: AVATAR_MIME,
  },
  CHAT_ATTACHMENT: {
    bucket: env.MINIO_BUCKET,
    keyPrefix: "chat-uploads",
    maxBytes: env.CHAT_VIDEO_MAX_BYTES,
    allowedMime: CHAT_MIME,
    maxBytesByMime: CHAT_MAX_BYTES_BY_MIME,
  },
  COMMUNITY_CHAT_ATTACHMENT: {
    bucket: env.MINIO_BUCKET,
    keyPrefix: "community-chat-uploads",
    maxBytes: env.COMMUNITY_CHAT_MAX_BYTES,
    allowedMime: CHAT_MIME,
    maxBytesByMime: CHAT_MAX_BYTES_BY_MIME,
  },
  GROUP_AVATAR: {
    bucket: env.MINIO_BUCKET_AVATARS,
    keyPrefix: "group-avatars",
    maxBytes: env.AVATAR_MAX_UPLOAD_BYTES,
    allowedMime: AVATAR_MIME,
  },
  GROUP_CHAT_ATTACHMENT: {
    bucket: env.MINIO_BUCKET,
    keyPrefix: "group-chat-uploads",
    maxBytes: env.GROUP_CHAT_MAX_BYTES,
    allowedMime: CHAT_MIME,
    maxBytesByMime: CHAT_MAX_BYTES_BY_MIME,
  },
};

/**
 * Extensions safe to render inline in a browser (the media kinds). Any other
 * stored object (documents, text, data) is served as a forced download so an
 * uploaded HTML/SVG/XML payload can never execute inline from our origin.
 *
 * DERIVED from CHAT_MIME (image/video/audio only) so a future codec added to the
 * allow-list can't silently become download-only — or, worse, a future document
 * type slip through as inline — by forgetting to update a second hand-kept list.
 */
const INLINE_RENDER_EXTS = new Set<string>(
  Object.entries(CHAT_MIME)
    .filter(
      ([mime]) =>
        mime.startsWith("image/") ||
        mime.startsWith("video/") ||
        mime.startsWith("audio/")
    )
    .map(([, ext]) => ext)
);

/**
 * Content-Disposition for a download of `objectKey`, decided by its extension:
 * `undefined` (inline) for media kinds, `"attachment"` (forced download) for
 * everything else. Applied on the explicit download-url endpoint; the inline
 * resolve-on-read render path and `X-Content-Type-Options: nosniff` are deferred
 * to the CDN/proxy phase (see docs/MEDIA_ARCHITECTURE_REVIEW.md §9).
 */
export function dispositionForKey(objectKey: string): string | undefined {
  const ext = objectKey.split(".").pop()?.toLowerCase() ?? "";
  return INLINE_RENDER_EXTS.has(ext) ? undefined : "attachment";
}
