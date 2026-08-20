import { Router, type IRouter } from "express";
import type { Request, Response } from "express";

import { asyncHandler, sendApiError } from "@aimess/utils";
import { HTTP_STATUS } from "@aimess/constants";
import { logger } from "@aimess/logger";

/**
 * Stable public alias: `GET /api/v1/users/linked-devices` and
 * `DELETE /api/v1/users/linked-devices/{deviceId}` forward to auth-service's
 * existing `GET /auth/sessions` / `DELETE /auth/sessions/{sessionId}` — the
 * "linked devices" list/logout feature already lives there (SOW §1.1). No new
 * business logic: same forwarding-proxy pattern as `createLegacyUploadsRouter`
 * / `createNotificationsAliasRouter`. `{deviceId}` in this alias IS the
 * `sessionId` field each row in the list response already carries.
 */
export function createLinkedDevicesAliasRouter(
  authServiceUrl: string
): IRouter {
  const router = Router();
  const base = `${authServiceUrl.replace(/\/$/, "")}/api/auth/sessions`;

  function forwardHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {};
    if (typeof req.headers.authorization === "string") {
      headers.Authorization = req.headers.authorization;
    }
    if (typeof req.headers["x-lang"] === "string") {
      headers["x-lang"] = req.headers["x-lang"];
    }
    return headers;
  }

  async function relay(
    req: Request,
    res: Response,
    upstreamRequest: () => Promise<globalThis.Response>,
    serviceLabel: string
  ): Promise<Response | void> {
    let upstream: globalThis.Response;
    try {
      upstream = await upstreamRequest();
    } catch (error) {
      logger.error(`${serviceLabel} forward failed`);
      logger.error(error);
      sendApiError(req, res, {
        statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
        messageKey: "SERVICE_UNAVAILABLE",
        retryAfterSec: 5,
      });
      return;
    }
    const payload = await upstream.text();
    return res.status(upstream.status).type("application/json").send(payload);
  }

  router.get(
    "/users/linked-devices",
    asyncHandler(async (req: Request, res: Response) =>
      relay(
        req,
        res,
        () => fetch(base, { method: "GET", headers: forwardHeaders(req) }),
        "GET /users/linked-devices → auth-service"
      )
    )
  );

  router.delete(
    "/users/linked-devices/:deviceId",
    asyncHandler(async (req: Request, res: Response) => {
      const deviceId = String(req.params.deviceId);
      return relay(
        req,
        res,
        () =>
          fetch(`${base}/${encodeURIComponent(deviceId)}`, {
            method: "DELETE",
            headers: forwardHeaders(req),
          }),
        "DELETE /users/linked-devices/:deviceId → auth-service"
      );
    })
  );

  return router;
}
