import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import helmet from "helmet";

import { env, getCorsAllowedOrigins } from "./config/env.js";
import { setupSwagger } from "./docs/swagger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { createApiRouter } from "./routes/api.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import type { MessagingClient } from "./grpc/clients/messaging.client.js";

const corsOptions = {
  origin: getCorsAllowedOrigins(),
  credentials: true,
} satisfies CorsOptions;

export function createApp(messagingClient: MessagingClient): Express {
  const app = express();

  app.disable("x-powered-by");

  if (env.TRUST_PROXY_HOPS > 0) {
    app.set("trust proxy", env.TRUST_PROXY_HOPS);
  }

  app.use(
    helmet({
      // Swagger UI needs inline scripts/styles
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(cors(corsOptions));

  app.use(requestIdMiddleware);
  app.use(rateLimiter);

  setupSwagger(app);

  app.use("/health", healthRouter);

  // Versioned API proxies (before body parser so POST JSON forwards correctly)
  app.use("/api", createApiRouter(messagingClient));

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.use(errorHandler);

  return app;
}
