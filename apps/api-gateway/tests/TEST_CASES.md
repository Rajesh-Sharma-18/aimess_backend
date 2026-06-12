# api-gateway — Test Cases

Service: **api-gateway** (edge / BFF). Repo: `apps/api-gateway`.

The gateway is mostly a **router + proxy + edge-auth** layer. It owns only a
small number of routes it handles locally; everything else is reverse-proxied to
a downstream microservice via `http-proxy-middleware`. This doc covers every
endpoint surface the gateway exposes, plus the cross-cutting middleware
behaviour that the same routes exercise.

App is built by `createApp(messagingClient)` (factory; no default `app`) in
`apps/api-gateway/src/app.ts`. Middleware order (`app.ts:46-79`):
`x-powered-by off → helmet → cors → requestId → global rateLimiter → swagger →
asyncapi → /health → /admin (proxy) → /api (proxy + local routes) →
express.json(1mb) → express.urlencoded(1mb) → errorHandler`.

> Note: `express.json` is registered **after** the `/admin` and `/api` mounts
> (`app.ts:71-77`) so the proxies forward the raw request body. Only routes that
> mount their **own** body parser (e.g. `/api/v1/app-version/check`) see a parsed
> `req.body`.

Legend:

- **[EXECUTED]** — a Jest test asserts this case.
- **[DOC-ONLY]** — described from code, no automated test (reason noted).

Envelope contract (verified in code):

- Local success: `{ success, message, data }` via `@aimess/utils ApiResponse`
  (`ApiResponse` always sets `success: true`; for graceful-failure responses
  `data` is `null` but `success` stays `true` — see RTC 503 below).
- Local error (AppError): `{ success: false, message }` via
  `middleware/error-handler.ts` (localized via `@aimess/constants t()`).
- Edge-auth / IP / proxy-down rejections: `{ success: false, message }` authored
  inline in the relevant middleware/route.
- Proxied responses: body comes from the downstream service; the gateway only
  strips upstream `Access-Control-*` headers (`proxy/create-service-proxy.ts:41`).

---

## 1. `GET /health` — Liveness

- **File:** `src/routes/health.routes.ts`
- **Description:** Static liveness probe. Returns the "running" envelope.
- **Preconditions:** none (public, unauthenticated, rate-limit-exempt).
- **Auth:** none.

| Case                                                                                 | Type     | Expected      | Status                                                  |
| ------------------------------------------------------------------------------------ | -------- | ------------- | ------------------------------------------------------- |
| GET /health returns running envelope `{success:true, message:"API Gateway Running"}` | Positive | 200           | **[EXECUTED]** `health/health.test.ts`, `smoke.test.ts` |
| Response carries a fresh `x-request-id` header (uuid v4 shape)                       | Positive | 200 + header  | **[EXECUTED]** `health.test.ts`                         |
| A distinct `x-request-id` per request                                                | Edge     | 200           | **[EXECUTED]** `health.test.ts`                         |
| Exempt from the global rate limiter (50 rapid hits all 200)                          | Edge     | 200×N         | **[EXECUTED]** `health.test.ts`                         |
| `x-powered-by` is hidden (`app.disable`)                                             | Security | header absent | **[EXECUTED]** `health.test.ts`                         |
| helmet headers present (`x-content-type-options: nosniff`, dns-prefetch)             | Security | 200 + headers | **[EXECUTED]** `health.test.ts`                         |
| `POST /health` (no POST handler)                                                     | Negative | 404           | **[EXECUTED]** `health.test.ts`                         |
| Unknown top-level path → catch-all 404                                               | Negative | 404           | **[EXECUTED]** `health.test.ts`                         |

Expected response structure (positive): `{ success: true, message: string }`
(no `data` key — health does not use `ApiResponse`).

---

## 2. `POST /api/v1/app-version/check` — Mobile force-update check

- **Files:** `src/routes/v1/app-version.routes.ts`,
  `src/app-version/app-version.controller.ts`,
  `src/app-version/app-version.service.ts`,
  `src/app-version/app-version.validator.ts`,
  `src/app-version/version-format.ts`, `src/app-version/compare-version.ts`
- **Description:** Only request-body-driven, locally-computed gateway endpoint
  (no proxy). Compares a client `version` against the per-platform policy and
  returns `forceUpdate` / `optionalUpdate` / `isUpToDate` flags.
- **Preconditions:** policy config loaded (file or env defaults). In tests the
  store is mocked to env defaults (android/ios mandatory=optional=`1.0.0`).
- **Auth:** none (public).
- **Body parser:** its own `express.json({ limit: "32kb" })`
  (`app-version.routes.ts:8`).
