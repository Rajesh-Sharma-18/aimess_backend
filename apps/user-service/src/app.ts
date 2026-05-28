import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { localeMiddleware } from "@aimess/utils";

import { userRoutes } from "./api/routes/index.js";
import { internalRoutes } from "./api/routes/internal.routes.js";
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
  app.use("/api/internal", internalRoutes);
  app.use("/api/v1/users", userRoutes);

  app.use(errorHandler);

  return app;
}

export const app: Express = createApp();
