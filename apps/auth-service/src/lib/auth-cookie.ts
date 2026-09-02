import type { Request, RequestHandler, Response } from "express";

import { authCookie, env } from "../config/env.js";

// AIM-02. The website used to keep the user's PASSWORD in a cookie so it could
// replay a login on boot. The refresh token replaces it: httpOnly (JS cannot
// read it), scoped to the auth endpoints, and revocable server-side. It is set
// IN ADDITION to the JSON body - native clients have no cookie jar and parse
// `tokens.refreshToken` as a required field, so the body must stay.

const baseOptions = {
  httpOnly: true,
  secure: authCookie.secure,
  sameSite: authCookie.sameSite,
  path: authCookie.path,
} as const;

// A "remember me" login gets a persistent cookie that outlives the browser
// process; a plain login gets a session cookie that dies with it. The token
// itself stays valid server-side either way - closing the browser drops the
// client's copy, it does not revoke the session.
export function setRefreshCookie(
  res: Response,
  refreshToken: string,
  persistForSeconds?: number
): void {
  res.cookie(authCookie.name, refreshToken, {
    ...baseOptions,
    ...(persistForSeconds ? { maxAge: persistForSeconds * 1000 } : {}),
  });
}

// Every login path funnels through here so the cookie flags cannot drift
// between password, social and device-link sign-in.
export function setLoginRefreshCookie(
  res: Response,
  tokens: { refreshToken: string; refreshTokenExpiresIn: number },
  rememberMe?: boolean
): void {
  setRefreshCookie(
    res,
    tokens.refreshToken,
    rememberMe ? tokens.refreshTokenExpiresIn : undefined
  );
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(authCookie.name, baseOptions);
}

// Rotation has to re-issue the cookie, and it must not silently demote a
// persistent cookie to a session one. The token TTL is the only signal we have
// (the browser never sends Max-Age back), so a token carrying the remember-me
// lifetime keeps a persistent cookie.
export function setRotatedRefreshCookie(
  res: Response,
  refreshToken: string,
  refreshTokenExpiresIn: number
): void {
  const rememberTtl = Number(env.JWT_REFRESH_EXPIRES_IN_REMEMBER_ME);
  const persistent =
    Number.isFinite(rememberTtl) && refreshTokenExpiresIn >= rememberTtl;

  setRefreshCookie(res, refreshToken, persistent ? refreshTokenExpiresIn : undefined);
}

// One named cookie off the raw header - cookie-parser would be a dependency for
// three lines, and nothing else in this service reads cookies.
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== authCookie.name) continue;

    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return value.length > 0 ? value : undefined;
  }

  return undefined;
}

// Lets /refresh and /token keep their existing body validator: the cookie is
// folded into req.body before validation, so a browser sends no body at all and
// a native client is completely unaffected. The body wins when both are present
// - an explicit token is always fresher than an ambient cookie.
export const hydrateRefreshTokenFromCookie: RequestHandler = (
  req,
  _res,
  next
) => {
  const body = req.body as { refreshToken?: unknown } | undefined;

  if (!body || typeof body.refreshToken !== "string" || !body.refreshToken.trim()) {
    const cookie = readRefreshCookie(req);
    if (cookie) req.body = { ...(body ?? {}), refreshToken: cookie };
  }

  next();
};
