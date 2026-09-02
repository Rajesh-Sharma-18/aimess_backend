import type { Request } from "express";

/**
 * Derive the client IP + user-agent for audit/session rows.
 *
 * `req.ip` honours `app.set("trust proxy", TRUST_PROXY_HOPS)` (applied in
 * app.ts) and therefore picks the entry the trusted proxy appended. The
 * previous implementation hand-parsed `X-Forwarded-For` and took the LEFTMOST
 * entry, which is the one the caller supplies — so the address stamped on
 * admin audit rows was attacker-chosen, and forensics after an incident pointed
 * at whatever the attacker typed.
 */
export function getRequestContext(req: Request): {
  ip: string;
  userAgent: string | null;
} {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const ua = req.headers["user-agent"];
  return { ip, userAgent: typeof ua === "string" ? ua : null };
}
