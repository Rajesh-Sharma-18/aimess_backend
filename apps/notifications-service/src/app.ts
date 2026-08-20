import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";

import { localeMiddleware, notFoundHandler } from "@aimess/utils";

import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { deviceRouter } from "./routes/device.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import { testPushRouter } from "./routes/test-push.routes.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(localeMiddleware);

  app.use("/health", healthRouter);

  // Device-token registration (proxied via the API gateway). JWT-authenticated.
  app.use("/v1/devices", deviceRouter);

  // Dev-only test endpoint. Internal — not exposed via the API gateway.
  if (env.NODE_ENV === "development") {
    app.use("/test", testPushRouter);
  }

  // Anything below the routes answers in the shared envelope. The hand-rolled
  // handler this replaces echoed `err.message` of an UNHANDLED throw straight
  // to the client — a stack frame, a query, or a connection string, verbatim.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app: Express = createApp();
