# Auth — Forgot / Reset Password

Source: `apps/auth-service/src/api/routes/auth.routes.ts`
(`POST /api/auth/forgot-password/request`, `.../verify`, `.../reset`)

Three-step flow → `passwordResetService`:

1. `requestOtp` — rate-limited OTP issuance (`assertOtpRequestAllowed` per email + IP), 6-digit code,
   `OtpCode(PASSWORD_RESET)`, published to notifications. Unknown/ineligible email → 404.
2. `verifyOtp` — checks attempts cap, verifies code (bcrypt), consumes OTP, issues a one-time `PasswordResetToken`.
3. `resetPassword` — consumes reset token, rejects same-as-current password (for password users), updates hash,
   **revokes all sessions**.

---

### TC-AUTH-044 — Request password reset OTP (happy path)

| Field                     | Value                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                                                                                                       |
| **API/Event Name**        | `POST /api/auth/forgot-password/request`                                                                                                    |
| **Test Scenario**         | Eligible email gets an OTP                                                                                                                  |
| **Category**              | Happy Path                                                                                                                                  |
| **Priority**              | High                                                                                                                                        |
| **Preconditions**         | Active user with verified email + a password OR linked social account                                                                       |
| **Request Payload**       | `{ "email": "user@example.com" }`                                                                                                           |
| **Expected Response**     | `200` `{ data:{ email:"user@example.com" }, message: AUTH_PASSWORD_RESET_OTP_SENT }`                                                        |
| **Expected DB Changes**   | Prior active PASSWORD_RESET OTPs consumed; new `OtpCode` (codeHash, expiresAt = OTP_TTL_SECONDS, maxAttempts = OTP_MAX_ATTEMPTS, ipAddress) |
| **Expected Socket/Event** | RabbitMQ password-reset-otp event (`publishPasswordResetOtpSafe`)                                                                           |
| **Notes**                 | Email normalized to lowercase.                                                                                                              |

### TC-AUTH-045 — Request reset for unknown email → 404

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Password Reset                                                                |
| **API/Event Name**        | `POST /api/auth/forgot-password/request`                                             |
| **Test Scenario**         | Email not on any account                                                             |
| **Category**              | Error Handling                                                                       |
| **Priority**              | High                                                                                 |
| **Preconditions**         | No user with this email                                                              |
| **Request Payload**       | `{ "email": "nobody@example.com" }`                                                  |
| **Expected Response**     | `404` `AUTH_PASSWORD_RESET_EMAIL_NOT_FOUND`                                          |
| **Expected DB Changes**   | None (rate-limit counter still incremented before lookup)                            |
| **Expected Socket/Event** | None                                                                                 |
| **Notes**                 | SECURITY: distinct 404 enables email enumeration on this endpoint — note as finding. |

### TC-AUTH-046 — Request reset for ineligible account (deleted/inactive/no method)

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                                            |
| **API/Event Name**        | `POST /api/auth/forgot-password/request`                                         |
| **Test Scenario**         | User exists but `canResetPassword` false                                         |
| **Category**              | Business Rule                                                                    |
| **Priority**              | Medium                                                                           |
| **Preconditions**         | User deletedAt set, or status != ACTIVE, or no password & no linked accounts     |
| **Request Payload**       | `{ "email": "ineligible@example.com" }`                                          |
| **Expected Response**     | `404` `AUTH_PASSWORD_RESET_EMAIL_NOT_FOUND`                                      |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | None                                                                             |
| **Notes**                 | `canResetPassword` requires (social OR passwordHash) AND active AND not deleted. |

### TC-AUTH-047 — Request reset OTP throttled (rate limit)

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                                                              |
| **API/Event Name**        | `POST /api/auth/forgot-password/request`                                                           |
| **Test Scenario**         | More than OTP_REQUEST_MAX requests in window                                                       |
| **Category**              | Rate Limit                                                                                         |
| **Priority**              | High                                                                                               |
| **Preconditions**         | Redis available; exceed OTP_REQUEST_MAX per email or per IP in OTP_REQUEST_WINDOW_SEC              |
| **Request Payload**       | repeated `{ "email": "user@example.com" }`                                                         |
| **Expected Response**     | `429` `AUTH_OTP_REQUEST_THROTTLED`                                                                 |
| **Expected DB Changes**   | None for throttled calls                                                                           |
| **Expected Socket/Event** | None                                                                                               |
| **Notes**                 | Throttle checked BEFORE user lookup; per-identifier and per-IP counters. Fails open if Redis down. |

