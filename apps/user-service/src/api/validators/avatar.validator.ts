import { z } from "zod";

import { ALLOWED_AVATAR_CONTENT_TYPES } from "../../lib/avatar-storage.js";
import { env } from "../../config/env.js";

const allowedContentTypes = Object.keys(ALLOWED_AVATAR_CONTENT_TYPES) as [
  string,
  ...string[],
];

const maxBytes = env.AVATAR_MAX_UPLOAD_BYTES;

export const avatarUploadUrlSchema = z.object({
  contentType: z.enum(allowedContentTypes),
  contentLength: z.coerce
    .number()
    .int()
    .positive()
    .max(maxBytes, {
      message: `File must be at most ${String(maxBytes)} bytes`,
    }),
});

export type AvatarUploadUrlInput = z.infer<typeof avatarUploadUrlSchema>;
