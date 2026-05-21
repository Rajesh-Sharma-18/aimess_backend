# AIMess Backend — Implementation Notes & Review Record

> Living record of what is implemented, key decisions, gotchas, and known gaps.
> Update this whenever you ship or change a feature. Last reviewed: **2026-05-21**.
> Scope of this record: **auth-service**, **user-service**, **community-service** (auth + user + community-create flow).

---

## 0. community-service (MongoDB `community_db` · **Prisma 6** · Redis · MinIO)

New service (port 3003). Verified: boot reaches "listening on 3003" (Mongo+Redis+MinIO connected), live replica-set write smoke passed (no P2031), typecheck/lint green.

- **ORM = Prisma 6.19.x**, NOT Prisma 7 — **Prisma 7 dropped MongoDB support entirely**. community-service pins prisma/@prisma/client `^6.19`; generator `provider="prisma-client-js"`; generated client imported from `src/generated/prisma/index.js`. auth/user stay on Prisma 7 (pnpm isolates per-package). Mongo `createMany` has **no** `skipDuplicates`.
- **Mongo MUST be a replica set** (Prisma wraps `@unique`-model writes in transactions → `P2031` without one). Local `mongodb` container now runs `--replSet rs0 --bind_ip_all`, **no auth** (auth+replSet needs a keyfile, painful on Windows). Connection: `mongodb://localhost:27018/community_db?directConnection=true`. Production = managed Mongo (Atlas) with RS+auth. See aimess-dev-setup.
- **Endpoints** (all bearer-auth, mounted so downstream = `/api/v1/communities/...`): `POST /communities` (create — creator=ADMIN, selected friends → ACTIVE members, sequential writes + `createMany` + compensating cleanup, NO `$transaction`), `PATCH /communities/:id` (edit — **ACTIVE ADMIN only**), `GET /communities/:id` (+ `myRole`, ACTIVE membership only), `GET /communities/mine` (cursor), `GET /communities/categories`, `GET /communities/name-available`, `GET /communities/handle-available` (Redis dual-TTL cache), `POST /communities/images/upload-url` (MinIO presign, mirrors avatars). Routes ordered specific-before-`/:id`. Categories seeded (10) via `db:seed`.
- **Decisions:** Community has `name @unique` + `handle @unique` (the `@Community Name`), `type PUBLIC|PRIVATE`, category ref, avatar/cover. Selected members added directly as ACTIVE. `ForbiddenError` (403) added to `@aimess/errors`.
- **Known gaps:** `memberIds` are NOT server-validated as the creator's friends (trusts client selection — TODO before GA). Members management/chat/invites/join-requests/moderation/reports DEFERRED. Community events (RabbitMQ) deferred. Full HTTP-through-gateway + presigned-upload round-trip not runtime-tested.

### user-service — friends list

- `GET /users/friends?search=&cursor=&limit=` — accepted friends only (both requester/addressee sides), alphabetical (`firstName,lastName,userId`), each item has a `section` letter for the A/B/C "Select Members" UI, presigned avatar. Cursor on `userId`. **Returns `[]` (not error) until friendships exist — the friend-request feature isn't built yet.**

### Shared `@aimess/storage` + generic uploads (cross-service)

- `@aimess/storage` (`packages/storage`) owns ALL MinIO/S3 mechanics: `createStorageClient`, `createPresignedUploadUrl`/`createPresignedViewUrl`, `headObject`, `deleteObject`, `ensureBuckets`, `buildObjectKey`, `assertObjectKeyOwnedBy`, `assertAllowedMime`/`assertFileSize`, and the high-level `createUploadUrl(def,…)`. Package is dependency-light (only `@aws-sdk/*`) — no service env, no `@aimess/*` runtime dep; throws package-local `StorageValidationError`, services translate.
- **One generic endpoint per service:** `POST /users/uploads/url` (type `AVATAR`) and `POST /communities/uploads/url` (type `COMMUNITY_AVATAR`). Body `{ type, contentType, contentLength }` → `{ uploadUrl, objectKey, uploadExpiresIn, maxBytes, headers }`. Per-service upload-type registry in `config/uploads.ts` (type → bucket/keyPrefix/maxBytes/allowedMime). The old per-resource endpoints (`/profiles/me/avatar/upload-url`, `/communities/images/upload-url`) were removed. **Convention: new upload kinds = a new registry entry, NOT a new endpoint.**
- Errors: `@aimess/errors` gained `UnsupportedMediaTypeError` (415); generic message keys `UPLOAD_UNSUPPORTED_CONTENT_TYPE` (415) / `UPLOAD_FILE_TOO_LARGE` / `UPLOAD_FILE_EMPTY` (400). Presigned PUT signs **only** Content-Type (clients PUT with that one header) — keep it that way.
- **Community cover dropped from the create/edit flow** (not in Figma) — the `coverUrl` Prisma field is kept (always null, future community-page banner); responses still include `coverUrl`/`coverUrlExpiresIn`.

