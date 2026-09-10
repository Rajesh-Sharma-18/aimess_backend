import { logger } from "@aimess/logger";
import type { RequestHandler } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

export type ServiceProxyOptions = {
  target: string;
  /** Path prefix on the downstream service (e.g. `/api/auth`). */
  downstreamPrefix: string;
  serviceName: string;
  /** Upstream response deadline. Defaults to 30s — raise only for streaming routes. */
  proxyTimeoutMs?: number;
};

/**
 * Proxy mounted at `/api/{version}/{segment}`.
 * Rewrites the public gateway path into the downstream service path.
 */
export function createServiceProxy(
  options: ServiceProxyOptions
): RequestHandler {
  const downstreamPrefix = options.downstreamPrefix.replace(/\/$/, "");

  return createProxyMiddleware({
    target: options.target,
    changeOrigin: true,
    // Without these, a hung upstream never fires `on.error`: the socket stays
    // pinned until the client gives up, so the 502 handler below never runs and
    // the caller sees a browser-level timeout with no envelope. `proxyTimeout`
    // bounds the wait for the upstream response; `timeout` bounds the incoming
    // request. Uploads do NOT flow through here (they go direct to MinIO via
    // presigned URLs), so 30s is well clear of any legitimate JSON round trip.
    proxyTimeout: options.proxyTimeoutMs ?? 30_000,
    timeout: options.proxyTimeoutMs ?? 30_000,
    pathRewrite: (path) => {
      const suffix = path.startsWith("/") ? path : `/${path}`;
      const normalizedSuffix =
        suffix.replace(
          new RegExp(`^(/api/v\\d+)?/${options.serviceName}`),
          ""
        ) || "/";
      return `${downstreamPrefix}${normalizedSuffix}`;
    },
    on: {
      /**
       * Tell the downstream service which client this request came from.
       *
       * It could not previously find out. nginx sets `X-Forwarded-For` and the
       * gateway reads it (TRUST_PROXY_HOPS=1), but the gateway does not APPEND
       * itself to that chain, and every downstream service ships with
       * TRUST_PROXY_HOPS=0 — so `req.ip` inside auth-service was the gateway's
       * own container address, identically, for every request from every user
       * on the platform. Each per-IP limiter down there was therefore a single
       * platform-wide bucket: auth-service's login limiter was not "15 failed
       * attempts per address", it was 15 for everyone combined.
       *
       * `setHeader` OVERWRITES, so a client cannot forge this: whatever it
       * sends under this name is replaced with the address the gateway
       * resolved. Downstream services are reachable only from inside the
       * compose network, and the gateway is the only thing that talks to them.
       *
       * Deliberately a header of its own rather than `xfwd: true` on the proxy:
       * `xfwd` would append the gateway's own PEER (nginx) to X-Forwarded-For,
       * which every downstream reader would then have to count hops through,
       * and `X-Forwarded-For` also feeds session/device identity in
       * auth-service. This carries one fact and changes nothing else.
       */
      proxyReq: (proxyReq, req) => {
        const clientIp = (req as { ip?: string }).ip;
        if (clientIp) proxyReq.setHeader("x-client-ip", clientIp);
      },
      proxyRes: (proxyRes) => {
        // The gateway is the SINGLE CORS authority. Downstream services use a
        // bare `cors()` → `Access-Control-Allow-Origin: *`. If that leaks back
        // through the proxy it overrides the gateway's per-origin header and
        // breaks credentialed cross-origin requests for any origin the gateway
        // itself didn't echo (Safari/WebKit: "WildcardOriginNotAllowed").
        // Strip every upstream CORS header so only the gateway's survive.
        for (const key of Object.keys(proxyRes.headers)) {
          if (key.toLowerCase().startsWith("access-control-")) {
            delete proxyRes.headers[key];
          }
        }
      },
      error: (error, req, res) => {
        const requestId = req?.headers?.["x-request-id"];
        const isTimeout =
          (error as NodeJS.ErrnoException).code === "ECONNRESET" ||
          (error as NodeJS.ErrnoException).code === "ETIMEDOUT";

        logger.error(`${options.serviceName} proxy error`, {
          service: "api-gateway",
          upstream: options.serviceName,
          requestId,
          code: (error as NodeJS.ErrnoException).code,
          error,
        });

        if (res && "writeHead" in res && !res.headersSent) {
          // 504 for a deadline, 503 for an unreachable upstream. Both are
          // retryable and the client is told so explicitly; the previous 502
          // carried no code, so a client could not distinguish "try again in a
          // moment" from "this request will never work".
          const statusCode = isTimeout ? 504 : 503;
          const retryAfter = 5;
          res.writeHead(statusCode, {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
          });
          res.end(
            JSON.stringify({
              success: false,
              message:
                "Service temporarily unavailable. Please try again later.",
              error: {
                code: isTimeout ? "TIMEOUT" : "SERVICE_UNAVAILABLE",
                message:
                  "Service temporarily unavailable. Please try again later.",
                retryAfter,
                retryable: true,
                ...(typeof requestId === "string" ? { requestId } : {}),
              },
            })
          );
        }
      },
    },
  });
}
