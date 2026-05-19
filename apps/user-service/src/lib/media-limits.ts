import { env } from "../config/env.js";

/** Avatar upload limits (enforced on presign + after upload). */
export const AvatarMediaLimits = {
  maxBytes: env.AVATAR_MAX_UPLOAD_BYTES,
  maxBytesLabel: formatBytes(env.AVATAR_MAX_UPLOAD_BYTES),
} as const;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function assertAvatarFileSize(contentLength: number): void {
  if (contentLength < 1) {
    throw new Error("AVATAR_FILE_EMPTY");
  }
  if (contentLength > AvatarMediaLimits.maxBytes) {
    throw new Error("AVATAR_FILE_TOO_LARGE");
  }
}
