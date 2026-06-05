# Auth — Logout

Source: `apps/auth-service/src/api/routes/auth.routes.ts` (`POST /api/auth/logout`)

`logout` → `sessionService.logout(userId, sessionId)`. Requires a valid access token
(`authenticateAccessToken`). Revokes the caller's current session (`USER_SIGNED_OUT`) and clears it from the
session-active cache.

---

### TC-AUTH-039 — Logout current session (happy path)

| Field                     | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Logout                                                                                |
| **API/Event Name**        | `POST /api/auth/logout`                                                                      |
| **Test Scenario**         | Authenticated user logs out                                                                  |
| **Category**              | Happy Path                                                                                   |
| **Priority**              | High                                                                                         |
| **Preconditions**         | Valid access token for an active session                                                     |
| **Request Payload**       | none (Bearer access token in header)                                                         |
| **Expected Response**     | `200` `{ data:null, message: AUTH_LOGOUT_SUCCESS }`                                          |
| **Expected DB Changes**   | Current `Session.revokedAt` set, reason `USER_SIGNED_OUT`; session removed from active cache |
| **Expected Socket/Event** | None                                                                                         |
| **Notes**                 | Session id taken from JWT (`req.auth.sessionId`).                                            |

### TC-AUTH-040 — Logout without access token → 401

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Auth / Logout                           |
| **API/Event Name**        | `POST /api/auth/logout`                 |
| **Test Scenario**         | No Authorization header                 |
| **Category**              | AuthN                                   |
| **Priority**              | High                                    |
| **Preconditions**         | None                                    |
| **Request Payload**       | none                                    |
| **Expected Response**     | `401` (authenticate middleware rejects) |
| **Expected DB Changes**   | None                                    |
| **Expected Socket/Event** | None                                    |
| **Notes**                 | —                                       |

### TC-AUTH-041 — Logout with tampered JWT → 401

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Auth / Logout                          |
| **API/Event Name**        | `POST /api/auth/logout`                |
| **Test Scenario**         | Signature-modified access token        |
| **Category**              | Security                               |
| **Priority**              | High                                   |
| **Preconditions**         | None                                   |
| **Request Payload**       | none (forged Bearer token)             |
| **Expected Response**     | `401`                                  |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | JWT verified with `JWT_ACCESS_SECRET`. |

### TC-AUTH-042 — Logout when session already revoked

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Logout                                                                        |
| **API/Event Name**        | `POST /api/auth/logout`                                                              |
| **Test Scenario**         | Session revoked between token issue and logout                                       |
| **Category**              | Edge Case                                                                            |
| **Priority**              | Medium                                                                               |
| **Preconditions**         | Session revoked; access token still un-expired but `assertSessionActive` should fail |
| **Request Payload**       | none                                                                                 |
| **Expected Response**     | `401` (session-active check fails in middleware) — request never reaches the handler |
| **Expected DB Changes**   | None                                                                                 |
| **Expected Socket/Event** | None                                                                                 |
| **Notes**                 | `authenticateAccessToken` runs `isSessionActiveForRequest`.                          |

### TC-AUTH-043 — Logout is idempotent for cache (no double-revoke side effects)

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Logout                                                                               |
| **API/Event Name**        | `POST /api/auth/logout`                                                                     |
| **Test Scenario**         | revokeForUser returns revoked:false when nothing to revoke                                  |
| **Category**              | DB State                                                                                    |
| **Priority**              | Low                                                                                         |
| **Preconditions**         | Session already revoked at DB but still cached active                                       |
| **Request Payload**       | none                                                                                        |
| **Expected Response**     | `200` (handler reached only if cache says active); cache cleared only when `result.revoked` |
| **Expected DB Changes**   | No-op if already revoked                                                                    |
| **Expected Socket/Event** | None                                                                                        |
| **Notes**                 | `markSessionRevoked` only called when `result.revoked` true.                                |
