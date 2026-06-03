# Notifications — Mark Read / Mark-All-Read

**Source:**

- `apps/chat-service/src/api/routes/notification.routes.ts`
  (`POST /api/chat/notifications/read`, `POST /api/chat/notifications/read-all`)
- `apps/chat-service/src/api/controllers/notification.controller.ts` (`markRead`, `markAllRead`)
- `apps/chat-service/src/repositories/notification.repository.ts` (`markRead`, `markAllRead`)
- `apps/chat-service/src/api/validators/notification.validator.ts` (`markReadSchema` — **defined but NOT wired into the route**)
- `apps/api-gateway/src/sockets/namespaces/notify.ns.ts` (socket `notifications:mark_read`)

Behavior notes:

- `POST /read` reads `req.body.notificationId` directly (no validator middleware applied). Calls
  `markRead(notificationId)` → `prisma.notification.update({ where:{ id }, data:{ isRead:true, readAt:now } })`.
  **No `userId` scoping** → any caller can mark ANY notification id read (IDOR). See TC-NOTIF-053.
- `POST /read-all` is scoped to `req.auth.userId` (`updateMany where userId, isRead:false`).

---

### TC-NOTIF-050 — Mark a single notification read (happy path)

| Field                     | Value                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Mark Read                                                                           |
| **API/Event Name**        | `POST /api/chat/notifications/read`                                                                 |
| **Test Scenario**         | Caller marks own unread notification read                                                           |
| **Category**              | Happy Path                                                                                          |
| **Priority**              | High                                                                                                |
| **Preconditions**         | Unread notification `N1` owned by caller                                                            |
| **Request Payload**       | `{ "notificationId": "<N1 id>" }`                                                                   |
| **Expected Response**     | `200` `ApiResponse(<updated notification>)` with `isRead:true, readAt:<now>`                        |
| **Expected DB Changes**   | `N1.isRead=true`, `N1.readAt=now`                                                                   |
| **Expected Socket/Event** | None directly (clients reconcile badge via `notification:count` on next connect / forwarded events) |
| **Notes**                 | —                                                                                                   |

---

### TC-NOTIF-051 — Mark read with missing notificationId

| Field                     | Value                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Notifications / Mark Read                                                                              |
| **API/Event Name**        | `POST /api/chat/notifications/read`                                                                    |
| **Test Scenario**         | Body omits `notificationId`                                                                            |
| **Category**              | Input Validation                                                                                       |
| **Priority**              | High                                                                                                   |
| **Preconditions**         | Valid token                                                                                            |
| **Request Payload**       | `{}`                                                                                                   |
| **Expected Response**     | `500` (controller passes `undefined` to `prisma.update where:{id:undefined}` → Prisma throws)          |
| **Expected DB Changes**   | None                                                                                                   |
| **Expected Socket/Event** | None                                                                                                   |
| **Notes**                 | GAP: `markReadSchema` (min 5 / max 100) is NOT applied; should return `400`. Confirm actual error code |

---

### TC-NOTIF-052 — Mark read with non-existent id

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Mark Read                                      |
| **API/Event Name**        | `POST /api/chat/notifications/read`                            |
| **Test Scenario**         | Valid-format id that does not exist                            |
| **Category**              | Error Handling                                                 |
| **Priority**              | Medium                                                         |
| **Preconditions**         | Valid token                                                    |
| **Request Payload**       | `{ "notificationId": "64f0000000000000deadbeef" }`             |
| **Expected Response**     | `500`/`404` — `prisma.update` on missing record throws `P2025` |
| **Expected DB Changes**   | None                                                           |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | Verify how `asyncHandler` maps P2025                           |

---

### TC-NOTIF-053 — IDOR: mark another user's notification read

