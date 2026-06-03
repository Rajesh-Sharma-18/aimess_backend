# Notifications — Unread Counts & Badge Sync

**Source:**

- `apps/chat-service/src/api/routes/notification.routes.ts` (`GET /api/chat/notifications/unread-count`)
- `apps/chat-service/src/api/controllers/notification.controller.ts` (`getUnreadCount`)
- `apps/chat-service/src/repositories/notification.repository.ts` (`getUnreadCount`)
- `apps/api-gateway/src/sockets/namespaces/notify.ns.ts` (`notification:count` on connect)
- `docs/SOCKET_EVENTS.md` §6 `/notify`

Behavior notes:

- `GET /unread-count` → `ApiResponse({ count }, "CHAT_UNREAD_COUNT_FETCHED")`.
  `getUnreadCount` = `count where { userId, isRead:false, isDeleted:false }`.
- On `/notify` socket connect, the gateway calls `NotificationClient.getNotifications({ userId, limit:1, cursor:"" })`
  and emits `notification:count` `{ count: res.unreadCount }` once.

---

### TC-NOTIF-070 — Get unread count (happy path)

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Unread Count                                   |
| **API/Event Name**        | `GET /api/chat/notifications/unread-count`                     |
| **Test Scenario**         | Caller with 3 unread notifications                             |
| **Category**              | Happy Path                                                     |
| **Priority**              | High                                                           |
| **Preconditions**         | 3 unread, ≥1 read, ≥1 deleted-unread for caller                |
| **Request Payload**       | `GET /api/chat/notifications/unread-count`                     |
| **Expected Response**     | `200` `ApiResponse({ count: 3 }, "CHAT_UNREAD_COUNT_FETCHED")` |
| **Expected DB Changes**   | None                                                           |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | Deleted notifications excluded even if unread                  |

---

### TC-NOTIF-071 — Unread count is zero

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| **Feature/Module**        | Notifications / Unread Count               |
| **API/Event Name**        | `GET /api/chat/notifications/unread-count` |
| **Test Scenario**         | No unread notifications                    |
| **Category**              | Edge Case                                  |
| **Priority**              | Medium                                     |
| **Preconditions**         | All read or none exist                     |
| **Request Payload**       | `GET /api/chat/notifications/unread-count` |
| **Expected Response**     | `200` `{ count: 0 }`                       |
| **Expected DB Changes**   | None                                       |
| **Expected Socket/Event** | None                                       |
| **Notes**                 | —                                          |

---

### TC-NOTIF-072 — Unread count scoped to caller (AuthZ)

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| **Feature/Module**        | Notifications / Unread Count               |
| **API/Event Name**        | `GET /api/chat/notifications/unread-count` |
| **Test Scenario**         | A's count excludes B's notifications       |
| **Category**              | AuthZ                                      |
| **Priority**              | High                                       |
| **Preconditions**         | A has 2 unread, B has 5 unread             |
| **Request Payload**       | (as A) `GET .../unread-count`              |
| **Expected Response**     | `200` `{ count: 2 }`                       |
| **Expected DB Changes**   | None                                       |
| **Expected Socket/Event** | None                                       |
| **Notes**                 | `where userId = req.auth.userId`           |

---

### TC-NOTIF-073 — Unread count without auth

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| **Feature/Module**        | Notifications / Unread Count               |
| **API/Event Name**        | `GET /api/chat/notifications/unread-count` |
| **Test Scenario**         | No auth header                             |
| **Category**              | AuthN                                      |
| **Priority**              | High                                       |
| **Preconditions**         | None                                       |
| **Request Payload**       | `GET .../unread-count`                     |
| **Expected Response**     | `401` Unauthorized                         |
| **Expected DB Changes**   | None                                       |
| **Expected Socket/Event** | None                                       |
| **Notes**                 | —                                          |

---

### TC-NOTIF-074 — Count drops after mark-read

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Unread Count                                   |
| **API/Event Name**        | `GET /api/chat/notifications/unread-count`                     |
| **Test Scenario**         | Mark one read, then re-query count                             |
| **Category**              | Business Rule                                                  |
| **Priority**              | High                                                           |
| **Preconditions**         | Count = 3                                                      |
| **Request Payload**       | `POST /read {notificationId}` then `GET .../unread-count`      |
| **Expected Response**     | `200` `{ count: 2 }`                                           |
| **Expected DB Changes**   | One row `isRead:true`                                          |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | Counter is derived (live count), not a stored field — no drift |

