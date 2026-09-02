import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Express, Request, Response } from "express";

import { logger } from "@aimess/logger";

/**
 * Serves the Socket.IO real-time contract as a live, browsable page.
 *
 *     GET /docs/socket              → AsyncAPI React viewer
 *     GET /docs/socket/asyncapi.yaml → raw spec
 */

// src/docs/asyncapi.ts → ../../ = gateway root
const GATEWAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../");

const SPEC_PATH = resolve(GATEWAY_ROOT, "asyncapi/asyncapi.yaml");

/**
 * EXACT version of the standalone AsyncAPI React component.
 *
 * This was `"2"` — a floating major — so whatever unpkg resolved `2.x.x` to at
 * request time executed on this origin, with no subresource integrity and (at
 * the time) no CSP. A compromised or hijacked package release, or an unpkg
 * incident, ran attacker JavaScript on the API origin, in the browser of an
 * operator who had just opened the docs. Pinning does not remove the
 * third-party dependency, but it means a new release cannot silently become
 * what this page loads.
 *
 * The page is now also non-production only (see app.ts) and covered by the
 * gateway's CSP, so this is defence in depth rather than the only control.
 * Vendoring the bundle into the gateway's own static assets would remove the
 * off-origin load entirely; recorded as residual rather than done here.
 */
const REACT_COMPONENT_VERSION = "2.7.5";

function loadSpec(path: string, label: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    logger.warn(`AsyncAPI ${label} spec not found at ${path}: ${String(err)}`);
    return null;
  }
}

function viewerHtml(specUrl: string, title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
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
          schema: { url: "${specUrl}" },
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
  app.get(
    ["/docs/socket/asyncapi.yaml", "/docs/socket/asyncapi.yml"],
    (_req: Request, res: Response) => {
      const spec = loadSpec(SPEC_PATH, "socket");
      if (!spec) {
        res.status(404).json({ error: "ASYNCAPI_SPEC_NOT_FOUND" });
        return;
      }
      res.type("application/yaml").send(spec);
    }
  );

  app.get(["/docs/socket", "/docs/socket/"], (_req: Request, res: Response) => {
    res
      .type("html")
      .send(
        viewerHtml(
          "/docs/socket/asyncapi.yaml",
          "AIMess Real-time API (Socket.IO)"
        )
      );
  });
}
