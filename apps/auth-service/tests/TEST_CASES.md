# auth-service — Test Cases

Endpoint-by-endpoint test catalog for **auth-service**, grounded in the real
source (routes / validators / controllers / services / middleware).

- **Strategy:** supertest drives the real Express app (`src/app.ts`); routing,
  middleware, Zod validation, controllers and services run for real. Only the
  I/O boundary (Prisma, Redis, RabbitMQ publishers, gRPC, ID-token verifiers,
  session-active cache) is mocked.
- **Status:** `183/183` Jest tests passing (15 suites, green).
- **Legend:** `[E]` = EXECUTED (a Jest test asserts it) · `[D]` = DOCUMENTED-ONLY
  (derived from the code, no test yet).

## Common contracts

- **Success envelope:** `{ success: true, message, data }`. `ApiResponse`
  serializes `Date` values to epoch ms.
- **Error envelope:** `{ success: false, message }` (localized via `t()` from the
  `messageKey` on the thrown `AppError`).
- **Validation failure** (`validateBody` / `validateQuery` / `validateParams`) →
  **400** with the first Zod issue message.
- **Auth failure** (`authenticateAccessToken`) → **401** (missing / malformed /
  expired / forged token, or session not active).
- All routes are mounted under `/api/auth`. `helmet` + `cors` (credentials) +
  `express.json({limit:"1mb"})` are applied app-wide. `x-powered-by` disabled.
- **No HTTP rate limiting is actually applied** to any route — the
  `sensitiveAuthRateLimiter` is defined but never wired (see AUDIT.md F2).

---

## 1. POST /api/auth/accounts/validate

- **Method:** POST · **Auth:** none · **Validation:** `validateAccountSchema`
  (`account`: trimmed, 3–32 chars, `^[-a-zA-Z0-9_]+$`).
- **Description:** Checks whether a username (`account`) is available for signup.
- **Preconditions:** none.
- **Positive**
  - `[E]` Free account → **200** `{ available: true, account }`.
  - `[E]` Trims surrounding whitespace before the availability check.
  - `[E]` Boundary lengths 3 and 32 accepted → 200.
- **Negative**
  - `[E]` Account already taken → **409** `AUTH_ACCOUNT_TAKEN`.
  - `[D]` `account` too short (<3) / too long (>32) → **400**.
  - `[D]` Illegal characters (space, `!`, etc.) → **400**.
- **Security / edge**
  - `[E]` Object payload (NoSQL-injection-shaped, not a string) safely rejected → **400**.
- **Status codes:** 200, 400, 409.

## 2. POST /api/auth/register

- **Method:** POST · **Auth:** none · **Validation:** `registerSchema`
  (`account`, `password` 8–128, `fcmTokens?` string[] default `[]`).
- **Description:** Creates a password account, issues an auth session, publishes
  `user.created`.
- **Positive**
  - `[E]` New account → **201** `{ user: { userId, account, role, createdAt }, tokens }`.
- **Negative**
  - `[E]` Account already exists → **409** `AUTH_ACCOUNT_TAKEN`.
  - `[E]` Validation matrix → **400**: missing password, password too short,
    account too short, illegal account chars, missing account, empty body.
- **Edge / security**
  - `[D]` Password only length-validated (8–128) — no complexity rule (AUDIT F8).
  - `[D]` Account uniqueness is **case-sensitive** at the DB layer; `Alice` and
    `alice` can both register (AUDIT F5).
  - `[D]` Extra/privileged body fields stripped by Zod (mass-assignment safe).
- **Status codes:** 201, 400, 409.

## 3. POST /api/auth/login

- **Method:** POST · **Auth:** none · **Validation:** **NONE** — `validateBody`
  is commented out in `auth.routes.ts:48-49` (AUDIT F1).
- **Description:** Logs in by username or verified email; password compare;
  failed-attempt lockout; merges fcmTokens; supports `rememberMe`.