---

### TC-NOTIF-075 — Count is 0 after mark-all-read

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Notifications / Unread Count                 |
| **API/Event Name**        | `GET /api/chat/notifications/unread-count`   |
| **Test Scenario**         | mark-all-read then re-query                  |
| **Category**              | Business Rule                                |
| **Priority**              | Medium                                       |
| **Preconditions**         | Several unread                               |
| **Request Payload**       | `POST /read-all` then `GET .../unread-count` |
| **Expected Response**     | `200` `{ count: 0 }`                         |
| **Expected DB Changes**   | All read                                     |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | —                                            |

---

### TC-NOTIF-076 — `notification:count` emitted on `/notify` connect (badge sync)

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Badge Sync (socket)                                              |
| **API/Event Name**        | socket `notification:count` (`/notify`)                                          |
| **Test Scenario**         | Client connects to `/notify`; receives initial unread badge                      |
| **Category**              | Happy Path                                                                       |
| **Priority**              | High                                                                             |
| **Preconditions**         | Authenticated socket; caller has N unread                                        |
| **Request Payload**       | (connect with valid JWT)                                                         |
| **Expected Response**     | server emits `notification:count` `{ count: N }` once after join `user:<userId>` |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | `notification:count` { count }                                                   |
| **Notes**                 | `count` sourced from gRPC `getNotifications().unreadCount`                       |

---

### TC-NOTIF-077 — `notification:count` failure on connect is non-fatal

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Badge Sync (socket)                                   |
| **API/Event Name**        | socket connect `/notify`                                              |
| **Test Scenario**         | gRPC `getNotifications` fails (notifications-service down)            |
| **Category**              | Error Handling                                                        |
| **Priority**              | Medium                                                                |
| **Preconditions**         | notifications gRPC unavailable / circuit open                         |
| **Request Payload**       | (connect with valid JWT)                                              |
| **Expected Response**     | Connection stays up; **no** `notification:count` emitted; warn logged |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | None (catch swallows error)                                           |
| **Notes**                 | Client should tolerate a missing initial count                        |

---

### TC-NOTIF-078 — New notification raises badge via forwarded `notify:<userId>` event

| Field                     | Value                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Badge Sync (socket)                                                                                                                |
| **API/Event Name**        | forwarded event on `notify:<userId>` Redis channel → `/notify`                                                                                     |
| **Test Scenario**         | Producer publishes a `notification:new`-style event to `notify:<userId>`                                                                           |
| **Category**              | Business Rule                                                                                                                                      |
| **Priority**              | High                                                                                                                                               |
| **Preconditions**         | User has a live `/notify` socket subscribed to `notify:<userId>`                                                                                   |
| **Request Payload**       | Redis publish `notify:<userId>` `{ event:"notification:new", data:{...} }`                                                                         |
| **Expected Response**     | Gateway re-emits the verbatim event to room `user:<userId>`                                                                                        |
| **Expected DB Changes**   | (Producer-side) one `Notification` row created                                                                                                     |
| **Expected Socket/Event** | `notification:new` (or whatever `event` was published) forwarded verbatim                                                                          |
| **Notes**                 | `/notify` forwards ANY event on the channel; payload is opaque/verbatim. Client increments badge locally; absolute count re-synced on next connect |

---

### TC-NOTIF-079 — Multi-socket badge: ref-counted subscription

| Field                     | Value                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Badge Sync (socket)                                                                                   |
| **API/Event Name**        | `/notify` connect/disconnect                                                                                          |
| **Test Scenario**         | Same user opens 2 sockets; one disconnects                                                                            |
| **Category**              | Concurrency                                                                                                           |
| **Priority**              | Medium                                                                                                                |
| **Preconditions**         | User connects twice (2 devices/tabs)                                                                                  |
| **Request Payload**       | connect, connect, then disconnect one                                                                                 |
| **Expected Response**     | After first disconnect, `notify:<userId>` Redis sub remains (ref count 1); events still forwarded to remaining socket |
| **Expected DB Changes**   | None                                                                                                                  |
| **Expected Socket/Event** | Forwarded events still reach surviving socket                                                                         |
| **Notes**                 | `userSubCount` map; `unsubscribe` only when count hits 0                                                              |
