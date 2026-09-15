import type { RequestHandler } from "express";

import { logger } from "@aimess/logger";
import { buildIpAllowList, sendApiError } from "@aimess/utils";

import { env, getAdminIpWhitelist } from "../config/env.js";

/**
 * Null when enforcement is switched off, so the guard below takes the same
 * `next()` path an unconfigured list already took — no source-address check,
 * and crucially no denial to log. Building the list anyway and skipping the
 * check per request would spend startup work on a matcher nothing consults.
 */
const allowlist = env.ADMIN_IP_WHITELIST_ENABLED
  ? buildIpAllowList(getAdminIpWhitelist(), (entry, reason) => {
      logger.warn(`ADMIN_IP_WHITELIST: ignoring "${entry}" — ${reason}`);
    })
  : null;

// Once, at import — not per request. Which of the two states a deployment is in
// is the first thing anyone asks when an admin call 403s, or when one does not.
logger.info(
  `Admin IP whitelist enforcement: ${
    env.ADMIN_IP_WHITELIST_ENABLED ? "enabled" : "disabled"
  }`,
  { service: "api-gateway" }
);

/**
 * Gateway edge guard for the entire `/admin/*` surface. An empty allowlist
 * means allow all, which is why `config/env.ts` refuses to boot a production
 * gateway that has an admin surface and an empty list — unless
 * `ADMIN_IP_WHITELIST_ENABLED=false` says the deployment has no IP perimeter at
 * all, which is the one state an operator can now express without spelling
 * allow-all as a CIDR the production assertion (rightly) refuses.
 *
 * That switch skips ONLY this check. It sits between the admin rate limiter and
 * `adminJwt`, so with it off an admin request still meets the limiter, the edge
 * token check, and every control backoffice-service applies behind the proxy.
 *
 * Entries may be literal addresses or CIDR ranges — see `buildIpAllowList`,
 * which is shared with backoffice-service so the two guards cannot drift. It
 * replaced an exact string comparison that made every mask match nothing.
 *
 * The client address comes from `req.ip`. The previous local `clientIp()`
 * helper read `X-Forwarded-For` and took the LEFTMOST entry whenever
 * TRUST_PROXY_HOPS was above zero — but with one trusted proxy the
 * authoritative entry is the LAST one, the address the proxy appended. An
 * attacker sending `X-Forwarded-For: <an allowlisted office IP>` produced
 * `<allowlisted>, <attacker>` after the proxy appended, and the helper returned
 * the attacker's chosen value, so every request passed this guard. `req.ip`
 * applies the configured hop count and picks the correct entry.
 */
export const adminIpAllowlist: RequestHandler = (req, res, next) => {
  if (allowlist === null) {
    next();
    return;
  }

  if (allowlist.check(req.ip ?? req.socket.remoteAddress ?? "")) {
    next();
    return;
  }

  sendApiError(req, res, { statusCode: 403, messageKey: "FORBIDDEN" });
};