### Cross-cutting gotcha — Prisma + MongoDB soft-delete (`deletedAt`)

Prisma omits **unset optional fields** on Mongo, and `where: { deletedAt: null }` does **NOT** match a _missing_ field (only an explicitly-null one). So communities created normally (no `deletedAt` written) were invisible to every `deletedAt: null` query → `GET /communities/:id`, `/mine`, and name/handle availability all silently returned nothing. **Fix/convention for Mongo soft-delete: filter active rows with `deletedAt: { isSet: false }`** (soft-delete sets a Date; never store explicit null — a restore should `unset` the field). Applied in `community.repository.ts` (findById/findByName/findByHandle + the `community` relation filter in listMyMemberships). Use `isSet:false`, not `null`, for any future Mongo soft-deletable model.

### Cross-cutting gotcha — Express 5 `req.query` is immutable per-access

`req.query` is a getter that **re-parses on every access**, so `Object.assign(req.query, parsed)` is silently lost (coerced/defaulted Zod values never reach controllers). All `validate-query` middlewares (auth/user/community) now do `Object.defineProperty(req,"query",{value:parsed.data,...})` instead. (Duplicated in 3 services — consolidating the `validate-*` family into `@aimess/utils` is a noted follow-up.)

---

## 1. Current implementation status

### auth-service (Postgres `aimess_auth` + Redis + RabbitMQ)

Implemented and verified (compiles + lints; **not** runtime/integration-tested):

- **Registration** (`POST /auth/register`) — bcrypt hash (cost 12), creates `AuthUser`, issues tokens, publishes `user.created`.
- **Login** (`POST /auth/login`) — account-or-email identifier, email-verified gate, **account lockout** enforced.
- **Account lockout** — `recordFailedLogin` atomically increments `failedLoginAttempts`; once `AUTH_MAX_FAILED_LOGINS` (default 5) is hit, sets `lockedUntil = now + AUTH_LOCKOUT_MINUTES` (default 15). Login rejects while `lockedUntil` is in the future. `recordSuccessfulLogin` resets both.
- **Sessions / refresh** (`session.service.ts`) — refresh looks up by token **hash**, checks expiry/revocation/account-active, detects **reuse** via `rotatedToId` (revokes all sessions on reuse), rotates the refresh token. `logout` revokes the session. List / revoke-one / revoke-all sessions implemented.
- **Social login** (`/auth/google`, `/auth/apple`) — **Firebase-based.** The mobile client signs in with Google/Apple via the **Firebase Auth SDK** and sends the resulting **Firebase ID token** (field stays `idToken` / `identityToken`). The backend verifies it with **firebase-admin** (`firebaseAuth.verifyIdToken`) in `lib/firebase-id-token.ts`, asserts `firebase.sign_in_provider` matches the endpoint, and extracts the provider sub from `firebase.identities[provider][0]` (falls back to Firebase `uid`). Same verifier powers `social-link.service.ts` (link provider to a logged-in account). **Email is only trusted as verified when present on the Firebase token** — never client-supplied. Auto-merge by email only when `email && emailVerified`; link creation relies on unique constraint + P2002 catch.
  - Firebase Admin init: `config/firebase.ts`, credentials via `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` (same 3-var cert pattern as notifications-service). The old direct-verification path (`google-auth-library`, `jwks-rsa`, `GOOGLE_CLIENT_IDS`/`APPLE_CLIENT_IDS`) was **removed**.
  - **Firebase env is OPTIONAL and init is LAZY** (`getFirebaseAuth()`). The service boots without Firebase configured — only `/auth/google` + `/auth/apple` + social link/unlink error (clear "Firebase is not configured" message) until the 3 vars are set. This prevents the whole auth-service from crashing on boot when creds are absent.
