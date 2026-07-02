import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import helmet from "helmet";

import { env, getCorsAllowedOrigins } from "./config/env.js";
import { setupAsyncApiDocs } from "./docs/asyncapi.js";
import { setupSwagger } from "./docs/swagger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { createAdminRouter } from "./routes/admin.routes.js";
import { createApiRouter } from "./routes/api.routes.js";
import { createLinkHostRouter } from "./routes/linkhost.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import { createInternalSrsRouter } from "./routes/internal-srs.routes.js";
import type { MessagingClient } from "./grpc/clients/messaging.client.js";
import type { MediaClient } from "./grpc/clients/media.client.js";

const allowedOrigins = getCorsAllowedOrigins();
// const allowedHeaders = getCorsAllowedHeaders();

const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    // Allow requests with no origin (like mobile apps, curl requests, etc.)
    if (!origin) {
      return callback(null, true);
    }

    if (env.NODE_ENV === "development") {
      // In development, allow any origin
      callback(null, true);
    } else if (allowedOrigins.includes(origin)) {
      // In production, only allow configured origins
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
} satisfies CorsOptions;

export function createApp(
  messagingClient: MessagingClient,
  mediaClient: MediaClient
): Express {
  const app = express();
  app.locals.mediaClient = mediaClient;

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

  // Dedicated community link host (aimess.me): .well-known proofs + "Open in
  // app" preview. Host-gated — non-link hosts pass straight through to the API.
  // Mounted before the rate limiter / API so link traffic isn't proxied.
  app.use(createLinkHostRouter());

  // SRS server callbacks. No user JWT; stream-service validates SRS_HOOK_SECRET.
  app.use("/internal", createInternalSrsRouter());

  app.use(rateLimiter);

  setupSwagger(app);
  setupAsyncApiDocs(app);

  app.use("/health", healthRouter);

  // Admin surface â€” proxied to backoffice-service. Mounted BEFORE express.json
  // (proxy must forward the raw body) and before the generic /api mount.
  app.use("/admin", createAdminRouter());

  // Versioned API proxies (before body parser so POST JSON forwards correctly)
  app.use("/api", createApiRouter(messagingClient));

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.use(errorHandler);

  return app;
}
