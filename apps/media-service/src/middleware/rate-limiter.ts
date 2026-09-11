import rateLimit from "express-rate-limit";

import { rateLimitHandler } from "@aimess/utils";

// Runs after authenticateAccessToken on every route, so req.auth is always
// populated here; userId/sessionId fallback to req.ip only guards against
// future routes that mount this limiter without auth.
export const mediaRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.userId ?? req.auth?.sessionId ?? req.ip,
  handler: rateLimitHandler(),
});

/**
 * Async antivirus scan-status polling (`GET /media/scan-status`).
 *
 * Read-shaped and, unlike everything above, its volume is set by how long
 * CLAMAV takes rather than by what the user does. `/media/confirm` answers
 * PENDING whenever the scan has not finished, and every client then polls the
 * same object until it resolves — around a dozen times per file on the web, and
 * every open client does it for every item in a batch at once.
 *
 * Sharing `mediaRateLimiter` therefore charged a scan the user did not ask for
 * against the budget they needed to upload: ONE 10-item album could spend up to
 * 200 polls, i.e. the entire 200-per-15-minutes write bucket, and the uploads
 * that followed were rejected with 429 while nothing abusive had happened. The
 * api-gateway already meters this path as a read (`readRateLimiter`) for that
 * exact reason; this is the same split applied at the service.
 *
 * Still metered, and still per-user: polling is cheap but not free (a storage
 * HEAD plus a DB read each), so this bounds a runaway client loop. It does not
 * try to shape the normal polling rate.
 */
export const mediaScanStatusRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.userId ?? req.auth?.sessionId ?? req.ip,
  handler: rateLimitHandler(),
});
