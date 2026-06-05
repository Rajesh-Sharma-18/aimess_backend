# Auth — Refresh & Access Token

Source: `apps/auth-service/src/api/routes/auth.routes.ts` (`POST /api/auth/refresh`, `POST /api/auth/token`)

`refreshTokens` → `sessionService.refresh` (rotates the refresh token, returns a new access+refresh pair).
`issueAccessToken` → `sessionService.issueAccessToken` (returns a new access token only, **no rotation**).
Both validate `refreshTokenSchema` (`refreshToken` non-empty). Refresh tokens are SHA-256 hashed in DB.
Reuse of an already-rotated token triggers a **token-reuse breach response**: ALL of the user's sessions are
revoked.

---

### TC-AUTH-027 — Refresh rotates tokens (happy path)

| Field                     | Value                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Refresh                                                                                                                        |
| **API/Event Name**        | `POST /api/auth/refresh`                                                                                                              |
| **Test Scenario**         | Valid active refresh token returns new pair                                                                                           |
| **Category**              | Happy Path                                                                                                                            |
| **Priority**              | High                                                                                                                                  |
| **Preconditions**         | Active session with a valid, unrotated, unexpired refresh token                                                                       |
| **Request Payload**       | `{ "refreshToken": "<valid>" }`                                                                                                       |
| **Expected Response**     | `200` `{ data:{ tokens:{ accessToken, refreshToken, accessTokenExpiresIn, refreshTokenExpiresIn } }, message: AUTH_REFRESH_SUCCESS }` |
| **Expected DB Changes**   | Old `RefreshToken.rotatedToId` set to new row; new `RefreshToken` created; session marked active in cache                             |
| **Expected Socket/Event** | None                                                                                                                                  |
| **Notes**                 | New refreshToken differs from the supplied one.                                                                                       |

### TC-AUTH-028 — Refresh with unknown token → 401

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Auth / Refresh                        |
| **API/Event Name**        | `POST /api/auth/refresh`              |
| **Test Scenario**         | Token hash not found                  |
| **Category**              | AuthN                                 |
| **Priority**              | High                                  |
| **Preconditions**         | None                                  |
| **Request Payload**       | `{ "refreshToken": "garbage-token" }` |
| **Expected Response**     | `401` `AUTH_REFRESH_TOKEN_INVALID`    |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |
| **Notes**                 | —                                     |

### TC-AUTH-029 — Refresh-token reuse revokes all sessions (breach)

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Refresh                                                                                     |
| **API/Event Name**        | `POST /api/auth/refresh`                                                                           |
| **Test Scenario**         | Replay a token that was already rotated                                                            |
| **Category**              | Security                                                                                           |
| **Priority**              | High                                                                                               |
| **Preconditions**         | A refresh token already rotated once (`rotatedToId` set)                                           |
| **Request Payload**       | `{ "refreshToken": "<old-rotated-token>" }`                                                        |
| **Expected Response**     | `401` `AUTH_REFRESH_TOKEN_INVALID`                                                                 |
| **Expected DB Changes**   | ALL user sessions revoked with reason `TOKEN_REUSE_DETECTED`; session-active cache cleared for all |
| **Expected Socket/Event** | None                                                                                               |
| **Notes**                 | Theft-detection: legitimate + attacker both get logged out.                                        |

### TC-AUTH-030 — Refresh with expired token → 401 expired

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Auth / Refresh                                 |
| **API/Event Name**        | `POST /api/auth/refresh`                       |
| **Test Scenario**         | `expiresAt <= now`                             |
| **Category**              | Error Handling                                 |
| **Priority**              | High                                           |
| **Preconditions**         | RefreshToken expired, not rotated, not revoked |
| **Request Payload**       | `{ "refreshToken": "<expired>" }`              |
| **Expected Response**     | `401` `AUTH_REFRESH_TOKEN_EXPIRED`             |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | Distinct code from INVALID.                    |

### TC-AUTH-031 — Refresh with revoked token → 401

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Auth / Refresh                         |
| **API/Event Name**        | `POST /api/auth/refresh`               |
| **Test Scenario**         | Token row has `revokedAt` set          |
| **Category**              | AuthN                                  |
| **Priority**              | High                                   |
| **Preconditions**         | RefreshToken revoked (e.g. via logout) |
| **Request Payload**       | `{ "refreshToken": "<revoked>" }`      |
| **Expected Response**     | `401` `AUTH_REFRESH_TOKEN_INVALID`     |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | —                                      |

### TC-AUTH-032 — Refresh when parent session revoked → 401

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Auth / Refresh                                               |
| **API/Event Name**        | `POST /api/auth/refresh`                                     |
| **Test Scenario**         | Session.revokedAt set but token row not individually revoked |
| **Category**              | Business Rule                                                |
| **Priority**              | High                                                         |
| **Preconditions**         | Session revoked (e.g. remote sign-out)                       |
| **Request Payload**       | `{ "refreshToken": "<token of revoked session>" }`           |
| **Expected Response**     | `401` `AUTH_REFRESH_TOKEN_INVALID`                           |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | `stored.session.revokedAt` guard.                            |

