import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Express, Request, Response } from "express";

import { logger } from "@aimess/logger";

/**
 * Serves the Socket.IO real-time contract (AsyncAPI 3.1) as a live, browsable
 * page — the WebSocket equivalent of the Swagger UI mounted at `/docs/v1`.
 *
 *   GET /docs/socket              → AsyncAPI React viewer (HTML)
 *   GET /docs/socket/asyncapi.yaml → the raw spec (served verbatim)
 *
 * The spec is read from `apps/api-gateway/asyncapi/asyncapi.yaml`. That folder
 * sits at the gateway root (outside `src/`), so the same relative path resolves
 * whether we run from `src/` (tsx) or `dist/` (built) — both are two levels
 * below the gateway root.
 */

// src/docs/asyncapi.ts → ../../ = gateway root; dist/docs/asyncapi.js → ../../ = gateway root.
const SPEC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../asyncapi/asyncapi.yaml"
);

// Pinned versions of the standalone AsyncAPI React component (loaded from CDN;
// the gateway disables CSP for the docs surface, same as Swagger UI).
const REACT_COMPONENT_VERSION = "2";

function loadSpec(): string | null {
  try {
    return readFileSync(SPEC_PATH, "utf8");
  } catch (err) {
    logger.warn(`AsyncAPI spec not found at ${SPEC_PATH}: ${String(err)}`);
    return null;
  }
}

function viewerHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AIMess Real-time API (Socket.IO)</title>
    <link
      rel="stylesheet"
      href="https://unpkg.com/@asyncapi/react-component@${REACT_COMPONENT_VERSION}/styles/default.min.css"
    />
    <style>
      html, body { margin: 0; padding: 0; }
    </style>
  </head>
  <body>
    <div id="asyncapi"></div>
    <script src="https://unpkg.com/@asyncapi/react-component@${REACT_COMPONENT_VERSION}/browser/standalone/index.js"></script>
    <script>
      AsyncApiStandalone.render(
        {
          schema: { url: "/docs/socket/asyncapi.yaml" },
          config: {
            show: { sidebar: true, errors: true },
            expand: { messageExamples: true },
          },
        },
        document.getElementById("asyncapi")
      );
    </script>
  </body>
</html>`;
}

export function setupAsyncApiDocs(app: Express): void {
  // Raw spec — the viewer fetches this; also handy for tooling/imports.
  app.get(
    ["/docs/socket/asyncapi.yaml", "/docs/socket/asyncapi.yml"],
    (_req: Request, res: Response) => {
      const spec = loadSpec();
      if (!spec) {
        res.status(404).json({ error: "ASYNCAPI_SPEC_NOT_FOUND" });
        return;
      }
      res.type("application/yaml").send(spec);
    }
  );

  // Browsable viewer (HTML).
  app.get(["/docs/socket", "/docs/socket/"], (_req: Request, res: Response) => {
    res.type("html").send(viewerHtml());
  });
}
