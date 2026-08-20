import { Router, type IRouter } from "express";

import { createServiceProxy } from "../../proxy/create-service-proxy.js";
import {
  sensitiveAuthRateLimiter,
  otpRateLimiter,
  inviteLinkPreviewRateLimiter,
  deviceTokenRateLimiter,
} from "../../middleware/rate-limit.js";
import { getServicesForVersion } from "../../versioning/registry.js";
import { env } from "../../config/env.js";
import { appVersionRouter } from "./app-version.routes.js";
import { createLegacyUploadsRouter } from "./legacy-uploads.routes.js";
import { createNotificationsAliasRouter } from "./notifications.routes.js";
import { createLinkedDevicesAliasRouter } from "./linked-devices.routes.js";
import { invitesRouter } from "./invites.routes.js";
import type { MessagingClient } from "../../grpc/clients/messaging.client.js";

export function createV1Router(_messagingClient: MessagingClient): IRouter {
  const v1Router: IRouter = Router();

  v1Router.use("/app-version", appVersionRouter);

  // Stable alias: POST /api/v1/users/uploads/url is forwarded to media-service's
  // POST /api/v1/media/upload-url. Registered BEFORE the generic `/users` proxy
  // below so it intercepts that one path. Only mounted when media-service is
  // configured (mirrors its proxy mount).
  if (env.MEDIA_SERVICE_URL) {
    v1Router.use(createLegacyUploadsRouter(env.MEDIA_SERVICE_URL));
  }

  // Stable alias: GET/DELETE /api/v1/users/linked-devices(/:deviceId) forward
  // to auth-service's existing sessions list/revoke. Registered before the
  // generic `/users` proxy below so it intercepts these two paths.
  v1Router.use(createLinkedDevicesAliasRouter(env.AUTH_SERVICE_URL));

  // Dedicated limiter for the public invite-link preview endpoint (unauthenticated,
  // enumeration risk). Must be registered before the generic service proxy.
  v1Router.use("/communities/invite-links", inviteLinkPreviewRateLimiter);

  // Unauthenticated preview card for a shared link (community handle / group
  // invite token) — what the web interstitial renders. Same enumeration risk as
  // the invite-link preview above, so it shares that limiter, and it is mounted
  // before the generic service proxies because it fans out to two services.
  v1Router.use("/invites", inviteLinkPreviewRateLimiter, invitesRouter);

  // Rate-limit device-token registration (POST /api/v1/devices).
  // Token floods are cheap to send but expensive to prune; 10/min per IP
  // is enough for all legitimate rotation scenarios.
  v1Router.use("/devices", deviceTokenRateLimiter);

  // Stable alias: POST /api/v1/notifications/fcm-token is forwarded to
  // notifications-service POST /v1/devices (the same target as `/devices`).
  // Keeps the legacy FCM-token path working without duplicating logic. Shares
  // the device-token rate limiter and is registered before the generic proxies.
  if (env.NOTIFICATION_SERVICE_URL) {
    v1Router.use("/notifications/fcm-token", deviceTokenRateLimiter);
    v1Router.use(createNotificationsAliasRouter(env.NOTIFICATION_SERVICE_URL));
  }

  // Stricter throttle on sensitive auth endpoints, applied before the generic
  // service proxy below. Must be registered ahead of the proxy mount so it runs
  // first on these paths.
  for (const sensitivePath of [
    "/auth/login",
    "/auth/forgot-password",
    "/auth/google",
    "/auth/apple",
    // Previously unthrottled at the edge: password reset accepts an OTP and
    // sets a new password, and register is the account-creation flood surface.
    // Both were covered only by the global backstop.
    "/auth/reset-password",
    "/auth/register",
  ]) {
    v1Router.use(sensitivePath, sensitiveAuthRateLimiter);
  }

  // OTP verify/resend get their own, looser bucket. Sharing `auth.sensitive`
  // with login meant a user legitimately re-requesting a code burned the login
  // budget for their whole IP.
  for (const otpPath of ["/auth/verify-otp", "/auth/resend-otp"]) {
    v1Router.use(otpPath, otpRateLimiter);
  }

  for (const service of getServicesForVersion("v1")) {
    v1Router.use(
      `/${service.segment}`,
      createServiceProxy({
        target: service.target,
        downstreamPrefix: service.downstreamPrefix,
        serviceName: service.segment,
      })
    );
  }

  return v1Router;
}