- **Positive**
  - `[E]` Valid credentials → **200** `{ tokens, isProfileCompleted, role }`.
  - `[E]` Login via email identifier routes to `findByEmailForLogin`.
  - `[E]` Returns `isProfileCompleted` + `role`; passes `rememberMe` to token issuance.
  - `[E]` Merges supplied `fcmTokens` on success.
- **Negative**
  - `[E]` Unknown account → **401** `AUTH_INVALID_CREDENTIALS`.
  - `[E]` Wrong password → **401** + records a failed attempt.
  - `[E]` Account locked (`lockedUntil` in future) → **401** `AUTH_ACCOUNT_LOCKED`.
  - `[E]` Account not `ACTIVE` → **401** `AUTH_ACCOUNT_NOT_ACTIVE`.
  - `[E]` Email identifier not yet verified → **401** `AUTH_INVALID_CREDENTIALS`.
  - `[E]` Social-only account (no `passwordHash`) → **401** `AUTH_PASSWORD_NOT_SET`.
  - `[E]` Soft-deleted account (`deletedAt` set) → **401**.
- **Security / edge**
  - `[E]` Mass-assignment of `role`/`status`/`id` ignored; stored `USER` role echoed.
  - `[E]` **Missing `account` → 500** (not 400) because `/login` skips
    `validateBody`; the service dereferences an undefined identifier (AUDIT F1).
  - `[D]` Non-string `account` / `password` → likely 500 (no schema guard).
- **Status codes:** 200, 401, **500 (on malformed body — should be 400)**.

## 4. POST /api/auth/refresh

- **Method:** POST · **Auth:** none (refresh token in body) · **Validation:**
  `refreshTokenSchema` (`refreshToken` non-empty).
- **Description:** Rotates the refresh token, returns a new token pair; detects
  token reuse and revokes all sessions.
- **Positive**
  - `[E]` Valid token → **200** `{ tokens }` (new pair).
- **Negative**
  - `[E]` Unknown token → **401** `AUTH_REFRESH_TOKEN_INVALID`.
  - `[E]` Reused (already-rotated) token → **401** **and revokes all user sessions**.
  - `[E]` Revoked token → **401**.
  - `[E]` Expired token → **401** `AUTH_REFRESH_TOKEN_EXPIRED`.
  - `[E]` Owning session revoked → **401**.
  - `[E]` Account deleted / not ACTIVE → **401** `AUTH_ACCOUNT_NOT_ACTIVE`.
  - `[D]` Missing `refreshToken` → **400**.
- **Status codes:** 200, 400, 401.

## 5. POST /api/auth/token

- **Method:** POST · **Auth:** none · **Validation:** `refreshTokenSchema`.
- **Description:** Issues a fresh access token **without** rotating the refresh
  token (same guard set as `/refresh`, minus rotation).
- **Positive**
  - `[E]` Valid token → **200** `{ accessToken, accessTokenExpiresIn }`, refresh unchanged.
- **Negative**
  - `[E]` Expired token → **401**.
  - `[E]` Missing `refreshToken` → **400**.
  - `[D]` Unknown / reused / revoked / inactive-account → **401** (same branches as `/refresh`).
- **Status codes:** 200, 400, 401.

## 6. POST /api/auth/logout

- **Method:** POST · **Auth:** required.
- **Description:** Revokes the caller's current session.
- **Positive**
  - `[E]` Valid token → **200**, session revoked, cache marked revoked.
- **Negative**
  - `[E]` No `Authorization` header → **401**.
  - `[E]` Malformed `Authorization` header → **401**.
  - `[E]` Expired token → **401**.
  - `[E]` Forged (wrong-secret) token → **401**.
- **Status codes:** 200, 401.

## 7. POST /api/auth/google · POST /api/auth/apple

- **Method:** POST · **Auth:** none · **Validation:** `googleLoginSchema`
  (`idToken`) / `appleLoginSchema` (`identityToken`, optional `email`,
  `fullName`, `fcmTokens`).
- **Description:** Social sign-in. Existing link → login; verified-email match →
  auto-link to existing account; otherwise create a new account.
