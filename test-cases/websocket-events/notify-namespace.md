# WebSocket — /notify Namespace

In-app notification feed + unread badge. Delegates to notifications-service over
gRPC. On connect the gateway emits `notification:count` once and ref-count
subscribes the user's `notify:<userId>` Redis channel; events published there are
re-emitted to `user:<userId>` verbatim. On disconnect the ref-count is decremented
and the channel unsubscribed when it reaches zero.

**Source:** `apps/api-gateway/src/sockets/namespaces/notify.ns.ts`,
`docs/SOCKET_EVENTS.md` §6.

---

### TC-WS-150 — notification:count emitted once on connect

| Field                     | Value                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Notifications                                                                              |
| **API/Event Name**        | `server→client: notification:count`                                                                    |
| **Test Scenario**         | Happy path — badge count delivered immediately on `/notify` connect                                    |
| **Category**              | Happy Path                                                                                             |
| **Priority**              | High                                                                                                   |
| **Preconditions**         | Valid `/notify` connect; notifications-service reachable                                               |
| **Request Payload**       | n/a                                                                                                    |
| **Expected Response**     | Socket receives `notification:count { count }`                                                         |
| **Expected DB Changes**   | None (read-only `getNotifications({ limit:1, cursor:"" })`)                                            |
| **Expected Socket/Event** | Single `notification:count` emit to the connecting socket only                                         |
| **Notes**                 | `count = res.unreadCount`. If the gRPC fetch fails, connect still succeeds, no count emitted (logged). |

### TC-WS-151 — notifications:fetch cursor pagination

| Field                     | Value                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Notifications                                                                             |
| **API/Event Name**        | `client→server: notifications:fetch`                                                                  |
| **Test Scenario**         | Pagination — paged notification feed                                                                  |
| **Category**              | Pagination/Filter/Sort                                                                                |
| **Priority**              | Medium                                                                                                |
| **Preconditions**         | Connected `/notify`                                                                                   |
| **Request Payload**       | `{ cursor?, limit:20 }` (or `{}` / no payload)                                                        |
| **Expected Response**     | Ack `{ success:true, data:{ notifications, nextCursor, unreadCount } }`                               |
| **Expected DB Changes**   | None (read)                                                                                           |
| **Expected Socket/Event** | None                                                                                                  |
| **Notes**                 | `payload ?? {}` — omitting the payload entirely is valid. `limit` capped at 100. `userId` from token. |

