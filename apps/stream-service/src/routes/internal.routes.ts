import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import type { LivestreamService } from "../services/livestream.service.js";

function logStreamHookBanner(message: string): void {
  logger.info("========== AIMESS_SRS_HOOK_STREAM_SERVICE ==========");
  logger.info(message);
  logger.info("========== AIMESS_SRS_HOOK_STREAM_SERVICE_END ======");
}

/** Constant-time compare of two possibly-different-length strings. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison so the branch takes comparable time either way.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Internal (non-gateway) routes — mounted at `/internal`.
 *
 * `POST /srs/hooks` is the SRS http_hooks callback target. SRS posts JSON for
 * on_publish/on_unpublish/on_play/on_stop with the publishing stream name in
 * `stream` (== our streamKey). Per the SRS hook protocol the response body is a
 * bare integer: `0` allows the action, non-zero denies it. The endpoint always
 * requires `SRS_HOOK_SECRET` — SRS's `http_hooks` config can't set custom
 * headers, so the secret must be embedded in the hook URL's `?secret=` query
 * string (see `docker/srs/aimess.conf`); the `x-srs-secret` header is also
 * accepted for any non-SRS caller that can set headers.
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
      logStreamHookBanner(
        `HIT /internal/srs/hooks action=${body.action ?? "?"} app=${
          body.app ?? "?"
        } stream=${body.stream ?? "?"} ip=${req.ip ?? "?"} querySecret=${
          typeof req.query.secret === "string" ? "yes" : "no"
        } headerSecret=${
          typeof req.headers["x-srs-secret"] === "string" ? "yes" : "no"
        } secretCheck=enabled`
      );
      logger.info(
        `SRS hook HIT — action=${body.action ?? "?"} stream=${body.stream ?? "?"} app=${body.app ?? "?"} ip=${req.ip ?? "?"}`
      );

      // Shared-secret guard — always enforced.
      const provided =
        (typeof req.headers["x-srs-secret"] === "string"
          ? (req.headers["x-srs-secret"] as string)
          : "") ||
        (typeof req.query.secret === "string" ? req.query.secret : "");
      if (!provided || !safeEqual(provided, env.SRS_HOOK_SECRET)) {
        logger.warn(
          "AIMESS_SRS_HOOK_STREAM_SERVICE rejected: bad/missing secret"
        );
        // Deny the SRS action.
        res.status(403).json(1);
        return;
      }

      const action = body.action ?? "";
      const streamKey = body.stream ?? "";

      if (!streamKey) {
        logger.warn(
          `AIMESS_SRS_HOOK_STREAM_SERVICE ${action} missing stream key`
        );
        res.json(0);
        return;
      }

      // Transcoded quality renditions (e.g. KEY_720p, KEY_360p) re-publish into
      // SRS via RTMP and trigger hooks too — allow them through without a DB lookup.
      const QUALITY_SUFFIXES = ["_720p", "_480p", "_360p"];
      if (QUALITY_SUFFIXES.some((s) => streamKey.endsWith(s))) {
        res.json(0);
        return;
      }

      try {
        switch (action) {
          case "on_publish": {
            const allow = await livestreamService.handlePublish(streamKey);
            logStreamHookBanner(
              `RESULT action=on_publish stream=${streamKey} allowed=${String(allow)} responseBody=${
                allow ? "0" : "1"
              }`
            );
            res.json(allow ? 0 : 1);
            return;
          }
          case "on_unpublish": {
            await livestreamService.handleUnpublish(streamKey);
            logStreamHookBanner(
              `RESULT action=on_unpublish stream=${streamKey} responseBody=0`
            );
            res.json(0);
            return;
          }
          case "on_play": {
            await livestreamService.incrementViewer(streamKey, 1);
            logStreamHookBanner(
              `RESULT action=on_play stream=${streamKey} responseBody=0`
            );
            res.json(0);
            return;
          }
          case "on_stop": {
            await livestreamService.incrementViewer(streamKey, -1);
            logStreamHookBanner(
              `RESULT action=on_stop stream=${streamKey} responseBody=0`
            );
            res.json(0);
            return;
          }
          default:
            logStreamHookBanner(
              `RESULT action=${action || "unknown"} stream=${streamKey} responseBody=0`
            );
            // Unknown / unhandled action — allow by default.
            res.json(0);
            return;
        }
      } catch (error) {
        logger.error(
          `AIMESS_SRS_HOOK_STREAM_SERVICE ${action} failed: ${String(error)}`
        );
        // On internal error, allow on_publish (do not block a real go-live on a
        // transient DB blip is risky; deny is the safer choice for publish).
        res.json(action === "on_publish" ? 1 : 0);
      }
    })();
  });

  return router;
}
