# backoffice-service — TEST_CASES

Endpoint-by-endpoint test catalogue for the AIMess **backoffice-service** (admin
panel API, port 3010, mounted at `/v1`; gateway proxies `/admin/v1/*` → `:3010/v1/*`).

Status legend:

- **[X]** EXECUTED — a Jest test in `apps/backoffice-service/tests/**` asserts this case (197/197 green).
- **[D]** DOCUMENTED-ONLY — the behaviour exists in code / is a valid scenario but no Jest test exercises it yet.

Shared contract (verified in `src/middleware/error-handler.ts`, `src/api/middleware/*`):

- Success envelope: `{ success: true, data, ... }` (some endpoints add `message`, `pagination`).
- Error envelope: `{ success: false, message }`.
- Zod body/params/query failure → **400**. Missing/expired/forged admin token → **401**. Missing permission → **403**. Resource not found → **404**. Conflict → **409**. OTP/issuance throttle → **429**. Bulk endpoints → **207**.
- Every `/v1/*` router except the public auth subset is gated by `adminAuth` (JWT + active-session + ACTIVE-admin) then `requirePermission(<key>)`.

---

## 1. Auth — `/v1/auth/*` (mostly public)

### POST /v1/auth/login

- **Method:** POST — **Public** (no bearer). Validates `loginSchema` (`email` valid, `password` min 1).
- **Description:** Single-step admin login (email + password) → `{ tokens, admin }`.
- **Preconditions:** Admin row exists, `status === "ACTIVE"`, password matches.
- **Positive:** [X] valid creds → 200 with `data.tokens.accessToken` + `data.admin`.
- **Negative:** [X] invalid creds → 401 (`AUTH_INVALID_CREDENTIALS`); [X] non-ACTIVE account → 403 (`ADMIN_ACCOUNT_NOT_ACTIVE`); [X] missing/empty email or password, malformed email, empty body → 400; [X] malformed JSON body → 400 (never 500).
- **Edge:** [D] valid creds but `verifyPassword` false → 401; [D] login when Redis session cache unavailable (`markAdminSessionActive` no-op path).
- **Security:** [X] mass-assignment — extra `role`/`permissions`/`isSuperAdmin` ignored (only email+password reach service); [X] NoSQL-injection-shaped `{ $ne: null }` email → 400; [D] **no per-IP/per-account brute-force throttle on login** (see AUDIT High-1).
- **Status codes:** 200 / 400 / 401 / 403.

### POST /v1/auth/refresh

- **Method:** POST — **Public**. Validates `refreshSchema` (`refreshToken` min 1).
- **Description:** Rotate the admin access/refresh pair (rotation + reuse-detection).
- **Positive:** [X] valid token → 200 new pair.
- **Negative:** [X] invalid/already-rotated → 401 (`AUTH_INVALID_TOKEN`); [X] missing/empty refreshToken → 400.
- **Edge:** [D] reuse detected (`rotatedToId` set) → revoke all sessions + 401; [D] expired refresh (`refreshExpiresAt <= now`) → 401 (`AUTH_TOKEN_EXPIRED`); [D] admin since deactivated → 403; [D] concurrent rotate (`rotate()` returns null) → 401.
- **Status codes:** 200 / 400 / 401 / 403.

### POST /v1/auth/forgot-password

- **Method:** POST — **Public**. Validates `forgotPasswordSchema` (email; trimmed+lowercased).
- **Description:** Enumeration-safe OTP issuance.
- **Positive:** [X] known email → 200 echoing lowercased email; [X] unknown email → SAME 200 (no enumeration).
- **Negative:** [X] missing/malformed email → 400.
- **Edge:** [D] OTP issuance throttle hit (`assertOtpRequestAllowed`) → 429 (`RATE_LIMITED`); [D] non-ACTIVE admin → silent no-op 200.
- **Security:** [D] no leak of account existence (constant response) — only happy-path asserted, throttle path documented.
- **Status codes:** 200 / 400 / 429(D).

### POST /v1/auth/verify-otp

