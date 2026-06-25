import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { localeMiddleware } from "@aimess/utils";

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

  app.use("/health", healthRouter);
  // Un-authenticated SRS callbacks — NOT routed through the gateway.
  app.use("/internal", createInternalRoutes(deps.livestreamService));
  app.use("/api/v1", createServiceRoutes(deps.controller));

  app.use(errorHandler);

  return app;
}
