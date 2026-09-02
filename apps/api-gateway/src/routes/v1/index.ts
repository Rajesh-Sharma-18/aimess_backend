import { Router, type IRouter } from "express";

import { createServiceProxy } from "../../proxy/create-service-proxy.js";
import { createChatBanGate } from "../../middleware/ban-gate.js";
import {
  sensitiveAuthRateLimiter,
  otpRateLimiter,
  inviteLinkPreviewRateLimiter,
  deviceTokenRateLimiter,
  forgotPasswordRateLimiter,
  mediaRateLimiter,
  readRateLimiter,
  searchRateLimiter,
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

  // community-service's card route is the one unauthenticated community
  // endpoint, so it carries the same enumeration risk as the invite preview and
  // shares its limiter. The authenticated `/by-handle/:handle` resolver above it
  // is deliberately NOT throttled this hard — normal app navigation uses it.
  v1Router.use(
    "/communities/by-handle/:handle/card",
    inviteLinkPreviewRateLimiter
  );

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
    "/auth/google",
    "/auth/apple",
    // Previously unthrottled at the edge: password reset accepts an OTP and
    // sets a new password, and register is the account-creation flood surface.
    // Both were covered only by the global backstop.
    "/auth/reset-password",
    "/auth/register",
    // Refresh mints a fresh access token from a bearer-equivalent credential
    // and carries no Authorization header, so the global limiter fell back to
    // the IP bucket and allowed ~144k guesses a day per address with no
    // account lockout on the path. The admin router has always treated its
    // identical endpoint as sensitive; this mirrors that. `/auth/token` is the
    // same primitive under auth-service's own path name.
    "/auth/refresh",
    "/auth/token",
    // Unauthenticated availability oracle: 409 for a taken account, 200
    // otherwise, over the whole 3-32 character handle namespace. Enumerated
    // handles feed targeted credential stuffing against /auth/login.
    "/auth/accounts",
  ]) {
    v1Router.use(sensitivePath, sensitiveAuthRateLimiter);
  }

  // OTP endpoints get their own, looser bucket. Sharing `auth.sensitive` with
  // login meant a user legitimately re-requesting a code burned the login
  // budget for their whole IP.
  //
  // These paths were `/auth/verify-otp` and `/auth/resend-otp`, neither of
  // which exists in auth-service — so the limiter was mounted on nothing and
  // every real OTP endpoint ran unthrottled at the edge. The list below is the
  // actual route set (see auth-service's auth / email-link / change-email
  // routers). Forgot-password has its own tighter bucket, mounted below.
  for (const otpPath of [
    "/auth/link-email/request",
    "/auth/link-email/verify",
    "/auth/change-email/request",
    "/auth/change-email/verify",
  ]) {
    v1Router.use(otpPath, otpRateLimiter);
  }

  // Read-heavy and search paths. Both limiters were configured with their own
  // env knobs and then imported by nothing, so every search, listing and sync
  // endpoint across user, community and chat ran with only the global backstop.
  for (const searchPath of [
    "/users/search",
    "/users/discovery",
    "/communities/search",
    "/chat/search",
  ]) {
    v1Router.use(searchPath, searchRateLimiter);
  }
  for (const readPath of ["/users/friends", "/chat/conversations"]) {
    v1Router.use(readPath, readRateLimiter);
  }

  // Presigned upload-URL minting is a write-shaped operation that grants an
  // object-store write, so it is sized like the device-token limiter rather
  // than like a read. It previously had none at all.
  v1Router.use("/media", mediaRateLimiter);

  // Forgot-password has its own, tighter bucket (10 per 15 min) rather than
  // sharing the 20-per-15-min credential bucket: users legitimately retry
  // during a reset, but the flow also mails an OTP on every call. The limiter
  // existed with its own configuration and was imported by nothing.
  v1Router.use("/auth/forgot-password", forgotPasswordRateLimiter);

  // Scoped ban gate: reject a system-banned user's still-valid access token on
  // chat/group REST before it reaches chat-service (spec §28 — an old token must
  // not outlive the ban). Registered before the generic proxy so it runs first
  // on `/chat`; fail-open, so it never breaks chat for non-banned users.
  v1Router.use("/chat", createChatBanGate());

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
