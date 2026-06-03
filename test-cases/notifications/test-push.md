# Notifications — Dev Test-Push Endpoints

> **DEV-ONLY.** Both endpoints are explicitly marked for removal once real FCM fan-out is wired
> through the notification consumer. The auth-service one currently always returns "not configured".

**Source:**

- `apps/notifications-service/src/routes/test-push.routes.ts` (`POST /test/push`, mounted only in non-prod — `app.ts` guards `app.use("/test", testPushRouter)`)
- `apps/auth-service/src/api/routes/test-push.routes.ts` (`POST /test/push` — by account/email, NO auth)
- `apps/notifications-service/src/app.ts` (mount + env guard)

---

### TC-NOTIF-110 — notifications-service test push to token list (happy path)

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Test Push (dev)                                                     |
| **API/Event Name**        | `POST /test/push` (notifications-service)                                           |
| **Test Scenario**         | Fire push to explicit token list                                                    |
| **Category**              | Happy Path                                                                          |
| **Priority**              | Medium                                                                              |
| **Preconditions**         | Service running in non-prod; valid FCM token(s)                                     |
| **Request Payload**       | `{ "tokens":["tok1","tok2"], "title":"Hi", "body":"Test" }`                         |
| **Expected Response**     | `200` `{ success:true, sent:<okCount>, total:2, results:[{token, ok, messageId}] }` |
| **Expected DB Changes**   | None                                                                                |
| **Expected Socket/Event** | None                                                                                |
| **Notes**                 | Per-token `sendPush`; `ok = messageId !== null`                                     |

---

### TC-NOTIF-111 — test push, no auth required (dev exposure)

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Notifications / Test Push (dev)                                    |
| **API/Event Name**        | `POST /test/push` (notifications-service)                          |
| **Test Scenario**         | Call without any token                                             |
| **Category**              | AuthN                                                              |
| **Priority**              | High                                                               |
| **Preconditions**         | non-prod                                                           |
| **Request Payload**       | `{ "tokens":["t"], "title":"a", "body":"b" }`, no Authorization    |
| **Expected Response**     | `200` (no auth middleware on this route)                           |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | Security note: must be unreachable in production. See TC-NOTIF-114 |

---

### TC-NOTIF-112 — test push validation: empty tokens array

| Field                     | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Test Push (dev)                                 |
| **API/Event Name**        | `POST /test/push` (notifications-service)                       |
| **Test Scenario**         | `tokens: []`                                                    |
| **Category**              | Input Validation                                                |
| **Priority**              | Medium                                                          |
| **Preconditions**         | non-prod                                                        |
| **Request Payload**       | `{ "tokens":[], "title":"a", "body":"b" }`                      |
| **Expected Response**     | `400` `{ success:false, message:"Invalid body", issues:[...] }` |
| **Expected DB Changes**   | None                                                            |
| **Expected Socket/Event** | None                                                            |
| **Notes**                 | `tokens` `.min(1)` array of `.min(1)` strings                   |

---

### TC-NOTIF-113 — test push validation: title/body length bounds

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Notifications / Test Push (dev)                         |
| **API/Event Name**        | `POST /test/push` (notifications-service)               |
| **Test Scenario**         | `title` >120 or `body` >500 chars, or empty             |
| **Category**              | Input Validation                                        |
| **Priority**              | Low                                                     |
| **Preconditions**         | non-prod                                                |
| **Request Payload**       | `{ "tokens":["t"], "title":"<121 chars>", "body":"x" }` |
| **Expected Response**     | `400` Invalid body                                      |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | `title` 1–120, `body` 1–500                             |

---

### TC-NOTIF-114 — test push route disabled in production

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Test Push (dev)                                |
| **API/Event Name**        | `POST /test/push` (notifications-service)                      |
| **Test Scenario**         | Route mounted only outside production                          |
| **Category**              | Security                                                       |
| **Priority**              | High                                                           |
| **Preconditions**         | `NODE_ENV=production`                                          |
| **Request Payload**       | `{ "tokens":["t"], "title":"a", "body":"b" }`                  |
| **Expected Response**     | `404` (router not mounted)                                     |
| **Expected DB Changes**   | None                                                           |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | Verify the `app.use("/test", ...)` guard condition in `app.ts` |