- **Method:** POST — **Public**. Validates `verifyOtpSchema` (email; `code` = `^\d{6}$`).
- **Description:** Verify OTP, mint single-use reset token.
- **Positive:** [X] correct 6-digit code → 200 with `resetToken`.
- **Negative:** [X] `OTP_INVALID` → 400; [X] `OTP_MAX_ATTEMPTS` → 400; [X] non-numeric / too short / too long / missing code / missing email → 400.
- **Edge:** [D] wrong code increments `attempts` then 400; [D] admin deactivated between request+verify → 400.
- **Security:** [D] `verify-otp` is NOT enumeration-safe the way forgot-password is — a wrong code on a _real_ email returns `OTP_INVALID` while a _non-existent_ email also returns `OTP_INVALID` (`findLatestActive` → null) — both 400, so no oracle. (AUDIT Low — documented as acceptable.)
- **Status codes:** 200 / 400.

### POST /v1/auth/resend-otp

- **Method:** POST — **Public**. Validates `resendOtpSchema` (email).
- **Positive:** [X] valid email → 200 echo + cooldown applied.
- **Negative:** [X] malformed email → 400.
- **Edge:** [D] within resend cooldown (`assertResendCooldown` NX miss) → 429.
- **Status codes:** 200 / 400 / 429(D).

### POST /v1/auth/reset-password

- **Method:** POST — **Public**. Validates `resetPasswordSchema` (resetToken ≥32, strict password policy, `confirmPassword` cross-field refine).
- **Description:** Consume reset token, set new password, revoke all sessions.
- **Positive:** [X] valid token + matching strong passwords → 200 `{ reset: true }`; [X] `confirmPassword` never forwarded to the service.
- **Negative:** [X] `RESET_TOKEN_INVALID` → 400; [X] `RESET_TOKEN_EXPIRED` → 400; [X] `PASSWORD_SAME_AS_CURRENT` → 400; [X] mismatched confirm, missing uppercase/digit/special, too short, short reset token, empty body → 400.
- **Edge:** [D] token consumed (`consumedAt` set) → 400; [D] admin deactivated → 400.
- **Status codes:** 200 / 400.

### POST /v1/auth/logout (admin-gated)

- **Method:** POST — requires admin bearer (`adminAuth`, no permission key).
- **Positive:** [X] valid token → 200 `{ loggedOut: true }`, session revoked.
- **Negative (the full JWT seam, exercised end-to-end):** [X] no header → 401; [X] malformed header (`Token abc.def`) → 401; [X] expired token → 401; [X] forged (wrong secret) → 401; [X] wrong `type` claim (not `admin_access`) → 401; [X] admin no longer ACTIVE → 401; [X] admin record missing → 401.
- **Edge:** [D] token missing `sid` claim → 401 (`makeAdminTokenWithoutSid` helper exists, not asserted); [D] session inactive in cache (`isAdminSessionActiveForRequest` false) → 401.
- **Status codes:** 200 / 401.

---

## 2. Me — `/v1/me` (admin-gated)

### GET /v1/me

- **Method:** GET — `adminAuth` only (no permission key).
- **Positive:** [X] valid token → 200 profile + resolved permissions.
- **Negative:** [X] no token → 401.
- **Edge:** [D] admin missing in `getMe` → 401 (`AUTH_UNAUTHORIZED`).
- **Status codes:** 200 / 401.

---

## 3. Dashboard — `/v1/dashboard/*` (perm: `dashboard.read`)

### GET /v1/dashboard/overview

- **Positive:** [X] 200 stat cards (`totalUsers` etc).
- **Negative:** [X] no token → 401; [X] missing `dashboard.read` → 403.
- **Edge:** [D] gRPC upstream failure → 0-fallback (service degrades, still 200).
- **Status codes:** 200 / 401 / 403.

### GET /v1/dashboard/charts (validates `dashboardChartsQuerySchema`)

- **Positive:** [X] default `period=monthly` → 200, service called with `"monthly"`; [X] `?period=daily|weekly|monthly` each → 200.
- **Negative:** [X] invalid `period` enum → 400; [X] malformed `?from` datetime → 400; [X] missing `dashboard.read` → 403.
- **Edge:** [D] `from`/`to` accepted for forward-compat but ignored by v1.
- **Status codes:** 200 / 400 / 403.

### GET /v1/dashboard/service-status