### TC-AUTH-033 — Refresh when account deleted/inactive → 401 not active

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Auth / Refresh                                         |
| **API/Event Name**        | `POST /api/auth/refresh`                               |
| **Test Scenario**         | User soft-deleted or status != ACTIVE                  |
| **Category**              | Business Rule                                          |
| **Priority**              | High                                                   |
| **Preconditions**         | User deletedAt set OR status SUSPENDED/BANNED          |
| **Request Payload**       | `{ "refreshToken": "<valid token of inactive user>" }` |
| **Expected Response**     | `401` `AUTH_ACCOUNT_NOT_ACTIVE`                        |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | —                                                      |

### TC-AUTH-034 — Refresh missing token field → 400

| Field                     | Value                        |
| ------------------------- | ---------------------------- |
| **Feature/Module**        | Auth / Refresh               |
| **API/Event Name**        | `POST /api/auth/refresh`     |
| **Test Scenario**         | Empty body                   |
| **Category**              | Required Params              |
| **Priority**              | Medium                       |
| **Preconditions**         | None                         |
| **Request Payload**       | `{}`                         |
| **Expected Response**     | `400` VALIDATION_FAILED      |
| **Expected DB Changes**   | None                         |
| **Expected Socket/Event** | None                         |
| **Notes**                 | `refreshTokenSchema.min(1)`. |

### TC-AUTH-035 — Double-spend refresh token race (concurrency)

| Field                     | Value                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Refresh                                                                                                                    |
| **API/Event Name**        | `POST /api/auth/refresh`                                                                                                          |
| **Test Scenario**         | Same refresh token sent twice concurrently                                                                                        |
| **Category**              | Concurrency                                                                                                                       |
| **Priority**              | High                                                                                                                              |
| **Preconditions**         | One valid unrotated refresh token                                                                                                 |
| **Request Payload**       | 2× `{ "refreshToken": "<same valid>" }`                                                                                           |
| **Expected Response**     | Ideally one `200`, the loser `401`. If both read pre-rotation, the second replay is later treated as reuse → all sessions revoked |
| **Expected DB Changes**   | At most one successful rotation; reuse path may revoke all sessions                                                               |
| **Expected Socket/Event** | None                                                                                                                              |
| **Notes**                 | Verify `rotate` is atomic; document observed behavior under contention.                                                           |

### TC-AUTH-036 — Issue access token without rotation (happy path)

| Field                     | Value                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Token                                                                              |
| **API/Event Name**        | `POST /api/auth/token`                                                                    |
| **Test Scenario**         | Valid refresh token returns access token only                                             |
| **Category**              | Happy Path                                                                                |
| **Priority**              | High                                                                                      |
| **Preconditions**         | Valid active refresh token                                                                |
| **Request Payload**       | `{ "refreshToken": "<valid>" }`                                                           |
| **Expected Response**     | `200` `{ data:{ accessToken, accessTokenExpiresIn }, message: AUTH_ACCESS_TOKEN_ISSUED }` |
| **Expected DB Changes**   | NO rotation — refresh token unchanged; session marked active                              |
| **Expected Socket/Event** | None                                                                                      |
| **Notes**                 | Differs from /refresh: refresh token is NOT consumed.                                     |

### TC-AUTH-037 — Issue access token reuse detection

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Auth / Token                                |
| **API/Event Name**        | `POST /api/auth/token`                      |
| **Test Scenario**         | Already-rotated token replayed              |
| **Category**              | Security                                    |
| **Priority**              | High                                        |
| **Preconditions**         | refresh token has rotatedToId set           |
| **Request Payload**       | `{ "refreshToken": "<rotated>" }`           |
| **Expected Response**     | `401` `AUTH_REFRESH_TOKEN_INVALID`          |
| **Expected DB Changes**   | All sessions revoked `TOKEN_REUSE_DETECTED` |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | Same breach handling as /refresh.           |

### TC-AUTH-038 — Issue access token with expired/revoked/inactive

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Auth / Token                                                      |
| **API/Event Name**        | `POST /api/auth/token`                                            |
| **Test Scenario**         | Expired→EXPIRED, revoked→INVALID, inactive user→NOT_ACTIVE        |
| **Category**              | Error Handling                                                    |
| **Priority**              | High                                                              |
| **Preconditions**         | Various invalid states                                            |
| **Request Payload**       | `{ "refreshToken": "<state>" }`                                   |
| **Expected Response**     | `401` with matching code (EXPIRED / INVALID / ACCOUNT_NOT_ACTIVE) |
| **Expected DB Changes**   | None                                                              |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | Mirrors /refresh guards minus rotation.                           |
