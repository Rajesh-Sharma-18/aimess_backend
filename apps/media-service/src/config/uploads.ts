import { env } from "./env.js";

export type MediaCategoryKey =
  | "USER_AVATAR"
  | "COMMUNITY_AVATAR"
  | "COMMUNITY_COVER"
  | "CHAT_ATTACHMENT"
  | "COMMUNITY_CHAT_ATTACHMENT"
  | "GROUP_AVATAR"
  | "GROUP_CHAT_ATTACHMENT";

const CHAT_MIME = {
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
} as const;

export const UPLOAD_CATEGORIES: Record<
  MediaCategoryKey,
  {
    bucket: string;
    keyPrefix: string;
    maxBytes: number;
    allowedMime: Record<string, string>;
  }
> = {
  USER_AVATAR: {
    bucket: env.MINIO_BUCKET_AVATARS,
    keyPrefix: "avatars",
    maxBytes: env.AVATAR_MAX_UPLOAD_BYTES,
    allowedMime: {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    },
  },
  COMMUNITY_AVATAR: {
    bucket: env.MINIO_BUCKET_COMMUNITY,
    keyPrefix: "community/avatar",
    maxBytes: env.COMMUNITY_IMAGE_MAX_UPLOAD_BYTES,
    allowedMime: {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    },
  },
  COMMUNITY_COVER: {
    bucket: env.MINIO_BUCKET_COMMUNITY,
    keyPrefix: "community/cover",
    maxBytes: env.COMMUNITY_IMAGE_MAX_UPLOAD_BYTES,
    allowedMime: {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    },
  },
  CHAT_ATTACHMENT: {
    bucket: env.MINIO_BUCKET,
    keyPrefix: "chat-uploads",
    maxBytes: env.CHAT_VIDEO_MAX_BYTES,
    allowedMime: CHAT_MIME,
  },
  COMMUNITY_CHAT_ATTACHMENT: {
    bucket: env.MINIO_BUCKET,
    keyPrefix: "community-chat-uploads",
    maxBytes: env.COMMUNITY_CHAT_MAX_BYTES,
    allowedMime: CHAT_MIME,
  },
  GROUP_AVATAR: {
    bucket: env.MINIO_BUCKET_AVATARS,
    keyPrefix: "group-avatars",
    maxBytes: env.AVATAR_MAX_UPLOAD_BYTES,
    allowedMime: {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    },
  },
  GROUP_CHAT_ATTACHMENT: {
    bucket: env.MINIO_BUCKET,
    keyPrefix: "group-chat-uploads",
    maxBytes: env.GROUP_CHAT_MAX_BYTES,
    allowedMime: CHAT_MIME,
  },
};
