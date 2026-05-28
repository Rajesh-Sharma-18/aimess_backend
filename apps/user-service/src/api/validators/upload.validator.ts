import { z } from "zod";

import { UPLOAD_TYPES } from "../../config/uploads.js";

const uploadTypes = Object.keys(UPLOAD_TYPES) as [string, ...string[]];

export const uploadUrlSchema = z.object({
  type: z.enum(uploadTypes),
  contentType: z.string().min(1),
  contentLength: z.coerce.number().int().positive(),
});

export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;
