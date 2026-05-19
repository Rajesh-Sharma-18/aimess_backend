import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";

import { serviceRoutes } from "./api/routes/index.js";
import { healthRouter } from "./routes/health.routes.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.use("/health", healthRouter);
  app.use("/api/v1", serviceRoutes);

  return app;
}

export const app: Express = createApp();
