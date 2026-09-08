import type { RequestHandler } from "express";

import { logger } from "@aimess/logger";
import { buildIpAllowList, sendApiError } from "@aimess/utils";

import { getAdminIpWhitelist } from "../config/env.js";

const allowlist = buildIpAllowList(getAdminIpWhitelist(), (entry, reason) => {
  logger.warn(`ADMIN_IP_WHITELIST: ignoring "${entry}" — ${reason}`);
});

/**
 * Gateway edge guard for the entire `/admin/*` surface. An empty allowlist
 * means allow all, which is why `config/env.ts` refuses to boot a production
 * gateway that has an admin surface and an empty list.
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
