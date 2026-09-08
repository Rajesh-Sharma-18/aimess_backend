import { extractPublishSecret } from "../lib/stream-identity.js";
import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { safeEqual, digestKey } from "../lib/secret-compare.js";
import type { LivestreamService } from "../services/livestream.service.js";

function logStreamHookBanner(message: string): void {
  logger.info("========== AIMESS_SRS_HOOK_STREAM_SERVICE ==========");
  logger.info(message);
  logger.info("========== AIMESS_SRS_HOOK_STREAM_SERVICE_END ======");
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
 * accepted, and the api-gateway proxy moves it there so the value stops
 * appearing in upstream access logs. Nothing request-controlled is logged
 * before the shared-secret check, so an unauthenticated caller cannot write to
 * the production log.
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
        /** SRS connection id — distinguishes a superseded publisher's late
         *  on_unpublish from the live one's (see handleUnpublish). */
        client_id?: string | number;
        /**
         * The publish URL's query string, forwarded verbatim by SRS.
         *
         * This is where the publish secret arrives: streams are published under
         * a PUBLIC name, and `?secret=<streamKey>` proves the right to publish
         * it. Without this the hook would be authenticating on the name alone,
         * which every viewer can read out of their own playback URL.
         */
        param?: string;
      };
      // Shared-secret guard — always enforced, and BEFORE any logging.
      //
      // The two banner/info lines that used to sit here ran first and
      // unconditionally, which had two consequences: an unauthenticated caller
      // could write attacker-chosen `action` / `app` / `stream` strings into
      // the log, and every authenticated hook printed the raw stream name —
      // which is the sole publish credential, so log access was
      // broadcast-takeover access. They now run below the guard, with the name
      // reduced to a digest.
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

      // Stream keys are logged as a short digest, never verbatim. These hooks
      // fire several times per broadcast plus once per viewer (on_play), so the
      // raw value would end up scattered across the logs of every environment
      // that ships them.
      logStreamHookBanner(
        `HIT /internal/srs/hooks action=${body.action ?? "?"} app=${
          body.app ?? "?"
        } stream=${digestKey(body.stream)} ip=${req.ip ?? "?"} querySecret=${
          typeof req.query.secret === "string" ? "yes" : "no"
        } headerSecret=${
          typeof req.headers["x-srs-secret"] === "string" ? "yes" : "no"
        } secretCheck=enabled`
      );
      logger.info(
        `SRS hook HIT — action=${body.action ?? "?"} stream=${digestKey(body.stream)} app=${body.app ?? "?"} client=${String(body.client_id ?? "?")} ip=${req.ip ?? "?"}`
      );

      const action = body.action ?? "";
      const streamKey = body.stream ?? "";
      // SRS sends client_id as a string; coerce defensively so a numeric id
      // still compares equal across publish/unpublish.
      const clientId =
        body.client_id === undefined || body.client_id === null
          ? undefined
          : String(body.client_id);

      if (!streamKey) {
        logger.warn(
          `AIMESS_SRS_HOOK_STREAM_SERVICE ${action} missing stream key`
        );
        res.json(0);
        return;
      }

      // NOTE: rendition names (`<name>_1080p` … `_360p`) are deliberately NOT
      // special-cased here. They used to be allowed unconditionally, before any
      // DB lookup or secret check — which made every rung of a live stream's
      // public quality ladder publishable by anyone who could read the
      // playbackId out of their own player URL.
      //
      // Nothing legitimate needs that branch: renditions never reach this hook.
      // On the server they are produced by external ffmpeg workers pushing into
      // I-03, which runs no http_hooks at all; locally the transcode block
      // publishes into `vhost abr`, which likewise has none. See
      // docs/calls/SRS-Server-Snapshot-2026-08-04.md §1 and docker/srs/aimess.conf.
      //
      // So a rendition-suffixed name arriving here is an outside publisher, and
      // falls through to handlePublish, which denies an unknown name and logs it.

      try {
        switch (action) {
          case "on_publish": {
            const allow = await livestreamService.handlePublish(
              streamKey,
              clientId,
              { secret: extractPublishSecret(body.param) }
            );
            logStreamHookBanner(
              `RESULT action=on_publish stream=${digestKey(streamKey)} allowed=${String(allow)} responseBody=${
                allow ? "0" : "1"
              }`
            );
            res.json(allow ? 0 : 1);
            return;
          }
          case "on_unpublish": {
            await livestreamService.handleUnpublish(streamKey, clientId);
            logStreamHookBanner(
              `RESULT action=on_unpublish stream=${digestKey(streamKey)} responseBody=0`
            );
            res.json(0);
            return;
          }
          case "on_play": {
            await livestreamService.incrementViewer(streamKey, 1);
            logStreamHookBanner(
              `RESULT action=on_play stream=${digestKey(streamKey)} responseBody=0`
            );
            res.json(0);
            return;
          }
          case "on_stop": {
            await livestreamService.incrementViewer(streamKey, -1);
            logStreamHookBanner(
              `RESULT action=on_stop stream=${digestKey(streamKey)} responseBody=0`
            );
            res.json(0);
            return;
          }
          default:
            logStreamHookBanner(
              `RESULT action=${action || "unknown"} stream=${digestKey(streamKey)} responseBody=0`
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
