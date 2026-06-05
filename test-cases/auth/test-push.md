# Auth — Test Push (DEV ONLY)

Source: `apps/auth-service/src/api/routes/test-push.routes.ts` (`POST /api/auth/test/push`)

DEV-only helper, mounted only when not in production (`app.use("/api/auth", testPushRoutes)` guarded by env).
No auth. Looks up a user by account/email and would push to their FCM tokens — but FCM token storage isn't
wired in auth-service, so it always reports "not configured" with `deviceCount:0`.

---

### TC-AUTH-156 — Test push for existing user (not configured)

| Field                     | Value                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Test Push (dev)                                                                                    |
| **API/Event Name**        | `POST /api/auth/test/push`                                                                                |
| **Test Scenario**         | Known account → no tokens, returns not-configured                                                         |
| **Category**              | Happy Path                                                                                                |
| **Priority**              | Low                                                                                                       |
| **Preconditions**         | User exists; dev environment (route mounted)                                                              |
| **Request Payload**       | `{ "account": "new_user1" }`                                                                              |
| **Expected Response**     | `200` `{ data:{ userId, deviceCount:0, results:[] }, message:"FCM push support is not configured yet." }` |
| **Expected DB Changes**   | None                                                                                                      |
| **Expected Socket/Event** | None (no FCM tokens to dispatch to)                                                                       |
| **Notes**                 | `tokens` always empty in current implementation.                                                          |

### TC-AUTH-157 — Test push for unknown user → 404

| Field                     | Value                         |
| ------------------------- | ----------------------------- |
| **Feature/Module**        | Auth / Test Push (dev)        |
| **API/Event Name**        | `POST /api/auth/test/push`    |
| **Test Scenario**         | account not found             |
| **Category**              | Error Handling                |
| **Priority**              | Low                           |
| **Preconditions**         | None                          |
| **Request Payload**       | `{ "account": "ghost_user" }` |
| **Expected Response**     | `404` `USER_NOT_FOUND`        |
| **Expected DB Changes**   | None                          |
| **Expected Socket/Event** | None                          |
| **Notes**                 | `findByAccount` miss.         |

### TC-AUTH-158 — Test push missing account → 400

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Auth / Test Push (dev)                              |
| **API/Event Name**        | `POST /api/auth/test/push`                          |
| **Test Scenario**         | Empty body                                          |
| **Category**              | Required Params                                     |
| **Priority**              | Low                                                 |
| **Preconditions**         | None                                                |
| **Request Payload**       | `{}`                                                |
| **Expected Response**     | `400` VALIDATION_FAILED                             |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | `account` required; title<=120, body<=500 optional. |

### TC-AUTH-159 — Test push route absent in production

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Auth / Test Push (dev)                    |
| **API/Event Name**        | `POST /api/auth/test/push`                |
| **Test Scenario**         | Production build does not mount the route |
| **Category**              | Security                                  |
| **Priority**              | Medium                                    |
| **Preconditions**         | Production env                            |
| **Request Payload**       | `{ "account":"new_user1" }`               |
| **Expected Response**     | `404` (route not registered)              |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | Confirms the dev-only guard in app.ts.    |
