# backoffice-service — AUDIT

Findings discovered while reading the real source of **backoffice-service** during
test authoring (197/197 Jest integration cases green). Every item is grounded in a
`file:line`. No speculative issues — only what the code actually shows.

Severity: High / Medium / Low. Type: MissingValidation / Security / Bug / DataIntegrity / Inconsistency.

---

## High

### H1 — No brute-force / rate-limit protection on admin login (Security, MissingValidation)

- **Endpoint:** POST /v1/auth/login (and all admin routes).
- **Where:** `src/config/env.ts:44-50` declares `ADMIN_RATE_LIMIT_WINDOW_MINUTES`, `ADMIN_RATE_LIMIT_MAX`, `ADMIN_LOGIN_RATE_LIMIT_MAX`; a repo-wide grep shows these three vars are **never read** anywhere in `src/`. `src/app.ts:12-56` wires `helmet`, `cors`, body parsers, and routes but **no `express-rate-limit`** (or equivalent) middleware. `src/services/admin-auth.service.ts:129-159` `login()` does an unthrottled `findByEmail` + `bcrypt.compare` on every attempt.
- **Detail:** The only throttling in the service is on the password-reset OTP flow (`src/lib/admin-otp-throttle.ts`). Login itself — the highest-value target — has no per-IP or per-account attempt cap, enabling credential-stuffing / password spraying against admin accounts. The env vars give a false impression that a limiter exists.
- **Recommendation:** Mount an `express-rate-limit` (or Redis-backed sliding window) limiter on `/v1/auth/login` keyed by IP + email, honoring `ADMIN_LOGIN_RATE_LIMIT_MAX` / `ADMIN_RATE_LIMIT_WINDOW_MINUTES`; add a global limiter for the rest of `/v1/*` using `ADMIN_RATE_LIMIT_MAX`. Return 429 (`RATE_LIMITED`). If rate limiting is intentionally delegated to the gateway, delete the unused env vars and document it.

### H2 — `ADMIN_IP_WHITELIST` declared but not enforced in-service (Security, MissingValidation)

- **Endpoint:** all admin routes.
- **Where:** `src/config/env.ts:39-40` defines `ADMIN_IP_WHITELIST` ("Comma-separated allowlist; empty = allow all (dev). Enforced at gateway too."). Grep confirms it is read **nowhere** in `src/` — no middleware consumes it.
- **Detail:** The admin panel is the most sensitive surface in the platform, but if the gateway is bypassed (direct hit on `:3010`, internal network, misconfigured ingress) there is no IP allowlist defense-in-depth in the service itself. The "Enforced at gateway too" comment implies a layered control that does not exist here.
- **Recommendation:** Add an IP-allowlist middleware in `src/app.ts` (before `adminAuth`) that enforces `ADMIN_IP_WHITELIST` when non-empty, using `getRequestContext`-style client-IP derivation. Reject non-whitelisted IPs with 403. If truly gateway-only, remove the env var + misleading comment.

### H3 — Audit-log client IP is spoofable when `TRUST_PROXY_HOPS=0` (Security, DataIntegrity)

- **Endpoint:** every audited mutation (ban/suspend/unban, resolve/dismiss, close/reopen, end, login, etc.).
- **Where:** `src/lib/request-context.ts:14-24`. When `TRUST_PROXY_HOPS === 0`, the code does `if (req.ip) ip = req.ip;`. But `src/app.ts:17-19` only calls `app.set("trust proxy", ...)` when `TRUST_PROXY_HOPS > 0`. With Express's default (`trust proxy` off), `req.ip` is the socket peer — correct — **but** the default test/prod env (`.env`) ships `TRUST_PROXY_HOPS=0`, so behind any real proxy the audit IP becomes the proxy's IP, not the client's. Conversely, the `TRUST_PROXY_HOPS>0` branch (`request-context.ts:16-21`) blindly trusts the **leftmost** `X-Forwarded-For` entry, which a client can forge unless every hop is trusted.
- **Detail:** Audit logs are a security/compliance artifact; an attacker who can set `X-Forwarded-For` (when hops>0) can write arbitrary attacker-controlled IPs into the immutable audit trail, and the hops=0 default loses the real client IP behind a proxy. Either way the recorded `ip` is unreliable.
- **Recommendation:** Always `app.set("trust proxy", env.TRUST_PROXY_HOPS)` (Express accepts `0` = trust none) and derive the IP via `req.ip` only, letting Express's hop-counting pick the correct XFF entry instead of hand-rolling `split(",")[0]`. Document the deployment requirement that exactly N proxy hops are trusted.