### TC-AUTH-048 — Request reset invalid email format → 400

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                    |
| **API/Event Name**        | `POST /api/auth/forgot-password/request` |
| **Test Scenario**         | Not a valid email                        |
| **Category**              | Input Validation                         |
| **Priority**              | Medium                                   |
| **Preconditions**         | None                                     |
| **Request Payload**       | `{ "email": "not-an-email" }`            |
| **Expected Response**     | `400` VALIDATION_FAILED                  |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | `emailSchema.email()`.                   |

### TC-AUTH-049 — Verify reset OTP (happy path) issues reset token

| Field                     | Value                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                                                                           |
| **API/Event Name**        | `POST /api/auth/forgot-password/verify`                                                                         |
| **Test Scenario**         | Correct 6-digit code                                                                                            |
| **Category**              | Happy Path                                                                                                      |
| **Priority**              | High                                                                                                            |
| **Preconditions**         | Active PASSWORD_RESET OTP exists for email                                                                      |
| **Request Payload**       | `{ "email": "user@example.com", "code": "123456" }`                                                             |
| **Expected Response**     | `200` `{ data:{ resetToken, resetTokenExpiresIn }, message: AUTH_PASSWORD_RESET_OTP_VERIFIED }`                 |
| **Expected DB Changes**   | OTP `consumedAt` set; prior active reset tokens for user consumed; new `PasswordResetToken` (hashed, expiresAt) |
| **Expected Socket/Event** | None                                                                                                            |
| **Notes**                 | resetToken is the plaintext (>=32 chars); DB stores hash.                                                       |

### TC-AUTH-050 — Verify wrong OTP increments attempts

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                               |
| **API/Event Name**        | `POST /api/auth/forgot-password/verify`             |
| **Test Scenario**         | Incorrect code                                      |
| **Category**              | AuthN                                               |
| **Priority**              | High                                                |
| **Preconditions**         | Active OTP exists                                   |
| **Request Payload**       | `{ "email": "user@example.com", "code": "000000" }` |
| **Expected Response**     | `400` `AUTH_OTP_INVALID`                            |
| **Expected DB Changes**   | OTP `attempts` += 1                                 |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | —                                                   |

### TC-AUTH-051 — Verify after max attempts → blocked

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                               |
| **API/Event Name**        | `POST /api/auth/forgot-password/verify`             |
| **Test Scenario**         | attempts >= maxAttempts                             |
| **Category**              | Rate Limit                                          |
| **Priority**              | High                                                |
| **Preconditions**         | OTP attempts already at maxAttempts                 |
| **Request Payload**       | `{ "email": "user@example.com", "code": "123456" }` |
| **Expected Response**     | `400` `AUTH_OTP_MAX_ATTEMPTS`                       |
| **Expected DB Changes**   | None (even a correct code is rejected once capped)  |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | Cap checked before code verification.               |

### TC-AUTH-052 — Verify with no active OTP → invalid

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                               |
| **API/Event Name**        | `POST /api/auth/forgot-password/verify`             |
| **Test Scenario**         | No active OTP (expired/consumed/never sent)         |
| **Category**              | Error Handling                                      |
| **Priority**              | Medium                                              |
| **Preconditions**         | No active PASSWORD_RESET OTP                        |
| **Request Payload**       | `{ "email": "user@example.com", "code": "123456" }` |
| **Expected Response**     | `400` `AUTH_OTP_INVALID`                            |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | `findLatestActive` returns null.                    |

### TC-AUTH-053 — Verify rejects non-6-digit code format → 400

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                             |
| **API/Event Name**        | `POST /api/auth/forgot-password/verify`           |
| **Test Scenario**         | code = "12ab" or "1234567"                        |
| **Category**              | Input Validation                                  |
| **Priority**              | Medium                                            |
| **Preconditions**         | None                                              |
| **Request Payload**       | `{ "email": "user@example.com", "code": "12ab" }` |
| **Expected Response**     | `400` VALIDATION_FAILED                           |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | Regex `^\d{6}$`.                                  |

