import { logger } from "@aimess/logger";
import type { RequestHandler } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

export type ServiceProxyOptions = {
  target: string;
  /** Path prefix on the downstream service (e.g. `/api/auth`). */
  downstreamPrefix: string;
  serviceName: string;
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
      error: (error, _req, res) => {
        logger.error(`${options.serviceName} proxy error`);
        logger.error(error);

        if (res && "writeHead" in res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: false,
              message:
                "Service temporarily unavailable. Please try again later.",
            })
          );
        }
      },
    },
  });
}
