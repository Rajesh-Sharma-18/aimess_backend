import { z } from "zod";

import { parseAppVersion } from "./version-format.js";
import { APP_PLATFORMS } from "./types.js";

export const checkAppVersionSchema = z.object({
  platform: z.string().toLowerCase().pipe(z.enum(APP_PLATFORMS)),
  version: z
    .string()
    .trim()
    .min(1, "Version is required")
    .superRefine((value, ctx) => {
      try {
        parseAppVersion(value);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Version must be major.minor.patch (e.g. 1.0.5)",
        });
      }
    }),
  // Android API level / iOS major version. Optional: shipped clients don't send it,
  // and without it the minimum-OS rung simply never fires.
  osLevel: z.number().int().min(0).max(1000).optional(),
});

export type CheckAppVersionInput = z.infer<typeof checkAppVersionSchema>;