- **QR device linking** (Redis, polling, WhatsApp-style) — new device shows a QR, logged-in device approves:
  - `POST /auth/devices/link/initiate` (no auth) → `{ linkToken, pollSecret, expiresAt }`; QR encodes **only** `linkToken`; `pollSecret` stays private on the new device.
  - `GET /auth/devices/link/status?linkToken=&pollSecret=` (no auth, polled) → `{ state: PENDING|APPROVED|EXPIRED|CONSUMED, approvedDeviceLabel, tokens }`; tokens delivered **exactly once** after approval, then CONSUMED. Bad/missing pollSecret → EXPIRED (no enumeration).
  - `POST /auth/devices/link/approve` (auth) → mints a real device Session+RefreshToken for the new device via `issueAuthTokens` with a **fresh random deviceId** (NOT the approver's — avoids wiping the approver's session). Returns `{ linkedAt, sessionId }` — `sessionId` is the new device's session so the approver can **"undo"** the link (Figma "Auth Successful → UNDO") via `DELETE /auth/sessions/{sessionId}`. (`issueAuthTokens` now returns `{ tokens, sessionId }`.)
  - **Sessions screen (Figma "Linked Device"):** `GET /auth/sessions` (list devices, `isCurrent` flag), `DELETE /auth/sessions/{sessionId}` (terminate one / UNDO a link), `POST /auth/sessions/revoke-all` = **"Sign Out from all Other Devices"** — revokes all sessions EXCEPT the caller's current one (via `revokeOthersForUser`; `revokeAllForUser` is kept for reuse-detection which must kill all).
  - **Boot resilience:** `server.ts` bounds the Redis connect with a 5s timeout race so a hung/misconfigured Redis (e.g. the Windows 6379 native-service conflict — see aimess-dev-setup) can never block `app.listen`; the service starts and Redis-backed features recover once Redis is reachable.
  - Store: `lib/device-link-store.ts`, Redis key `aimess:devlink:{linkToken}`, TTL 120s. Single-use approve + deliver-once consume are **atomic Lua** (`redis.eval`, KEEPTTL). pollSecret stored hashed only.
- **Delete account** (soft) — `DELETE /auth/account` (auth): confirm via `currentPassword` (password accounts) or email `otp` (social-only; request via `POST /auth/account/delete/request-otp`). Order: confirm → `softDeleteUser` (atomic `$transaction`: status=DELETED + deletedAt, revoke all sessions w/ `SessionRevokeReason.ACCOUNT_DELETED` + refresh tokens) → `markSessionsRevoked` → publish `user.deleted`. Migration `20260520120000_account_deleted_revoke_reason` adds the enum value. user-service consumes `user.deleted` (own queue `user.deleted.queue` + DLX, mirrors user.created) → idempotent profile soft-delete + username release. DELETED accounts already rejected at login/refresh. OTP verify-and-consume consolidated into `lib/otp.ts` `verifyAndConsumeOtp` (shared by account-deletion + email-link; password-reset left separate due to different consume semantics).
- **Social link / unlink** (`POST /api/auth/social/google/link`, `/social/apple/link`, `/social/unlink`) — `social-link.service.ts`, all `authenticateAccessToken`-guarded. Link verifies the Firebase ID token (same `verifyFirebaseIdToken`), then `linkProvider` guards: `AUTH_SOCIAL_ALREADY_LINKED` (same user), `AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE` (another user owns it), `AUTH_PROVIDER_ALREADY_LINKED` (user already has that provider). Create is wrapped in **P2002 race handling** mapping to those conflicts. Unlink refuses to remove the **last sign-in method** (`AUTH_LAST_SIGN_IN_METHOD`) via `countSignInMethods` (password + linked providers).
- **OTP** — issuance throttled per identifier via `lib/otp-rate-limit.ts` (`OTP_REQUEST_MAX` / `OTP_REQUEST_WINDOW_SEC`, defaults 5 / 900s). Per-OTP attempt cap via `OTP_MAX_ATTEMPTS`.
- **Password reset, change-email, change-password, email-link, account availability, social-link** — controllers/services/repos present.

