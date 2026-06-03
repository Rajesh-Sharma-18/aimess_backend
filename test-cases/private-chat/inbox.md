# Private Chat — Unified Inbox

> **Source:** `routes/inbox.routes.ts` (`GET /` mounted at `/api/v1/chat/inbox`),
> `controllers/inbox.controller.ts#getInbox`, `services/inbox.service.ts`,
> `validators/query.validator.ts#inboxQuerySchema`,
> `events/publish-conv-updated.ts`, `docs/SOCKET_EVENTS.md` §7.6 (bump-to-top).

---

### TC-PCHAT-084 — Get inbox (newest page, happy path)

| Field                     | Value                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Inbox                                                                                                                 |
| **API/Event Name**        | `GET /api/v1/chat/inbox`                                                                                                             |
| **Test Scenario**         | No cursor → newest 20 items (private + group merged)                                                                                 |
| **Category**              | Happy Path                                                                                                                           |
| **Priority**              | High                                                                                                                                 |
| **Preconditions**         | A has rooms/groups                                                                                                                   |
| **Request Payload**       | none (limit default 20)                                                                                                              |
| **Expected Response**     | `200` `{ data:[…], pagination:{ totalData, totalPage, currentPage:1, limit, nextCursor, hasMore } }` ordered by `lastMessageAt` desc |
| **Expected DB Changes**   | None                                                                                                                                 |
| **Expected Socket/Event** | None                                                                                                                                 |
| **Notes**                 | Unified private + group; default limit 20                                                                                            |

### TC-PCHAT-085 — Inbox before_ts pagination (older page)

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Private Chat / Inbox                                  |
| **API/Event Name**        | `GET /api/v1/chat/inbox?before_ts=<ms>&limit=20`      |
| **Test Scenario**         | items with `lastMessageAt <= before_ts`, newest-first |
| **Category**              | Pagination/Filter/Sort                                |
| **Priority**              | High                                                  |
| **Preconditions**         | >20 conversations                                     |
| **Request Payload**       | `before_ts=1700000000000&limit=20`                    |
| **Expected Response**     | `200` page; `nextCursor` = boundary `lastMessageAt`   |
| **Expected DB Changes**   | None                                                  |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | epoch ms; boundary inclusive                          |

### TC-PCHAT-086 — Inbox after_ts pagination (newer page)

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Private Chat / Inbox                                 |
| **API/Event Name**        | `GET /api/v1/chat/inbox?after_ts=<ms>`               |
| **Test Scenario**         | items with `lastMessageAt >= after_ts`, oldest-first |
| **Category**              | Pagination/Filter/Sort                               |
| **Priority**              | Medium                                               |
| **Preconditions**         | —                                                    |
| **Request Payload**       | `after_ts=1700000000000`                             |
| **Expected Response**     | `200` oldest-first                                   |
| **Expected DB Changes**   | None                                                 |
| **Expected Socket/Event** | None                                                 |
| **Notes**                 | direction "after"                                    |

### TC-PCHAT-087 — Inbox both before_ts and after_ts (invalid)

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Inbox                                   |
| **API/Event Name**        | `GET /api/v1/chat/inbox?before_ts=1&after_ts=2`        |
| **Test Scenario**         | mutually exclusive both set                            |
| **Category**              | Input Validation                                       |
| **Priority**              | Medium                                                 |
| **Preconditions**         | —                                                      |
| **Request Payload**       | both params                                            |
| **Expected Response**     | `400` "Provide either before_ts or after_ts, not both" |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | `inboxQuerySchema.refine`                              |

### TC-PCHAT-088 — Inbox limit > 100

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Private Chat / Inbox               |
| **API/Event Name**        | `GET /api/v1/chat/inbox?limit=200` |
| **Test Scenario**         | limit above max                    |
| **Category**              | Input Validation                   |
| **Priority**              | Low                                |
| **Preconditions**         | —                                  |
| **Request Payload**       | `limit=200`                        |
| **Expected Response**     | `400` (max 100)                    |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | min 1, max 100, default 20         |