- **Rate limit:** **exempt** — `skipRateLimit()` matches `/app-version/check`
  (`middleware/rate-limit.ts:7-14`).
- **Validation:** Zod `checkAppVersionSchema` — `platform ∈ {android, ios}`,
  `version` trimmed, non-empty, `major.minor.patch` (1–5 digits each).

| Case                                                                                                  | Type           | Input                                       | Expected                | Status                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| up-to-date android (version == policy) → `isUpToDate:true`                                            | Positive       | `{android, 1.0.0}`                          | 200                     | **[EXECUTED]** `app-version/check.test.ts`                                                                                          |
| ios above policy → `isUpToDate:true`                                                                  | Positive       | `{ios, 2.5.9}`                              | 200                     | **[EXECUTED]**                                                                                                                      |
| below mandatory → `forceUpdate:true`                                                                  | Positive       | `{android, 0.9.9}`                          | 200                     | **[EXECUTED]**                                                                                                                      |
| canonicalizes client version in response                                                              | Positive       | `{ios, 10.20.30}`                           | 200                     | **[EXECUTED]**                                                                                                                      |
| missing `platform`                                                                                    | Negative (Zod) | `{version}`                                 | 400 `VALIDATION_FAILED` | **[EXECUTED]**                                                                                                                      |
| missing `version`                                                                                     | Negative       | `{platform}`                                | 400                     | **[EXECUTED]**                                                                                                                      |
| empty body                                                                                            | Negative       | `{}`                                        | 400                     | **[EXECUTED]**                                                                                                                      |
| invalid platform enum (`windows`)                                                                     | Negative       |                                             | 400                     | **[EXECUTED]**                                                                                                                      |
| `version: null`                                                                                       | Negative       |                                             | 400                     | **[EXECUTED]**                                                                                                                      |
| `version: ""`                                                                                         | Negative       |                                             | 400                     | **[EXECUTED]**                                                                                                                      |
| non-string version (number)                                                                           | Negative       | `version:100`                               | 400                     | **[EXECUTED]**                                                                                                                      |
| malformed `1.0` (not 3 segments)                                                                      | Negative       |                                             | 400                     | **[EXECUTED]**                                                                                                                      |
| non-numeric segment `1.x.0`                                                                           | Negative       |                                             | 400                     | **[EXECUTED]**                                                                                                                      |
| leading `v` prefix `v1.0.0`                                                                           | Negative       |                                             | 400                     | **[EXECUTED]**                                                                                                                      |
| trims surrounding whitespace `"  1.2.3  "`                                                            | Edge           |                                             | 200 canonical `1.2.3`   | **[EXECUTED]**                                                                                                                      |
| max-width segments (5 digits) accepted                                                                | Edge           | `99999.99999.99999`                         | 200                     | **[EXECUTED]**                                                                                                                      |
| over-width segment (6 digits) rejected                                                                | Edge           | `100000.0.0`                                | 400                     | **[EXECUTED]**                                                                                                                      |
| rate-limiter does NOT block (30 rapid hits all 200)                                                   | Edge           |                                             | 200×30                  | **[EXECUTED]**                                                                                                                      |
| mass-assignment: extra/privileged fields ignored (`isAdmin`, `minimumRequiredVersion`, `forceUpdate`) | Security       |                                             | 200, server values win  | **[EXECUTED]**                                                                                                                      |
| NoSQL-shaped `platform: {$ne:null}` rejected                                                          | Security       |                                             | 400                     | **[EXECUTED]**                                                                                                                      |
| NoSQL-shaped `version: {$gt:""}` rejected                                                             | Security       |                                             | 400                     | **[EXECUTED]**                                                                                                                      |
| oversize body > 32kb → body-parser 413                                                                | Negative       |                                             | 413 (entity too large)  | **[DOC-ONLY]** (parser-level; not asserted)                                                                                         |
| optional-update band (client ≥ mandatory, < latest) → `optionalUpdate:true`                           | Positive       | requires distinct mandatory≠optional policy | 200                     | **[DOC-ONLY]** (test policy has mandatory==optional==1.0.0, so the optional band is unreachable; needs a custom config to exercise) |

Expected response structure (positive):

```
{ success: true, message: "App version checked",
  data: { platform, clientVersion, minimumRequiredVersion,
          latestRecommendedVersion, forceUpdate, optionalUpdate,
          isUpToDate, storeUrl? } }
```

---

## 3. `GET /api/v1/webrtc/rtc-config` — WebRTC ICE config

- **Files:** `src/routes/v1/webrtc.routes.ts`,
  `src/grpc/clients/messaging.client.ts` (`getRtcConfig` breaker)
