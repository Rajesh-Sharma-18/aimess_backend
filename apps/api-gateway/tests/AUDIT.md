# api-gateway — Code Audit

Prioritized findings discovered while reading the **real source** of
`apps/api-gateway/src`. Every finding cites `file:line`. Nothing here is
invented — each is a behaviour the code actually exhibits today.

The gateway is an edge/BFF layer: it routes, proxies, rate-limits, sets CORS,
and runs **edge** auth for the admin surface and Socket.IO. Most business authz
is intentionally delegated downstream, so several items below are "by-design but
worth confirming" rather than outright bugs — severity reflects that.

| #   | Severity | Type                | Endpoint / Area                                         |
| --- | -------- | ------------------- | ------------------------------------------------------- |
| 1   | High     | Security            | `GET /api/v1/webrtc/rtc-config`                         |
| 2   | Medium   | Inconsistency       | `GET /api/v1/webrtc/rtc-config` (503 envelope)          |
| 3   | Medium   | Security            | Global rate limiter — in-memory, per-process            |
| 4   | Medium   | Bug / DataIntegrity | Global rate limiter skip rule too broad                 |
| 5   | Medium   | Bug                 | `requestIdMiddleware` overwrites inbound `x-request-id` |
| 6   | Medium   | Inconsistency       | App-version semver regex (env) vs validator             |
| 7   | Medium   | Security            | Admin IP allowlist + `X-Forwarded-For` spoofing         |
| 8   | Low      | Security            | App-version store cache poisoning / no TTL              |
| 9   | Low      | Inconsistency       | CORS dev mode reflects any origin with credentials      |
| 10  | Low      | MissingValidation   | App-version body parser limit / no 413 surfaced         |
| 11  | Low      | Inconsistency       | `adminJwt` `req.path` exact-match skip-list brittleness |

---

## 1. [High] Security — `webrtc/rtc-config` has no auth gate and may leak TURN credentials

- **Endpoint:** `GET /api/v1/webrtc/rtc-config`
- **File:** `src/routes/v1/webrtc.routes.ts:11-27`; wired in
  `src/routes/v1/index.ts:14` with no auth middleware.
- **Detail:** The route is mounted directly on the v1 router with **no
  authentication middleware** in front of it (unlike every proxied service, the
  gateway handles this one locally). Its response body is the messaging
  service's `RtcConfiguration`, which can include TURN `username`/`credential`
  pairs (`grpc/clients/messaging.client.ts:198-209` — `IceServer.username`,
  `IceServer.credential`). If those are long-lived/static TURN credentials, any
  unauthenticated caller can harvest them and relay media through the TURN
  server at the operator's expense. The test suite even uses a sample with
  `username:"user", credential:"pass"` (`tests/webrtc/rtc-config.test.ts:31-33`),
  confirming credentials flow through verbatim.
- **Recommendation:** Require a valid access token (reuse the shared
  `@aimess/auth-jwt` middleware, same as the socket handshake) before issuing
  RTC config, and prefer short-lived/ephemeral TURN credentials minted per
  authenticated user. If anonymous access is genuinely required, document it
  explicitly and ensure only STUN (no credentials) is returned unauthenticated.

---

## 2. [Medium] Inconsistency — RTC 503 graceful response returns `success: true`

