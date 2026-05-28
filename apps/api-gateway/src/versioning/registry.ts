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

console.log("env.COMMUNITY_SERVICE_URL", env.COMMUNITY_SERVICE_URL);

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

const servicesByVersion: Record<ApiVersion, VersionedServiceConfig[]> = {
  v1: v1Services,
};

export function getServicesForVersion(
  version: ApiVersion
): VersionedServiceConfig[] {
  return servicesByVersion[version];
}