---

## Medium

### M1 — Admin password policy comment says "min 12" but enforces min 6 (MissingValidation, Inconsistency)

- **Endpoint:** POST /v1/auth/reset-password.
- **Where:** `src/api/validators/password-reset.validator.ts:5-7`. The JSDoc reads `Admin password policy: min 12 chars with upper + lower + digit + special.` but the schema is `.min(6, "Password must be at least 6 characters")`. Also `BOOTSTRAP_SUPER_ADMIN_PASSWORD` is `z.string().min(6)` (`env.ts:63`).
- **Detail:** Admin accounts — the highest-privilege accounts in the system — can have a 6-character password (e.g. `Aa1!aa`), contradicting the documented 12-char minimum. The strength refinements (upper/lower/digit/special) are present, but the length floor is half the documented value.
- **Recommendation:** Raise `.min()` to 12 to match the stated policy (and the comment), or correct the comment if 6 is intentional. Align `BOOTSTRAP_SUPER_ADMIN_PASSWORD` accordingly.

### M2 — Moderation/community/livestream repositories are in-memory mock fixtures; mutations are non-persistent and not atomic with the audit log (DataIntegrity, Bug)

- **Endpoint:** POST resolve/dismiss/bulk (reports), close/reopen/bulk (communities), end/bulk (livestreams).
- **Where:** `src/repositories/report.repository.ts:8` imports `reportFixtures` and `resolve()`/`dismiss()` mutate `this.rows` in place (`report.repository.ts:263-296`, `requireOpen` at `318-325`). The interface JSDoc (`report.repository.ts:36-41`) states Phase 2 will add a Prisma-backed implementation. Community (`community.repository.ts`) and livestream (`livestream.repository.ts`) follow the same fixture pattern.
- **Detail:** Today these "mutations" change a shared module-level array, so (a) every admin action is lost on restart / not visible across processes, and (b) the service writes a real `AuditLog` + `ModerationAction` row (`moderation.service.ts:91-105`, `community.service.ts:110-136`) for an action that never durably mutated the underlying entity — and the two writes are not in a transaction, so the persisted audit/moderation rows can diverge from the (ephemeral) entity state. The bulk loops (`community.service.ts:200-231`) write per-item audit rows with a hard-coded `before:{status:"ACTIVE"}` assumption (`community.service.ts:221`) that depends on the mock repo's guard staying truthful.
- **Recommendation:** Track this as the documented Phase-2 migration; until the Prisma-backed repos land, do not treat these endpoints as durable. When implemented, wrap the entity mutation + ModerationAction + AuditLog in a single transaction so the audit trail cannot diverge from entity state.

### M3 — `verifyOtp` / `resetPassword` do not re-check the OTP-issuance throttle and `verifyOtp` has no per-IP lockout (Security)

- **Endpoint:** POST /v1/auth/verify-otp.
- **Where:** `src/services/admin-password-reset.service.ts:113-157`. `verifyOtp` enforces only the per-OTP-row `attempts < maxAttempts` cap (`:124-132`); there is no per-IP or per-email throttle on the verify endpoint itself (the throttle in `admin-otp-throttle.ts` is applied only on `requestOtp`/`resendOtp`).
- **Detail:** With `ADMIN_OTP_MAX_ATTEMPTS=5` per issued code, an attacker who can trigger fresh issuance (subject to the issuance throttle of 5/15min) still gets multiple guess windows, and the verify endpoint has no independent rate limit. Combined with H1 (no global limiter) this widens the OTP brute-force surface.
- **Recommendation:** Add a per-IP/per-email rate limit to `verify-otp`, and consider a short lockout after repeated `OTP_INVALID` across codes for the same email.

