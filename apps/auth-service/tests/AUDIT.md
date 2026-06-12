# auth-service — Code Audit

Prioritized findings discovered while reading the auth-service source for the
test pass. Every item is grounded in a `file:line`. Findings are what the code
actually shows — no speculative issues.

Severity scale: **High** (security / correctness in prod) · **Medium**
(hardening / consistency / data-integrity) · **Low** (cleanup / DX).

---

## High

### F1 — `/login` runs with NO request validation (validateBody commented out)

- **Type:** Bug / MissingValidation
- **Endpoint:** `POST /api/auth/login`
- **Where:** `src/api/routes/auth.routes.ts:48-49` — `// authRoutes.post("/login", validateBody(loginSchema), login);` then `authRoutes.post("/login", login);`. `loginSchema` is also commented out of the import (`auth.routes.ts:25`).
- **Detail:** The login route skips `validateBody(loginSchema)`. The controller casts `req.body as LoginInput` (`auth.controller.ts:41`) and the service calls `normalizeLoginIdentifier(input.account)` (`auth.service.ts:64`). A request missing `account` throws inside the service and falls through to the generic handler → **500** instead of a clean **400** (proven by the test "does NOT 400 on a missing account … service throws → 500", `login-extra.test.ts:170`). Beyond the wrong status code: `password`, `account`, `fcmTokens`, and `rememberMe` are never type/shape-checked, so a non-string password reaches `bcrypt.compare` and an array/object `account` reaches the repository unchecked.
- **Recommendation:** Re-enable `validateBody(loginSchema)` on `/login` and restore the import. The schema already exists and is tested elsewhere; this is a one-line revert.

### F2 — Sensitive-auth rate limiter is defined but never applied (no HTTP throttling anywhere)

- **Type:** Security
- **Endpoint:** all auth routes (register, login, forgot-password, etc.)
- **Where:** `src/middleware/rate-limiters.ts:8` defines `sensitiveAuthRateLimiter`; a repo-wide search finds **no import** of it in `app.ts` or any route file.
- **Detail:** Despite env knobs `SENSITIVE_AUTH_RATE_LIMIT_MAX` / `_WINDOW_MINUTES` (`config/env.ts:48-54`), no Express rate limiting is wired. `/login`, `/register`, and `/forgot-password/request` are unthrottled at the HTTP layer, enabling credential stuffing / password-spray / OTP-flooding. (OTP _issuance_ has a separate Redis throttle in `lib/otp-rate-limit.ts`, but that does not cover login/register and fails open on Redis outage.)
- **Recommendation:** Mount `sensitiveAuthRateLimiter` on the sensitive POST routes (login, register, forgot-password/\*, social login). Also see F3 — the limiter is misconfigured even once wired.

### F3 — Rate limiter `windowMs` is 15 _milliseconds_, not 15 minutes

- **Type:** Bug
- **Endpoint:** n/a (config)
- **Where:** `src/middleware/rate-limiters.ts:10` — `windowMs: env.SENSITIVE_AUTH_RATE_LIMIT_WINDOW_MINUTES,` with the correct `15 * 60 * 1000` left commented on line 9.
- **Detail:** `express-rate-limit` expects `windowMs` in milliseconds. Passing the raw minutes value (`15`) makes the window 15 ms, so the limiter would reset almost instantly and never actually throttle. This bug is latent today only because the limiter is unwired (F2); fixing F2 without F3 yields a no-op limiter.
- **Recommendation:** `windowMs: env.SENSITIVE_AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000`.

### F4 — Debug `console.log` of full request body / user record on register & login

- **Type:** Security (sensitive-data exposure) / Bug
- **Endpoint:** `POST /api/auth/register`, `POST /api/auth/login`
- **Where:** `src/api/controllers/auth.controller.ts:34` `console.log("Registration result111:", req.body);`; `src/services/auth.service.ts:24` `console.log("Attempting to register account:", account);`, `:40` `console.log("User registered with ID:", user);`, `:69` `console.log("user found for login:", user);`.
- **Detail:** `req.body` on register contains the plaintext `password`; the login log dumps the full user row (incl. `passwordHash`, `status`, lockout state). These leftover debug logs write credentials/PII to stdout in every environment and bypass the structured `@aimess/logger`. The `111` suffix confirms ad-hoc debugging that shipped.
- **Recommendation:** Delete all four `console.log` statements. If logging is needed, use `logger` with redacted fields.

### F5 — Username uniqueness is case-sensitive (duplicate-identity / takeover-adjacent risk)