| Field                     | Value                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Mark Read                                                                                                                                                                                                                 |
| **API/Event Name**        | `POST /api/chat/notifications/read`                                                                                                                                                                                                       |
| **Test Scenario**         | User B marks User A's notification read by id                                                                                                                                                                                             |
| **Category**              | Security                                                                                                                                                                                                                                  |
| **Priority**              | High                                                                                                                                                                                                                                      |
| **Preconditions**         | Notification `N_A` owned by User A; User B knows/guesses its id                                                                                                                                                                           |
| **Request Payload**       | (as User B) `{ "notificationId": "<N_A id>" }`                                                                                                                                                                                            |
| **Expected Response**     | **Currently `200`** — succeeds (no ownership check)                                                                                                                                                                                       |
| **Expected DB Changes**   | `N_A.isRead=true` (cross-user mutation — VULNERABILITY)                                                                                                                                                                                   |
| **Expected Socket/Event** | None                                                                                                                                                                                                                                      |
| **Notes**                 | GAP/BUG: `markRead` should scope by `userId`. The socket path `notifications:mark_read` passes `userId` to gRPC `markNotificationsRead({ userId, notificationIds })` — verify the gRPC handler enforces ownership; the HTTP path does not |

---

### TC-NOTIF-054 — Mark read without auth

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Notifications / Mark Read           |
| **API/Event Name**        | `POST /api/chat/notifications/read` |
| **Test Scenario**         | No auth header                      |
| **Category**              | AuthN                               |
| **Priority**              | High                                |
| **Preconditions**         | None                                |
| **Request Payload**       | `{ "notificationId": "x" }`         |
| **Expected Response**     | `401` Unauthorized                  |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | —                                   |

---

### TC-NOTIF-055 — Mark already-read notification (idempotent)

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Notifications / Mark Read                          |
| **API/Event Name**        | `POST /api/chat/notifications/read`                |
| **Test Scenario**         | Mark an already-read notification read again       |
| **Category**              | Business Rule                                      |
| **Priority**              | Low                                                |
| **Preconditions**         | `N1.isRead=true`                                   |
| **Request Payload**       | `{ "notificationId": "<N1 id>" }`                  |
| **Expected Response**     | `200` `isRead:true`, `readAt` refreshed to new now |
| **Expected DB Changes**   | `readAt` overwritten (unconditional `update`)      |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | Minor: readAt timestamp changes on repeat          |

---

### TC-NOTIF-056 — Mark-all-read (happy path)

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Mark All Read                                                 |
| **API/Event Name**        | `POST /api/chat/notifications/read-all`                                       |
| **Test Scenario**         | Caller clears all unread                                                      |
| **Category**              | Happy Path                                                                    |
| **Priority**              | High                                                                          |
| **Preconditions**         | Several unread notifications for caller                                       |
| **Request Payload**       | (empty body)                                                                  |
| **Expected Response**     | `200` `ApiResponse(null, "CHAT_NOTIFICATIONS_ALL_READ")`                      |
| **Expected DB Changes**   | `updateMany where {userId, isRead:false}` → all set `isRead:true, readAt:now` |
| **Expected Socket/Event** | None                                                                          |
| **Notes**                 | —                                                                             |

---

### TC-NOTIF-057 — Mark-all-read scoped to caller only

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Notifications / Mark All Read                 |
| **API/Event Name**        | `POST /api/chat/notifications/read-all`       |
| **Test Scenario**         | A marks-all-read; B's notifications untouched |
| **Category**              | AuthZ                                         |
| **Priority**              | High                                          |
| **Preconditions**         | A and B both have unread notifications        |
| **Request Payload**       | (as A, empty body)                            |
| **Expected Response**     | `200`                                         |
| **Expected DB Changes**   | Only A's rows updated; B's `isRead` unchanged |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | `where: { userId: A }` enforces isolation     |

---

