import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { safeEqual, digestKey } from "../lib/secret-compare.js";
import type { LivestreamService } from "../services/livestream.service.js";

/**
 * One callback/auth parameter, coerced defensively.
 *
 * Values arrive from the CDN as query parameters or a form/JSON body, and
 * Express hands back `string | string[] | ParsedQs` for anything an attacker
 * (or a console typo) can repeat. Everything that is not a plain scalar becomes
 * "" rather than leaking `[object Object]` into a DB lookup or a log line.
 */
function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Event timestamp in epoch ms.
 *
 * The console lets each parameter be renamed and deselected, so take the
 * millisecond field first, fall back to the second-granularity one, and finally
 * to arrival time. Only ever used to order two events for the same stream.
 */
function eventMs(params: Record<string, unknown>): number {
  const ms = Number(str(params.milltime));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(str(params.time) || str(params.timestamp));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return Date.now();
}

/**
 * Every parameter the vendor actually sent, with the shared secret redacted.
 *
 * The console lets each callback parameter be renamed or switched off, and the
 * vendor documents no payload sample — so the only reliable record of what a
 * real callback carries is the one we print when it arrives. Logged verbatim
 * (except the secret) because that is the point: to compare against the
 * console's checkbox list and spot a renamed or missing field.
 *
 * The stream name is NOT a credential here, unlike the SRS hook: CDN streams
 * publish under the public playbackId and prove the right to publish with a
 * separate `?secret=`, which never reaches this log.
 */
function dumpParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (key.toLowerCase() === "secret") {
      parts.push("secret=<redacted>");
      continue;
    }
    parts.push(`${key}=${str(value) || JSON.stringify(value)}`);
  }
  return parts.length ? parts.join(" ") : "(no parameters)";
}

/**
 * Internal (non-gateway) CDNetworks routes — mounted at `/internal`.
 *
 * Three endpoints, all configured by URL in the CDNetworks console:
 * - `/cdn/start` and `/cdn/end` are Stream Status Callbacks. They REPORT; they
 *   cannot deny anything, and the vendor documents neither a retry nor a
 *   signature, which is why `reconcileCdn` exists as the safety net.
 * - `/cdn/auth` is Remote Authentication, which DOES gate the publish.
 *
 * The console can send either GET or POST, hence `router.all` — `express.json`
 * and `express.urlencoded` are already mounted, so a form or JSON body lands in
 * `req.body` and query parameters in `req.query`.
 *
 * The shared secret rides in the URL (`?secret=`), because the console has no
 * field for custom headers — the same constraint SRS's hooks have. The gateway
 * moves it into `x-cdn-secret` so it stops appearing in upstream access logs.
 * Nothing request-controlled is logged before that check, so an unauthenticated
 * caller cannot write into the production log.
 */