### TC-AUTH-054 — Reset password (happy path) revokes all sessions

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                                                                         |
| **API/Event Name**        | `POST /api/auth/forgot-password/reset`                                                                        |
| **Test Scenario**         | Valid reset token + new password                                                                              |
| **Category**              | Happy Path                                                                                                    |
| **Priority**              | High                                                                                                          |
| **Preconditions**         | Valid unconsumed unexpired `PasswordResetToken`                                                               |
| **Request Payload**       | `{ "resetToken": "<32+ chars>", "password": "N3wStr0ng!" }`                                                   |
| **Expected Response**     | `200` `{ data:null, message: AUTH_PASSWORD_RESET_SUCCESS }`                                                   |
| **Expected DB Changes**   | `passwordHash` updated (bcrypt 12); reset token `consumedAt` set; ALL sessions revoked + active cache cleared |
| **Expected Socket/Event** | None                                                                                                          |
| **Notes**                 | Forces re-login on all devices.                                                                               |

### TC-AUTH-055 — Reset with invalid/consumed token → 400

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                      |
| **API/Event Name**        | `POST /api/auth/forgot-password/reset`                     |
| **Test Scenario**         | Token not found or already consumed                        |
| **Category**              | Security                                                   |
| **Priority**              | High                                                       |
| **Preconditions**         | Token already used or wrong                                |
| **Request Payload**       | `{ "resetToken": "<consumed>", "password": "N3wStr0ng!" }` |
| **Expected Response**     | `400` `AUTH_RESET_TOKEN_INVALID`                           |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | Single-use enforced.                                       |

### TC-AUTH-056 — Reset with expired token → 400

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                     |
| **API/Event Name**        | `POST /api/auth/forgot-password/reset`                    |
| **Test Scenario**         | `expiresAt <= now`                                        |
| **Category**              | Error Handling                                            |
| **Priority**              | High                                                      |
| **Preconditions**         | PasswordResetToken expired                                |
| **Request Payload**       | `{ "resetToken": "<expired>", "password": "N3wStr0ng!" }` |
| **Expected Response**     | `400` `AUTH_RESET_TOKEN_EXPIRED`                          |
| **Expected DB Changes**   | None                                                      |
| **Expected Socket/Event** | None                                                      |
| **Notes**                 | —                                                         |

### TC-AUTH-057 — Reset new password same as current (password users) → 400

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                          |
| **API/Event Name**        | `POST /api/auth/forgot-password/reset`                         |
| **Test Scenario**         | New password equals current hash                               |
| **Category**              | Business Rule                                                  |
| **Priority**              | Medium                                                         |
| **Preconditions**         | Valid reset token; user has password & no linked social        |
| **Request Payload**       | `{ "resetToken": "<valid>", "password": "<same as current>" }` |
| **Expected Response**     | `400` `AUTH_PASSWORD_SAME_AS_CURRENT`                          |
| **Expected DB Changes**   | None                                                           |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | Check skipped for social users with no passwordHash.           |

### TC-AUTH-058 — Reset when account deleted/inactive → 400

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                   |
| **API/Event Name**        | `POST /api/auth/forgot-password/reset`                  |
| **Test Scenario**         | Token valid but account became inactive                 |
| **Category**              | Business Rule                                           |
| **Priority**              | Medium                                                  |
| **Preconditions**         | User deletedAt set or status != ACTIVE                  |
| **Request Payload**       | `{ "resetToken": "<valid>", "password": "N3wStr0ng!" }` |
| **Expected Response**     | `400` `AUTH_RESET_TOKEN_INVALID`                        |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | —                                                       |

### TC-AUTH-059 — Reset rejects short reset token / short password → 400

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                       |
| **API/Event Name**        | `POST /api/auth/forgot-password/reset`                      |
| **Test Scenario**         | resetToken < 32 chars OR password < 8                       |
| **Category**              | Input Validation                                            |
| **Priority**              | Medium                                                      |
| **Preconditions**         | None                                                        |
| **Request Payload**       | `{ "resetToken": "short", "password": "x" }`                |
| **Expected Response**     | `400` VALIDATION_FAILED                                     |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | `resetPasswordSchema`: resetToken min(32), password min(8). |

### TC-AUTH-060 — Reset token double-use (concurrency)

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Auth / Password Reset                                      |
| **API/Event Name**        | `POST /api/auth/forgot-password/reset`                     |
| **Test Scenario**         | Same reset token used twice concurrently                   |
| **Category**              | Concurrency                                                |
| **Priority**              | High                                                       |
| **Preconditions**         | One valid reset token                                      |
| **Request Payload**       | 2× `{ "resetToken": "<valid>", "password": "N3wStr0ng!" }` |
| **Expected Response**     | One `200`; the other `400 AUTH_RESET_TOKEN_INVALID`        |
| **Expected DB Changes**   | Password updated once; token consumed once                 |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | Verify `markConsumed` ordering prevents two successes.     |
