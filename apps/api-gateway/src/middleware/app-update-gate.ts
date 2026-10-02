import type { RequestHandler } from "express";
import { sendApiError } from "@aimess/utils";

import { appVersionService } from "../app-version/index.js";
import type { AppVersionService } from "../app-version/app-version.service.js";

// Paths an outdated client still needs: the check itself (mounted ahead of this
// gate) and token refresh, so a user forced to update is still signed in after it.
const EXEMPT_PREFIXES = ["/auth/refresh", "/auth/token"];

/**
 * Server-side enforcement of an admin FORCE rule. The client's blocking screen is
 * UX only — a patched or rooted build can remove it — so a client below the
 * platform's force version is refused here with 426 once the admin turns on
 * `enforceOnServer`.
 *
 * The body carries only the code; the client re-asks /app-version/check for
 * the full verdict and copy.
 *
 * Fails open everywhere: no `x-platform`/`x-app-version` (shipped iOS and web
 * send no version), an unparsable version, or a policy read error all pass.
 */
export function createAppUpdateGate(
  service: Pick<AppVersionService, "refusal"> = appVersionService
): RequestHandler {
  return (req, res, next) => {
    if (EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
      next();
      return;
    }
    void service
      .refusal(req.header("x-platform"), req.header("x-app-version"))
      .then((refusal) => {
        if (!refusal) {
          next();
          return;
        }
        sendApiError(req, res, {
          statusCode: 426,
          messageKey: "APP_UPDATE_REQUIRED",
          code: "APP_UPDATE_REQUIRED",
        });
      }, () => next());
  };
}
