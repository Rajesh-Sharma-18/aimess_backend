import type { Express, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";

import { resolveSwaggerServerUrls } from "../config/env.js";
import {
  API_VERSIONS,
  DEFAULT_API_VERSION,
  type ApiVersion,
} from "../versioning/types.js";
import {
  buildOpenApiDocument,
  parseOpenApiVersion,
} from "./openapi/openapi-document.js";

const swaggerUiOptions: swaggerUi.SwaggerUiOptions = {
  customSiteTitle: "AIMess API",
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    // ngrok's free tier returns an HTML interstitial for browser-originated
    // requests unless this header is present. Inject it so "Try it out" reaches
    // the gateway when the docs are served through an ngrok tunnel. (Self-
    // contained — swagger-ui-express serializes this function into the page.)
    requestInterceptor: (request: { headers: Record<string, string> }) => {
      request.headers["ngrok-skip-browser-warning"] = "true";
      return request;
    },
  },
};

function documentForRequest(req: Request, version: ApiVersion) {
  return buildOpenApiDocument(version, resolveSwaggerServerUrls(req));
}

function setupVersionedSwagger(app: Express, version: ApiVersion): void {
  const base = `/docs/${version}`;

  app.get(`${base}/openapi.json`, (req, res) => {
    res.json(documentForRequest(req, version));
  });

  app.use(base, swaggerUi.serve);
  app.get([base, `${base}/`], (req, res, next) => {
    swaggerUi.setup(documentForRequest(req, version), swaggerUiOptions)(
      req,
      res,
      next
    );
  });
}

export function setupSwagger(app: Express): void {
  // Default docs → latest version
  app.get("/docs", (_req, res) => {
    res.redirect(302, `/docs/${DEFAULT_API_VERSION}`);
  });

  app.get("/docs/openapi.json", (req, res) => {
    res.redirect(302, `/docs/${DEFAULT_API_VERSION}/openapi.json`);
  });

  for (const version of API_VERSIONS) {
    setupVersionedSwagger(app, version);
  }

  // Version index (helpful when v2+ exists)
  app.get("/docs/versions", (_req, res: Response) => {
    res.json({
      versions: API_VERSIONS.map((v) => ({
        version: v,
        docs: `/docs/${v}`,
        openapi: `/docs/${v}/openapi.json`,
        apiBase: `/api/${v}`,
      })),
      default: DEFAULT_API_VERSION,
    });
  });
}

export { parseOpenApiVersion };