### TC-WS-152 — notifications:fetch limit over 100 → INVALID_PAYLOAD

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | WebSocket / Notifications                        |
| **API/Event Name**        | `client→server: notifications:fetch`             |
| **Test Scenario**         | Input validation — `limit:200`                   |
| **Category**              | Input Validation                                 |
| **Priority**              | Low                                              |
| **Preconditions**         | Connected                                        |
| **Request Payload**       | `{ limit:200 }`                                  |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }` |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | `limit` is `int().positive().max(100)`.          |

### TC-WS-153 — notifications:mark_read marks notifications read

| Field                     | Value                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Notifications                                                                                            |
| **API/Event Name**        | `client→server: notifications:mark_read`                                                                             |
| **Test Scenario**         | Happy path — mark a set of notifications read                                                                        |
| **Category**              | Happy Path                                                                                                           |
| **Priority**              | Medium                                                                                                               |
| **Preconditions**         | Notifications exist for the user                                                                                     |
| **Request Payload**       | `{ notificationIds:["n1","n2"] }`                                                                                    |
| **Expected Response**     | Ack `{ success:true, data:{ … } }`                                                                                   |
| **Expected DB Changes**   | Those notifications flagged read; unread count decreases                                                             |
| **Expected Socket/Event** | None directly (a subsequent `notification:count` is not auto-pushed by this handler)                                 |
| **Notes**                 | `userId` from token — a user can only mark their own notifications; foreign IDs are no-ops in notifications-service. |

### TC-WS-154 — notifications:mark_read empty array allowed

| Field                     | Value                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Notifications                                                                     |
| **API/Event Name**        | `client→server: notifications:mark_read`                                                      |
| **Test Scenario**         | Edge — empty `notificationIds`                                                                |
| **Category**              | Edge Case                                                                                     |
| **Priority**              | Low                                                                                           |
| **Preconditions**         | Connected                                                                                     |
| **Request Payload**       | `{ notificationIds:[] }`                                                                      |
| **Expected Response**     | Ack `{ success:true, … }` (no-op)                                                             |
| **Expected DB Changes**   | None                                                                                          |
| **Expected Socket/Event** | None                                                                                          |
| **Notes**                 | `MarkReadSchema` allows `.min(0)`. Missing field entirely → INVALID_PAYLOAD (field required). |

### TC-WS-155 — Forwarded notify event delivered to user room

| Field                     | Value                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Notifications                                                                                                                                         |
| **API/Event Name**        | `server→client: <forwarded event>`                                                                                                                                |
| **Test Scenario**         | DB state — notifications-service publishes a new-notification event to `notify:<userId>`                                                                          |
| **Category**              | DB State                                                                                                                                                          |
| **Priority**              | High                                                                                                                                                              |
| **Preconditions**         | User connected on `/notify` (so the channel is subscribed)                                                                                                        |
| **Request Payload**       | n/a                                                                                                                                                               |
| **Expected Response**     | n/a                                                                                                                                                               |
| **Expected DB Changes**   | Notification row created in notifications-service                                                                                                                 |
| **Expected Socket/Event** | Gateway re-emits `parsed.event` with `parsed.data` to `user:<userId>` (channel `notify:<userId>` mapped via `.replace("notify:","user:")`)                        |
| **Notes**                 | Event name forwarded verbatim. A client that is **not** connected won't have the channel subscribed → relies on FCM push + `notifications:fetch` on next connect. |

### TC-WS-156 — Ref-counted channel subscription across multiple sockets

| Field                     | Value                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Notifications                                                                                                                                                                  |
| **API/Event Name**        | connect/disconnect (subscription lifecycle)                                                                                                                                                |
| **Test Scenario**         | Concurrency — same user opens two `/notify` sockets, then closes one                                                                                                                       |
| **Category**              | Concurrency                                                                                                                                                                                |
| **Priority**              | Medium                                                                                                                                                                                     |
| **Preconditions**         | Two `/notify` sockets for same `userId`                                                                                                                                                    |
| **Request Payload**       | n/a                                                                                                                                                                                        |
| **Expected Response**     | n/a                                                                                                                                                                                        |
| **Expected DB Changes**   | None                                                                                                                                                                                       |
| **Expected Socket/Event** | First connect → `redisSub.subscribe("notify:<userId>")` (count 1→); second connect increments count, no re-subscribe; closing one decrements; channel `unsubscribe` only when count hits 0 |
| **Notes**                 | `userSubCount` Map is per-gateway-instance. On a multi-instance deployment each instance tracks its own sockets — see scaling-redis-adapter.md for cross-instance behavior.                |

### TC-WS-157 — Last socket disconnect unsubscribes channel

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Notifications                                                        |
| **API/Event Name**        | `disconnect`                                                                     |
| **Test Scenario**         | DB state — closing the only `/notify` socket unsubscribes `notify:<userId>`      |
| **Category**              | Edge Case                                                                        |
| **Priority**              | Low                                                                              |
| **Preconditions**         | Single `/notify` socket connected                                                |
| **Request Payload**       | n/a                                                                              |
| **Expected Response**     | n/a                                                                              |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | `userSubCount` entry deleted; `redisSub.unsubscribe("notify:<userId>")` called   |
| **Notes**                 | Prevents leaking Redis channel subscriptions for offline users on that instance. |

### TC-WS-158 — Malformed JSON on notify channel dropped

| Field                     | Value                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Notifications                                                                                  |
| **API/Event Name**        | Redis `message` handler                                                                                    |
| **Test Scenario**         | Error handling — non-JSON published to `notify:<userId>`                                                   |
| **Category**              | Error Handling                                                                                             |
| **Priority**              | Low                                                                                                        |
| **Preconditions**         | Garbage on channel                                                                                         |
| **Request Payload**       | n/a                                                                                                        |
| **Expected Response**     | n/a                                                                                                        |
| **Expected DB Changes**   | None                                                                                                       |
| **Expected Socket/Event** | Nothing emitted; parse-error warning logged                                                                |
| **Notes**                 | Uses `subscribe`/`message` (exact channel), not `psubscribe`, and ignores channels not starting `notify:`. |

### TC-WS-159 — AuthZ: cannot receive another user's notifications

| Field                     | Value                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Notifications                                                                                                           |
| **API/Event Name**        | `server→client` forwarding                                                                                                          |
| **Test Scenario**         | Security — user A cannot get B's forwarded notify events                                                                            |
| **Category**              | Security                                                                                                                            |
| **Priority**              | High                                                                                                                                |
| **Preconditions**         | A connected on `/notify`                                                                                                            |
| **Request Payload**       | n/a                                                                                                                                 |
| **Expected Response**     | n/a                                                                                                                                 |
| **Expected DB Changes**   | None                                                                                                                                |
| **Expected Socket/Event** | A is in `user:<A>` only (auto-joined from token); `notify:<B>` maps to `user:<B>` room which A is not in → A receives nothing for B |
| **Notes**                 | Unlike `/chat` (`presence:subscribe`), `/notify` has no event to join other users' rooms — isolation is structural.                 |