- **Positive (Google)**
  - `[E]` Existing linked user → **200** `isNewUser:false`.
  - `[E]` Verified email matches an existing account → auto-link → **200** `isNewUser:false`.
  - `[E]` No link/email match → new account → **200** `isNewUser:true`.
- **Positive (Apple)**
  - `[E]` Verified token → **200**.
  - `[E]` Creates a new account from client-supplied email when the token omits it.
- **Negative / security**
  - `[E]` Provider email **unverified** → does NOT auto-link (creates new instead) — takeover guard.
  - `[E]` No email for a brand-new user → **409** `AUTH_SOCIAL_EMAIL_REQUIRED`.
  - `[E]` Linked account not ACTIVE → **401**.
  - `[E]` Linked account locked → **401**.
  - `[E]` Token verification failure → **500** (verifier throws; not mapped to 401, AUDIT F9).
  - `[D]` Missing `idToken` / `identityToken` → **400**.
- **Status codes:** 200, 400, 401, 409, 500.

## 8. POST /api/auth/forgot-password/request

- **Method:** POST · **Auth:** none · **Validation:** `requestPasswordResetOtpSchema` (`email`).
- **Description:** Issues a password-reset OTP for a resettable account. OTP
  issuance is throttled in Redis (`assertOtpRequestAllowed`, fails open).
- **Positive**
  - `[E]` Known resettable account → **200**; response echoes normalized email.
  - `[E]` Email normalized to lowercase in the response.
- **Negative / security**
  - `[E]` Email not associated with a resettable account → **404**
    `AUTH_PASSWORD_RESET_EMAIL_NOT_FOUND` — **user-enumeration leak** (AUDIT F6).
  - `[E]` Deleted account → **404**.
  - `[D]` Invalid email format → **400**.
  - `[D]` OTP issuance over the Redis throttle → **429** `AUTH_OTP_REQUEST_THROTTLED`.
- **Status codes:** 200, 400, 404, 429.

## 9. POST /api/auth/forgot-password/verify

- **Method:** POST · **Auth:** none · **Validation:** `verifyPasswordResetOtpSchema`
  (`email`, `code` exactly 6 digits).
- **Description:** Verifies the reset OTP, returns a short-lived reset token.
- **Positive**
  - `[E]` Correct OTP → **200** `{ resetToken, resetTokenExpiresIn }`.
- **Negative**
  - `[E]` No active OTP → **400** `AUTH_OTP_INVALID`.
  - `[E]` Wrong code → **400** + attempts incremented.
  - `[E]` Attempt cap reached → **400** `AUTH_OTP_MAX_ATTEMPTS`.
  - `[D]` Malformed code (not 6 digits) → **400** (Zod).
- **Status codes:** 200, 400.

## 10. POST /api/auth/forgot-password/reset

- **Method:** POST · **Auth:** none · **Validation:** `resetPasswordSchema`
  (`resetToken` ≥32 chars, `password`).
- **Description:** Consumes the reset token, sets a new password, revokes all sessions.
- **Positive**
  - `[E]` Valid token → **200**, password updated, sessions revoked.
- **Negative**
  - `[E]` Unknown / invalid token → **400** `AUTH_RESET_TOKEN_INVALID`.
  - `[E]` Already-consumed token → **400**.
  - `[E]` Expired token → **400** `AUTH_RESET_TOKEN_EXPIRED`.
  - `[E]` Account no longer active → **400**.
  - `[D]` New password identical to current (password accounts) → **400** `AUTH_PASSWORD_SAME_AS_CURRENT`.
  - `[D]` `resetToken` <32 chars → **400** (Zod).
- **Status codes:** 200, 400.

## 11. POST /api/auth/link-email/request

- **Method:** POST · **Auth:** required · **Validation:** `requestLinkEmailOtpSchema` (`email`).
- **Description:** Sends an OTP to link/verify an email on the caller's account.
- **Positive**
  - `[E]` Brand-new email → **200** `AUTH_LINK_EMAIL_OTP_SENT`.
  - `[E]` Email already on the account but unverified → re-sends OTP → **200** `AUTH_EMAIL_ALREADY_ON_ACCOUNT`.