### user-service (Postgres `aimess_users` + Redis + RabbitMQ + MinIO)

- **Profile** created via `user.created` RabbitMQ consumer (idempotent + DLQ — see §3).
- **Profile CRUD** (`GET/PATCH /profiles/me`) — username change has a **30-day cooldown** (`USERNAME_CHANGE_COOLDOWN_MS`). Email aggregated from auth-service (cache-first, see §3).
- **Username** (`/username/generate`, `/username/validate`) — **read-only**; they do NOT persist. Username only changes via `PATCH /me`.
- **Avatar** — MinIO presigned PUT, MIME whitelist, post-upload HEAD size re-check, ownership-prefix check. Private bucket, presigned GET on read.
- **Settings** (`GET`/`PATCH /settings/me`) — Figma-aligned, 5 groups, partial update, atomic in one `$transaction`, lazy default-creation:
  - `privacy` — 5 scopes (per-field option sets match each Figma screen) + `callAllowedFriendIds` (≤500).
  - `chat` — `autoDeleteTimer` (`OFF/DAYS_7/DAYS_15/DAYS_30`), `typingIndicators`, `readReceipts`.
  - `app` — `language` (`en/vi/th`), `theme` (`LIGHT/DARK/AUTO`; AUTO="System").
  - `notifications` — 6 toggles (`chat/call/friendRequest/system/community/liveStream`) + `quietHours{enabled,start,end,days[]}` (days 0=Sun..6=Sat, time "HH:mm").
  - `liveStream` — `defaultVideoQuality` (`AUTO/HIGH_1080P/STANDARD_720P/DATA_SAVER_480P`).
  - API `notifications` keys map to DB `*Enabled` columns in the service layer. Models: `PrivacySettings`, `ChatSettings`, `AppSettings`, `NotificationSettings`, `LiveStreamSettings` — all created for new users in `createFromRegistration` and lazily via `ensureDefaultSettings`.
  - Migration `20260520120000_settings_figma_alignment`: added NotificationSettings + LiveStreamSettings + `LiveStreamQuality` enum; changed `AutoDeleteTimer` to day-based; **removed** `dataSaverMode`/`autoplayVideos` + `AutoplayMode` enum (not in design).
  - **Out of scope (by design):** _Data Usage_ screen = read-only network analytics (no settings write — future metrics endpoint). _Block List_ = separate blocks domain (`Block` model), not part of settings PATCH.
- **Connected accounts** — aggregates auth-service linked accounts.

### api-gateway (port **8000**)

- Single global rate limiter (100/min/IP, in-memory) applied app-wide.
- **Stricter per-route limiter** `sensitiveAuthRateLimiter` (20 / 15 min / IP) on `/auth/login`, `/auth/forgot-password/*`, `/auth/google`, `/auth/apple`.
- Generic per-service proxy by URL segment (`auth`, `users`, …) via `versioning/registry.ts`.

---

## 2. Fixes applied during the 2026-05-20 review

| Area                        | Fix                                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth typecheck (was broken) | `session-api-messages.ts` was empty but imported by `session.controller.ts`. Message keys already exist in `@aimess/constants`, so the controller now uses `t()` directly and the dead file was deleted. |
| gateway                     | Added `sensitiveAuthRateLimiter` for sensitive auth endpoints (defense-in-depth over account lockout).                                                                                                   |
| docs                        | `aimess-architecture` skill catalogue: api-gateway port `3000 → 8000` (matches CLAUDE.md + env).                                                                                                         |
| eslint                      | Added `varsIgnorePattern: "^_"` + `ignoreRestSiblings` to mirror existing `argsIgnorePattern` (cleared blocking error on intentional `_ignored` rest-omit).                                              |
| user-service                | Hardened `user.created` consumer (DLQ, parse-in-try, idempotency), username race retry, cache-first auth lookup, removed dead `example.*` scaffold. (Most done in-flight; verified.)                     |

---

## 3. Key decisions & conventions (so future work stays consistent)

