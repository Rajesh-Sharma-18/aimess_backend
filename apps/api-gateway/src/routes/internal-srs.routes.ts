import { createHash } from "node:crypto";

import express, { Router, type IRouter, type Request } from "express";
import { logger } from "@aimess/logger";
import { sendApiError } from "@aimess/utils";

import { env } from "../config/env.js";
import { srsHookRateLimiter } from "../middleware/rate-limit.js";

/**
 * Upstream URL, with `secret` STRIPPED from the forwarded query.
 *
 * SRS can only carry the shared secret in the hook URL's query string, so it
 * unavoidably reaches this gateway that way — and a query string is written
 * down by every hop that logs a URL (reverse proxy, CDN, APM). Re-attaching it
 * as `x-srs-secret` for the upstream leg keeps it out of stream-service's own
 * access logs and any hop between the two, and stops it being copied further.
 * Anyone who reads those logs can otherwise forge on_publish / on_unpublish
 * hooks and mark arbitrary streams live or dead.
 *
 * Every OTHER query parameter is preserved verbatim, because stream-service
 * reads them.
 */
export function srsHookUrl(req: Request): string {
  const base = env.STREAM_SERVICE_URL?.replace(/\/$/, "") ?? "";
  const queryIndex = req.originalUrl.indexOf("?");
  if (queryIndex < 0) return `${base}/internal/srs/hooks`;
  const params = new URLSearchParams(req.originalUrl.slice(queryIndex + 1));
  params.delete("secret");
  const query = params.toString();
  return `${base}/internal/srs/hooks${query ? `?${query}` : ""}`;
}

/**
 * Short, non-reversible tag for a stream key.
 *
 * The SRS stream name is the publish credential: anyone who reads it can point
 * their own encoder at the ingest endpoint and take over the broadcast. It was
 * logged verbatim on every hook — several lines per stream, plus one per
 * viewer (`on_play`) — so log access was broadcast-takeover access.
 */
function digestKey(value: string | undefined): string {
  if (!value) return "none";
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function parseHookBody(bodyText: string): {
  action?: string;
  app?: string;
  stream?: string;
} {
  try {
    const parsed = JSON.parse(bodyText) as {
      action?: unknown;
      app?: unknown;
      stream?: unknown;
    };
    return {
      action: typeof parsed.action === "string" ? parsed.action : undefined,
      app: typeof parsed.app === "string" ? parsed.app : undefined,
      stream: typeof parsed.stream === "string" ? parsed.stream : undefined,
    };
  } catch {
    return {};
  }
}

function logGatewayHookBanner(message: string): void {
  logger.info("========== AIMESS_SRS_HOOK_GATEWAY ==========");
  logger.info(message);
  logger.info("========== AIMESS_SRS_HOOK_GATEWAY_END ======");
}

/**
 * Narrow unauthenticated edge route for SRS HTTP callbacks.
 *
 * This intentionally exposes only POST /internal/srs/hooks through the API
 * domain, then forwards to stream-service's existing internal hook endpoint.
 * SRS cannot attach a user JWT; stream-service validates SRS_HOOK_SECRET when
 * configured, via ?secret=... or x-srs-secret.
 */
export function createInternalSrsRouter(): IRouter {
  const router: IRouter = Router();

  router.post(
    "/srs/hooks",
    // Own bucket — this route is exempt from the global limiter, which would
    // collapse every stream's hooks into one IP bucket. See srsHookRateLimiter.
    srsHookRateLimiter,
    express.raw({ type: "*/*", limit: "1mb" }),
    (req, res) => {
      void (async () => {
        if (!env.STREAM_SERVICE_URL) {
          sendApiError(req, res, {
            statusCode: 503,
            messageKey: "SERVICE_UNAVAILABLE",
          });
          return;
        }

        // SRS cannot set custom headers on its hook requests, so it sends the
        // secret as `?secret=`. Accept it there, then forward it as a HEADER —
        // so it never reaches an upstream access log — and strip it from the
        // forwarded query (see `srsHookUrl`).
        const secret =
          req.get("x-srs-secret") ||
          (typeof req.query.secret === "string" ? req.query.secret : "");

        // Refuse before logging anything. The banner below used to run first
        // and unconditionally, so an unauthenticated caller could write
        // attacker-chosen `action` / `app` / `stream` strings into the log, and
        // every authenticated hook printed the raw stream name — which is the
        // publish credential.
        if (!secret) {
          sendApiError(req, res, {
            statusCode: 403,
            messageKey: "FORBIDDEN",
          });
          return;
        }

        const bodyText = Buffer.isBuffer(req.body)
          ? req.body.toString("utf8")
          : String(req.body ?? "");
        const hook = parseHookBody(bodyText);
        logGatewayHookBanner(
          `HIT /internal/srs/hooks action=${hook.action ?? "?"} app=${
            hook.app ?? "?"
          } stream=${digestKey(hook.stream)} ip=${req.ip ?? "?"} querySecret=${
            typeof req.query.secret === "string" ? "yes" : "no"
          } headerSecret=${req.get("x-srs-secret") ? "yes" : "no"}`
        );

        const headers: Record<string, string> = {
          "content-type": req.get("content-type") || "application/json",
          "x-srs-secret": secret,
        };

        try {
          const upstream = await fetch(srsHookUrl(req), {
            method: "POST",
            headers,
            body: bodyText,
          });
          const text = await upstream.text();
          logGatewayHookBanner(
            `FORWARDED_TO_STREAM_SERVICE status=${upstream.status} body=${text}`
          );
          res
            .status(upstream.status)
            .type(upstream.headers.get("content-type") || "application/json")
            .send(text);
        } catch (error) {
          logger.error(`SRS hook proxy failed: ${String(error)}`);
          sendApiError(req, res, {
            statusCode: 503,
            messageKey: "SERVICE_UNAVAILABLE",
            retryAfterSec: 5,
          });
        }
      })();
    }
  );

  return router;
}
