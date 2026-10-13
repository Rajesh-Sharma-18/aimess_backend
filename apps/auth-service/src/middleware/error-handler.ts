/**
 * Re-export of the shared handler in `@aimess/utils`. Kept as a file so the
 * existing `import { errorHandler } from "./middleware/error-handler.js"` in
 * `app.ts` is unchanged.
 */
import {
  accountBannedMessage,
  accountSuspendedMessage,
  resolveTimeZone,
} from "@aimess/constants";
import { createErrorHandler } from "@aimess/utils";

import { AccountRestrictedError } from "../lib/account-guard.js";

export const errorHandler = createErrorHandler({
  service: "auth-service",
  // Two unique columns collide here and they are not interchangeable: an email
  // clash must not tell the user their username is taken.
  uniqueConstraintKey: (target) =>
    target.toLowerCase().includes("account")
      ? "AUTH_ACCOUNT_TAKEN"
      : "AUTH_EMAIL_EXISTS",
  mapError: (error, req) => {
    if (!(error instanceof AccountRestrictedError)) return null;
    const { reason, until } = error;
    if (error.messageKey === "ACCOUNT_SUSPENDED") {
      return {
        statusCode: 403,
        code: "ACCOUNT_SUSPENDED",
        fallbackMessage: accountSuspendedMessage(
          until,
          reason,
          req.locale,
          resolveTimeZone(req.headers["x-timezone"])
        ),
        details: until !== null ? { until, reason } : undefined,
      };
    }
    return {
      statusCode: 403,
      code: "ACCOUNT_BANNED",
      fallbackMessage: accountBannedMessage(reason, req.locale),
      details: reason ? { reason } : undefined,
    };
  },
});
