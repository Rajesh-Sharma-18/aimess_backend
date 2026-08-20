import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { auditContextMiddleware } from "@aimess/constants";
import { localeMiddleware, notFoundHandler } from "@aimess/utils";

import { createServiceRoutes } from "./api/routes/index.js";
import type { StreamController } from "./api/controllers/index.js";
import type { LivestreamService } from "./services/livestream.service.js";
import { errorHandler } from "./middleware/error-handler.js";
import { healthRouter } from "./routes/health.routes.js";
import { createInternalRoutes } from "./routes/internal.routes.js";

export interface AppDeps {
  controller: StreamController;
  livestreamService: LivestreamService;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(localeMiddleware);
  // Establishes the ambient audit context (client source + IP + user-agent) for
  // every request below it, so audit rows written deep in a service know where
  // the action came from without threading a parameter through each call site.
  app.use(auditContextMiddleware);

  app.use("/health", healthRouter);
  // Un-authenticated SRS callbacks — NOT routed through the gateway.
  app.use("/internal", createInternalRoutes(deps.livestreamService));
  app.use("/api/v1", createServiceRoutes(deps.controller));

  // Terminates the chain so an unmatched path answers with the JSON envelope
  // instead of falling through to Express's HTML `finalhandler`.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
