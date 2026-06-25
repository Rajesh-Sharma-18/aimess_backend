import { Router, type IRouter, type Request, type Response } from "express";

import { env, isLinkHost } from "../config/env.js";
import { detectFromSegment } from "../linkhost/detect-link.js";
import { renderPreviewPage } from "../linkhost/preview.js";
import { fetchPublicCommunityCard } from "../linkhost/public-card.js";
import {
  buildAppleAppSiteAssociation,
  buildAssetLinks,
} from "../linkhost/well-known.js";

function absoluteUrl(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl}`;
}

/**
 * Dedicated community link host (aimess.me). Serves the App/Universal-Link
 * `.well-known` proofs and the server-rendered "Open in app" preview. Mounted
 * FIRST in the app, but host-gated: requests to any non-link host fall straight
 * through (`next("router")`) to normal API routing, so the gateway keeps serving
 * the API on its own host.
 */
export function createLinkHostRouter(): IRouter {
  const router = Router();

  // Host gate — skip the entire router unless this is the link domain.
  router.use((req, _res, next) => {
    if (!isLinkHost(req.hostname)) return next("router");
    next();
  });

  // --- .well-known (must be exact paths, before the catch-all) ---
  router.get("/.well-known/assetlinks.json", (_req, res) => {
    // application/json, no redirect (Android verification requirement).
    res.type("application/json").json(buildAssetLinks());
  });

  router.get("/.well-known/apple-app-site-association", (_req, res) => {
    // No file extension, application/json, no redirect (iOS requirement).
    res.type("application/json").json(buildAppleAppSiteAssociation());
  });

  // Root → send people to the web app (no community targeted).
  router.get("/", (_req, res) => {
    res.redirect(302, env.WEB_APP_URL);
  });

  // Catch-all single-segment community link: `/<handle>` or `/+<code>`.
  router.get("/:seg", async (req: Request, res: Response) => {
    const rawSeg = req.params.seg;
    const seg = Array.isArray(rawSeg) ? rawSeg[0] : rawSeg;
    const target = detectFromSegment(seg);

    if (target.kind === "invalid") {
      res
        .status(404)
        .type("html")
        .send(
          renderPreviewPage({
            target,
            card: null,
            pageUrl: absoluteUrl(req),
          })
        );
      return;
    }

    // PUBLIC handles fetch a metadata card (for OG unfurl). PRIVATE codes never
    // leak metadata to logged-out viewers → generic card.
    const card =
      target.kind === "public"
        ? await fetchPublicCommunityCard(target.handle)
        : null;

    res
      .status(200)
      .type("html")
      .send(renderPreviewPage({ target, card, pageUrl: absoluteUrl(req) }));
  });

  return router;
}
