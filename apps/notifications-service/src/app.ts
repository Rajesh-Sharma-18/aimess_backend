import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";

import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.routes.js";
import { testPushRouter } from "./routes/test-push.routes.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.use("/health", healthRouter);

  // Dev-only test endpoint. Internal — not exposed via the API gateway.
  if (env.NODE_ENV === "development") {
    app.use("/test", testPushRouter);
  }

  return app;
}

export const app: Express = createApp();