- **Type:** DataIntegrity / Security
- **Endpoint:** `POST /api/auth/register`, `POST /api/auth/accounts/validate`, `POST /api/auth/login`
- **Where:** `accountSchema` has `.toLowerCase()` **commented out** (`src/api/validators/auth.validator.ts:6`); `findByAccount` does an exact `prisma.authUser.findUnique({ where: { account } })` (`repositories/auth.repository.ts:297-299`); `accountAvailabilityService.validateAvailability` only `.trim()`s (`services/account-availability.service.ts:8`).
- **Detail:** `Alice`, `alice`, and `ALICE` are treated as distinct accounts at registration and availability check. The code comment in `lib/login-identifier.ts:7-13` even claims "Account names are stored lowercase (case-insensitive identity)", but `normalizeLoginIdentifier` only trims — so the stored value and the login lookup are both case-sensitive and the documented invariant is violated. This enables confusing near-duplicate handles and impersonation-style lookalikes, and makes the availability check unreliable.
- **Recommendation:** Decide on one policy and apply it consistently: either re-enable `.toLowerCase()` in `accountSchema` (and lowercase in `findByAccount`/availability/login normalize) with a case-insensitive unique index, or document case-sensitivity intentionally. Today the behavior contradicts its own comments.

### F6 — Password-reset request leaks account existence (user enumeration)

- **Type:** Security
- **Endpoint:** `POST /api/auth/forgot-password/request`
- **Where:** `src/services/password-reset.service.ts:60-62` — `if (!user || !canResetPassword(user)) { throw new NotFoundError("AUTH_PASSWORD_RESET_EMAIL_NOT_FOUND"); }`.
- **Detail:** A known resettable email returns 200; an unknown / non-resettable email returns **404**. An attacker can enumerate which emails have accounts (and which are social-only / deleted) purely from the status code. Standard practice for "forgot password" is to return 200 regardless. Confirmed by tests `password-reset.test.ts:114` and `:125` which assert the 404.
- **Recommendation:** Return a generic 200 ("if an account exists, an OTP was sent") for both the found and not-found branches; only branch internally on whether to actually send.

---

## Medium

### F7 — Dev-only test-push endpoint is unauthenticated and does account lookup by arbitrary input

- **Type:** Security
- **Endpoint:** `POST /api/auth/test/push`
- **Where:** `src/api/routes/test-push.routes.ts:27-33` (no `authenticateAccessToken`); mounted only when `NODE_ENV === "development"` (`src/app.ts:56-58`).
- **Detail:** The route accepts an `account` and calls `authRepository.findByAccount(account)` with no auth, distinguishing existing vs missing accounts via 404 vs 200 — another enumeration vector, plus an unauthenticated fan-out to `NOTIFICATIONS_SERVICE_URL`. It is correctly gated to development and the file is flagged "DEV ONLY — remove", so this is Medium, not High. Risk is that the gate is the only thing standing between this and prod.
- **Recommendation:** Remove the file before any non-dev deploy (as its own header instructs), or at minimum require auth. Do not rely solely on the `NODE_ENV` gate long-term.

### F8 — No password-complexity policy (length-only)

- **Type:** Security / MissingValidation
- **Endpoint:** register, change-password, forgot-password/reset
- **Where:** `passwordSchema` = `z.string().min(8).max(128)` only (`src/api/validators/auth.validator.ts:20-23`).
- **Detail:** Passwords are accepted on length alone — `"password"`, `"12345678"`, `"aaaaaaaa"` all pass. No character-class / breached-password / entropy check. Combined with F2 (no login throttling) this materially weakens account security.
- **Recommendation:** Add at minimum a deny-list of common passwords or a basic complexity/entropy rule; ideally a breached-password check. Apply uniformly across register / change-password / reset (they all share `passwordSchema`).

### F9 — Social ID-token verification failures surface as 500, not 401

- **Type:** Inconsistency / Bug
- **Endpoint:** `POST /api/auth/google`, `POST /api/auth/apple` (and the link variants)
- **Where:** `services/social-auth.service.ts:206` (`verifyGoogleIdToken`) / `:225` (`verifyAppleIdToken`) throw; nothing maps them to an `AppError`, so the generic handler returns 500 (`middleware/error-handler.ts:84-90`). Confirmed by test "propagates a token-verification failure as 500" (`social-auth.test.ts:196`).
- **Detail:** An invalid / expired / forged provider token is a **client** auth failure and should be **401**, not a 500 "internal server error". The current behavior both misreports the category and risks alerting noise (500s look like server faults).
- **Recommendation:** Wrap the verifier calls (or have the verifiers throw `UnauthorizedError`) so a bad token maps to 401 `AUTH_INVALID_CREDENTIALS` / a social-specific key. Distinguish genuine verifier outages (network/JWKS) from invalid-token cases.