- **Session revocation model:** this codebase uses **session-based** revocation (Redis `session-active-cache` + DB `revokedAt`/`SessionRevokeReason`), NOT the jti-blacklist described in the architecture skill's "Auth quick reference". Logout/revoke mark the session revoked; the auth middleware checks session-active state. Keep this model unless deliberately migrating to jti.
- **RabbitMQ DLQ (user.created):** uses a **simple dedicated pair** — exchange `user.queue.dlx` (direct, durable), queue `user.queue.dlq`, routing key `user.queue.dead`; main `user.queue` declared with `deadLetterExchange`/`deadLetterRoutingKey`. **Publisher (auth-service) and consumer (user-service) MUST declare identical queue args** — RabbitMQ queue args are immutable, mismatch → `PRECONDITION_FAILED`. This is NOT yet the full `aimess.events` topic + `aimess.retry` TTL-backoff mesh from the architecture spec (known gap — see §4).
- **user-service → auth-service** uses **HTTP** (`AUTH_SERVICE_URL` + `fetch`), not gRPC, for profile/email aggregation. This is the one sanctioned internal HTTP hop. `resolve-auth-account.ts` is **cache-first** (Redis `account:summary`) then HTTP on miss, with on-failure cache fallback.
- **Username:** DB `@unique` is the source of truth. Generation/claim handles P2002 by retrying with the next suffix (bounded). A P2002 on `userId` during profile create = idempotent success (concurrent event).
- **OTP/email delivery:** still a **dev stub** — OTPs are logged, not emailed. Real delivery waits on notifications-service wiring. `OTP_DEV_FIXED_CODE` can pin a code in dev.
- **Rate limiting:** in-memory stores (per process). Move to a Redis store (`rate-limit-redis`) before horizontal scaling.
- **Layering is clean** in both services: controllers thin, repositories own all Prisma, services hold logic, multi-write ops use `$transaction`. Keep it that way.

---

## 4. Known gaps / TODOs (not yet done)

- [ ] **No runtime/integration tests run** — everything above is verified by typecheck + lint + code reading only. APIs not yet smoke-tested end-to-end.
- [ ] **No automated test suite** exists for these services.
- [ ] **OTP/email delivery** not wired (dev stub only).
- [ ] **DLQ topology** is the simple per-queue pair, not the spec's `aimess.events` topic + `aimess.retry` (1s→2s→4s TTL) + `aimess.dlq` retry mesh.
- [ ] **gRPC** path (`packages/grpc-contracts`) exists but is unused; auth aggregation is HTTP. Migrate when ready.
- [ ] **Rate-limit Redis store** for multi-replica gateways.
- [ ] **Not deeply reviewed/tested:** `account.controller.ts`, `settings.controller.ts`, `connected-accounts.service.ts`, full avatar/MinIO round-trip, gateway `app-version` routes.
- [ ] **Session revocation** intentionally diverges from the skill's jti-blacklist note — reconcile the doc or the design.
- [ ] **Build output collision (infra):** all apps' `tsconfig` resolve `outDir` to the repo-root `dist/` (from `tsconfig.base.json`), so `auth/user/gateway` builds overwrite each other — a per-service `pnpm start` against `apps/<svc>/dist/index.js` would fail. Fix: per-app `outDir`/`rootDir`. (Found by Quality Tester 2026-05-20; pre-existing.)
- [ ] **No circuit breakers (opossum):** architecture mandates opossum on outbound cross-service calls, but it isn't used anywhere (e.g. `user-service/src/lib/auth-client.ts` HTTP hop has a timeout + cache fallback but no breaker).
- [ ] **`resolve-auth-account` cache staleness:** the cache-first read serves a recent Redis copy even when auth-service is healthy, so connected-accounts/email can be stale up to the TTL right after a link/unlink or email change. Decide: invalidate on change (event from auth-service) vs live-first for the connected-accounts path vs accept the TTL window.
- [ ] **`extractBearerToken`** (user-service `lib/`) is a generic helper that should live in `@aimess/utils`/`@aimess/auth-jwt` to avoid re-copying per service.

---

## 5. Verification status (2026-05-20)

- `pnpm --filter @aimess/auth-service typecheck` — **PASS**
- `pnpm --filter @aimess/user-service typecheck` — **PASS**
- `pnpm --filter @aimess/api-gateway typecheck` — **PASS**
- `lint` (auth, user, gateway) — **0 errors** (2 warnings each = intentional `console.error` in env validation)
- `prisma migrate status` (user-service) — **up to date**; `username` column present.
- Runtime / integration — **NOT done.**