- **Negative**
  - `[E]` Email already verified on this account → **400** `AUTH_EMAIL_ALREADY_LINKED`.
  - `[E]` Email taken by another user → **409** `AUTH_EMAIL_EXISTS`.
  - `[E]` Account not active (guard) → **401**.
  - `[E]` No token → **401**.
  - `[D]` Invalid email → **400**; OTP throttle → **429**.
- **Status codes:** 200, 400, 401, 409, 429.

## 12. POST /api/auth/link-email/verify

- **Method:** POST · **Auth:** required · **Validation:** `verifyLinkEmailOtpSchema` (`email`, `code` 6 digits).
- **Description:** Verifies the OTP and atomically links the email + sets
  `primaryAccount=EMAIL` if unset.
- **Positive**
  - `[E]` Correct OTP → **200** `{ userId, emailVerified, primaryAccount }`.
- **Negative**
  - `[E]` Email taken by another user before verify → **409**.
  - `[E]` Invalid OTP code → **400** (consume failure propagates).
  - `[E]` Malformed code → **400** (Zod).
  - `[D]` No token → **401**; account not active → **401**.
- **Status codes:** 200, 400, 401, 409.

## 13. POST /api/auth/change-email/request

- **Method:** POST · **Auth:** required · **Validation:** `requestChangeEmailSchema` (`oldEmail`, `newEmail`).
- **Description:** Sends an OTP to the new email after confirming the old email matches.
- **Positive**
  - `[E]` Valid request → **200** `AUTH_CHANGE_EMAIL_OTP_SENT`.
- **Negative**
  - `[E]` Account has no email set → **400** `AUTH_EMAIL_NOT_SET`.
  - `[E]` `oldEmail` mismatch → **400** `AUTH_OLD_EMAIL_MISMATCH`.
  - `[E]` `newEmail` equals `oldEmail` → **400** `AUTH_NEW_EMAIL_SAME_AS_OLD`.
  - `[E]` New email taken by another user → **409** `AUTH_EMAIL_EXISTS`.
  - `[E]` No token → **401**.
  - `[D]` Invalid email format → **400**; OTP throttle → **429**.
- **Status codes:** 200, 400, 401, 409, 429.

## 14. POST /api/auth/change-email/verify

- **Method:** POST · **Auth:** required · **Validation:** `verifyChangeEmailSchema` (`oldEmail`, `newEmail`, `code`).
- **Description:** Verifies the OTP and updates the verified email.
- **Positive**
  - `[E]` Correct OTP → **200** `{ userId, emailVerified }`.
- **Negative / security**
  - `[E]` No active OTP → **400** `AUTH_OTP_INVALID`.
  - `[E]` OTP belongs to a different user → **400** (IDOR-safe: `otp.userId !== userId`).
  - `[E]` Wrong code → **400** + attempts incremented.
  - `[E]` Malformed code → **400** (Zod).
  - `[D]` No token → **401**; old-email mismatch / same email / email taken → as `/request`.
- **Status codes:** 200, 400, 401, 409.

## 15. POST /api/auth/change-password

- **Method:** POST · **Auth:** required · **Validation:** `changePasswordSchema` (`currentPassword`, `newPassword`).
- **Description:** Verifies the current password, sets the new one, revokes all sessions.
- **Positive**
  - `[E]` Correct current password → **200**, sessions revoked.
- **Negative**
  - `[E]` Wrong current password → **400** `AUTH_CURRENT_PASSWORD_INVALID`.
  - `[E]` New password equals current → **400** `AUTH_PASSWORD_SAME_AS_CURRENT`.
  - `[E]` Account has no password (social-only) → **400** `AUTH_PASSWORD_NOT_SET`.
  - `[E]` Account not active (guard) → **401**.
  - `[E]` No token → **401**.
