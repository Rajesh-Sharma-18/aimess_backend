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

  // Admin endpoints live at `{root}/admin/v1/...` (NOT under `/api/vN`). Their
  // keys already carry the full `/admin/v1/...` prefix, so each admin path item
  // gets a path-level `servers` override pointing at the gateway ROOT. Build a
  // new paths object so non-admin entries are left untouched.
  const adminServers = [
    ...new Set(serverBaseUrls.filter(Boolean).map(normalizeGatewayBaseUrl)),
  ].map((url) => ({ url, description: "Admin surface (/admin)" }));

  // Every admin endpoint honors the platform `x-lang`/Accept-Language locale
  // mechanism (responses localized vi/en). Stamp the shared LanguageHeader at
  // the PATH-ITEM level so it applies to all operations under each `/admin/`
  // key without editing all 68 operations; operation-level params still merge.
  const adminLanguageParam = {
    $ref: "#/components/parameters/LanguageHeader",
  };

  const paths = Object.fromEntries(
    Object.entries(spec.paths).map(([key, item]) => {
      if (!key.startsWith("/admin/")) return [key, item];
      const pathItem = item as Record<string, unknown>;
      const existingParams = Array.isArray(pathItem.parameters)
        ? (pathItem.parameters as unknown[])
        : [];
      return [
        key,
        {
          ...pathItem,
          servers: adminServers,
          parameters: [adminLanguageParam, ...existingParams],
        },
      ];
    })
  );

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
        "All current routes are available at `/api/v1/...`.",
        "",
        "Chat/messaging response datetime fields are Unix epoch milliseconds (integer/int64); request datetime inputs and pagination cursors are ISO-8601 strings.",
      ].join("\n"),
    },
    servers: uniqueServers.map((url, index) => ({
      url,
      description:
        index === 0 ? `${version} — current host` : `${version} — ${url}`,
    })),
    tags: spec.tags,
    paths,
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
        adminBearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Admin access token from POST /admin/v1/auth/login (signed with JWT_ADMIN_SECRET).",
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
