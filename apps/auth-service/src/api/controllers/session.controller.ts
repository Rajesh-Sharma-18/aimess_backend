import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { isAppError } from "@aimess/errors";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { RefreshTokenInput } from "../validators/session.validator.js";
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRotatedRefreshCookie,
} from "../../lib/auth-cookie.js";
import { sessionService } from "../../services/session.service.js";

// Only a REJECTED credential kills the cookie. A 500 from a database hiccup
// must not sign the user out - the token is still perfectly good, and the
// browser cannot re-create an httpOnly cookie it never had access to.
function clearCookieIfTokenRejected(res: Response, error: unknown): void {
  if (isAppError(error) && error.statusCode === HTTP_STATUS.UNAUTHORIZED) {
    clearRefreshCookie(res);
  }
}

export const refreshTokens = asyncHandler(
  async (req: Request, res: Response) => {
    const { refreshToken } = req.body as RefreshTokenInput;

    let tokens;
    try {
      tokens = await sessionService.refresh(refreshToken);
    } catch (error) {
      // The cookie is httpOnly, so a browser holding a dead token can never
      // clear it itself and would retry the same doomed refresh on every boot.
      clearCookieIfTokenRejected(res, error);
      throw error;
    }

    // Rotation invalidates the value the browser is holding, so the cookie has
    // to be replaced in the same response.
    setRotatedRefreshCookie(
      res,
      tokens.refreshToken,
      tokens.refreshTokenExpiresIn
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ tokens }, t("AUTH_REFRESH_SUCCESS", req.locale)));
  }
);

export const issueAccessToken = asyncHandler(
  async (req: Request, res: Response) => {
    const { refreshToken } = req.body as RefreshTokenInput;

    let result;
    try {
      // Does not rotate, so the cookie value stays valid and is left alone.
      result = await sessionService.issueAccessToken(refreshToken);
    } catch (error) {
      clearCookieIfTokenRejected(res, error);
      throw error;
    }

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_ACCESS_TOKEN_ISSUED", req.locale)));
  }
);

// The logout body is optional and unvalidated (every other credential path has
// its own validator), so it is narrowed here rather than trusted.
function bodyRefreshToken(req: Request): string | undefined {
  const value = (req.body as { refreshToken?: unknown } | undefined)
    ?.refreshToken;
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

export const logout = asyncHandler(async (req: Request, res: Response) => {
  if (req.auth) {
    await sessionService.logout(req.auth.userId, req.auth.sessionId);
  } else {
    // No usable access token. The refresh token still identifies the session,
    // and it must be revoked here or "Sign out" would leave it alive.
    //
    // The body is read as well as the cookie: native clients have no cookie
    // jar, and a browser talking to an API on another site never gets the
    // cookie back either, so the cookie alone left those sessions unkillable
    // once the access token had expired. The body wins when both are present,
    // exactly as `hydrateRefreshTokenFromCookie` decides it for /refresh - an
    // explicit token is the caller's own session, an ambient cookie need not be.
    const refreshToken = bodyRefreshToken(req) ?? readRefreshCookie(req);
    if (refreshToken) await sessionService.logoutByRefreshToken(refreshToken);
  }

  clearRefreshCookie(res);

  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(null, t("AUTH_LOGOUT_SUCCESS", req.locale)));
});

export const listSessions = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await sessionService.listSessions(
      req.auth.userId,
      req.auth.sessionId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_SESSIONS_LISTED", req.locale)));
  }
);

/** Revoke one device (any row from GET /sessions, including `isCurrent: true`). */
export const revokeSession = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId } = req.params as { sessionId: string };

    await sessionService.revokeSession(
      req.auth.userId,
      req.auth.sessionId,
      sessionId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("AUTH_SESSION_REVOKED", req.locale)));
  }
);

/** "It's Me" — resolve the login-detected notification without terminating the session. */
export const trustSession = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId } = req.params as { sessionId: string };

    await sessionService.trustSession(
      req.auth.userId,
      req.auth.sessionId,
      sessionId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("AUTH_SESSION_TRUSTED", req.locale)));
  }
);

/** Revoke every active session (all devices). */
export const revokeAllSessions = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await sessionService.revokeAllSessions(
      req.auth.userId,
      req.auth.sessionId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("AUTH_SESSIONS_ALL_REVOKED", req.locale))
      );
  }
);
