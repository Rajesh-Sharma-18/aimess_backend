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
 * Rewrites `/login` → `/api/auth/login` (Express strips the mount path before proxying).
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
      return `${downstreamPrefix}${suffix}`;
    },
    on: {
      error: (error, _req, res) => {
        logger.error(`${options.serviceName} proxy error`);
        logger.error(error);

        if (res && "writeHead" in res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: false,
              message: `${options.serviceName} service unavailable`,
            })
          );
        }
      },
    },
  });
}