### TC-NOTIF-058 — Mark-all-read with no unread (no-op)

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Notifications / Mark All Read           |
| **API/Event Name**        | `POST /api/chat/notifications/read-all` |
| **Test Scenario**         | Caller already has zero unread          |
| **Category**              | Edge Case                               |
| **Priority**              | Low                                     |
| **Preconditions**         | All caller notifications already read   |
| **Request Payload**       | (empty body)                            |
| **Expected Response**     | `200` `CHAT_NOTIFICATIONS_ALL_READ`     |
| **Expected DB Changes**   | None (0 rows matched)                   |
| **Expected Socket/Event** | None                                    |
| **Notes**                 | —                                       |

---

### TC-NOTIF-059 — Mark-all-read without auth

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Notifications / Mark All Read           |
| **API/Event Name**        | `POST /api/chat/notifications/read-all` |
| **Test Scenario**         | No auth header                          |
| **Category**              | AuthN                                   |
| **Priority**              | High                                    |
| **Preconditions**         | None                                    |
| **Request Payload**       | (empty)                                 |
| **Expected Response**     | `401` Unauthorized                      |
| **Expected DB Changes**   | None                                    |
| **Expected Socket/Event** | None                                    |
| **Notes**                 | —                                       |

---

### TC-NOTIF-060 — Concurrency: mark-all-read races a new incoming notification

| Field                     | Value                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Mark All Read                                                                                        |
| **API/Event Name**        | `POST /api/chat/notifications/read-all` + concurrent notification create                                             |
| **Test Scenario**         | A new notification is created while mark-all-read runs                                                               |
| **Category**              | Concurrency                                                                                                          |
| **Priority**              | Medium                                                                                                               |
| **Preconditions**         | Caller has unread notifications; a producer inserts one mid-request                                                  |
| **Request Payload**       | read-all + concurrent `notification.create`                                                                          |
| **Expected Response**     | `200`                                                                                                                |
| **Expected DB Changes**   | The new notification inserted AFTER `updateMany` snapshot remains `isRead:false` (not lost) — unread count = 1 after |
| **Expected Socket/Event** | Newly inserted notification still triggers its `notify:<userId>` forward (if producer emits)                         |
| **Notes**                 | Verify no read flag is wrongly applied to the late arrival, and the badge reflects the 1 remaining unread            |

---

### TC-NOTIF-061 — Socket `notifications:mark_read` with array of ids

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Notifications / Mark Read (socket)                                                               |
| **API/Event Name**        | socket `notifications:mark_read` (`/notify`)                                                     |
| **Test Scenario**         | Client marks multiple notifications read over WS                                                 |
| **Category**              | Happy Path                                                                                       |
| **Priority**              | High                                                                                             |
| **Preconditions**         | Authenticated `/notify` connection; notification ids owned by user                               |
| **Request Payload**       | `{ "notificationIds": ["id1","id2"] }`                                                           |
| **Expected Response**     | ack `{ success:true, data:{...} }` via gRPC `markNotificationsRead({ userId, notificationIds })` |
| **Expected DB Changes**   | Listed notifications set read (gRPC handler should scope by `userId`)                            |
| **Expected Socket/Event** | ack only                                                                                         |
| **Notes**                 | `MarkReadSchema` allows empty array (`min(0)`) → no-op; non-array → ack `INVALID_PAYLOAD`        |

---

### TC-NOTIF-062 — Socket `notifications:mark_read` with empty array (no-op)

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Notifications / Mark Read (socket)                   |
| **API/Event Name**        | socket `notifications:mark_read` (`/notify`)         |
| **Test Scenario**         | Empty id array                                       |
| **Category**              | Edge Case                                            |
| **Priority**              | Low                                                  |
| **Preconditions**         | Authenticated `/notify` connection                   |
| **Request Payload**       | `{ "notificationIds": [] }`                          |
| **Expected Response**     | ack `{ success:true, data:{...} }` (no rows changed) |
| **Expected DB Changes**   | None                                                 |
| **Expected Socket/Event** | ack only                                             |
| **Notes**                 | `min(0)` permits empty                               |
