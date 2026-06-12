import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { localeMiddleware } from "@aimess/utils";

import { createMediaRoutes } from "./api/routes/media.routes.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRoutes } from "./routes/health.routes.js";
import { env } from "./config/env.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin:
        env.CORS_ALLOWED_ORIGINS === "*"
          ? "*"
          : env.CORS_ALLOWED_ORIGINS.split(","),
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(localeMiddleware);

  app.use("/", createHealthRoutes());
  app.use("/api/v1/media", createMediaRoutes());

  app.use(errorHandler);

  return app;
}

export const app: Express = createApp();
