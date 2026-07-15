/** Supported public API versions on the gateway. */
export const API_VERSIONS = ["v1", "v2"] as const;

export type ApiVersion = (typeof API_VERSIONS)[number];

export const DEFAULT_API_VERSION: ApiVersion = "v1";

export function isApiVersion(value: string): value is ApiVersion {
  return (API_VERSIONS as readonly string[]).includes(value);
}
