import cors from "cors";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";

import { logger } from "@aimess/logger";

import { env } from "./config/env.js";
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

  app.use("/health", healthRouter);

  // Device-token registration (proxied via the API gateway). JWT-authenticated.
  app.use("/v1/devices", deviceRouter);

  // Dev-only test endpoint. Internal — not exposed via the API gateway.
  if (env.NODE_ENV === "development") {
    app.use("/test", testPushRouter);
  }

  // Minimal error handler — maps @aimess/errors (and auth failures) to JSON.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message =
      err instanceof Error ? err.message : "Internal server error";
    if (statusCode >= 500) logger.error(err);
    res.status(statusCode).json({ success: false, message });
  });

  return app;
}

export const app: Express = createApp();