### F10 — gRPC admin + internal methods have no per-call authentication

- **Type:** Security
- **Endpoint:** gRPC `AuthService` — `getUserCounts`, `getActiveUserCounts`, `getActiveUserSeries`, `adminListUsers`, `adminGetUser`, `getAccountSummary`, `bulkGetAccounts`
- **Where:** `src/grpc/server.ts:262-309` — server is created with `ServerCredentials.createInsecure()` and no auth interceptor; admin methods (`adminListUsers`, `adminGetUser`) read full user records.
- **Detail:** Any caller able to reach the gRPC port can list/read users and account summaries. Security relies entirely on the network boundary (private mesh). That may be the intended trust model, but it is undocumented at the call sites and there is no defense-in-depth (no shared-secret metadata check, no mTLS).
- **Recommendation:** Add an auth interceptor (shared secret in metadata or mTLS) for at least the `admin*` methods, or explicitly document the network-trust assumption in the file. `bulkGetAccounts` already caps input at 500 ids (`:248`) — good; apply similar limits/auth to `adminListUsers`.

### F11 — `validateQuery`/`validateParams` lack the noisy `console.error` that `validateBody` has — and `validateBody` logs full Zod errors

- **Type:** Inconsistency / Low-grade info exposure
- **Endpoint:** all validated routes
- **Where:** `src/api/middleware/validate-body.ts:11` `console.error("Validation failed:", parsed.error);` (raw bash via `console`, not `logger`); `middleware/validate-query.ts` and `validate-params.ts` have no such line.
- **Detail:** Inconsistent logging across the three validators, and `validateBody` dumps the raw Zod error (which can echo submitted field values) to stderr via `console` rather than the structured logger. Minor, but it is the same class of leftover-debug issue as F4 and can print user-supplied content.
- **Recommendation:** Drop the `console.error` (or route through `logger.debug`) and keep the three validators consistent.

---

## Low

### F12 — Dead code: commented-out `isSocialUser` and `loginSchema` import

- **Type:** Bug (cleanup)
- **Where:** `services/password-reset.service.ts:158` `// const isSocialUser = user.linkedAccounts.length > 0;`; `api/routes/auth.routes.ts:25` commented `loginSchema` import; `rate-limiters.ts:9` commented `windowMs`.
- **Detail:** Leftover commented code obscures intent and, in the login/rate-limiter cases, marks exactly where a real behavior was disabled (F1/F3). Low on its own; flagged because it co-locates with the High findings.
- **Recommendation:** Remove dead comments once F1/F3 are resolved.

### F13 — `mergeFcmTokens` builds a raw SQL array from client-supplied tokens

- **Type:** Security (low — parameterized)
- **Endpoint:** `POST /api/auth/login`, social login
- **Where:** `repositories/auth.repository.ts:374-383` — `prisma.$executeRaw` with `${tokens}::text[]`.
- **Detail:** Uses tagged-template `$executeRaw` so values are parameterized (not string-concatenated) — not injectable as written. Noted only because raw SQL with client input is a surface worth keeping under review; tokens are validated as non-empty strings (`fcmTokensSchema`) but have no length/count cap, so an oversized array could bloat the row.
- **Recommendation:** Cap `fcmTokens` array length in the schema (e.g. `.max(20)`). Keep using `$executeRaw` tagged templates (never `$executeRawUnsafe`).

---

## Uncovered areas (no automated test today)

- `POST /api/auth/test/push` (dev-only route) — entirely untested.
- gRPC server methods (`src/grpc/server.ts`) and admin repositories
  (`admin-users.repository.ts`, `admin-stats.repository.ts`) — no tests.
- RabbitMQ consumer `messaging/profile-updated-consumer.ts` and the publishers'
  failure/retry paths — only the no-op happy path is mocked.
- ID-token verifiers `lib/google-id-token.ts` / `lib/apple-id-token.ts` (JWKS,
  `aud`/`iss` checks, clock skew) — mocked out in tests; their real validation
  logic is unexercised.
- `lib/otp-rate-limit.ts` 429 throttle path and its fail-open-on-Redis-error
  behavior — documented, not executed.
- Concurrency/transaction paths: `setPrimaryAccountIfUnset`,
  `linkVerifiedEmailAndSetPrimary`, `recordFailedLogin` lockout transaction,
  `softDeleteUser` — exercised only at the service mock level, not against a real DB.
- Password-reset "new password equals current" branch (`password-reset.service.ts:170-179`).
- `/refresh` & `/token` full branch matrix for `/token` (only expired + happy + missing tested).
- CORS origin allow-list behavior in `production` mode (`app.ts:24-29`).
