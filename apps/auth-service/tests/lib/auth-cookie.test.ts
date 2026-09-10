/**
 * hydrateRefreshTokenFromCookie — the middleware that lets /auth/refresh and
 * /auth/token keep one body validator while a browser sends nothing but the
 * httpOnly `aimess_rt` cookie. Covers the three inputs that matter: cookie
 * only, body wins over cookie, and neither (which must be a 401 naming the
 * missing credential, not a 400 validation failure).
 */
import type { NextFunction, Request, Response } from "express";
import { UnauthorizedError } from "@aimess/errors";

import { hydrateRefreshTokenFromCookie } from "../../src/lib/auth-cookie.js";

function run(
  body: unknown,
  cookieHeader?: string
): { req: Request; error: unknown } {
  const req = { body, headers: cookieHeader ? { cookie: cookieHeader } : {} } as Request;
  let error: unknown;
  const next = ((err?: unknown) => {
    error = err;
  }) as NextFunction;

  hydrateRefreshTokenFromCookie(req, {} as Response, next);
  return { req, error };
}

describe("hydrateRefreshTokenFromCookie", () => {
  it("folds the cookie into an empty body", () => {
    const { req, error } = run({}, "aimess_rt=cookie-token");

    expect(error).toBeUndefined();
    expect(req.body).toEqual({ refreshToken: "cookie-token" });
  });

  it("keeps an explicit body token over the cookie", () => {
    const { req, error } = run(
      { refreshToken: "body-token" },
      "aimess_rt=cookie-token"
    );

    expect(error).toBeUndefined();
    expect(req.body).toEqual({ refreshToken: "body-token" });
  });

  it("rejects with 401 when neither the body nor a cookie carries a token", () => {
    const { error } = run({});

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect((error as UnauthorizedError).statusCode).toBe(401);
    expect((error as UnauthorizedError).messageKey).toBe("AUTH_REFRESH_TOKEN_MISSING");
  });
});
