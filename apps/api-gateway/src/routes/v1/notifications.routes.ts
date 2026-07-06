import express, { Router, type IRouter } from "express";
import type { Request, Response } from "express";

import { asyncHandler } from "@aimess/utils";
import { HTTP_STATUS } from "@aimess/constants";
import { logger } from "@aimess/logger";

/**
 * Stable public alias for FCM / APNs device-token registration.
 *
 *   POST /api/v1/notifications/fcm-token
 *     → forwarded to notifications-service
 *   POST /v1/devices   (register/upsert the caller's push token)
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

      let upstream: globalThis.Response;
      try {
        upstream = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(typeof req.headers.authorization === "string"
              ? { Authorization: req.headers.authorization }
              : {}),
            ...(typeof req.headers["x-lang"] === "string"
              ? { "x-lang": req.headers["x-lang"] }
              : {}),
          },
          body: JSON.stringify(forwardBody),
        });
      } catch (error) {
        logger.error(
          "/notifications/fcm-token → notifications-service forward failed"
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
    })
  );

  return router;
}
