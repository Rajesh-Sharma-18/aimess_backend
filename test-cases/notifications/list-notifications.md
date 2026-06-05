# Notifications — List In-App Notifications

**Source:**

- `apps/chat-service/src/api/routes/notification.routes.ts` (`GET /api/chat/notifications`)
- `apps/chat-service/src/api/controllers/notification.controller.ts` (`getNotifications`)
- `apps/chat-service/src/services/notification.service.ts`
- `apps/chat-service/src/repositories/notification.repository.ts` (`findByUserId`, `countByUserId`)
- `apps/chat-service/src/lib/pagination.ts` (`buildPaginatedResponse`)
- `apps/chat-service/src/generated/prisma/schema.prisma` (`Notification`)

Endpoint: `GET /api/chat/notifications?cursor=&limit=&page=` — auth required.

Behavior notes:

- Scoped to `req.auth.userId`. Filters `isDeleted:false`. Ordered `createdAt desc`.
- Cursor is an ISO timestamp; `createdAt < cursor` (keyset). `limit` default 20 (parsed via
  `Number(req.query.limit) || 20`; **no max enforced at controller** — the route does not apply
  `getNotificationsSchema`, which would have capped at 100). `page` used only for the paginated wrapper.
- Response: `200` `ApiResponse(buildPaginatedResponse(data, totalCount, page, limit, "createdAt"), msg)`.
  `msg` = `CHAT_NOTIFICATIONS_FETCHED` if any, else `CHAT_NO_NOTIFICATIONS_FOUND`.

---

### TC-NOTIF-030 — List notifications (happy path)

| Field                     | Value                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / List                                                                                             |
| **API/Event Name**        | `GET /api/chat/notifications`                                                                                    |
| **Test Scenario**         | User with several notifications fetches the feed                                                                 |
| **Category**              | Happy Path                                                                                                       |
| **Priority**              | High                                                                                                             |
| **Preconditions**         | ≥3 non-deleted notifications for caller                                                                          |
| **Request Payload**       | `GET /api/chat/notifications`                                                                                    |
| **Expected Response**     | `200` `ApiResponse({ data:[...], pagination:{...} }, "CHAT_NOTIFICATIONS_FETCHED")`                              |
| **Expected DB Changes**   | None (read-only)                                                                                                 |
| **Expected Socket/Event** | None                                                                                                             |
| **Notes**                 | Items ordered newest-first; each item carries `type, actorId, entity, actorSnapshot, payload, isRead, createdAt` |

---

### TC-NOTIF-031 — Empty feed returns NO_NOTIFICATIONS message

| Field                     | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / List                                                         |
| **API/Event Name**        | `GET /api/chat/notifications`                                                |
| **Test Scenario**         | User with no notifications                                                   |
| **Category**              | Edge Case                                                                    |
| **Priority**              | Medium                                                                       |
| **Preconditions**         | Zero notifications for caller                                                |
| **Request Payload**       | `GET /api/chat/notifications`                                                |
| **Expected Response**     | `200` `data:[]`, `pagination.total:0`, message `CHAT_NO_NOTIFICATIONS_FOUND` |
| **Expected DB Changes**   | None                                                                         |
| **Expected Socket/Event** | None                                                                         |
| **Notes**                 | —                                                                            |

---

### TC-NOTIF-032 — Limit respected (page size)

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Notifications / List                                  |
| **API/Event Name**        | `GET /api/chat/notifications`                         |
| **Test Scenario**         | `limit=5` with 12 notifications                       |
| **Category**              | Pagination/Filter/Sort                                |
| **Priority**              | High                                                  |
| **Preconditions**         | 12 notifications for caller                           |
| **Request Payload**       | `GET /api/chat/notifications?limit=5`                 |
| **Expected Response**     | `200` `data.length == 5`; `pagination.total == 12`    |
| **Expected DB Changes**   | None                                                  |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | `take: 5` in repo; `countByUserId` returns full total |

---

### TC-NOTIF-033 — Cursor pagination (next page)

| Field                     | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / List                                                      |
| **API/Event Name**        | `GET /api/chat/notifications`                                             |
| **Test Scenario**         | Fetch page 2 via `cursor` = last item's `createdAt`                       |
| **Category**              | Pagination/Filter/Sort                                                    |
| **Priority**              | High                                                                      |
| **Preconditions**         | >limit notifications                                                      |
| **Request Payload**       | `GET /api/chat/notifications?limit=5&cursor=2026-06-01T10:00:00.000Z`     |
| **Expected Response**     | `200` items strictly older than cursor (`createdAt < cursor`), no overlap |
| **Expected DB Changes**   | None                                                                      |
| **Expected Socket/Event** | None                                                                      |
| **Notes**                 | Keyset; stable under inserts at the head                                  |

---

### TC-NOTIF-034 — Invalid cursor (non-date string)

