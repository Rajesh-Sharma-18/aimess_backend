/**
 * Supported public API versions on the gateway. `v1` is the single, complete
 * surface — the parallel `/api/v2` pagination surface was folded back into it,
 * so every capability lives on v1 and there is nothing else to route.
 */
export const API_VERSIONS = ["v1"] as const;

export type ApiVersion = (typeof API_VERSIONS)[number];

export const DEFAULT_API_VERSION: ApiVersion = "v1";

export function isApiVersion(value: string): value is ApiVersion {
  return (API_VERSIONS as readonly string[]).includes(value);
}
