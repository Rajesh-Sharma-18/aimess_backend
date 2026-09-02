import { createHash } from "node:crypto";

import express, { Router, type IRouter } from "express";
import { logger } from "@aimess/logger";
import { sendApiError } from "@aimess/utils";

import { env } from "../config/env.js";

/**
 * Upstream URL, with NO query string.
 *
 * The query used to be copied verbatim from `req.originalUrl`, and the only key
 * stream-service reads from it is `secret`. That put the shared secret in the
 * URL of a public-facing request, where it is recorded by load balancers, CDNs
 * and any APM that indexes full URLs — and anyone who reads those logs can
 * forge on_publish / on_unpublish hooks and mark arbitrary streams live or
 * dead. Everything stream-service needs is in the request BODY; the secret now
 * travels as a header (see below).
 */
function srsHookUrl(): string {
  const base = env.STREAM_SERVICE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/internal/srs/hooks`;
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

/**
 * A log-safe reference to a stream name.
 *
 * The SRS stream name is the publish credential: anyone who reads it can point
 * their own encoder at the ingest endpoint and take over the broadcast. It was
 * logged verbatim on every hook — several lines per stream, plus one per
 * viewer — so log access was broadcast-takeover access.
 */
function streamRef(name: string | undefined): string {
  if (!name) return "?";
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
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
        // so it never reaches an upstream access log — and drop the query
        // entirely.
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
          } stream=${streamRef(hook.stream)} ip=${req.ip ?? "?"}`
        );

        const headers: Record<string, string> = {
          "content-type": req.get("content-type") || "application/json",
          "x-srs-secret": secret,
        };

        try {
          const upstream = await fetch(srsHookUrl(), {
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