- **Description:** Fetches ICE/TURN config from messaging-service over gRPC
  (opossum circuit breaker). Mounted **before** the proxied services, so it is
  reachable even when downstream HTTP services are down.
- **Preconditions:** injected `MessagingClient`.
- **Auth:** **none** (see AUDIT — no auth gate on this route).

| Case                                                         | Type     | Expected                                                                        | Status                                     |
| ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| returns rtcConfig from messaging client                      | Positive | 200 `{success, message, data: rtcConfig}`                                       | **[EXECUTED]** `webrtc/rtc-config.test.ts` |
| forwards empty iceServers list unchanged                     | Positive | 200 `{iceServers: []}`                                                          | **[EXECUTED]**                             |
| gRPC rejects (breaker open / service down) → graceful        | Negative | 503, `{success:true, message:"RTC service temporarily unavailable", data:null}` | **[EXECUTED]**                             |
| gRPC DEADLINE_EXCEEDED rejection → 503, raw error not leaked | Negative | 503 (no "DEADLINE" in message)                                                  | **[EXECUTED]**                             |
| `POST /webrtc/rtc-config` (wrong method) → 404               | Negative | 404                                                                             | **[EXECUTED]**                             |
| unknown webrtc subpath → 404                                 | Negative | 404                                                                             | **[EXECUTED]**                             |

Expected response structure (positive): `{ success: true, message: "RTC
configuration retrieved", data: RtcConfiguration }`. NOTE the 503 graceful path
keeps `success: true` because it uses `ApiResponse(null, ...)` — documented as a
finding in AUDIT (envelope inconsistency).

---

## 4. Proxy routing — `/api/v1/{auth,users,communities,chat,devices}/*`

- **Files:** `src/routes/v1/index.ts`, `src/versioning/registry.ts`,
  `src/proxy/create-service-proxy.ts`
- **Description:** Versioned reverse proxy. Each registry entry is mounted only
  when its `*_SERVICE_URL` env var is set (`registry.ts:22-63`); `auth` is
  always mounted. `pathRewrite` strips `^(/api/v\d+)?/<segment>` and re-prefixes
  with the downstream prefix.
- **Auth:** **none at the gateway** — all real authz is delegated downstream
  (the gateway forwards `Authorization` as-is). See AUDIT.

Path-rewrite table (verified by sentinel proxy in `proxy/routing.test.ts`):

| Public path                                                | Service     | Downstream                        | Status         |
| ---------------------------------------------------------- | ----------- | --------------------------------- | -------------- |
| `/api/v1/auth/login`                                       | auth        | `/api/auth/login`                 | **[EXECUTED]** |
| `/api/v1/auth` (bare)                                      | auth        | `/api/auth/`                      | **[EXECUTED]** |
| `/api/v1/users/me`                                         | users       | `/api/v1/users/me`                | **[EXECUTED]** |
| `/api/v1/communities/abc/members`                          | communities | `/api/v1/communities/abc/members` | **[EXECUTED]** |
| `/api/v1/chat/conversations`                               | chat        | `/api/chat/conversations`         | **[EXECUTED]** |
| `POST /api/v1/devices` (bare)                              | devices     | `/v1/devices/`                    | **[EXECUTED]** |
| `DELETE /api/v1/devices/abc123`                            | devices     | `/v1/devices/abc123`              | **[EXECUTED]** |
| registry mounts auth/users/communities/chat/devices for v1 | —           | —                                 | **[EXECUTED]** |

Negative / security:

| Case                                                                          | Type     | Expected                                                            | Status                                                                                                                                    |
| ----------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| unknown v1 segment `/api/v1/does-not-exist`                                   | Negative | 404 (no proxy)                                                      | **[EXECUTED]**                                                                                                                            |
| unknown version `/api/v2/auth/login`                                          | Negative | 404 (only v1 mounted)                                               | **[EXECUTED]**                                                                                                                            |
| bare `/api`                                                                   | Negative | 404                                                                 | **[EXECUTED]**                                                                                                                            |
| path-traversal-shaped `/api/v1/%2e%2e/admin` does not escape to another mount | Security | 404                                                                 | **[EXECUTED]**                                                                                                                            |
| downstream service unreachable → proxy `error` handler                        | Negative | 502 `{success:false, message:"Service temporarily unavailable..."}` | **[DOC-ONLY]** (`create-service-proxy.ts:47-61`; needs a real dead upstream — not asserted, proxy factory is mocked in the routing suite) |
| upstream `Access-Control-*` headers stripped from proxied response            | Security | headers absent                                                      | **[DOC-ONLY]** (`create-service-proxy.ts:34-46`; requires a live upstream)                                                                |

