/**
 * Re-export of the shared handler in `@aimess/utils`, matching every other
 * service. This service previously had no `middleware/` directory at all — its
 * handler was an inline closure in `app.ts`.
 */
import { createErrorHandler } from "@aimess/utils";

export const errorHandler = createErrorHandler({
  service: "notifications-service",
});
