import type { Request, RequestHandler, Response } from "express";

import { logger } from "@aimess/logger";
import { sendApiError } from "@aimess/utils";

/**
 * Hard ceiling on a proxied request body.
 *
 * `express.json({ limit: "1mb" })` is mounted BELOW the `/admin` and `/api`
 * proxies, and Express middleware only runs on routes reached before the
 * handler that answers. http-proxy-middleware streams the raw body upstream and
 * answers the request itself, so those parsers only ever saw traffic that fell
 * through to the 404 handler — no size limit was applied to a single proxied
 * request. The production HAProxy edge sets no body cap either. An
 * unauthenticated caller could POST a multi-gigabyte body to
 * `/api/v1/auth/login` and hold gateway and upstream sockets and memory until
 * the downstream parser finally aborted, one connection per request.
 *
 * Two checks, because either alone is insufficient:
 *
 *  - `Content-Length`, when present, is refused up front, before a single byte
 *    of payload is read.
 *  - A chunked request has no `Content-Length`, so the stream is metered as it
 *    arrives and destroyed the moment it passes the cap. Without this, the
 *    header check is trivially skipped with `Transfer-Encoding: chunked`.
 *
 * The default is 1 MB, matching the parsers below the proxies and the
 * Socket.IO frame cap. Chat needs more headroom than that for a message with
 * several attachment descriptors, so its mount passes a larger value — the
 * limit is per-mount rather than global for exactly that reason.
 */
export function createBodySizeLimit(maxBytes: number): RequestHandler {
  return (req: Request, res: Response, next) => {
    const reject = (observed: number | undefined) => {
      logger.warn("request_body_too_large", {
        service: "api-gateway",
        method: req.method,
        endpoint: req.originalUrl.split("?")[0],
        ip: req.ip,
        limitBytes: maxBytes,
        ...(observed !== undefined ? { observedBytes: observed } : {}),
      });
      sendApiError(req, res, {
        statusCode: 413,
        messageKey: "PAYLOAD_TOO_LARGE",
      });
    };

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(declared);
      // Stop reading: the client may still be sending, and we do not want it.
      req.destroy();
      return;
    }

    // No declared length (chunked) — meter the stream itself.
    if (!Number.isFinite(declared)) {
      let received = 0;
      const onData = (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          req.removeListener("data", onData);
          if (!res.headersSent) reject(received);
          req.destroy();
        }
      };
      req.on("data", onData);
      // The proxy re-reads the stream, so stop metering once it is consumed.
      req.once("end", () => req.removeListener("data", onData));
      req.once("close", () => req.removeListener("data", onData));
    }

    next();
  };
}