Expected response structure: opaque pass-through of the downstream body.

---

## 5. Admin edge — `/admin/*` (proxied to backoffice-service)

- **Files:** `src/routes/admin.routes.ts`, `src/middleware/admin-jwt.ts`,
  `src/middleware/admin-ip-allowlist.ts`, `src/middleware/rate-limit.ts`
- **Description:** Edge controls in front of backoffice-service. Order:
  `adminRateLimiter → adminIpAllowlist → (sensitive paths: adminLoginRateLimiter)
→ adminJwt → proxy`. `adminJwt` verifies **signature + expiry only** (HS256,
  `JWT_ADMIN_SECRET`); the jti blacklist is enforced downstream.
- **Public (JWT-skipped) paths** (`admin-jwt.ts:12-23`): `/v1/auth/login`,
  `/v1/auth/refresh`, `/v1/auth/forgot-password`, `/v1/auth/verify-otp`,
  `/v1/auth/resend-otp`, `/v1/auth/reset-password`, `/v1/health`,
  `/v1/health/ready`.
- **Path rewrite:** strip `/admin` → forward `/v1/...` to backoffice
  (`admin.routes.ts:65`).

Edge-rejection messages (gateway-authored): `"Unauthorized"`,
`"Invalid or expired token"`, `"Admin auth not configured"`.

| Case                                                          | Type              | Path                                  | Expected                                       | Status                                                                               |
| ------------------------------------------------------------- | ----------------- | ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| no Authorization header on protected path                     | Negative          | `GET /admin/v1/users`                 | 401 `Unauthorized`                             | **[EXECUTED]** `admin/admin-edge.test.ts`                                            |
| malformed header (no `Bearer ` prefix)                        | Negative          |                                       | 401 `Unauthorized`                             | **[EXECUTED]**                                                                       |
| `Bearer ` with empty token                                    | Negative          |                                       | 401 `Unauthorized`                             | **[EXECUTED]**                                                                       |
| expired admin token                                           | Negative          |                                       | 401 `Invalid or expired token`                 | **[EXECUTED]**                                                                       |
| forged admin token (wrong secret)                             | Negative/Security |                                       | 401 `Invalid or expired token`                 | **[EXECUTED]**                                                                       |
| garbage non-JWT bearer                                        | Negative          |                                       | 401 `Invalid or expired token`                 | **[EXECUTED]**                                                                       |
| USER access token (wrong secret) is NOT a valid admin token   | Security          |                                       | 401 `Invalid or expired token`                 | **[EXECUTED]**                                                                       |
| JWT tampering (altered payload, broken signature)             | Security          |                                       | 401, never proxied                             | **[EXECUTED]**                                                                       |
| valid admin token passes the edge (proxied, NOT an edge 401)  | Positive          |                                       | not an edge rejection                          | **[EXECUTED]**                                                                       |
| public login path reachable WITHOUT token (skipped → proxied) | Positive          | `POST /admin/v1/auth/login`           | not an edge rejection                          | **[EXECUTED]**                                                                       |
| public forgot-password reachable without token                | Positive          | `POST /admin/v1/auth/forgot-password` | not an edge rejection                          | **[EXECUTED]**                                                                       |
| `JWT_ADMIN_SECRET` unset → fail closed                        | Security          |                                       | 401 `Admin auth not configured`                | **[DOC-ONLY]** (`admin-jwt.ts:42-46`; test env always sets the secret)               |
| IP not in non-empty allowlist → 403                           | Security          |                                       | 403 `You do not have permission...`            | **[DOC-ONLY]** (`admin-ip-allowlist.ts:34`; test env allowlist is empty = allow-all) |
| `BACKOFFICE_SERVICE_URL` unset → 503                          | Negative          |                                       | 503 `This service is currently unavailable...` | **[DOC-ONLY]** (`admin.routes.ts:46-54`; test env sets the URL)                      |
| backoffice unreachable → proxy error                          | Negative          |                                       | 502 graceful                                   | **[DOC-ONLY]** (`admin.routes.ts:66-81`)                                             |
| admin login rate limit exceeded                               | Security          | sensitive paths                       | 429                                            | **[DOC-ONLY]** (`rate-limit.ts:82-94`; not driven)                                   |

Expected response structure: edge rejection `{ success:false, message }`;
otherwise downstream pass-through.

---

## 6. Socket.IO connection auth — `gatewaySocketAuthMiddleware`

