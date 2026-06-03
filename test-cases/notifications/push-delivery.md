# Notifications — Push Delivery (Firebase Admin FCM)

**Source:**

- `apps/notifications-service/src/providers/firebase/sendPush.ts`
- `apps/notifications-service/src/services/device-token.service.ts` (`getTokensForUser`, `pruneToken`)
- `apps/notifications-service/src/repositories/device-token.repository.ts` (`findTokensByUserId`, `deleteByToken`)

Behavior notes:

- `sendPush({ token, title, body, data? })` calls `messaging.send(...)` and returns
  `{ messageId, invalidToken }`.
- On error, `messageId:null`. `invalidToken:true` only when FCM `code` ∈
  `{ messaging/registration-token-not-registered, messaging/invalid-registration-token, messaging/invalid-argument }`.
  Otherwise `invalidToken:false` (transient — keep token).
- `sendPush` **never throws** (catches internally); callers inspect the result.
- Dead-token cleanup is the **caller's** responsibility via `deviceTokenService.pruneToken(token)`
  (→ `deleteByToken`, unscoped). No automatic prune inside `sendPush`.

> NOTE: There is no production consumer wired yet (test-push routes are DEV-ONLY). These cases
> describe the `sendPush` provider contract and the intended prune flow.

---

### TC-NOTIF-090 — Successful push to a valid token

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Notifications / Push Delivery                  |
| **API/Event Name**        | `sendPush()` (provider)                        |
| **Test Scenario**         | Send to a live FCM token                       |
| **Category**              | Happy Path                                     |
| **Priority**              | High                                           |
| **Preconditions**         | Valid FCM token; Firebase Admin initialized    |
| **Request Payload**       | `{ token:"valid", title:"Hi", body:"Msg" }`    |
| **Expected Response**     | `{ messageId:"<fcm-id>", invalidToken:false }` |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | Logs `Push sent: <id>`                         |

---

### TC-NOTIF-091 — Push with data payload

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Push Delivery                                        |
| **API/Event Name**        | `sendPush()`                                                         |
| **Test Scenario**         | Include string→string `data` map                                     |
| **Category**              | Optional Params                                                      |
| **Priority**              | Medium                                                               |
| **Preconditions**         | Valid token                                                          |
| **Request Payload**       | `{ token, title, body, data:{ type:"message", roomId:"r1" } }`       |
| **Expected Response**     | `{ messageId, invalidToken:false }`; `data` forwarded in FCM message |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | `data` spread only when present                                      |

---

### TC-NOTIF-092 — Invalid token → invalidToken flag set (cleanup signal)

| Field                     | Value                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Push Delivery                                                                                  |
| **API/Event Name**        | `sendPush()`                                                                                                   |
| **Test Scenario**         | FCM returns `registration-token-not-registered`                                                                |
| **Category**              | Error Handling                                                                                                 |
| **Priority**              | High                                                                                                           |
| **Preconditions**         | Dead/unregistered token                                                                                        |
| **Request Payload**       | `{ token:"dead", title, body }`                                                                                |
| **Expected Response**     | `{ messageId:null, invalidToken:true }` (no throw)                                                             |
| **Expected DB Changes**   | None by `sendPush`; caller should then `pruneToken("dead")` → row deleted                                      |
| **Expected Socket/Event** | None                                                                                                           |
| **Notes**                 | Codes that flag invalid: `registration-token-not-registered`, `invalid-registration-token`, `invalid-argument` |

---

### TC-NOTIF-093 — Transient FCM error → token NOT flagged invalid

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Notifications / Push Delivery                          |
| **API/Event Name**        | `sendPush()`                                           |
| **Test Scenario**         | FCM returns `messaging/internal-error` / `unavailable` |
| **Category**              | Error Handling                                         |
| **Priority**              | High                                                   |
| **Preconditions**         | Valid token, transient FCM outage                      |
| **Request Payload**       | `{ token:"ok", title, body }`                          |
| **Expected Response**     | `{ messageId:null, invalidToken:false }`               |
| **Expected DB Changes**   | None — token retained (do NOT prune)                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | Prevents wrongly pruning a good token on a blip        |

---

### TC-NOTIF-094 — Fan-out across a user's multiple devices

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Push Delivery                                 |
| **API/Event Name**        | `getTokensForUser()` + per-token `sendPush()`                 |
| **Test Scenario**         | User has 3 registered tokens; push fans to all                |
| **Category**              | Business Rule                                                 |
| **Priority**              | High                                                          |
| **Preconditions**         | 3 `DeviceToken` rows for user                                 |
| **Request Payload**       | producer loops `findTokensByUserId(userId)` → `sendPush` each |
| **Expected Response**     | 3 send results                                                |
| **Expected DB Changes**   | Dead tokens among them pruned individually                    |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | Mirrors `test-push` dev route's `Promise.all` fan-out         |

---

### TC-NOTIF-095 — Dead token pruned via pruneToken (cleanup)

| Field                     | Value                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Push Delivery                                                            |
| **API/Event Name**        | `deviceTokenService.pruneToken()`                                                        |
| **Test Scenario**         | After `invalidToken:true`, caller prunes the token                                       |
| **Category**              | DB State                                                                                 |
| **Priority**              | High                                                                                     |
| **Preconditions**         | Dead token row exists                                                                    |
| **Request Payload**       | `pruneToken("dead")`                                                                     |
| **Expected Response**     | resolves void                                                                            |
| **Expected DB Changes**   | Row(s) with that token deleted (`deleteByToken`, unscoped — removes regardless of owner) |
| **Expected Socket/Event** | None                                                                                     |
| **Notes**                 | Unscoped delete is correct here: a dead token belongs to whoever last owned it           |

---

### TC-NOTIF-096 — Firebase not initialized / credentials missing

| Field                     | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Push Delivery                                                |
| **API/Event Name**        | `sendPush()`                                                                 |
| **Test Scenario**         | Firebase Admin lacks credentials                                             |
| **Category**              | Error Handling                                                               |
| **Priority**              | Medium                                                                       |
| **Preconditions**         | Missing/invalid service account                                              |
| **Request Payload**       | `{ token, title, body }`                                                     |
| **Expected Response**     | `{ messageId:null, invalidToken:<by code> }`; error logged                   |
| **Expected DB Changes**   | None                                                                         |
| **Expected Socket/Event** | None                                                                         |
| **Notes**                 | Verify `messaging` init guard in `firebase.ts`; should not crash the process |

---

### TC-NOTIF-097 — Push to a user with zero registered devices

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Notifications / Push Delivery                   |
| **API/Event Name**        | `getTokensForUser()`                            |
| **Test Scenario**         | User has no `DeviceToken` rows                  |
| **Category**              | Edge Case                                       |
| **Priority**              | Medium                                          |
| **Preconditions**         | No tokens for user                              |
| **Request Payload**       | `findTokensByUserId(userId)`                    |
| **Expected Response**     | `[]` → no `sendPush` calls                      |
| **Expected DB Changes**   | None                                            |
| **Expected Socket/Event** | None                                            |
| **Notes**                 | Producer must short-circuit on empty token list |
