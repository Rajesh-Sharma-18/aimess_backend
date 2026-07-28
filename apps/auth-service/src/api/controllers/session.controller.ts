import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { RefreshTokenInput } from "../validators/session.validator.js";
import { sessionService } from "../../services/session.service.js";

export const refreshTokens = asyncHandler(
  async (req: Request, res: Response) => {
    const { refreshToken } = req.body as RefreshTokenInput;
    const tokens = await sessionService.refresh(refreshToken);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ tokens }, t("AUTH_REFRESH_SUCCESS", req.locale)));
  }
);

export const issueAccessToken = asyncHandler(
  async (req: Request, res: Response) => {
    const { refreshToken } = req.body as RefreshTokenInput;
    const result = await sessionService.issueAccessToken(refreshToken);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_ACCESS_TOKEN_ISSUED", req.locale)));
  }
);

export const logout = asyncHandler(async (req: Request, res: Response) => {
  await sessionService.logout(req.auth.userId, req.auth.sessionId);

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

    await sessionService.trustSession(req.auth.userId, sessionId);

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