- **File:** `src/sockets/auth.middleware.ts`
- **Description:** Handshake auth for all Socket.IO namespaces (`/chat`,
  `/community`, `/notify`). Reads token from `handshake.auth.token` (preferred)
  or `Authorization: Bearer` header; verifies via shared `@aimess/auth-jwt`
  (`JWT_ACCESS_SECRET`); resolves locale from `x-lang`/`Accept-Language`.
- **Note:** the full Socket.IO server + Redis adapter live only in `server.ts`;
  the middleware is a pure function of `socket.handshake` and is tested directly.

| Case                                                                                     | Type              | Expected                           | Status                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ----------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| valid token via `auth.token` → accept + populate `socket.data` (userId/sessionId/locale) | Positive          | next(no err)                       | **[EXECUTED]** `sockets/auth-middleware.test.ts`                                                                              |
| valid token via `Authorization: Bearer` header                                           | Positive          | accept                             | **[EXECUTED]**                                                                                                                |
| resolves supported locale from `x-lang` (`vi`)                                           | Positive          | `socket.data.locale="vi"`          | **[EXECUTED]**                                                                                                                |
| prefers `auth.token` over Authorization header                                           | Security          | auth.token user wins               | **[EXECUTED]**                                                                                                                |
| no token at all                                                                          | Negative          | `Error("Authentication required")` | **[EXECUTED]**                                                                                                                |
| empty auth object, no header                                                             | Negative          | `Authentication required`          | **[EXECUTED]**                                                                                                                |
| non-Bearer header (`Basic ...`)                                                          | Negative          | `Authentication required`          | **[EXECUTED]**                                                                                                                |
| expired token                                                                            | Negative          | `Authentication failed`            | **[EXECUTED]**                                                                                                                |
| forged token (wrong secret)                                                              | Security          | `Authentication failed`            | **[EXECUTED]**                                                                                                                |
| structurally-invalid (non-JWT) token                                                     | Negative          | `Authentication failed`            | **[EXECUTED]**                                                                                                                |
| tampered payload (signature mismatch)                                                    | Security          | `Authentication failed`            | **[EXECUTED]**                                                                                                                |
| does NOT populate `socket.data` when auth fails                                          | Security          | userId/sessionId undefined         | **[EXECUTED]**                                                                                                                |
| post-connect namespace events (message:send, reactions, typing, presence, catch-up)      | Positive/Negative | per `docs/SOCKET_EVENTS.md`        | **[DOC-ONLY]** (requires booting Socket.IO server + Redis adapter; out of harness scope, covered by namespace/service suites) |

---

## 7. Docs surfaces (Swagger / AsyncAPI) — `GET /docs*`

- **Files:** `src/docs/swagger.ts`, `src/docs/asyncapi.ts`
- **Description:** Swagger UI + OpenAPI JSON per version; `/docs` 302-redirects
  to the default version; AsyncAPI HTML for the socket contract.
- **Auth:** none (public docs).
- **Rate limit:** exempt (`skipRateLimit` matches `/docs`).

| Case                                                       | Type     | Expected | Status                              |
| ---------------------------------------------------------- | -------- | -------- | ----------------------------------- |
| `GET /docs` → 302 redirect to `/docs/v1`                   | Positive | 302      | **[DOC-ONLY]** (`swagger.ts:53-56`) |
| `GET /docs/v1/openapi.json` → OpenAPI document             | Positive | 200 JSON | **[DOC-ONLY]**                      |
| `GET /docs/versions` → version index                       | Positive | 200 JSON | **[DOC-ONLY]**                      |
| AsyncAPI is mocked to a no-op in tests (ESM `import.meta`) | —        | —        | mocked in `global-mocks.ts`         |

Reason DOC-ONLY: docs routes serve large generated HTML/JSON and are not part of
the audited security/validation surface; AsyncAPI is mocked out for the harness.

---

## Cross-cutting middleware (asserted via the routes above)

| Behaviour                                                         | File                          | Status                                                             |
| ----------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `requestIdMiddleware` sets fresh `x-request-id` per request       | `middleware/request-id.ts`    | **[EXECUTED]** (health suite)                                      |
| global rate limiter, `max:100/min`, skips health/docs/app-version | `middleware/rate-limit.ts`    | partial — skip path **[EXECUTED]**; 429 enforcement **[DOC-ONLY]** |
| helmet + `x-powered-by` off                                       | `app.ts:46-58`                | **[EXECUTED]** (health suite)                                      |
| CORS allow-all in dev, per-origin in prod, strips upstream CORS   | `app.ts:19-41`, `proxy:34-46` | **[DOC-ONLY]**                                                     |
| `errorHandler` localizes AppError, 500 fallback                   | `middleware/error-handler.ts` | partial — 400 path **[EXECUTED]** via app-version                  |
