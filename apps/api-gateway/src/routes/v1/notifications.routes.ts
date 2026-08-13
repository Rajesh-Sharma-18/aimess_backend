import express, { Router, type IRouter } from "express";
import type { Request, Response } from "express";

import { asyncHandler } from "@aimess/utils";
import { HTTP_STATUS } from "@aimess/constants";
import { logger } from "@aimess/logger";

/**
 * Stable public alias for FCM / APNs device-token registration.
 *
 *   POST   /api/v1/notifications/fcm-token
 *     → notifications-service POST /v1/devices        (register/upsert)
 *   DELETE /api/v1/notifications/fcm-token/{token}
 *     → notifications-service DELETE /v1/devices/{token}  (unregister)
 *
 * Device-token registration is owned by notifications-service and already
 * exposed at `POST /api/v1/devices` (see versioning/registry.ts). Clients that
 * target the older `/notifications/fcm-token` path would otherwise 404. This
 * alias keeps that contract working WITHOUT duplicating any business logic — it
 * forwards to the exact same downstream endpoint, which performs JWT auth
 * (deriving `userId` from the token), Zod validation, and the upsert.
 *
 * The only transform is light body normalization so common field aliases keep
 * working: `fcmToken`→`token`, `deviceType`→`platform`, and platform values are
 * upper-cased (`android`→`ANDROID`) to match the downstream enum. The downstream
 * response (status + JSON envelope) is relayed verbatim.
 */
export function createNotificationsAliasRouter(
  notificationServiceUrl: string
): IRouter {
  const router = Router();
  const upstreamUrl = `${notificationServiceUrl.replace(/\/$/, "")}/v1/devices`;

  router.post(
    "/notifications/fcm-token",
    express.json({ limit: "1mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        token?: unknown;
        fcmToken?: unknown;
        platform?: unknown;
        deviceType?: unknown;
        deviceId?: unknown;
        tokenType?: unknown;
      };

      // Accept the canonical shape plus common client aliases. Anything invalid
      // is left as-is so notifications-service produces the standard 400.
      const token = body.token ?? body.fcmToken;
      const rawPlatform = body.platform ?? body.deviceType;
      const platform =
        typeof rawPlatform === "string"
          ? rawPlatform.toUpperCase()
          : rawPlatform;

      const forwardBody: Record<string, unknown> = { token, platform };
      if (body.deviceId !== undefined) forwardBody.deviceId = body.deviceId;
      // Must be forwarded: dropping it defaults the row to FCM, and an iOS
      // PushKit token stored as FCM is sent over FCM, which never reaches
      // PushKit — the device silently stops ringing for incoming calls.
      if (body.tokenType !== undefined) forwardBody.tokenType = body.tokenType;

      return forward(req, res, upstreamUrl, "POST", forwardBody);
    })
  );

  // The native clients' documented logout step
  // (docs/push/ios-fcm-integration.md §13, android-fcm-integration.md) — it had
  // no route at all, so every mobile logout 404'd on the unregister and relied
  // entirely on the server-side session revocation to remove the row.
  router.delete(
    "/notifications/fcm-token/:token",
    asyncHandler(async (req: Request, res: Response) => {
      const token = encodeURIComponent(String(req.params.token));
      return forward(req, res, `${upstreamUrl}/${token}`, "DELETE");
    })
  );

  return router;
}

/**
 * Relay one request to notifications-service verbatim (status + JSON envelope),
 * carrying the caller's JWT so the downstream scopes the write to them.
 */
async function forward(
  req: Request,
  res: Response,
  url: string,
  method: "POST" | "DELETE",
  body?: Record<string, unknown>
): Promise<Response> {
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(typeof req.headers.authorization === "string"
          ? { Authorization: req.headers.authorization }
          : {}),
        ...(typeof req.headers["x-lang"] === "string"
          ? { "x-lang": req.headers["x-lang"] }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    logger.error(
      `${method} /notifications/fcm-token → notifications-service forward failed`
    );
    logger.error(error);
    return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      success: false,
      message:
        "Notification service temporarily unavailable. Please try again later.",
    });
  }

  const payload = await upstream.text();
  return res.status(upstream.status).type("application/json").send(payload);
}
