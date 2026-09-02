import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { auditContextMiddleware } from "@aimess/constants";
import { localeMiddleware } from "@aimess/utils";
import { NotFoundError } from "@aimess/errors";

import { env, isCorsOriginAllowed } from "./config/env.js";
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
import { createLiveKitWebhookRouter } from "./routes/livekit-webhook.routes.js";
import type { MessagingClient } from "./grpc/clients/messaging.client.js";
import type { MediaClient } from "./grpc/clients/media.client.js";

const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    if (isCorsOriginAllowed(origin)) {
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
  // Resolve `x-lang` / `Accept-Language` once, before anything that answers a
  // request itself or fans out to gRPC (the proxied routes forward the raw
  // header onward, so downstream services still resolve it independently).
  app.use(localeMiddleware);
  // Establishes the ambient audit context (client source + IP + user-agent) for
  // every request below it, so audit rows written deep in a service know where
  // the action came from without threading a parameter through each call site.
  app.use(auditContextMiddleware);

  // Rate limiting comes FIRST. Express runs middleware in mount order, so
  // anything mounted above this line is answered without ever being counted —
  // and the two routes below are the gateway's only unauthenticated public
  // surfaces: the link host fans out to community-service/chat-service to build
  // an OG card for an attacker-supplied handle, and /internal/srs/hooks accepts
  // a 1 MB body and forwards it upstream. Both were unmetered amplifiers while
  // they sat above the limiter.
  app.use(rateLimiter);

  // Dedicated community link host (aimess.me): .well-known proofs + "Open in
  // app" preview. Host-gated — non-link hosts pass straight through to the API.
  // Mounted before the API so link traffic isn't proxied.
  app.use(createLinkHostRouter());

  // SRS server callbacks. No user JWT; stream-service validates SRS_HOOK_SECRET.
  app.use("/internal", createInternalSrsRouter());

  setupSwagger(app);
  setupAsyncApiDocs(app);

  app.use("/health", healthRouter);

  // LiveKit signed webhooks. Mounted BEFORE express.json — the raw request body
  // is required for signature verification (see routes/livekit-webhook.routes.ts).
  app.use("/livekit", createLiveKitWebhookRouter(messagingClient));

  // Admin surface â€” proxied to backoffice-service. Mounted BEFORE express.json
  // (proxy must forward the raw body) and before the generic /api mount.
  app.use("/admin", createAdminRouter());

  // Versioned API proxies (before body parser so POST JSON forwards correctly)
  app.use("/api", createApiRouter(messagingClient));

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // Terminal 404. Without it an unmatched path falls through to Express's own
  // finalhandler, which answers with an HTML body ("Cannot GET /api/v1/nope") —
  // so a client that mistypes a route, or hits one that was removed, gets HTML
  // where the documented `{ success, message }` envelope was promised and its
  // JSON parse blows up instead of surfacing the real problem. `errorHandler`
  // never saw these: nothing called `next(err)`.
  app.use((_req, _res, next) => next(new NotFoundError("ROUTE_NOT_FOUND")));

  app.use(errorHandler);

  return app;
}
