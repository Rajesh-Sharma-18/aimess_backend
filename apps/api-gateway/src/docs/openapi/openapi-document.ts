import { isApiVersion, type ApiVersion } from "../../versioning/types.js";
import { v1Components, v1Paths, v1Tags } from "./versions/v1/index.js";

export function normalizeGatewayBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/v\d+(\/[^/]+)?$/i, "");
}

export function toVersionedServerUrl(
  baseUrl: string,
  version: ApiVersion
): string {
  const root = normalizeGatewayBaseUrl(baseUrl);
  return `${root}/api/${version}`;
}

type VersionSpec = {
  paths: Record<string, unknown>;
  tags: { name: string; description?: string }[];
  components: {
    parameters: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
};

const versionSpecs: Record<ApiVersion, VersionSpec> = {
  v1: {
    paths: v1Paths,
    tags: v1Tags,
    components: v1Components,
  },
};

/** Build OpenAPI 3 document for a specific API version. */
export function buildOpenApiDocument(
  version: ApiVersion,
  serverBaseUrls: string[]
) {
  const spec = versionSpecs[version];
  const uniqueServers = [
    ...new Set(
      serverBaseUrls
        .filter(Boolean)
        .map((u) => toVersionedServerUrl(u, version))
    ),
  ];

  return {
    openapi: "3.0.3",
    info: {
      title: `AIMess API ${version.toUpperCase()}`,
      version: version === "v1" ? "1.0.0" : version,
      description: [
        `Public HTTP **${version}** surface on the API gateway.`,
        "",
        "All paths below are relative to the selected server (e.g. `http://localhost:3000/api/v1`).",
        "",
        "When **v2** is introduced, use `/docs/v2` — **v1** routes remain available at `/api/v1/...`.",
      ].join("\n"),
    },
    servers: uniqueServers.map((url, index) => ({
      url,
      description:
        index === 0 ? `${version} — current host` : `${version} — ${url}`,
    })),
    tags: spec.tags,
    paths: spec.paths,
    components: {
      ...spec.components,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Access token from POST /auth/login, /auth/register, or /auth/refresh (`type: access` in JWT payload).",
        },
      },
    },
  };
}

export function parseOpenApiVersion(
  param: string | undefined
): ApiVersion | null {
  if (param && isApiVersion(param)) {
    return param;
  }
  return null;
}
