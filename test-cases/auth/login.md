# Auth — Login

Source: `apps/auth-service/src/api/routes/auth.routes.ts` (`POST /api/auth/login`)

`login` → `authService.login`. NOTE: the route has **no `validateBody`** (`loginSchema` is commented out in
the router), so all validation is done by the service / repository, not Zod. Identifier may be a username
(`account`) or a **verified linked email**. bcrypt compare; failed attempts increment `failedLoginAttempts`
and lock after `AUTH_MAX_FAILED_LOGINS`. On success, FCM tokens are merged and a `Session` + `RefreshToken`
are issued (`rememberMe` extends refresh TTL).

---

### TC-AUTH-014 — Login with username + password (happy path)

| Field                     | Value                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Login                                                                                                                                            |
| **API/Event Name**        | `POST /api/auth/login`                                                                                                                                  |
| **Test Scenario**         | Valid username + password returns tokens                                                                                                                |
| **Category**              | Happy Path                                                                                                                                              |
| **Priority**              | High                                                                                                                                                    |
| **Preconditions**         | Active `AuthUser` `account="new_user1"` with known password                                                                                             |
| **Request Payload**       | `{ "account": "new_user1", "password": "Str0ngPass!" }`                                                                                                 |
| **Expected Response**     | `200` `{ data:{ tokens:{ accessToken, refreshToken, accessTokenExpiresIn, refreshTokenExpiresIn }, isProfileCompleted }, message: AUTH_LOGIN_SUCCESS }` |
| **Expected DB Changes**   | `lastLoginAt` updated, `failedLoginAttempts` reset (recordSuccessfulLogin); FCM merge; new `Session` + `RefreshToken`                                   |
| **Expected Socket/Event** | None                                                                                                                                                    |
| **Notes**                 | Response shape differs from register (no `user` object).                                                                                                |

### TC-AUTH-015 — Login with verified email identifier

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Auth / Login                                                      |
| **API/Event Name**        | `POST /api/auth/login`                                            |
| **Test Scenario**         | account field holds a verified linked email                       |
| **Category**              | Happy Path                                                        |
| **Priority**              | High                                                              |
| **Preconditions**         | User has `email` set AND `emailVerified=true`                     |
| **Request Payload**       | `{ "account": "user@example.com", "password": "Str0ngPass!" }`    |
| **Expected Response**     | `200` tokens                                                      |
| **Expected DB Changes**   | success login bookkeeping; new session                            |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | `isEmailLoginIdentifier` detects `@`; uses `findByEmailForLogin`. |

### TC-AUTH-016 — Login with unverified email → invalid credentials

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Auth / Login                                                   |
| **API/Event Name**        | `POST /api/auth/login`                                         |
| **Test Scenario**         | Email exists but emailVerified=false                           |
| **Category**              | Business Rule                                                  |
| **Priority**              | High                                                           |
| **Preconditions**         | User with email, `emailVerified=false`                         |
| **Request Payload**       | `{ "account": "user@example.com", "password": "Str0ngPass!" }` |
| **Expected Response**     | `401` `AUTH_INVALID_CREDENTIALS`                               |
| **Expected DB Changes**   | None                                                           |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | Generic error avoids leaking that the email exists.            |

### TC-AUTH-017 — Login wrong password increments failed attempts

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Auth / Login                                          |
| **API/Event Name**        | `POST /api/auth/login`                                |
| **Test Scenario**         | Correct user, wrong password                          |
| **Category**              | AuthN                                                 |
| **Priority**              | High                                                  |
| **Preconditions**         | Active user exists                                    |
| **Request Payload**       | `{ "account": "new_user1", "password": "wrongpass" }` |
| **Expected Response**     | `401` `AUTH_INVALID_CREDENTIALS`                      |
| **Expected DB Changes**   | `failedLoginAttempts` += 1 (recordFailedLogin)        |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | —                                                     |

### TC-AUTH-018 — Login locks account after max failed attempts

| Field                     | Value                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Login                                                                                                                   |
| **API/Event Name**        | `POST /api/auth/login`                                                                                                         |
| **Test Scenario**         | Exceed AUTH_MAX_FAILED_LOGINS → lockout                                                                                        |
| **Category**              | Rate Limit                                                                                                                     |
| **Priority**              | High                                                                                                                           |
| **Preconditions**         | Active user; repeat wrong password AUTH_MAX_FAILED_LOGINS times                                                                |
| **Request Payload**       | repeated `{ "account":"new_user1", "password":"wrong" }`                                                                       |
| **Expected Response**     | After threshold: subsequent attempts `401 AUTH_ACCOUNT_LOCKED` even with correct password while `lockedUntil` is in the future |
| **Expected DB Changes**   | `lockedUntil` set ~`AUTH_LOCKOUT_MINUTES` ahead                                                                                |
| **Expected Socket/Event** | None                                                                                                                           |
| **Notes**                 | Lock checked before password compare.                                                                                          |

### TC-AUTH-019 — Login nonexistent account → invalid credentials

| Field                     | Value                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Login                                                                                                                                           |
| **API/Event Name**        | `POST /api/auth/login`                                                                                                                                 |
| **Test Scenario**         | Unknown username                                                                                                                                       |
| **Category**              | Security                                                                                                                                               |
| **Priority**              | High                                                                                                                                                   |
| **Preconditions**         | None                                                                                                                                                   |
| **Request Payload**       | `{ "account": "ghost_user", "password": "whatever1" }`                                                                                                 |
| **Expected Response**     | `401` `AUTH_INVALID_CREDENTIALS`                                                                                                                       |
| **Expected DB Changes**   | None                                                                                                                                                   |
| **Expected Socket/Event** | None                                                                                                                                                   |
| **Notes**                 | Same error/status as wrong-password → no account enumeration. Timing differs (no bcrypt compare on missing user) — note potential timing side-channel. |

