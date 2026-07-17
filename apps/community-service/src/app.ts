import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { localeMiddleware } from "@aimess/utils";

import { internalRoutes } from "./api/routes/internal.routes.js";
import { serviceRoutes, serviceV2Routes } from "./api/routes/index.js";
import { errorHandler } from "./middleware/error-handler.js";
import { healthRouter } from "./routes/health.routes.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(localeMiddleware);

  app.use("/health", healthRouter);
  // Unauthenticated service-to-service surface (shared-secret guarded). Mounted
  // OUTSIDE /api/v1 so it isn't reachable through the gateway's public proxy.
  app.use("/internal", internalRoutes);
  app.use("/api/v1", serviceRoutes);
  // Additive V2 surface (gateway rewrites `/api/v2/communities/*` here).
  app.use("/api/v2", serviceV2Routes);

  app.use(errorHandler);

  return app;
}

export const app: Express = createApp();
