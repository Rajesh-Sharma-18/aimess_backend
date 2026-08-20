/**
 * Re-export of the shared handler in `@aimess/utils`. Kept as a file so the
 * existing `import { errorHandler } from "./middleware/error-handler.js"` in
 * `app.ts` is unchanged.
 */
import { createErrorHandler } from "@aimess/utils";

export const errorHandler = createErrorHandler({
  service: "media-service",
  // A rejected upload is the one 413 that has copy of its own — it names the
  // per-category size cap rather than the generic transport message.
  mapError: (error) => {
    const status =
      (error as { status?: number; statusCode?: number })?.status ??
      (error as { statusCode?: number })?.statusCode;
    const type = (error as { type?: string })?.type;
    return status === 413 || type === "entity.too.large"
      ? { statusCode: 413, messageKey: "UPLOAD_FILE_TOO_LARGE" }
      : null;
  },
});