- **Positive:** [X] 200 array health panel.
- **Negative:** [X] no token → 401; [X] missing `dashboard.read` → 403.
- **Status codes:** 200 / 401 / 403.

---

## 4. User Management — `/v1/users/*` (read: `users.read`, mutate: `users.moderate`)

### GET /v1/users (validates `listUsersQuerySchema`)

- **Positive:** [X] 200 paginated list; [X] lowercase/aliased status (`active`, `pending_deletion`) → `["ACTIVE","DELETED"]`; [X] UI `sortBy=joinedDate&sortOrder=asc` → `joinedAt:asc`; [X] `q` → `search`.
- **Negative:** [X] no token → 401; [X] missing `users.read` → 403; [X] invalid status enum, invalid reports bucket, `limit>100`, `page<1`, malformed sort field, invalid `dateFrom` → 400.
- **Edge:** [D] `createdAfter`/`createdBefore` alias → `dateFrom`/`dateTo`; [D] legacy `sort`/`order` fallback when `sortBy` absent; [D] cursor pagination param.
- **Status codes:** 200 / 400 / 401 / 403.

### GET /v1/users/:userId (validates `userIdParamSchema`)

- **Positive:** [X] 200 full detail with `profile.userId`.
- **Negative:** [X] unknown user → 404 (`USER_NOT_FOUND`); [X] over-length userId (>64) → 400.
- **Status codes:** 200 / 400 / 404.

### GET /v1/users/:userId/reports

- **Positive:** [X] 200, service called `(USER_ID, 1, 20)`.
- **Edge:** [D] custom `page`/`limit`; [D] reporter-avatar presign null path.
- **Status codes:** 200 / 400 / 401 / 403.

### GET /v1/users/:userId/communities

- **Positive:** [X] 200 nested `{ items, pagination }`.
- **Status codes:** 200 / 400 / 401 / 403.

### GET /v1/users/:userId/communities/:communityId/members

- **Positive:** [X] 200 with `community` block; [X] `q` with `@` flags `searchIsEmail=true`; [X] plain `q` → `searchIsEmail=false`.
- **Edge:** [D] email resolves to no userId → empty page; [D] OWNER role filter folds to ADMIN; [D] email hydration batch path.
- **Status codes:** 200 / 400 / 401 / 403.

### POST /v1/users/:userId/ban (validates `banUserSchema`)

- **Positive:** [X] permanent ban (`durationDays` null) → 200 `status: "BANNED"`.
- **Negative:** [X] `users.read` only (no moderate) → 403; [X] missing reason, invalid reason enum, zero/negative durationDays, non-uuid reportId, note>2000 → 400.
- **Edge:** [D] `durationDays>0` → time-boxed SUSPENDED + `admin.user_suspended` event; [D] `forceLogout`/`notifyUser` defaults.
- **Security:** [X] mass-assignment — `status`/`userId`/`isAdmin` stripped; acted-on userId comes from PATH param; [X] NoSQL `{ $ne:null }` reason → 400.
- **Status codes:** 200 / 400 / 401 / 403.

### POST /v1/users/:userId/suspend (validates `suspendUserSchema`)

- **Positive:** [X] with `durationDays` → 200 `status: "SUSPENDED"`.
- **Negative:** [X] missing `durationDays` → 400.
- **Status codes:** 200 / 400 / 401 / 403.

### POST /v1/users/:userId/unban (validates `unbanUserSchema`)

- **Positive:** [X] with note → 200 `status: "ACTIVE"`; [X] empty body (note optional) → 200.
- **Status codes:** 200 / 400 / 401 / 403.

### POST /v1/users/bulk/ban (207) & /v1/users/bulk/activate (207)

- **Positive:** [X] bulk/ban → 207; [X] bulk/activate → 207; [X] `bulk` matched before `/:userId`.
- **Negative:** [X] empty `userIds`, >100 `userIds`, missing reason → 400.
- **Edge:** [D] per-affected-user audit/moderation/event fan-out; [D] idempotent already-ACTIVE no-op in bulkActivate.
- **Status codes:** 207 / 400 / 401 / 403.

---

## 5. Reports & Moderation — `/v1/reports/*` (read: `reports.read`, mutate: `reports.action`)

