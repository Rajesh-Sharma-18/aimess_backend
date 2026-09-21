import express, { Router, type IRouter, type Request } from "express";
import { logger } from "@aimess/logger";
import { sendApiError } from "@aimess/utils";

import { env } from "../config/env.js";
import { srsHookRateLimiter } from "../middleware/rate-limit.js";

/** Same budget as the SRS hook proxy: a DB read, a check and a write upstream. */
const CDN_CALLBACK_TIMEOUT_MS = 5000;

/** The three console-configured endpoints, forwarded verbatim upstream. */
const CDN_ROUTES = ["/cdn/start", "/cdn/end", "/cdn/auth"] as const;

/**
 * Upstream URL with `secret` STRIPPED from the forwarded query.
 *
 * The CDNetworks console has no field for custom headers, so the shared secret
 * can only travel in the callback URL — and a query string is written down by
 * every hop that logs a URL. It is re-attached as `x-cdn-secret` for the
 * upstream leg instead, exactly as `srsHookUrl` does for SRS. Every other
 * parameter is preserved: for a GET-configured callback they ARE the payload.
 */
export function cdnCallbackUrl(req: Request, path: string): string {
  const base = env.STREAM_SERVICE_URL?.replace(/\/$/, "") ?? "";
  const queryIndex = req.originalUrl.indexOf("?");
  if (queryIndex < 0) return `${base}/internal${path}`;
  const params = new URLSearchParams(req.originalUrl.slice(queryIndex + 1));
  params.delete("secret");
  const query = params.toString();
  return `${base}/internal${path}${query ? `?${query}` : ""}`;
}

/**
 * Narrow unauthenticated edge routes for CDNetworks live callbacks.
 *
 * Mirrors `createInternalSrsRouter`, with three differences forced by the
 * vendor:
 * - the console can be set to GET or POST per callback, so each route is
 *   registered with `router.all` and the method is forwarded as received;
 * - payloads are a handful of parameters, not a JSON hook body, so the raw
 *   body cap is 64kb rather than 1mb;
 * - the publish-auth route's answer decides whether a broadcast is accepted,
 *   so the upstream status and body are relayed unchanged.
 */
export function createInternalCdnRouter(): IRouter {
  const router: IRouter = Router();

  for (const path of CDN_ROUTES) {
    router.all(
      path,
      // Shares the SRS hook bucket: both are IP-scoped and CDN edge nodes are
      // different IPs from the SRS host, so a separate rule would buy nothing.
      srsHookRateLimiter,
      express.raw({ type: "*/*", limit: "64kb" }),
      (req, res) => {
        void (async () => {
          if (!env.STREAM_SERVICE_URL) {
            sendApiError(req, res, {
              statusCode: 503,
              messageKey: "SERVICE_UNAVAILABLE",
            });
            return;
          }

          const secret =
            req.get("x-cdn-secret") ||
            (typeof req.query.secret === "string" ? req.query.secret : "");

          // Refuse before logging anything request-controlled; the value itself
          // is verified upstream against CDN_CALLBACK_SECRET.
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

          const headers: Record<string, string> = {
            "content-type": req.get("content-type") || "application/json",
            "x-cdn-secret": secret,
          };

          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            CDN_CALLBACK_TIMEOUT_MS
          );
          try {
            const upstream = await fetch(cdnCallbackUrl(req, path), {
              method: req.method,
              headers,
              // GET/HEAD cannot carry one, and the parameters are in the query
              // for those anyway.
              body:
                req.method === "GET" || req.method === "HEAD"
                  ? undefined
                  : bodyText,
              signal: controller.signal,
            });
            const text = await upstream.text();
            res
              .status(upstream.status)
              .type(upstream.headers.get("content-type") || "text/plain")
              .send(text);
          } catch (error) {
            logger.error(`CDN callback proxy failed for ${path}: ${String(error)}`);
            sendApiError(req, res, {
              statusCode: 503,
              messageKey: "SERVICE_UNAVAILABLE",
              retryAfterSec: 5,
            });
          } finally {
            clearTimeout(timeout);
          }
        })();
      }
    );
  }

  return router;
}