- **Status codes:** 200, 400, 401.

## 16. GET /api/auth/sessions

- **Method:** GET · **Auth:** required.
- **Description:** Lists the caller's active sessions, flagging the current one.
- **Positive**
  - `[E]` Lists active sessions, `isCurrent` flag set on the caller's session → **200**.
  - `[E]` Empty list when there are no active sessions → **200**.
- **Negative**
  - `[E]` No token → **401**.
  - `[E]` Forged token → **401**.
- **Status codes:** 200, 401.

## 17. DELETE /api/auth/sessions/:sessionId

- **Method:** DELETE · **Auth:** required · **Validation:** `sessionIdParamsSchema` (`sessionId` UUID).
- **Description:** Revokes one session owned by the caller.
- **Positive**
  - `[E]` Revokes a specific session → **200**.
- **Negative / security**
  - `[E]` Target session not owned by caller → **404** (IDOR-safe: scoped by `userId`).
  - `[E]` Revoke races to a no-op (already gone) → **404**.
  - `[E]` Non-UUID `sessionId` → **400**.
  - `[E]` No token → **401**.
- **Status codes:** 200, 400, 401, 404.

## 18. POST /api/auth/sessions/revoke-all

- **Method:** POST · **Auth:** required.
- **Description:** "Sign out from all other devices" — revokes every session
  except the caller's current one.
- **Positive**
  - `[E]` Revokes all other sessions, keeps the current → **200** `{ revokedCount }`.
- **Negative**
  - `[E]` No token → **401**.
- **Status codes:** 200, 401.

## 19. POST /api/auth/social/google/link · POST /api/auth/social/apple/link

- **Method:** POST · **Auth:** required · **Validation:** `linkGoogleSchema` / `linkAppleSchema`.
- **Description:** Links a verified social provider to the caller's account;
  first linked method becomes `primaryAccount`.
- **Positive**
  - `[E]` Links a Google account → **200** `{ provider, primaryAccount }`.
- **Negative / security**
  - `[E]` Provider already linked to **this** user → **400** `AUTH_SOCIAL_ALREADY_LINKED`.
  - `[E]` Provider account linked to **another** user → **409** `AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE`.
  - `[E]` User already has this provider linked → **400** `AUTH_PROVIDER_ALREADY_LINKED`.
  - `[E]` Account not active (guard) → **401**.
  - `[E]` No token → **401**.
  - `[D]` Concurrent link race → P2002 mapped to 409/400 by `isProviderAccountConflict`.
- **Status codes:** 200, 400, 401, 409.

## 20. POST /api/auth/social/unlink

- **Method:** POST · **Auth:** required · **Validation:** `unlinkSocialSchema` (`provider` ∈ {GOOGLE, APPLE}).
- **Description:** Unlinks a social provider; refuses to remove the last sign-in method.
- **Positive**
  - `[E]` Unlinks when other sign-in methods remain → **200**.
- **Negative**
  - `[E]` Provider not linked → **400** `AUTH_SOCIAL_NOT_LINKED`.
  - `[E]` Unlinking the last remaining sign-in method → **400** `AUTH_LAST_SIGN_IN_METHOD`.
  - `[E]` No token → **401**.
  - `[D]` Invalid `provider` enum → **400** (Zod).
- **Status codes:** 200, 400, 401.

## 21. POST /api/auth/devices/link/initiate

- **Method:** POST · **Auth:** none · **Validation:** `initiateDeviceLinkSchema` (all device fields optional, ≤100 chars).
- **Description:** New device starts a QR/poll link session.
- **Positive**
  - `[E]` Creates a session → **201** `{ linkToken, pollSecret, expiresAt }`.
  - `[E]` Empty body accepted (all fields optional) → **201**.
- **Negative**
  - `[E]` Device field >100 chars → **400**.
- **Status codes:** 201, 400.

## 22. GET /api/auth/devices/link/status