### GET /v1/reports (validates `listReportsQuerySchema`)

- **Positive:** [X] 200 list; [X] filters+sort pass-through (`status`,`reportType`,`sort`,`page`,`limit`); [X] repeated `status` → array.
- **Negative:** [X] no token → 401; [X] missing `reports.read` → 403; [X] invalid status/reportType enum, malformed sort token, `limit>100`, `page<1`, invalid dateFrom → 400.
- **Status codes:** 200 / 400 / 401 / 403.

### GET /v1/reports/:reportId

- **Positive:** [X] 200 report core.
- **Negative:** [X] unknown → 404 (`REPORT_NOT_FOUND`); [X] over-length reportId (>64) → 400.
- **Security:** [X] SQL/path-injection-shaped id treated as ordinary id (404/400, never executed).
- **Status codes:** 200 / 400 / 404.

### GET /v1/reports/:reportId/{evidence,history,related}

- **Positive:** [X] each → 200, service called once.
- **Negative:** [X] invalid sub-resource page (`limit=999`) → 400.
- **Status codes:** 200 / 400.

### POST /v1/reports/:reportId/resolve (validates `resolveReportSchema`)

- **Positive:** [X] → 200 `status: "RESOLVED"`.
- **Negative:** [X] `reports.read` only → 403; [X] missing/invalid resolution enum, invalid `actionOnReportedUser`, note>2000 → 400.
- **Edge:** [D] missing report → 404 (`requireOpen` throws `REPORT_NOT_FOUND`); [D] already-resolved → 409 (`REPORT_ALREADY_RESOLVED`); [D] `SUSPEND_7D/30D` applied-actions `effectiveUntil`.
- **Status codes:** 200 / 400 / 403 / 404(D) / 409(D).

### POST /v1/reports/:reportId/dismiss (validates `dismissReportSchema`)

- **Positive:** [X] → 200 `status: "DISMISSED"`.
- **Negative:** [X] invalid dismiss reason → 400.
- **Edge:** [D] missing report → 404; [D] already-closed → 409.
- **Status codes:** 200 / 400 / 404(D) / 409(D).

### POST /v1/reports/bulk/{resolve,dismiss} (207)

- **Positive:** [X] bulk/resolve → 207; [X] bulk/dismiss → 207; [X] `bulk` matched before `/:reportId`.
- **Negative:** [X] empty/missing reportIds, >100 → 400.
- **Edge:** [D] mixed per-item failures (`runBulk` records `REPORT_NOT_FOUND`/`REPORT_ALREADY_RESOLVED`/`BULK_ITEM_FAILED`).
- **Status codes:** 207 / 400.

---

## 6. Community Management — `/v1/communities/*` (read: `communities.read`, mutate: `communities.moderate`)

### GET /v1/communities (validates `listCommunitiesQuerySchema`)

- **Positive:** [X] 200 list; [X] `sortBy=members&sortOrder=asc` → `memberCount:asc`.
- **Negative:** [X] no token → 401; [X] missing `communities.read` → 403; [X] invalid type/status enum, malformed sort token, `limit>100` → 400.
- **Status codes:** 200 / 400 / 401 / 403.

### GET /v1/communities/:communityId & /members

- **Positive:** [X] detail → 200; [X] members → 200.
- **Negative:** [X] unknown community → 404; [X] members invalid role enum → 400.
- **Status codes:** 200 / 400 / 404.

### POST /v1/communities/:communityId/close (validates `closeCommunitySchema`)

- **Positive:** [X] → 200 `status: "CLOSED"`.
- **Negative:** [X] `communities.read` only → 403; [X] missing/invalid reasonCode, reasonNote>2000 → 400.
- **Edge:** [D] missing community → 404; [D] already-closed → 409 (repo `close` guard); [D] moderationAction + auditLog ids returned.
- **Status codes:** 200 / 400 / 403 / 404(D) / 409(D).

### POST /v1/communities/:communityId/reopen

- **Positive:** [X] empty body → 200 `status: "ACTIVE"`.
- **Edge:** [D] reopen a non-CLOSED community → 409.
- **Status codes:** 200 / 400 / 409(D).

### POST /v1/communities/bulk/{close,reopen} (207)

