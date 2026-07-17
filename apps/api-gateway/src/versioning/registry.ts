import type { ApiVersion } from "./types.js";
import { env } from "../config/env.js";

export type VersionedServiceConfig = {
  /** URL path segment after `/api/{version}/` (e.g. `auth`, `users`). */
  segment: string;
  target: string;
  /** Downstream service path prefix (e.g. `/api/auth`, `/api/v1`). */
  downstreamPrefix: string;
  swaggerTag?: string;
};

const v1Services: VersionedServiceConfig[] = [
  {
    segment: "auth",
    target: env.AUTH_SERVICE_URL,
    downstreamPrefix: "/api/auth",
    swaggerTag: "Auth",
  },
];

if (env.USER_SERVICE_URL) {
  v1Services.push({
    segment: "users",
    target: env.USER_SERVICE_URL,
    downstreamPrefix: "/api/v1/users",
    swaggerTag: "Users",
  });
}

if (env.COMMUNITY_SERVICE_URL) {
  v1Services.push({
    segment: "communities",
    target: env.COMMUNITY_SERVICE_URL,
    // community-service serves its routes under /api/v1/communities/* (matches
    // its OpenAPI + direct testability), so keep the segment in the downstream
    // path. The gateway strips the /api/v1/communities mount, then this prefix
    // restores it. (Differs from `users`, whose service mounts at /api/v1 root.)
    downstreamPrefix: "/api/v1/communities",
    swaggerTag: "Communities",
  });
}

if (env.CHAT_SERVICE_URL) {
  v1Services.push({
    segment: "chat",
    target: env.CHAT_SERVICE_URL,
    downstreamPrefix: "/api/chat",
    swaggerTag: "Chat",
  });
}

if (env.NOTIFICATION_SERVICE_URL) {
  // FCM/APNs device-token registration. Public `/api/v1/devices` proxies to
  // notifications-service `/v1/devices` (register/upsert) + `/v1/devices/:token`
  // (unregister on logout).
  v1Services.push({
    segment: "devices",
    target: env.NOTIFICATION_SERVICE_URL,
    downstreamPrefix: "/v1/devices",
    swaggerTag: "Devices",
  });
}

if (env.MEDIA_SERVICE_URL) {
  v1Services.push({
    segment: "media",
    target: env.MEDIA_SERVICE_URL,
    downstreamPrefix: "/api/v1/media",
    swaggerTag: "Media",
  });
}

if (env.STREAM_SERVICE_URL) {
  // Livestream REST surface. stream-service mounts its routes under /api/v1/*
  // (e.g. /streams), so the gateway strips the /api/v1/streams mount and this
  // prefix restores it.
  v1Services.push({
    segment: "streams",
    target: env.STREAM_SERVICE_URL,
    downstreamPrefix: "/api/v1/streams",
    swaggerTag: "Streams",
  });
}

// V2 is a PARALLEL, additive surface. Only services that expose a V2 endpoint are
// registered here; every other resource keeps using V1. The downstream prefixes
// carry the `/api/v2` segment so the service can host the V2 routes beside the
// (frozen) V1 ones without collision. See each service's V2 route mount.
const v2Services: VersionedServiceConfig[] = [];

if (env.COMMUNITY_SERVICE_URL) {
  v2Services.push({
    segment: "communities",
    target: env.COMMUNITY_SERVICE_URL,
    // community-service hosts V2 at /api/v2/communities/* (mounted beside its
    // /api/v1/communities router). The gateway strips /api/v2/communities, then
    // this prefix restores it downstream.
    downstreamPrefix: "/api/v2/communities",
    swaggerTag: "Communities",
  });
}

if (env.CHAT_SERVICE_URL) {
  v2Services.push({
    segment: "chat",
    target: env.CHAT_SERVICE_URL,
    // chat-service hosts the V2 community message timeline at
    // /api/v2/chat/community/* (beside its /api/chat V1 router).
    downstreamPrefix: "/api/v2/chat",
    swaggerTag: "Chat",
  });
}

const servicesByVersion: Record<ApiVersion, VersionedServiceConfig[]> = {
  v1: v1Services,
  v2: v2Services,
};

export function getServicesForVersion(
  version: ApiVersion
): VersionedServiceConfig[] {
  return servicesByVersion[version];
}
