# Auth — Sessions (devices)

Source: `apps/auth-service/src/api/routes/session.routes.ts`
(`GET /api/auth/sessions`, `POST /api/auth/sessions/revoke-all`, `DELETE /api/auth/sessions/:sessionId`)

`sessionService.listSessions / revokeAllSessions / revokeSession`. All require a valid access token.
`revoke-all` keeps the caller's current session (sign out other devices). `DELETE :sessionId` can revoke any
of the caller's own sessions including the current one; `:sessionId` must be a UUID.

---

### TC-AUTH-073 — List active sessions (happy path)

| Field                     | Value                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Sessions                                                                                                                                                                                   |
| **API/Event Name**        | `GET /api/auth/sessions`                                                                                                                                                                          |
| **Test Scenario**         | Authenticated user lists their devices                                                                                                                                                            |
| **Category**              | Happy Path                                                                                                                                                                                        |
| **Priority**              | High                                                                                                                                                                                              |
| **Preconditions**         | User has >=1 active session                                                                                                                                                                       |
| **Request Payload**       | none (Bearer token)                                                                                                                                                                               |
| **Expected Response**     | `200` `{ data:{ sessions:[{ sessionId, deviceId, deviceName, deviceType, osVersion, appVersion, ipAddress, countryCode, lastActiveAt, createdAt, isCurrent }] }, message: AUTH_SESSIONS_LISTED }` |
| **Expected DB Changes**   | None                                                                                                                                                                                              |
| **Expected Socket/Event** | None                                                                                                                                                                                              |
| **Notes**                 | `isCurrent=true` for the row matching the JWT sessionId. Only non-revoked sessions returned.                                                                                                      |

### TC-AUTH-074 — List sessions without auth → 401

| Field                     | Value                    |
| ------------------------- | ------------------------ |
| **Feature/Module**        | Auth / Sessions          |
| **API/Event Name**        | `GET /api/auth/sessions` |
| **Test Scenario**         | No access token          |
| **Category**              | AuthN                    |
| **Priority**              | High                     |
| **Preconditions**         | None                     |
| **Request Payload**       | none                     |
| **Expected Response**     | `401`                    |
| **Expected DB Changes**   | None                     |
| **Expected Socket/Event** | None                     |
| **Notes**                 | —                        |

### TC-AUTH-075 — Revoke a specific other session (remote sign-out)

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Sessions                                                                    |
| **API/Event Name**        | `DELETE /api/auth/sessions/:sessionId`                                             |
| **Test Scenario**         | Revoke another device                                                              |
| **Category**              | Happy Path                                                                         |
| **Priority**              | High                                                                               |
| **Preconditions**         | Caller has a second active session                                                 |
| **Request Payload**       | path `:sessionId` = other session UUID                                             |
| **Expected Response**     | `200` `{ data:null, message: AUTH_SESSION_REVOKED }`                               |
| **Expected DB Changes**   | Target `Session.revokedAt` set, reason `REMOTE_SIGNOUT`; cleared from active cache |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | Reason is REMOTE_SIGNOUT when target != current.                                   |

### TC-AUTH-076 — Revoke current session via DELETE

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Auth / Sessions                                          |
| **API/Event Name**        | `DELETE /api/auth/sessions/:sessionId`                   |
| **Test Scenario**         | Caller revokes their own current session                 |
| **Category**              | Business Rule                                            |
| **Priority**              | Medium                                                   |
| **Preconditions**         | sessionId == current session                             |
| **Request Payload**       | path `:sessionId` = current session UUID                 |
| **Expected Response**     | `200` AUTH_SESSION_REVOKED                               |
| **Expected DB Changes**   | Current `Session.revokedAt`, reason `USER_SIGNED_OUT`    |
| **Expected Socket/Event** | None                                                     |
| **Notes**                 | Reason differs (USER_SIGNED_OUT) when target == current. |

