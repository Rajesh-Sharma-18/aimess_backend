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
    downstreamPrefix: "/api/v1",
    swaggerTag: "Users",
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