### TC-PCHAT-089 — Inbox empty

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Inbox                                                  |
| **API/Event Name**        | `GET /api/v1/chat/inbox`                                              |
| **Test Scenario**         | New user with no conversations                                        |
| **Category**              | Edge Case                                                             |
| **Priority**              | Low                                                                   |
| **Preconditions**         | A has no rooms                                                        |
| **Request Payload**       | none                                                                  |
| **Expected Response**     | `200` `{ data:[], pagination:{ totalPage:1 } }` `CHAT_NO_INBOX_FOUND` |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | None                                                                  |
| **Notes**                 | `totalPage` floored to 1                                              |

### TC-PCHAT-090 — Inbox rate limit (120/60s)

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Private Chat / Inbox                      |
| **API/Event Name**        | `GET /api/v1/chat/inbox`                  |
| **Test Scenario**         | >120 calls in 60s                         |
| **Category**              | Rate Limit                                |
| **Priority**              | Medium                                    |
| **Preconditions**         | —                                         |
| **Request Payload**       | repeated                                  |
| **Expected Response**     | `429` after limit (`inbox:list`, 120/60s) |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | Heaviest read → its own limiter           |

### TC-PCHAT-091 — Inbox unauthenticated

| Field                     | Value                    |
| ------------------------- | ------------------------ |
| **Feature/Module**        | Private Chat / Inbox     |
| **API/Event Name**        | `GET /api/v1/chat/inbox` |
| **Test Scenario**         | No token                 |
| **Category**              | AuthN                    |
| **Priority**              | High                     |
| **Preconditions**         | —                        |
| **Request Payload**       | —                        |
| **Expected Response**     | `401`                    |
| **Expected DB Changes**   | None                     |
| **Expected Socket/Event** | None                     |
| **Notes**                 | —                        |

### TC-PCHAT-092 — Bump-to-top on new message (real-time ordering)

| Field                     | Value                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Inbox                                                                                                         |
| **API/Event Name**        | `conv:updated` (`/chat`)                                                                                                     |
| **Test Scenario**         | New message moves the room to the top of A's list without refetch                                                            |
| **Category**              | Pagination/Filter/Sort                                                                                                       |
| **Priority**              | High                                                                                                                         |
| **Preconditions**         | A on the list screen, joined only `user:<A>`                                                                                 |
| **Request Payload**       | n/a (peer sends a message)                                                                                                   |
| **Expected Response**     | `conv:updated` → `user:<A>` `{ type:"PRIVATE", roomId, lastMessage:{ contentType, text }, lastMessageAt, senderId, unread }` |
| **Expected DB Changes**   | room `lastMessageAt` updated                                                                                                 |
| **Expected Socket/Event** | `conv:updated` (idempotent; splice to top keyed by roomId)                                                                   |
| **Notes**                 | `lastMessageAt` is epoch ms (number); fired to all participants                                                              |

### TC-PCHAT-093 — Inbox excludes deleted-for-me rooms

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Inbox                                             |
| **API/Event Name**        | `GET /api/v1/chat/inbox`                                         |
| **Test Scenario**         | A deleted a room for self; should not appear (until new message) |
| **Category**              | Business Rule                                                    |
| **Priority**              | Medium                                                           |
| **Preconditions**         | `deletedFor[A]` set on a room                                    |
| **Request Payload**       | none                                                             |
| **Expected Response**     | `200` deleted room hidden for A                                  |
| **Expected DB Changes**   | None                                                             |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | Verify a new message resurfaces the room                         |

### TC-PCHAT-094 — Inbox item carries peer snapshot + mute state

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Inbox                                                               |
| **API/Event Name**        | `GET /api/v1/chat/inbox`                                                           |
| **Test Scenario**         | Private items expose enriched peer + isMuted                                       |
| **Category**              | Happy Path                                                                         |
| **Priority**              | Medium                                                                             |
| **Preconditions**         | A has a muted room                                                                 |
| **Request Payload**       | none                                                                               |
| **Expected Response**     | `200` item `{ peerId, peer:{ displayName, memberId, avatar, isOnline }, isMuted }` |
| **Expected DB Changes**   | None                                                                               |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | `isMuted` honours `muteUntil` expiry                                               |