---

### TC-NOTIF-115 — test push partial failure reporting

| Field                     | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Test Push (dev)                                                        |
| **API/Event Name**        | `POST /test/push` (notifications-service)                                              |
| **Test Scenario**         | One good token, one dead token                                                         |
| **Category**              | Error Handling                                                                         |
| **Priority**              | Medium                                                                                 |
| **Preconditions**         | non-prod; mixed tokens                                                                 |
| **Request Payload**       | `{ "tokens":["good","dead"], "title":"a", "body":"b" }`                                |
| **Expected Response**     | `200` `{ success:true, sent:1, total:2, results:[{good, ok:true}, {dead, ok:false}] }` |
| **Expected DB Changes**   | None (this dev route does NOT prune)                                                   |
| **Expected Socket/Event** | None                                                                                   |
| **Notes**                 | If `sendPush` throws, the catch returns `{ token, ok:false, error }`                   |

---

### TC-NOTIF-116 — auth-service test push by account (FCM not configured)

| Field                     | Value                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Test Push (dev)                                                                       |
| **API/Event Name**        | `POST /test/push` (auth-service)                                                                      |
| **Test Scenario**         | Trigger push by account/email for an existing user                                                    |
| **Category**              | Happy Path                                                                                            |
| **Priority**              | Low                                                                                                   |
| **Preconditions**         | User exists for `account`                                                                             |
| **Request Payload**       | `{ "account":"user@example.com" }`                                                                    |
| **Expected Response**     | `200` `ApiResponse({ userId, deviceCount:0, results:[] }, "FCM push support is not configured yet.")` |
| **Expected DB Changes**   | None                                                                                                  |
| **Expected Socket/Event** | None                                                                                                  |
| **Notes**                 | auth-service has no token store → `tokens=[]` short-circuit; never reaches notifications-service      |

---

### TC-NOTIF-117 — auth-service test push: unknown account

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Test Push (dev)                               |
| **API/Event Name**        | `POST /test/push` (auth-service)                              |
| **Test Scenario**         | `account` matches no user                                     |
| **Category**              | Error Handling                                                |
| **Priority**              | Low                                                           |
| **Preconditions**         | None                                                          |
| **Request Payload**       | `{ "account":"nobody@example.com" }`                          |
| **Expected Response**     | `404` `USER_NOT_FOUND`                                        |
| **Expected DB Changes**   | None                                                          |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | `authRepository.findByAccount` returns null → `NotFoundError` |

---

### TC-NOTIF-118 — auth-service test push: missing account

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| **Feature/Module**        | Notifications / Test Push (dev)            |
| **API/Event Name**        | `POST /test/push` (auth-service)           |
| **Test Scenario**         | Body omits `account`                       |
| **Category**              | Input Validation                           |
| **Priority**              | Low                                        |
| **Preconditions**         | None                                       |
| **Request Payload**       | `{}`                                       |
| **Expected Response**     | `400` (validateBody — `account` `.min(1)`) |
| **Expected DB Changes**   | None                                       |
| **Expected Socket/Event** | None                                       |
| **Notes**                 | `title`/`body` optional                    |

---

### TC-NOTIF-119 — auth-service test push: notifications-service unreachable (future path)

| Field                     | Value                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Test Push (dev)                                                                                |
| **API/Event Name**        | `POST /test/push` (auth-service)                                                                               |
| **Test Scenario**         | If token store existed and downstream fetch failed                                                             |
| **Category**              | Error Handling                                                                                                 |
| **Priority**              | Low                                                                                                            |
| **Preconditions**         | Hypothetical (tokens present) — currently unreachable since `tokens=[]`                                        |
| **Request Payload**       | `{ "account":"user@example.com" }`                                                                             |
| **Expected Response**     | `502 BAD_GATEWAY` "Could not reach notifications-service" on fetch throw, or "rejected the request" on non-2xx |
| **Expected DB Changes**   | None                                                                                                           |
| **Expected Socket/Event** | None                                                                                                           |
| **Notes**                 | Dead code today; documents intended error mapping                                                              |
