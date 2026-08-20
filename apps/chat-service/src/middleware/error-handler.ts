/**
 * Re-export of the shared handler in `@aimess/utils`. Kept as a file so the
 * existing `import { errorHandler } from "./middleware/error-handler.js"` in
 * `app.ts` is unchanged.
 */
import { createErrorHandler } from "@aimess/utils";

export const errorHandler = createErrorHandler({
  service: "chat-service",
  uniqueConstraintKey: () => "CHAT_RESOURCE_CONFLICT",
});