- **Positive:** [X] bulk/close → 207; [X] bulk/reopen → 207; [X] `bulk` before `/:communityId`.
- **Negative:** [X] empty communityIds → 400.
- **Status codes:** 207 / 400.

---

## 7. Group Management — `/v1/groups/*` (read-only: `groups.read`)

### GET /v1/groups (validates `listGroupsQuerySchema`)

- **Positive:** [X] 200 nested `{ items, pagination }`; [X] default `sortBy=createdAt`/`sortOrder=desc`.
- **Negative:** [X] no token → 401; [X] missing `groups.read` → 403; [X] invalid sortBy/sortOrder enum, malformed fromDate, `limit>100` → 400.
- **Status codes:** 200 / 400 / 401 / 403.

### GET /v1/groups/:groupId

- **Positive:** [X] 200 detail.
- **Negative:** [X] unknown → 404; [X] over-length groupId → 400.
- **Status codes:** 200 / 400 / 404.

### GET /v1/groups/:groupId/members (validates `listGroupMembersQuerySchema`)

- **Positive:** [X] 200 member grid; [X] OWNER role filter → 200.
- **Negative:** [X] group absent (`result.found === false`) → 404; [X] invalid role enum → 400.
- **Status codes:** 200 / 400 / 404.

> NOTE: Groups expose **NO mutation** endpoints (no close/end/ban). `groups.moderate` exists in the catalogue but is unused by routes (read-only slice).

---

## 8. Livestream Management — `/v1/livestreams/*` (read: `livestreams.read`, mutate: `livestreams.moderate`)

### GET /v1/livestreams (validates `listLivestreamsQuerySchema`)

- **Positive:** [X] 200 list; [X] `hasReports=true&minReports=3` coerced (boolean/number).
- **Negative:** [X] no token → 401; [X] missing `livestreams.read` → 403; [X] invalid status enum, malformed sort token, negative minReports, `limit>100` → 400.
- **Status codes:** 200 / 400 / 401 / 403.

### GET /v1/livestreams/:livestreamId & /reports

- **Positive:** [X] detail → 200; [X] reports → 200.
- **Negative:** [X] unknown stream → 404; [X] reports invalid status filter → 400.
- **Status codes:** 200 / 400 / 404.

### POST /v1/livestreams/:livestreamId/end (validates `endLivestreamSchema`)

- **Positive:** [X] → 200 `status: "ENDED"`.
- **Negative:** [X] `livestreams.read` only → 403; [X] missing/invalid reasonCode, note>2000 → 400.
- **Edge:** [D] missing stream → repo behaviour (404/409); [D] `issueStrike`/`takedownRecording` flags.
- **Status codes:** 200 / 400 / 403.

### POST /v1/livestreams/bulk/{end,review-reports} (207)

- **Positive:** [X] bulk/end → 207; [X] bulk/review-reports → 207; [X] `bulk` before `/:livestreamId`.
- **Negative:** [X] bulk/review-reports invalid target status (`OPEN` not a review target) → 400.
- **Edge:** [D] bulk validation matrix (empty/over-100 ids) not asserted for livestreams.
- **Status codes:** 207 / 400.

---

## 9. Health / infra (no auth)

- **GET /health** → [X] 200 liveness `{ success, service: "backoffice-service", environment: "test" }`.
- **GET /v1/health** → [X] 200 (gateway-proxied liveness).
- **Unmatched top-level route** (`/totally-unknown`) → [X] 404 JSON (never HTML).
- **Unauthenticated `/v1/*` fall-through** (`/v1/does-not-exist`) → [X] 401 JSON (adminAuth runs before 404 on self-prefixed routers).

---

## Async / non-HTTP surface (not reachable via supertest)

- **`admin.report.ingest` consumer** (`src/messaging/consume-admin-report-ingest.ts`) — unit-tested separately (`src/messaging/__tests__/`): [X] malformed payload throws; [X] P2002 duplicate (idempotent) swallowed; nack-no-requeue → DLQ. Not part of the integration suite.
- **Validator unit tests** (`src/api/validators/__tests__/*`) and **repository smoke/grpc tests** (`src/repositories/__tests__/*`) run under a different harness; not counted in the 197 integration cases.
  </content>
  </invoke>
