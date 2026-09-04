import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { auditContextMiddleware } from "@aimess/constants";
import { localeMiddleware } from "@aimess/utils";
import { NotFoundError } from "@aimess/errors";

import { env, isCorsOriginAllowed } from "./config/env.js";
import { setupAsyncApiDocs } from "./docs/asyncapi.js";
import { setupSwagger } from "./docs/swagger.js";
import { createBodySizeLimit } from "./middleware/body-size-limit.js";
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
      // Name the origin: without it the log says only that SOMETHING was
      // refused, and the one fact needed to fix the allowlist is the one fact
      // missing.
      callback(new Error(`Not allowed by CORS: ${origin ?? "<none>"}`));
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

  // Unconditional: Express accepts 0 as "trust no proxy", which is exactly the
  // direct-client case the old `> 0` guard was trying to express. Leaving the
  // setting unapplied did not mean "no proxies" — it meant `req.ip` silently
  // ignored hop counting everywhere, which is why several call sites went off
  // and hand-parsed `X-Forwarded-For` themselves and took the LEFTMOST entry,
  // the one the client controls. `req.ip` is now the single source of client
  // identity for rate limiting, the admin allowlist and audit rows.
  app.set("trust proxy", env.TRUST_PROXY_HOPS);

  // CSP was disabled globally so that Swagger UI — a development tool — could
  // render its inline scripts, which left the whole API origin with no CSP at
  // all. The exemption now covers only the docs mount; everything else gets
  // helmet's default policy. This origin serves JSON, so a restrictive policy
  // costs nothing here and is a real second line of defence for the docs and
  // any HTML the edge ever grows.
  app.use(
    "/docs",
    helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false })
  );
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // An API origin should never be framed, never load third-party
          // script, and never be a form target.
          "default-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          "form-action": ["'none'"],
          "base-uri": ["'none'"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          upgradeInsecureRequests: [],
        },
      },
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

  // Rate limiter FIRST. It used to sit below the two mounts beneath it, so
  // neither was ever counted: the link host's catch-all fans out to
  // community-service and chat-service to build a preview card for an
  // attacker-supplied handle or invite token — an unauthenticated, unmetered
  // amplifier and a handle-enumeration oracle — and /internal/srs/hooks accepts
  // an unauthenticated 1 MB body and forwards it upstream on every call,
  // rejected or not.
  app.use(rateLimiter);

  // Dedicated community link host (aimess.me): .well-known proofs + "Open in
  // app" preview. Host-gated — non-link hosts pass straight through to the API.
  // Mounted before the API so link traffic isn't proxied.
  app.use(createLinkHostRouter());

  // SRS server callbacks. No user JWT; stream-service validates SRS_HOOK_SECRET.
  app.use("/internal", createInternalSrsRouter());

  // API documentation. Publishing the complete private API surface — every
  // path, parameter and schema, including the admin paths — to anyone who asks
  // is a reconnaissance gift, and the document is rebuilt per request, which
  // made an unauthenticated CPU and bandwidth amplifier out of the only public
  // edge. Non-production only.
  if (env.NODE_ENV !== "production") {
    setupSwagger(app);
    setupAsyncApiDocs(app);
  }

  app.use("/health", healthRouter);

  // LiveKit signed webhooks. Mounted BEFORE express.json — the raw request body
  // is required for signature verification (see routes/livekit-webhook.routes.ts).
  app.use("/livekit", createLiveKitWebhookRouter(messagingClient));

  // Body-size ceiling for the proxied routes. The `express.json` parsers below
  // never see these requests (the proxy answers first), so without this nothing
  // bounded a proxied body at the edge — see middleware/body-size-limit.ts.
  app.use("/admin", createBodySizeLimit(1024 * 1024));
  // Chat carries message payloads with attachment descriptors, so it gets the
  // same 2 MB headroom chat-service itself allows; everything else stays at 1 MB.
  app.use("/api/v1/chat", createBodySizeLimit(2 * 1024 * 1024));
  app.use("/api", createBodySizeLimit(1024 * 1024));

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