### TC-AUTH-020 — Login on soft-deleted account → invalid credentials

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- | --- | ---------------------- |
| **Feature/Module**        | Auth / Login                                               |
| **API/Event Name**        | `POST /api/auth/login`                                     |
| **Test Scenario**         | User has `deletedAt` set                                   |
| **Category**              | Business Rule                                              |
| **Priority**              | High                                                       |
| **Preconditions**         | User soft-deleted (deletedAt non-null)                     |
| **Request Payload**       | `{ "account": "deleted_user", "password": "Str0ngPass!" }` |
| **Expected Response**     | `401` `AUTH_INVALID_CREDENTIALS`                           |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | `!user                                                     |     | user.deletedAt` guard. |

### TC-AUTH-021 — Login on suspended/banned account → not active

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Auth / Login                                            |
| **API/Event Name**        | `POST /api/auth/login`                                  |
| **Test Scenario**         | status = SUSPENDED or BANNED                            |
| **Category**              | Business Rule                                           |
| **Priority**              | High                                                    |
| **Preconditions**         | User status != ACTIVE, not deleted, not locked          |
| **Request Payload**       | `{ "account": "susp_user", "password": "Str0ngPass!" }` |
| **Expected Response**     | `401` `AUTH_ACCOUNT_NOT_ACTIVE`                         |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | —                                                       |

### TC-AUTH-022 — Login on social-only account (no password set)

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Auth / Login                                            |
| **API/Event Name**        | `POST /api/auth/login`                                  |
| **Test Scenario**         | Account has no passwordHash (Google/Apple-only)         |
| **Category**              | Business Rule                                           |
| **Priority**              | Medium                                                  |
| **Preconditions**         | Active user with `passwordHash = null`                  |
| **Request Payload**       | `{ "account": "social_user", "password": "anything1" }` |
| **Expected Response**     | `401` `AUTH_PASSWORD_NOT_SET`                           |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | Checked after lock/active guards, before bcrypt.        |

### TC-AUTH-023 — Login merges supplied FCM tokens

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Login                                                                   |
| **API/Event Name**        | `POST /api/auth/login`                                                         |
| **Test Scenario**         | fcmTokens provided are merged onto the user                                    |
| **Category**              | DB State                                                                       |
| **Priority**              | Medium                                                                         |
| **Preconditions**         | Active user                                                                    |
| **Request Payload**       | `{ "account":"new_user1", "password":"Str0ngPass!", "fcmTokens":["tok-abc"] }` |
| **Expected Response**     | `200` tokens                                                                   |
| **Expected DB Changes**   | `auth_users.fcmTokens` contains `tok-abc` (deduped merge)                      |
| **Expected Socket/Event** | None                                                                           |
| **Notes**                 | `mergeFcmTokens` runs only after successful auth.                              |

### TC-AUTH-024 — Login rememberMe extends refresh token TTL

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Login                                                                       |
| **API/Event Name**        | `POST /api/auth/login`                                                             |
| **Test Scenario**         | rememberMe:true uses longer refresh expiry                                         |
| **Category**              | Business Rule                                                                      |
| **Priority**              | Medium                                                                             |
| **Preconditions**         | Active user                                                                        |
| **Request Payload**       | `{ "account":"new_user1", "password":"Str0ngPass!", "rememberMe":true }`           |
| **Expected Response**     | `200`; `refreshTokenExpiresIn` == `JWT_REFRESH_EXPIRES_IN_REMEMBER_ME` (> default) |
| **Expected DB Changes**   | `RefreshToken.expiresAt` further in the future                                     |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | `issueAuthTokens(userId, session, rememberMe)`.                                    |

### TC-AUTH-025 — Login with no body (no Zod guard on route)

| Field                     | Value                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Login                                                                                                                                 |
| **API/Event Name**        | `POST /api/auth/login`                                                                                                                       |
| **Test Scenario**         | Empty/missing fields reach the service unvalidated                                                                                           |
| **Category**              | Edge Case                                                                                                                                    |
| **Priority**              | Medium                                                                                                                                       |
| **Preconditions**         | None                                                                                                                                         |
| **Request Payload**       | `{}`                                                                                                                                         |
| **Expected Response**     | `401`/`500` — `normalizeLoginIdentifier(undefined)` may throw before reaching credential checks                                              |
| **Expected DB Changes**   | None                                                                                                                                         |
| **Expected Socket/Event** | None                                                                                                                                         |
| **Notes**                 | GAP: `loginSchema` exists but is NOT wired (`validateBody` commented out in router). Document actual behavior; recommend enabling validator. |

### TC-AUTH-026 — Login is case-sensitive on account (no toLowerCase)

| Field                     | Value                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Login                                                                                                     |
| **API/Event Name**        | `POST /api/auth/login`                                                                                           |
| **Test Scenario**         | "New_User1" vs stored "new_user1"                                                                                |
| **Category**              | Edge Case                                                                                                        |
| **Priority**              | Low                                                                                                              |
| **Preconditions**         | User stored as `new_user1`                                                                                       |
| **Request Payload**       | `{ "account": "New_User1", "password": "Str0ngPass!" }`                                                          |
| **Expected Response**     | Depends on `findByAccountForLogin` collation; `normalizeLoginIdentifier` only trims (no lowercase)               |
| **Expected DB Changes**   | None                                                                                                             |
| **Expected Socket/Event** | None                                                                                                             |
| **Notes**                 | GAP/ambiguity: comment in login-identifier.ts says it lowercases but code only `.trim()`s. Verify case handling. |