### M4 — Not-found enforcement on mutations is implicit (repo-level), and the pre-read `before` row is fetched but never used to guard (Inconsistency)

- **Endpoint:** POST /v1/users/:userId/ban|suspend|unban.
- **Where:** `src/services/user-management.service.ts:438-516` `banUser()` fetches `userDirectoryRepository.getById(userId)` into `before` (`:445`) but never null-checks it; the actual 404 is produced one call later inside `setStatus` (`user-directory.repository.ts:257-258` throws `NotFoundError("USER_NOT_FOUND")`). So the behaviour is _correct_ — an unknown userId 404s before any audit/event side effect (audit at `:475`, publish at `:505` both run after `setStatus`) — but the not-found check is implicit and easy to break: any future repo refactor that makes `setStatus` an upsert/no-op would silently allow "banning" a non-existent user with a 200 + published `admin.user_banned` event. The GET path 404s explicitly at the controller (`users.controller.ts:48-49`), so the location of the guard is inconsistent across read vs mutate.
- **Detail:** The wasted `before` read (a `getById` whose result is only used for the audit `before:{status}`) sits right next to the missing explicit guard, making the implicit dependency on `setStatus` throwing non-obvious to a reviewer.
- **Recommendation:** Make the guard explicit: `if (!before) throw new NotFoundError("USER_NOT_FOUND")` right after `:445` (and the same in `suspendUser`/`unbanUser`), so the 404 no longer depends on `setStatus`'s internal behaviour and the already-fetched `before` row earns its read.

---

## Low

### L1 — `verify-otp` is not enumeration-safe the way `forgot-password` is (Security, Inconsistency)

- **Endpoint:** POST /v1/auth/verify-otp.
- **Where:** `src/services/admin-password-reset.service.ts:116-122`. A missing OTP row (which also covers a non-existent email, since no code was ever issued for it) throws `BadRequestError("OTP_INVALID")` — the same error as a wrong code for a real email. So there is no direct existence oracle. However the _timing_ differs: a real email with an active OTP runs `verifyOtpCode` (bcrypt compare, `:128`) while a non-existent email short-circuits at `:120`, a measurable timing side-channel.
- **Detail:** Low impact (issuance is enumeration-safe and throttled), but the verify path's early return for unknown emails is a minor timing oracle.
- **Recommendation:** Optionally perform a dummy bcrypt comparison on the no-OTP branch to equalize timing, mirroring constant-time login patterns.

### L2 — `closeCommunity`/`reopenCommunity` default `notifyOwner` re-applied with `?? true` after Zod already defaulted it (Inconsistency, minor Bug)

- **Endpoint:** POST /v1/communities/:communityId/close|reopen.
- **Where:** `closeCommunitySchema` sets `notifyOwner: z.boolean().default(true)` (`community.validator.ts:201`), yet the service re-coalesces with `input.notifyOwner ?? true` in multiple places (`community.service.ts:118`, `:132`, `:161`, `:171`, `:211`, `:226`, `:258`, `:271`).
- **Detail:** Harmless today (the value is always defined post-validation), but the redundant `?? true` hides intent and would silently flip an explicit `false` to `true` if the field were ever made optional-without-default. Dead defensive code that can mask a future regression.
- **Recommendation:** Drop the `?? true` in the service and rely on the validated default, or make the validator field truly optional and keep the coalesce — but not both.

### L3 — `endLivestream` controller TODOs for step-up TOTP never implemented; privileged mutations lack second factor (Security, MissingValidation)