export function createInternalCdnRoutes(
  livestreamService: LivestreamService
): IRouter {
  const router = Router();

  /** Shared-secret guard. Returns the merged parameters, or null after replying. */
  function authorize(
    req: Request,
    res: Response,
    route: string
  ): Record<string, unknown> | null {
    // Arrival marker, before the secret check and before anything the caller
    // controls is read. Only fixed values (the matched route, the HTTP method,
    // the peer IP) and a yes/no for the secret — enough to answer "is the CDN
    // calling us at all?", which is the first question when a stream sticks in
    // PENDING, without letting an unauthenticated caller write chosen text into
    // the log.
    logger.info(
      `CDN callback hit: ${req.method} /internal/cdn/${route} ip=${req.ip ?? "?"} querySecret=${
        typeof req.query.secret === "string" ? "yes" : "no"
      } headerSecret=${typeof req.headers["x-cdn-secret"] === "string" ? "yes" : "no"}`
    );
    const provided =
      (typeof req.headers["x-cdn-secret"] === "string"
        ? (req.headers["x-cdn-secret"] as string)
        : "") ||
      (typeof req.query.secret === "string" ? req.query.secret : "");
    // A blank CDN_CALLBACK_SECRET fails closed: CDN edge IPs are not stable, so
    // this secret is the only thing standing between a stranger and our stream
    // state machine.
    if (
      !env.CDN_CALLBACK_SECRET ||
      !provided ||
      !safeEqual(provided, env.CDN_CALLBACK_SECRET)
    ) {
      logger.warn(`CDN ${route} rejected: bad/missing secret`);
      res.status(403).send("1");
      return null;
    }
    // Body wins over query: if the console is configured to POST, that is the
    // authoritative copy, and a query parameter of the same name would be the
    // stale one.
    return {
      ...(req.query as Record<string, unknown>),
      ...((req.body ?? {}) as Record<string, unknown>),
    };
  }

  /**
   * Stream started. Answers 200 regardless of what we did with it: the vendor
   * documents no retry, so a 5xx would only lose the event and page someone.
   */
  router.all("/cdn/start", (req: Request, res: Response) => {
    void (async () => {
      const params = authorize(req, res, "start");
      if (!params) return;

      const name = str(params.id);
      const appName = str(params.appname);
      logger.info(
        `AIMESS_CDN_CALLBACK start ${req.method} — ${dumpParams(params)}`
      );
      logger.info(
        `CDN stream start — stream=${digestKey(name)} app=${appName || "?"} host=${str(params.app) || "?"} clientIp=${str(params.ip) || "?"} edge=${str(params.node) || "?"} eventMs=${eventMs(params)}`
      );
      if (!name) {
        logger.warn("CDN start callback carried no stream name");
        res.send("0");
        return;
      }
      // Another application on the same domain is not ours to act on.
      if (appName && appName !== env.CDN_APP) {
        logger.warn(
          `CDN start ignored: app=${appName} is not ${env.CDN_APP}`
        );
        res.send("0");
        return;
      }

      try {
        await livestreamService.handleCdnStart(name, eventMs(params));
      } catch (error) {
        logger.warn(`CDN start handling failed: ${String(error)}`);
      }
      res.send("0");
    })();
  });

  /** Stream ended (publisher disconnected). Same reply discipline as start. */
  router.all("/cdn/end", (req: Request, res: Response) => {
    void (async () => {
      const params = authorize(req, res, "end");
      if (!params) return;

      const name = str(params.id);
      const appName = str(params.appname);
      logger.info(
        `AIMESS_CDN_CALLBACK end ${req.method} — ${dumpParams(params)}`
      );
      logger.info(
        `CDN stream end — stream=${digestKey(name)} app=${appName || "?"} clientIp=${str(params.ip) || "?"} edge=${str(params.node) || "?"} eventMs=${eventMs(params)}`
      );
      if (!name) {
        logger.warn("CDN end callback carried no stream name");
        res.send("0");
        return;
      }
      if (appName && appName !== env.CDN_APP) {
        logger.warn(`CDN end ignored: app=${appName} is not ${env.CDN_APP}`);
        res.send("0");
        return;
      }

      try {
        await livestreamService.handleCdnEnd(name, eventMs(params));
      } catch (error) {
        logger.warn(`CDN end handling failed: ${String(error)}`);
      }
      res.send("0");
    })();
  });

  /**
   * Remote authentication — the publish gate.
   *
   * Allow is `200` with body `0`, deny is `403` with body `1`. The vendor
   * documents the decision as configurable on either the status code or the
   * response body, so this is the one shape both readings agree on.
   *
   * An internal failure DENIES. This endpoint is the only publish gate the CDN
   * has, and failing open on an error would let a banned host or an ended
   * stream back on air.
   */
  router.all("/cdn/auth", (req: Request, res: Response) => {
    void (async () => {
      const params = authorize(req, res, "auth");
      if (!params) return;

      // The stream identifier's parameter name differs by console feature:
      // Origin Authentication (this dialog) sends it as `channel`, the status
      // callbacks send `id`, and the public docs call it `streamName`. Accept
      // all three. `channel` is often the full path (`push…/live/<name>` or an
      // `rtmp://…/<name>?secret=…` URL), so drop any query string and take the
      // last path segment — leaving the bare playbackId `findBySrsName` expects.
      const rawName =
        str(params.streamName) || str(params.id) || str(params.channel);
      const name = rawName.split("?")[0].split("/").filter(Boolean).pop() ?? "";
      // Application name arrives as `app` under Origin Authentication but as
      // `appname` under the status callbacks — read whichever is present.
      const appName =
        str(params.appName) || str(params.app) || str(params.appname);
      logger.info(
        `AIMESS_CDN_CALLBACK auth ${req.method} — ${dumpParams(params)}`
      );
      logger.info(
        `CDN publish auth — stream=${digestKey(name)} app=${appName || "?"} clientIp=${str(params.ip) || "?"} type=${str(params.type) || "?"}`
      );
      if (!name || (appName && appName !== env.CDN_APP)) {
        res.status(403).send("1");
        return;
      }

      let allowed = false;
      try {
        allowed = await livestreamService.authorizeCdnPublish({
          streamName: name,
          url: str(params.url),
        });
      } catch (error) {
        logger.warn(`CDN publish auth failed closed: ${String(error)}`);
      }
      if (allowed) res.send("0");
      else res.status(403).send("1");
    })();
  });

  return router;
}
