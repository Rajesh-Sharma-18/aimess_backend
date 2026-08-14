import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { AUDIT_SOURCES, createAuditContextMiddleware } from "@aimess/constants";
import { localeMiddleware } from "@aimess/utils";

import { serviceRoutes } from "./api/routes/index.js";
import { env } from "./config/env.js";
import { bootstrapHealthChecks } from "./lib/health.bootstrap.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { healthRouter } from "./routes/health.routes.js";

export function createApp(): Express {
  // Registers every System Health service/infrastructure probe exactly once,
  // before routes are mounted.
  bootstrapHealthChecks();

  const app = express();

  app.disable("x-powered-by");

  if (env.TRUST_PROXY_HOPS > 0) {
    app.set("trust proxy", env.TRUST_PROXY_HOPS);
  }

  app.use(helmet());

  // Allow all origins in development for admin panel access from different IPs
  app.use(
    cors({
      origin:
        env.NODE_ENV === "development"
          ? true
          : env.CORS_ALLOWED_ORIGINS.split(",")
              .map((o) => o.trim())
              .filter(Boolean),
      credentials: true,
      methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
      // allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(localeMiddleware);
  // Establishes the ambient audit context (client source + IP + user-agent) for
  // every request below it, so audit rows written deep in a service know where
  // the action came from without threading a parameter through each call site.
  // Pinned: this service has exactly one client, and the pin also rides the gRPC
  // hop, so a community closed from the panel is audited as ADMIN_PANEL in
  // community-service too — not as the admin's browser.
  app.use(createAuditContextMiddleware(AUDIT_SOURCES.ADMIN_PANEL));

  // Direct infra/k8s probes hit `/health`; the gateway-proxied admin surface
  // reaches the same probes at `/v1/health` (it strips `/admin`, so the spec's
  // `/admin/v1/health` lands here).
  app.use("/health", healthRouter);
  app.use("/v1/health", healthRouter);

  // Gateway strips `/admin` and proxies to `:3010/v1/*`, so mount at `/v1`.
  app.use("/v1", serviceRoutes);

  // Terminal 404 for any unmatched route — JSON, never HTML.
  app.use(notFound);

  app.use(errorHandler);

  return app;
}

export const app: Express = createApp();