### TC-AUTH-077 — Revoke session not owned / nonexistent → 404

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Auth / Sessions                                                   |
| **API/Event Name**        | `DELETE /api/auth/sessions/:sessionId`                            |
| **Test Scenario**         | sessionId belongs to another user or doesn't exist                |
| **Category**              | AuthZ                                                             |
| **Priority**              | High                                                              |
| **Preconditions**         | UUID not an active session of caller                              |
| **Request Payload**       | path `:sessionId` = stranger's/unknown UUID                       |
| **Expected Response**     | `404` `AUTH_SESSION_NOT_FOUND`                                    |
| **Expected DB Changes**   | None                                                              |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | `findActiveForUser` scopes to caller; prevents cross-user revoke. |

### TC-AUTH-078 — Revoke already-revoked session → 404

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Auth / Sessions                          |
| **API/Event Name**        | `DELETE /api/auth/sessions/:sessionId`   |
| **Test Scenario**         | Target session already revoked           |
| **Category**              | Edge Case                                |
| **Priority**              | Medium                                   |
| **Preconditions**         | Target session revokedAt already set     |
| **Request Payload**       | path `:sessionId` = revoked session UUID |
| **Expected Response**     | `404` `AUTH_SESSION_NOT_FOUND`           |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | `findActiveForUser` excludes revoked.    |

### TC-AUTH-079 — Revoke with non-UUID sessionId → 400

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Auth / Sessions                        |
| **API/Event Name**        | `DELETE /api/auth/sessions/:sessionId` |
| **Test Scenario**         | sessionId = "abc"                      |
| **Category**              | Input Validation                       |
| **Priority**              | Medium                                 |
| **Preconditions**         | None                                   |
| **Request Payload**       | path `:sessionId` = "abc"              |
| **Expected Response**     | `400` VALIDATION_FAILED                |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | `sessionIdParamsSchema.uuid()`.        |

### TC-AUTH-080 — Revoke all other sessions (keep current)

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Sessions                                                                     |
| **API/Event Name**        | `POST /api/auth/sessions/revoke-all`                                                |
| **Test Scenario**         | Sign out from all other devices                                                     |
| **Category**              | Happy Path                                                                          |
| **Priority**              | High                                                                                |
| **Preconditions**         | Caller has multiple active sessions                                                 |
| **Request Payload**       | none                                                                                |
| **Expected Response**     | `200` `{ data:{ ...revokedCount }, message: AUTH_SESSIONS_ALL_REVOKED }`            |
| **Expected DB Changes**   | All sessions except current revoked (`REMOTE_SIGNOUT`); their cache entries cleared |
| **Expected Socket/Event** | None                                                                                |
| **Notes**                 | Current session remains usable.                                                     |

### TC-AUTH-081 — Revoke-all with only the current session → no-op count

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Auth / Sessions                              |
| **API/Event Name**        | `POST /api/auth/sessions/revoke-all`         |
| **Test Scenario**         | Caller has just one (current) session        |
| **Category**              | Edge Case                                    |
| **Priority**              | Low                                          |
| **Preconditions**         | Single active session                        |
| **Request Payload**       | none                                         |
| **Expected Response**     | `200`; revoked count 0; current still active |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | `otherSessionIds` empty.                     |

### TC-AUTH-082 — Revoked session can no longer call protected routes

| Field                     | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Sessions                                                                        |
| **API/Event Name**        | `DELETE /api/auth/sessions/:sessionId` then any protected route with the revoked token |
| **Test Scenario**         | Access token of a revoked session is rejected                                          |
| **Category**              | Security                                                                               |
| **Priority**              | High                                                                                   |
| **Preconditions**         | Session B revoked from session A                                                       |
| **Request Payload**       | Use B's access token on `GET /api/auth/sessions`                                       |
| **Expected Response**     | `401` (session-active check fails even though JWT not yet expired)                     |
| **Expected DB Changes**   | None                                                                                   |
| **Expected Socket/Event** | None                                                                                   |
| **Notes**                 | Validates cache-backed `assertSessionActive` revocation model.                         |