- **Endpoint:** POST /v1/users/:userId/{ban,suspend,unban}, bulk variants.
- **Where:** `src/api/controllers/users.controller.ts:147-148, 170-172, 196-197, 220-222, 244-246` — repeated `TODO (Phase 2): Add step-up TOTP auth validation via X-Totp-Code header.` The TOTP model was explicitly dropped (`prisma/migrations/20260603120000_drop_admin_totp`).
- **Detail:** Destructive, irreversible-ish moderation actions (permanent ban, bulk ban up to 100 users) are protected only by the standard access token + a single permission key — no step-up auth. With TOTP removed from the schema, the TODOs are now unreachable as written.
- **Recommendation:** Decide and document whether step-up auth is required; if yes, reintroduce a second-factor (TOTP or re-auth) gate on destructive mutations. If no, remove the stale TODOs to avoid implying a control that will never exist.

### L4 — `dismissReport.flagFalseReport` is accepted, audited, but never persisted (Inconsistency)

- **Endpoint:** POST /v1/reports/:reportId/dismiss.
- **Where:** `dismissReportSchema` accepts `flagFalseReport` (`moderation.validator.ts:138`); the service records it only in the audit `after` (`moderation.service.ts:130-133`); the repo comment confirms it is "intentionally not persisted on the report in Phase 1" (`report.repository.ts:270-271`).
- **Detail:** Callers may believe flagging a false report has an effect (e.g. reporter-reputation penalty) when it currently does nothing beyond the audit note. Contract/expectation mismatch.
- **Recommendation:** Document the no-op clearly in the API spec, or implement the reporter-reputation side effect.

---

## Uncovered areas (no Jest test exercises these — candidates for future cases)

1. **Token-level auth edge cases:** admin token missing `sid` claim (`makeAdminTokenWithoutSid` helper exists but unused); inactive session in Redis cache (`isAdminSessionActiveForRequest` → false) → 401.
2. **Refresh rotation internals:** reuse-detection (`rotatedToId`) full-revocation path, expired refresh (`AUTH_TOKEN_EXPIRED`), admin-deactivated-during-refresh (403), concurrent-rotate null → 401 — all in `admin-auth.service.ts` but only the happy + generic-invalid paths are HTTP-tested.
3. **OTP/throttle 429 paths:** `forgot-password`/`resend-otp` issuance throttle and resend cooldown (`admin-otp-throttle.ts`) → 429 never asserted via HTTP.
4. **Moderation conflict/not-found mutation paths:** resolve/dismiss of a missing report → 404, already-resolved → 409 (`report.repository.ts:318-325`); same for community close/reopen on wrong-state rows.
5. **Bulk partial-failure semantics:** `runBulk` mixed success/failure result items (`report.repository.ts:354-382`) — only all-success (207) is asserted; per-item `ok:false` error codes untested.
6. **Service-layer business logic:** ban→suspend mapping when `durationDays>0` (`user-management.service.ts:447-460`) and `admin.user_suspended` vs `admin.user_banned` event selection; bulkActivate idempotent already-ACTIVE no-op (`:714-718`); these run only via the route happy-path with the service mocked, so the branching is not asserted.
7. **Cross-service degradation:** `resolveEmailToUserId` / `emailMapForUserIds` gRPC failure → graceful null/empty (`user-management.service.ts:758-802`).
8. **Livestream bulk validation matrix:** empty / >100 ids for bulk/end and bulk/review-reports (the users + reports slices assert this; livestreams does not).
9. **Dashboard upstream-failure fallback:** gRPC failure → 0-fallback / degraded service-status panel.
10. **`admin.report.ingest` consumer wiring** beyond the isolated unit test (queue assertion, DLQ routing) — not in the integration harness.
11. **Mass-assignment on non-user mutation bodies:** the ban body is tested; close/reopen/resolve/end bodies are not explicitly probed for ignored privileged fields (validators strip them, but it is unasserted).
    </content>