| Field                     | Value                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / List                                                                                |
| **API/Event Name**        | `GET /api/chat/notifications`                                                                       |
| **Test Scenario**         | `cursor=not-a-date`                                                                                 |
| **Category**              | Input Validation                                                                                    |
| **Priority**              | Medium                                                                                              |
| **Preconditions**         | Valid token                                                                                         |
| **Request Payload**       | `GET /api/chat/notifications?cursor=not-a-date`                                                     |
| **Expected Response**     | Likely `500` — `new Date("not-a-date")` → Invalid Date → Prisma error (no validator on route)       |
| **Expected DB Changes**   | None                                                                                                |
| **Expected Socket/Event** | None                                                                                                |
| **Notes**                 | GAP: `getNotificationsSchema` exists but is not wired; cursor not validated. Verify actual behavior |

---

### TC-NOTIF-035 — Soft-deleted notifications excluded

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / List                                                                               |
| **API/Event Name**        | `GET /api/chat/notifications`                                                                      |
| **Test Scenario**         | Some notifications have `isDeleted:true`                                                           |
| **Category**              | Business Rule                                                                                      |
| **Priority**              | Medium                                                                                             |
| **Preconditions**         | Mix of deleted/non-deleted notifications                                                           |
| **Request Payload**       | `GET /api/chat/notifications`                                                                      |
| **Expected Response**     | `200` only non-deleted items; `total` excludes deleted (`countByUserId` filters `isDeleted:false`) |
| **Expected DB Changes**   | None                                                                                               |
| **Expected Socket/Event** | None                                                                                               |
| **Notes**                 | —                                                                                                  |

---

### TC-NOTIF-036 — Only own notifications returned (AuthZ scoping)

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Notifications / List                                    |
| **API/Event Name**        | `GET /api/chat/notifications`                           |
| **Test Scenario**         | Two users each with notifications                       |
| **Category**              | AuthZ                                                   |
| **Priority**              | High                                                    |
| **Preconditions**         | User A and User B both have notifications               |
| **Request Payload**       | (as User A) `GET /api/chat/notifications`               |
| **Expected Response**     | `200` only A's notifications; none of B's appear        |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | `findByUserId(userId)` where `userId = req.auth.userId` |

---

### TC-NOTIF-037 — List without auth

| Field                     | Value                         |
| ------------------------- | ----------------------------- |
| **Feature/Module**        | Notifications / List          |
| **API/Event Name**        | `GET /api/chat/notifications` |
| **Test Scenario**         | No auth header                |
| **Category**              | AuthN                         |
| **Priority**              | High                          |
| **Preconditions**         | None                          |
| **Request Payload**       | `GET /api/chat/notifications` |
| **Expected Response**     | `401` Unauthorized            |
| **Expected DB Changes**   | None                          |
| **Expected Socket/Event** | None                          |
| **Notes**                 | `authenticate` middleware     |

---

### TC-NOTIF-038 — Excessive limit not capped at controller

| Field                     | Value                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / List                                                                                                                                      |
| **API/Event Name**        | `GET /api/chat/notifications`                                                                                                                             |
| **Test Scenario**         | `limit=100000`                                                                                                                                            |
| **Category**              | Edge Case                                                                                                                                                 |
| **Priority**              | Low                                                                                                                                                       |
| **Preconditions**         | Valid token                                                                                                                                               |
| **Request Payload**       | `GET /api/chat/notifications?limit=100000`                                                                                                                |
| **Expected Response**     | `200` returns up to all rows (no cap applied in controller)                                                                                               |
| **Expected DB Changes**   | None                                                                                                                                                      |
| **Expected Socket/Event** | None                                                                                                                                                      |
| **Notes**                 | GAP: validator caps at 100 but is unused; potential resource exhaustion. The `/notify` socket `notifications:fetch` path DOES cap at 100 (Zod `max(100)`) |

---

### TC-NOTIF-039 — limit=0 falls back to default

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ | --- | ---- |
| **Feature/Module**        | Notifications / List                                         |
| **API/Event Name**        | `GET /api/chat/notifications`                                |
| **Test Scenario**         | `limit=0`                                                    |
| **Category**              | Edge Case                                                    |
| **Priority**              | Low                                                          |
| **Preconditions**         | Valid token                                                  |
| **Request Payload**       | `GET /api/chat/notifications?limit=0`                        |
| **Expected Response**     | `200` defaults to 20 (`Number(0)                             |     | 20`) |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | Falsy `0` → fallback. Same for non-numeric `limit=abc` (`NaN |     | 20`) |

---

### TC-NOTIF-040 — Fetch via `/notify` socket `notifications:fetch`

| Field                     | Value                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / List (socket)                                                                                           |
| **API/Event Name**        | socket `notifications:fetch` (`/notify`)                                                                                |
| **Test Scenario**         | Connected client requests feed over WebSocket with ack                                                                  |
| **Category**              | Happy Path                                                                                                              |
| **Priority**              | High                                                                                                                    |
| **Preconditions**         | Authenticated `/notify` socket connection                                                                               |
| **Request Payload**       | `notifications:fetch` `{ "cursor": "", "limit": 20 }`                                                                   |
| **Expected Response**     | ack `{ success: true, data: { ...notifications, unreadCount } }` (via `NotificationClient.getNotifications` gRPC)       |
| **Expected DB Changes**   | None                                                                                                                    |
| **Expected Socket/Event** | ack only                                                                                                                |
| **Notes**                 | `limit` capped at 100 by `NotificationsFetchSchema`; invalid payload → ack `{ success:false, error:"INVALID_PAYLOAD" }` |
