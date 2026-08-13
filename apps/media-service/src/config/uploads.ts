import type { UploadTypeDef } from "@aimess/storage";

import { env } from "./env.js";

export type MediaCategoryKey =
  | "USER_AVATAR"
  | "COMMUNITY_AVATAR"
  | "COMMUNITY_COVER"
  | "CHAT_ATTACHMENT"
  | "COMMUNITY_CHAT_ATTACHMENT"
  | "GROUP_AVATAR"
  | "GROUP_CHAT_ATTACHMENT"
  | "LIVESTREAM_THUMBNAIL";

const MB = 1024 * 1024;

/**
 * Allowed chat-attachment MIME types → file extension. Telegram-parity set:
 * images, animated GIF, the common video and audio containers, voice-note
 * codecs, office/text documents, and ZIP archives. HEIC needs a server
 * transcode to render in browsers and is excluded. All document and archive
 * types require a post-upload /confirm pass (magic-byte + AV scan) before
 * they become downloadable — see docs/MEDIA_ARCHITECTURE_REVIEW.md.
 */
const CHAT_MIME = {
  // Images
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  // HEIC/HEIF — what an iPhone produces by default. Previously excluded with
  // the note "needs a server transcode to render in browsers"; that is a
  // RENDERING concern, and excluding the MIME did not keep the bytes out — a
  // HEIC declared as video/mp4 passed the old `????ftyp` signature rule, because
  // HEIC and MP4 share the ISO base media container. Accepting it explicitly and
  // validating it by BRAND (see magic-bytes.ts `isobmffMime`) is what actually
  // separates the two. Clients that cannot render HEIC should request a
  // client-side conversion; the pipeline no longer pretends the format is absent.
  "image/heic": "heic",
  "image/heif": "heif",
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
  // Archives — require magic-byte + AV scan before download is allowed
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
} as const;

/**
 * Per-MIME byte caps for chat attachments. Each value is the hard maximum
 * enforced at upload-url time (Content-Length check). The effective limit is
 * min(category.maxBytes, this[mime]) so a high category ceiling cannot be
 * exploited for smaller media types. MIMEs absent here use the category
 * ceiling.
 *
 * Image/audio/document values come from `env.CHAT_IMAGE_MAX_BYTES` /
 * `env.CHAT_AUDIO_MAX_BYTES` / `env.CHAT_DOCUMENT_MAX_BYTES` — the SAME env
 * vars (same names, same defaults) chat-service reads for its message-send-
 * time guard (apps/chat-service/src/constants/media-limits.ts), so the two
 * independent enforcement points can never silently drift apart. Video has no
 * entry here — it already shares `env.CHAT_VIDEO_MAX_BYTES` with the category
 * ceiling below, which chat-service also reads verbatim.
 */
const CHAT_MAX_BYTES_BY_MIME: Record<string, number> = {
  // Images
  "image/jpeg": env.CHAT_IMAGE_MAX_BYTES,
  "image/png": env.CHAT_IMAGE_MAX_BYTES,
  "image/webp": env.CHAT_IMAGE_MAX_BYTES,
  "image/heic": env.CHAT_IMAGE_MAX_BYTES,
  "image/heif": env.CHAT_IMAGE_MAX_BYTES,
  "image/gif": 30 * MB,
  // Audio + voice notes
  "audio/mpeg": env.CHAT_AUDIO_MAX_BYTES,
  "audio/ogg": env.CHAT_AUDIO_MAX_BYTES,
  "audio/wav": env.CHAT_AUDIO_MAX_BYTES,
  "audio/mp4": env.CHAT_AUDIO_MAX_BYTES,
  "audio/x-m4a": env.CHAT_AUDIO_MAX_BYTES,
  "audio/aac": env.CHAT_AUDIO_MAX_BYTES,
  "audio/flac": env.CHAT_AUDIO_MAX_BYTES,
  // Documents — legacy + modern (OOXML) Office formats
  "application/msword": env.CHAT_DOCUMENT_MAX_BYTES,
  "application/vnd.ms-excel": env.CHAT_DOCUMENT_MAX_BYTES,
  "application/vnd.ms-powerpoint": env.CHAT_DOCUMENT_MAX_BYTES,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    env.CHAT_DOCUMENT_MAX_BYTES,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    env.CHAT_DOCUMENT_MAX_BYTES,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    env.CHAT_DOCUMENT_MAX_BYTES,
  // Text/data documents
  "application/pdf": env.CHAT_DOCUMENT_MAX_BYTES,
  "text/plain": env.CHAT_DOCUMENT_MAX_BYTES,
  "text/csv": env.CHAT_DOCUMENT_MAX_BYTES,
  "application/json": env.CHAT_DOCUMENT_MAX_BYTES,
  "application/xml": env.CHAT_DOCUMENT_MAX_BYTES,
  "text/xml": env.CHAT_DOCUMENT_MAX_BYTES,
  // Archives
  "application/zip": env.CHAT_DOCUMENT_MAX_BYTES,
  "application/x-zip-compressed": env.CHAT_DOCUMENT_MAX_BYTES,
};

/** Avatars / covers are images only. */
const AVATAR_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
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
  /**
   * Livestream thumbnails, uploaded by moderators through backoffice-service.
   *
   * backoffice mints its own presigned PUT (same `createUploadUrl` helper, same
   * `STREAM_THUMBNAIL_UPLOAD_DEF` shape) but its "confirm" step was a bare
   * string check — `startsWith("stream/thumbnail/") && !includes("..")` — with no
   * HEAD, no magic bytes, no structural inspection and no AV scan, and the
   * prefix was absent from this table, so media-service could not address the
   * object at all: not to confirm it, not to scan it, not to delete it.
   * Registering the prefix here is what lets that path converge on this pipeline
   * instead of remaining a second, weaker one.
   */
  LIVESTREAM_THUMBNAIL: {
    bucket: env.MINIO_BUCKET_STREAM,
    keyPrefix: "stream/thumbnail",
    maxBytes: env.STREAM_THUMBNAIL_MAX_BYTES,
    allowedMime: AVATAR_MIME,
  },
};

/**
 * Resolve the upload category from a stored object key by matching its prefix.
 * The object key is the ground truth for where a file physically lives (bucket +
 * keyPrefix), so storage operations should trust it over a client-supplied
 * category that may disagree — e.g. a `community-chat-uploads/…` key sent with
 * `category: "CHAT_ATTACHMENT"`. The category prefixes are mutually exclusive
 * (none is a path-segment prefix of another), so at most one matches. Returns
 * null when no known prefix matches (caller falls back to the client category).
 */
export function resolveCategoryFromObjectKey(
  objectKey: string
): MediaCategoryKey | null {
  for (const key of Object.keys(UPLOAD_CATEGORIES) as MediaCategoryKey[]) {
    if (objectKey.startsWith(`${UPLOAD_CATEGORIES[key].keyPrefix}/`)) {
      return key;
    }
  }
  return null;
}

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