- **Endpoint:** `GET /api/v1/webrtc/rtc-config` (failure path)
- **File:** `src/routes/v1/webrtc.routes.ts:21-26`.
- **Detail:** On a gRPC failure the handler responds
  `res.status(503).json(new ApiResponse(null, "RTC service temporarily
unavailable"))`. `ApiResponse` always sets `success: true`, so a 503 error is
  emitted with `{ success: true, data: null }`. This contradicts the documented
  error envelope (`{ success: false, message }`). The existing test even
  comments on it (`tests/webrtc/rtc-config.test.ts:77` — "ApiResponse always
  sets success:true"). A client that branches on `body.success` will treat the
  outage as a success with null data.
- **Recommendation:** Return a `{ success: false, message }` body for the 503
  (e.g. throw an `AppError`/`ServiceUnavailableError` and let `errorHandler`
  format it), so the status code and the envelope agree.

---

## 3. [Medium] Security — rate limiters use an in-memory store (per-process, defeated by scale-out)

- **Area:** all limiters in `src/middleware/rate-limit.ts` (global `rateLimiter`
  L23, `sensitiveAuthRateLimiter` L47, `adminRateLimiter` L67,
  `adminLoginRateLimiter` L82, `forgotPasswordRateLimiter` L101).
- **Detail:** Every limiter uses `express-rate-limit`'s default **in-memory**
  store. The code itself flags this (`rate-limit.ts:19-21, 44-45`: "One counter
  per Node process — not shared across replicas"). The gateway is explicitly
  designed for horizontal scaling (Redis Socket.IO adapter, `REDIS_URL` already
  required in `config/env.ts:46`). With N replicas behind a load balancer the
  effective per-IP limit becomes N× the configured `max`, materially weakening
  the credential-stuffing / OTP-abuse defenses these limiters exist to provide.
- **Recommendation:** Back the limiters with `rate-limit-redis` using the
  already-configured `REDIS_URL`, at least for the sensitive-auth and admin-login
  limiters. `forgotPasswordRateLimiter` is also **defined but never wired** to a
  route (see grep: only `sensitiveAuthRateLimiter`/`adminLoginRateLimiter` are
  mounted) — either wire it on the forgot-password path or remove it.

---

## 4. [Medium] Bug / DataIntegrity — global rate-limit skip rule is an unanchored `includes`

- **Area:** `src/middleware/rate-limit.ts:7-14` (`skipRateLimit`).
- **Detail:** The skip predicate uses
  `path.includes("/app-version/check")` (substring, not prefix/exact). Any
  request whose path merely **contains** that substring bypasses the global rate
  limiter — e.g. a proxied downstream path like
  `/api/v1/communities/app-version/check-something` or a crafted
  `/api/v1/chat/x/app-version/check` would be exempted from throttling even
  though it is not the real gateway app-version endpoint. Combined with the fact
  that proxied paths are matched against `req.path` at the app level, this is an
  unintended throttle-bypass surface.
- **Recommendation:** Match the exact gateway path, e.g.
  `path === "/api/v1/app-version/check"` (or a `startsWith` on the known mount),
  and likewise anchor the `/health` and `/docs` checks (`startsWith` is fine for
  those but `app-version` should be exact).

---

## 5. [Medium] Bug — `requestIdMiddleware` unconditionally overwrites the inbound `x-request-id`

- **Area:** `src/middleware/request-id.ts:9-13`.
- **Detail:** The middleware always mints a new uuid and overwrites
  `req.headers["x-request-id"]`, discarding any inbound `X-Request-Id` from an
  upstream proxy/load balancer or a correlated client. Because the proxies use
  `changeOrigin` and forward headers, downstream services therefore receive a
  **gateway-generated** id, breaking end-to-end request correlation when a real
  trace id was already assigned at the edge (nginx/ALB). It also trusts no
  inbound id at all, so distributed tracing across the LB→gateway→service chain
  is severed.
- **Recommendation:** Reuse a valid inbound id when present
  (`req.headers["x-request-id"] ?? uuid()`), optionally validating its shape, so
  the id is generated only when absent.

---

## 6. [Medium] Inconsistency — env semver regex accepts shapes the validator rejects

- **Area:** `src/config/env.ts:9-12` (`semverLike = /^\d+(\.\d+){0,2}$/`,
  applied to `APP_VERSION_*_MANDATORY/OPTIONAL` defaults L74-79) vs
  `src/app-version/version-format.ts:2` (`/^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/`,
  requires all three segments, 1–5 digits each).
- **Detail:** The env schema accepts `"1"` or `"1.0"` for the policy floor, but
  the service then runs every policy value through `parseAppVersion`
  (`app-version.service.ts:13-14`, via `normalizePolicy`). If an operator
  configures `APP_VERSION_ANDROID_MANDATORY=1.0` (valid per env regex), the
  service will **throw** at request time (`version-format.ts:15` →
  `Error("INVALID_APP_VERSION_FORMAT")`), which is not an `AppError` and so falls
  through to the generic 500 handler (`error-handler.ts:33-40`). A
  mis-configured but env-validated policy thus turns every `/app-version/check`
  call into a 500.
- **Recommendation:** Make the env regex require the full `major.minor.patch`
  (`/^\d{1,5}\.\d{1,5}\.\d{1,5}$/`) so a bad policy fails fast at boot, not per
  request — and/or wrap the `normalizePolicy` parse so a bad policy yields a
  controlled error.

---

## 7. [Medium] Security — admin IP allowlist trusts the first `X-Forwarded-For` hop

- **Area:** `src/middleware/admin-ip-allowlist.ts:8-16` (`clientIp`).
- **Detail:** When `TRUST_PROXY_HOPS > 0` the client IP is taken from the
  **first** entry of `X-Forwarded-For` (`raw?.split(",")[0]`). `X-Forwarded-For`
  is client-supplied; unless every hop is a trusted proxy that overwrites it, an
  attacker can prepend an allowlisted IP (`X-Forwarded-For: 10.0.0.5, <real>`) to
  satisfy the allowlist. The gateway's own `trust proxy` is set to a hop **count**
  (`app.ts:48-49`), but this middleware reads XFF manually and takes index 0
  rather than the hop-count-adjusted address, so the two notions of "client IP"
  can disagree.
- **Recommendation:** Derive the client IP from Express's `req.ip` (which already
  honors the configured `trust proxy` hop count) instead of manually parsing
  `X-Forwarded-For[0]`, so a spoofed leading XFF entry cannot satisfy the
  allowlist. Ensure `TRUST_PROXY_HOPS` matches the real number of trusted hops.

---

## 8. [Low] Security — app-version store caches forever with no invalidation

- **Area:** `src/app-version/app-version.store.ts:18, 50-66` (module-level
  `cached`).
- **Detail:** The first `get()` reads the JSON policy file and caches it in a
  module-level variable for the **process lifetime** with no TTL or reload. Once
  cached, editing `config/app-versions.json` (the documented way to bump the
  force-update floor) has no effect until restart. A missing file silently falls
  back to env defaults (`ENOENT` → `cached = defaults`, L58-60), so a deploy that
  forgot to ship the config quietly serves the env floor with no warning. Not a
  direct vuln, but it makes the force-update kill-switch slow to take effect
  during an incident.
- **Recommendation:** Add a short TTL or an explicit reload/admin endpoint, and
  log at warn level when falling back to env defaults on ENOENT.

---

## 9. [Low] Security — CORS reflects any origin with credentials in development

- **Area:** `src/app.ts:29-31` + `credentials: true` (L39).
- **Detail:** When `NODE_ENV === "development"` the CORS origin callback returns
  `callback(null, true)` for **any** origin while `credentials: true` is set.
  That is the classic reflect-any-origin-with-credentials configuration. It is
  gated to development, so production (per-origin allowlist, L32-37) is fine —
  but a dev/staging box exposed beyond localhost would allow any site to make
  credentialed requests. Worth a note since staging often runs `development`.
- **Recommendation:** Even in development, reflect only an explicit dev allowlist
  (localhost + known LAN/tunnel origins) rather than `true`, or ensure non-prod
  remote environments run with `NODE_ENV=production`.

---

## 10. [Low] MissingValidation — app-version body-size 413 not surfaced as the standard envelope

- **Area:** `src/routes/v1/app-version.routes.ts:8` (`express.json({ limit:
"32kb" })`).
- **Detail:** A body over 32kb triggers express's body-parser `PayloadTooLarge`
  error. It is not an `AppError`, so it hits the generic branch of
  `error-handler.ts:33-40` and returns a **500** (`INTERNAL_SERVER_ERROR`) rather
  than a 413 with the standard `{ success:false, message }`. Minor, but an
  oversize body should be a client 4xx, not a server 5xx.
- **Recommendation:** Handle `type === "entity.too.large"` in `errorHandler` (or
  a dedicated body-parser error branch) and return 413 with the standard
  envelope.

---

## 11. [Low] Inconsistency — `adminJwt` public-path skip uses exact `req.path` match

- **Area:** `src/middleware/admin-jwt.ts:12-23, 37` (`PUBLIC_ADMIN_PATHS.has(req.path)`).
- **Detail:** The skip-list is matched with `Set.has(req.path)` — an exact
  string compare. A trailing slash, differing case, or an unexpected encoding
  (`/v1/auth/login/`, `/v1/auth/Login`) would **not** match and would then
  require a bearer on a path meant to be public (a locked-out admin hitting
  `/reset-password/` could be blocked). Conversely it is strict in the safe
  direction (fails closed), so this is low severity — but it is brittle and the
  same list is duplicated in three places (`admin-jwt.ts`, `admin.routes.ts`
  sensitive-paths L31-40, and `routes/v1/index.ts` for user auth), risking drift.
- **Recommendation:** Normalize `req.path` (strip trailing slash, lowercase) or
  match by prefix, and centralize the public-admin-path list in one shared
  constant consumed by both the JWT skip-list and the rate-limit sensitive-paths
  loop.

---

## Uncovered areas (no automated coverage today)

These are reachable code paths with **no executed Jest assertion**. They are
documented as DOC-ONLY in `TEST_CASES.md`; listed here so the gap is explicit.

1. **Proxy `error` handler 502 path** (`proxy/create-service-proxy.ts:47-61`)
   and **admin proxy 502** (`admin.routes.ts:66-81`) — graceful downstream-down
   responses are not exercised (the routing suite mocks the proxy factory).
2. **Upstream CORS-header stripping** on proxied responses
   (`create-service-proxy.ts:34-46`) — requires a live upstream; unverified.
3. **CORS origin policy** (allow-all in dev, per-origin + reject in prod,
   `app.ts:19-41`) — no test drives `Origin` handling or the prod reject branch.
4. **Global rate-limit 429 enforcement** (`rate-limit.ts:23-36`) — only the
   _skip_ behaviour is tested; the actual 100/min cutover and the
   sensitive/admin limiters' 429s are untested.
5. **`forgotPasswordRateLimiter`** (`rate-limit.ts:101-113`) — defined but not
   wired to any route; dead until mounted.
6. **Admin IP allowlist 403** (`admin-ip-allowlist.ts:34`) and **`adminJwt`
   fail-closed 401** when `JWT_ADMIN_SECRET` is unset (`admin-jwt.ts:42-46`) —
   test env always allows all IPs and always sets the secret.
7. **`BACKOFFICE_SERVICE_URL` unset → 503** stub (`admin.routes.ts:46-54`).
8. **Swagger/AsyncAPI docs routes** (`docs/swagger.ts`, `docs/asyncapi.ts`) —
   `/docs` redirect, `openapi.json`, `/docs/versions`, AsyncAPI viewer + 404
   when the spec file is missing (`asyncapi.ts:71-77`). AsyncAPI is mocked out in
   the harness.
9. **Socket.IO post-connect namespace behaviour** (`sockets/namespaces/*.ts`) —
   only the connection-auth gate is unit-tested; message/reaction/typing/
   presence/catch-up handlers and ack taxonomy are not driven here (covered by
   `docs/SOCKET_EVENTS.md` and downstream service suites; would need a booted
   Socket.IO server + Redis adapter).
10. **App-version optional-update band** (`compare-version.ts:44-50`) — the
    `optionalUpdate:true` branch is unreachable under the test policy
    (mandatory==optional==1.0.0); needs a custom policy where mandatory < optional.
11. **App-version store file read + ENOENT fallback + parse-error throw**
    (`app-version.store.ts:50-66`) — the store is mocked in `global-mocks.ts`, so
    real file I/O, the cache, and the "Invalid app version config file" throw
    (L33) are untested.
