import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { auditContextMiddleware } from "@aimess/constants";
import { localeMiddleware, notFoundHandler } from "@aimess/utils";

import { internalRoutes } from "./api/routes/internal.routes.js";
import { serviceRoutes } from "./api/routes/index.js";
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
  // Establishes the ambient audit context (client source + IP + user-agent) for
  // every request below it, so audit rows written deep in a service know where
  // the action came from without threading a parameter through each call site.
  app.use(auditContextMiddleware);

  app.use("/health", healthRouter);
  // Unauthenticated service-to-service surface (shared-secret guarded). Mounted
  // OUTSIDE /api/v1 so it isn't reachable through the gateway's public proxy.
  app.use("/internal", internalRoutes);
  app.use("/api/v1", serviceRoutes);

  // Terminates the chain so an unmatched path answers with the JSON envelope
  // instead of falling through to Express's HTML `finalhandler`.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app: Express = createApp();