- **Method:** GET · **Auth:** none · **Validation:** `deviceLinkStatusQuerySchema` (`linkToken`, `pollSecret`).
- **Description:** New device polls for approval and collects its tokens once.
- **Positive**
  - `[E]` `PENDING` while waiting.
  - `[E]` Hands back tokens exactly once when `APPROVED` (then `CONSUMED`).
- **Negative / security**
  - `[E]` Unknown session → `EXPIRED` (no enumeration leak).
  - `[E]` Wrong `pollSecret` → `EXPIRED` (indistinguishable from missing).
  - `[D]` Missing `linkToken` / `pollSecret` → **400**.
- **Status codes:** 200 (state in body), 400.

## 23. POST /api/auth/devices/link/approve

- **Method:** POST · **Auth:** required · **Validation:** `approveDeviceLinkSchema` (`linkToken`, optional `deviceLabel`).
- **Description:** Signed-in device approves a pending link; mints the new device's session.
- **Positive**
  - `[E]` Approves a pending link → **200** `{ linkedAt, sessionId }`.
- **Negative**
  - `[E]` Unknown link session → **404** `AUTH_DEVICE_LINK_NOT_FOUND`.
  - `[E]` Already approved → **409** `AUTH_DEVICE_LINK_ALREADY_APPROVED`.
  - `[E]` Link vanished during approval → **404**.
  - `[E]` No token → **401**.
- **Status codes:** 200, 401, 404, 409.

## 24. DELETE /api/auth/account

- **Method:** DELETE · **Auth:** required · **Validation:** `deleteAccountSchema` (`password?` optional at schema level).
- **Description:** Soft-deletes the caller's account; password required only for
  password accounts; revokes sessions; publishes `user.deleted`.
- **Positive**
  - `[E]` Password account + correct password → **200** `{ deletedAt }`.
  - `[E]` Social-only account without a password → **200**.
- **Negative**
  - `[E]` Password account omits the password → **400** `AUTH_PASSWORD_REQUIRED`.
  - `[E]` Wrong password → **401** `AUTH_PASSWORD_INCORRECT`.
  - `[E]` Account already deleted / not active (guard) → **401**.
  - `[E]` Empty-string password → **400** (Zod `min(1)`).
  - `[E]` No token → **401**.
- **Status codes:** 200, 400, 401.

## 25. POST /api/auth/test/push _(DEV-ONLY, mounted only when NODE_ENV=development)_

- **Method:** POST · **Auth:** **none** · **Validation:** inline `testPushSchema`.
- **Description:** Dev helper to trigger an FCM push by account. **Not mounted in
  test/production** (gated on `NODE_ENV === "development"`). No Jest coverage.
- `[D]` Unknown account → **404** `USER_NOT_FOUND`.
- `[D]` No FCM tokens stored → **200** "FCM push support is not configured yet."
- `[D]` notifications-service unreachable / rejects → **502** `BAD_GATEWAY`.
- **Security note:** unauthenticated account lookup; see AUDIT F7.

---

## gRPC surface (not HTTP; no supertest coverage)

`src/grpc/server.ts` exposes admin + internal methods with **no authentication**
on the gRPC channel itself: `getUserCounts`, `getActiveUserCounts`,
`getActiveUserSeries`, `adminListUsers`, `adminGetUser`, `getAccountSummary`,
`bulkGetAccounts`. Trust is delegated to the network boundary. See AUDIT F10.

---

## Coverage summary

| Area                                  | Executed cases |
| ------------------------------------- | -------------- |
| validate-account                      | 6              |
| register                              | 9              |
| login (+ extra branches)              | 14             |
| refresh / token                       | 11             |
| logout                                | 5              |
| social-auth (google/apple)            | 10             |
| password-reset (request/verify/reset) | 13             |
| link-email                            | 10             |
| change-email                          | 11             |
| change-password                       | 6              |
| sessions (list/revoke/revoke-all)     | 14             |
| social-link (link/unlink)             | 12             |
| device-link (initiate/status/approve) | 14             |
| account-deletion                      | 8              |
| **Total**                             | **183**        |
