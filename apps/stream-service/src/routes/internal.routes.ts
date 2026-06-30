import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import type { LivestreamService } from "../services/livestream.service.js";

/**
 * Internal (non-gateway, un-authenticated) routes — mounted at `/internal`.
 *
 * `POST /srs/hooks` is the SRS http_hooks callback target. SRS posts JSON for
 * on_publish/on_unpublish/on_play/on_stop with the publishing stream name in
 * `stream` (== our streamKey). Per the SRS hook protocol the response body is a
 * bare integer: `0` allows the action, non-zero denies it. The endpoint is
 * guarded by `SRS_HOOK_SECRET` (via `?secret=` query or `x-srs-secret` header)
 * only when that env is configured.
 */
export function createInternalRoutes(
  livestreamService: LivestreamService
): IRouter {
  const router = Router();

  router.post("/srs/hooks", (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as {
        action?: string;
        stream?: string;
        app?: string;
      };
      logger.info(
        `SRS hook HIT — action=${body.action ?? "?"} stream=${body.stream ?? "?"} app=${body.app ?? "?"} ip=${req.ip ?? "?"}`
      );

      // Shared-secret guard (only enforced when configured).
      if (env.SRS_HOOK_SECRET) {
        const provided =
          (typeof req.query.secret === "string" ? req.query.secret : "") ||
          (typeof req.headers["x-srs-secret"] === "string"
            ? (req.headers["x-srs-secret"] as string)
            : "");
        if (provided !== env.SRS_HOOK_SECRET) {
          logger.warn("SRS hook rejected: bad/missing secret");
          // Deny the SRS action.
          res.status(403).json(1);
          return;
        }
      }

      const action = body.action ?? "";
      const streamKey = body.stream ?? "";

      if (!streamKey) {
        logger.warn(`SRS hook ${action} missing stream key`);
        res.json(0);
        return;
      }

      try {
        switch (action) {
          case "on_publish": {
            const allow = await livestreamService.handlePublish(streamKey);
            res.json(allow ? 0 : 1);
            return;
          }
          case "on_unpublish": {
            await livestreamService.handleUnpublish(streamKey);
            res.json(0);
            return;
          }
          case "on_play": {
            await livestreamService.incrementViewer(streamKey, 1);
            res.json(0);
            return;
          }
          case "on_stop": {
            await livestreamService.incrementViewer(streamKey, -1);
            res.json(0);
            return;
          }
          default:
            // Unknown / unhandled action — allow by default.
            res.json(0);
            return;
        }
      } catch (error) {
        logger.error(`SRS hook ${action} failed: ${String(error)}`);
        // On internal error, allow on_publish (do not block a real go-live on a
        // transient DB blip is risky; deny is the safer choice for publish).
        res.json(action === "on_publish" ? 1 : 0);
      }
    })();
  });

  return router;
}
