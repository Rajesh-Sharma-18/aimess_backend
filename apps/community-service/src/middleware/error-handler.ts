/**
 * Re-export of the shared handler in `@aimess/utils`. Kept as a file so the
 * existing `import { errorHandler } from "./middleware/error-handler.js"` in
 * `app.ts` is unchanged.
 */
import { createErrorHandler } from "@aimess/utils";

export const errorHandler = createErrorHandler({
  service: "community-service",
  // Defensive fallback — the service layer normally translates P2002 into the
  // specific COMMUNITY_NAME_TAKEN / COMMUNITY_HANDLE_TAKEN conflict first.
  uniqueConstraintKey: (target) =>
    target.toLowerCase().includes("handle")
      ? "COMMUNITY_HANDLE_TAKEN"
      : "COMMUNITY_NAME_TAKEN",
});
