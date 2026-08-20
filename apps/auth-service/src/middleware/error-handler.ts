/**
 * Re-export of the shared handler in `@aimess/utils`. Kept as a file so the
 * existing `import { errorHandler } from "./middleware/error-handler.js"` in
 * `app.ts` is unchanged.
 */
import { createErrorHandler } from "@aimess/utils";

export const errorHandler = createErrorHandler({
  service: "auth-service",
  // Two unique columns collide here and they are not interchangeable: an email
  // clash must not tell the user their username is taken.
  uniqueConstraintKey: (target) =>
    target.toLowerCase().includes("account")
      ? "AUTH_ACCOUNT_TAKEN"
      : "AUTH_EMAIL_EXISTS",
});
