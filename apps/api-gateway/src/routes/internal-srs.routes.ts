import express, { Router, type IRouter, type Request } from "express";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

function srsHookUrl(req: Request): string {
  const base = env.STREAM_SERVICE_URL?.replace(/\/$/, "") ?? "";
  const queryIndex = req.originalUrl.indexOf("?");
  const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
  return `${base}/internal/srs/hooks${query}`;
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
    express.raw({ type: "*/*", limit: "1mb" }),
    (req, res) => {
      void (async () => {
        if (!env.STREAM_SERVICE_URL) {
          res.status(503).json({
            success: false,
            message: "Stream service is not configured.",
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
          } stream=${hook.stream ?? "?"} ip=${req.ip ?? "?"} querySecret=${
            typeof req.query.secret === "string" ? "yes" : "no"
          } headerSecret=${req.get("x-srs-secret") ? "yes" : "no"}`
        );

        const headers: Record<string, string> = {
          "content-type": req.get("content-type") || "application/json",
        };
        const secret = req.get("x-srs-secret");
        if (secret) headers["x-srs-secret"] = secret;

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
          res.status(502).json({
            success: false,
            message: "Stream service temporarily unavailable.",
          });
        }
      })();
    }
  );

  return router;
}
