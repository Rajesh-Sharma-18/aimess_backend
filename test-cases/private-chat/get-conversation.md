# Private Chat — Get Conversation / Timeline & Rooms

> **Source:** `apps/chat-service/src/api/routes/private-message.routes.ts`,
> `controllers/private-message.controller.ts` (`getMessages`, `searchMessages`, `getRoomMedia`),
> `controllers/private-room.controller.ts` (`getOrCreateRoom`, `getConversationList`, `deleteForMe`,
> `muteRoom`, `unmuteRoom`), `services/private-message.service.ts`, `services/private-room.service.ts`,
> `validators/query.validator.ts`. Base path `/api/v1/chat/private` (mount per gateway).

---

### TC-PCHAT-019 — Get or create room with peer (existing)

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Rooms                                       |
| **API/Event Name**        | `POST /rooms/:peerId`                                      |
| **Test Scenario**         | Room already exists for (A,B) — returns it                 |
| **Category**              | Happy Path                                                 |
| **Priority**              | High                                                       |
| **Preconditions**         | A authenticated; room (A,B) exists                         |
| **Request Payload**       | path `:peerId=<B>`; empty body                             |
| **Expected Response**     | `200` `{ data:{ roomId, participants, participantsKey } }` |
| **Expected DB Changes**   | None (idempotent lookup by `participantsKey`)              |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | No friendship check when room already exists               |

### TC-PCHAT-020 — Get or create room (new, friends)

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Rooms                                             |
| **API/Event Name**        | `POST /rooms/:peerId`                                            |
| **Test Scenario**         | No room yet; A & B are friends                                   |
| **Category**              | Happy Path                                                       |
| **Priority**              | High                                                             |
| **Preconditions**         | `checkFriendship(A,B)=true`                                      |
| **Request Payload**       | path `:peerId=<B>`                                               |
| **Expected Response**     | `200` `{ data:{ roomId:"prv_…", participants:[A,B].sorted } }`   |
| **Expected DB Changes**   | New `PrivateRoom` (roomId, participants sorted, participantsKey) |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | `participants` stored sorted; `participantsKey` is symmetric     |

### TC-PCHAT-021 — Get or create room blocked (not friends)

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Private Chat / Rooms                                 |
| **API/Event Name**        | `POST /rooms/:peerId`                                |
| **Test Scenario**         | No room; A & B not friends                           |
| **Category**              | Business Rule                                        |
| **Priority**              | High                                                 |
| **Preconditions**         | `checkFriendship=false`                              |
| **Request Payload**       | path `:peerId=<B>`                                   |
| **Expected Response**     | `403` `CHAT_FRIENDSHIP_REQUIRED`                     |
| **Expected DB Changes**   | None                                                 |
| **Expected Socket/Event** | None                                                 |
| **Notes**                 | Friendship gate enforced only on _new_ room creation |

### TC-PCHAT-022 — Get room create rate limit

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Private Chat / Rooms                            |
| **API/Event Name**        | `POST /rooms/:peerId`                           |
| **Test Scenario**         | >60 calls in 60s from one user                  |
| **Category**              | Rate Limit                                      |
| **Priority**              | Medium                                          |
| **Preconditions**         | —                                               |
| **Request Payload**       | repeated calls                                  |
| **Expected Response**     | `429` after limit (keyPrefix `pm:send`, 60/60s) |
| **Expected DB Changes**   | None beyond accepted                            |
| **Expected Socket/Event** | None                                            |
| **Notes**                 | Shares the `sendLimit` limiter                  |

### TC-PCHAT-023 — Get messages timeline (newest page)

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Timeline                                                          |
| **API/Event Name**        | `GET /rooms/:roomId/messages`                                                    |
| **Test Scenario**         | No cursor → newest 30 messages                                                   |
| **Category**              | Happy Path                                                                       |
| **Priority**              | High                                                                             |
| **Preconditions**         | Room exists with messages; A participant                                         |
| **Request Payload**       | query: none (limit defaults 30)                                                  |
| **Expected Response**     | `200` `{ data:[…], pagination:{ totalData, hasMore, nextCursor } }` newest-first |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | None                                                                             |
| **Notes**                 | `nextCursor` = boundary `createdAt` epoch-ms; `totalCount` from `countMessages`  |

### TC-PCHAT-024 — Timeline pagination via before_ts

| Field                     | Value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Timeline                                                                 |
| **API/Event Name**        | `GET /rooms/:roomId/messages?before_ts=<ms>&limit=20`                                   |
| **Test Scenario**         | Older page; `createdAt <= before_ts`, newest-first                                      |
| **Category**              | Pagination/Filter/Sort                                                                  |
| **Priority**              | High                                                                                    |
| **Preconditions**         | >20 messages                                                                            |
| **Request Payload**       | `before_ts=1700000000000&limit=20`                                                      |
| **Expected Response**     | `200` 20 items; `hasMore` exact (repo over-fetches 1)                                   |
| **Expected DB Changes**   | None                                                                                    |
| **Expected Socket/Event** | None                                                                                    |
| **Notes**                 | Boundary inclusive → consecutive pages may share a message on tie; client dedupes by id |

### TC-PCHAT-025 — Timeline pagination via after_ts

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Private Chat / Timeline                           |
| **API/Event Name**        | `GET /rooms/:roomId/messages?after_ts=<ms>`       |
| **Test Scenario**         | Newer page; `createdAt >= after_ts`, oldest-first |
| **Category**              | Pagination/Filter/Sort                            |
| **Priority**              | Medium                                            |
| **Preconditions**         | —                                                 |
| **Request Payload**       | `after_ts=1700000000000`                          |
| **Expected Response**     | `200` oldest-first ordering                       |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | direction = "after"                               |

### TC-PCHAT-026 — Timeline: before_ts and after_ts both supplied

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Timeline                                |
| **API/Event Name**        | `GET /rooms/:roomId/messages?before_ts=1&after_ts=2`   |
| **Test Scenario**         | Mutually-exclusive params both set                     |
| **Category**              | Input Validation                                       |
| **Priority**              | Medium                                                 |
| **Preconditions**         | —                                                      |
| **Request Payload**       | both params                                            |
| **Expected Response**     | `400` "Provide either before_ts or after_ts, not both" |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | `messageTimelineQuerySchema.refine`                    |

### TC-PCHAT-027 — Timeline limit > 100

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Private Chat / Timeline                 |
| **API/Event Name**        | `GET /rooms/:roomId/messages?limit=500` |
| **Test Scenario**         | limit above max                         |
| **Category**              | Input Validation                        |
| **Priority**              | Low                                     |
| **Preconditions**         | —                                       |
| **Request Payload**       | `limit=500`                             |
| **Expected Response**     | `400` (limit max 100)                   |
| **Expected DB Changes**   | None                                    |
| **Expected Socket/Event** | None                                    |
| **Notes**                 | min 1, max 100, default 30              |

### TC-PCHAT-028 — Timeline on non-existent room

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Private Chat / Timeline                             |
| **API/Event Name**        | `GET /rooms/:roomId/messages`                       |
| **Test Scenario**         | Unknown roomId                                      |
| **Category**              | Error Handling                                      |
| **Priority**              | Medium                                              |
| **Preconditions**         | —                                                   |
| **Request Payload**       | `:roomId=does-not-exist`                            |
| **Expected Response**     | `404` `CHAT_ROOM_NOT_FOUND`                         |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | service `getMessagesTimeline` checks room existence |

### TC-PCHAT-029 — Timeline IDOR (non-participant reads room)

| Field                     | Value                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Timeline                                                                                                                                                                                        |
| **API/Event Name**        | `GET /rooms/:roomId/messages`                                                                                                                                                                                  |
| **Test Scenario**         | User C (not in room A,B) requests messages                                                                                                                                                                     |
| **Category**              | Security / AuthZ                                                                                                                                                                                               |
| **Priority**              | High                                                                                                                                                                                                           |
| **Preconditions**         | C authenticated, not a participant                                                                                                                                                                             |
| **Request Payload**       | `:roomId=<A,B room>`                                                                                                                                                                                           |
| **Expected Response**     | Expected `403`/`404` — **GAP:** `getMessagesTimeline` only checks room exists, **not** participation (per-message `deletedFor` filter applies by userId but rows still returned). Verify and file as authz gap |
| **Expected DB Changes**   | None                                                                                                                                                                                                           |
| **Expected Socket/Event** | None                                                                                                                                                                                                           |
| **Notes**                 | Contrast: `getRoomMedia`/`listMedia` and `catchup` DO enforce `participants.includes(userId)`                                                                                                                  |

### TC-PCHAT-030 — Get unauthenticated

| Field                     | Value                         |
| ------------------------- | ----------------------------- |
| **Feature/Module**        | Private Chat / Timeline       |
| **API/Event Name**        | `GET /rooms/:roomId/messages` |
| **Test Scenario**         | No bearer token               |
| **Category**              | AuthN                         |
| **Priority**              | High                          |
| **Preconditions**         | —                             |
| **Request Payload**       | no Authorization header       |
| **Expected Response**     | `401`                         |
| **Expected DB Changes**   | None                          |
| **Expected Socket/Event** | None                          |
| **Notes**                 | `authenticate` middleware     |

### TC-PCHAT-031 — Search messages in room (happy path)

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Search                                                 |
| **API/Event Name**        | `GET /rooms/:roomId/messages/search?q=hello`                          |
| **Test Scenario**         | Text search returns matches                                           |
| **Category**              | Happy Path                                                            |
| **Priority**              | Medium                                                                |
| **Preconditions**         | Messages containing "hello"                                           |
| **Request Payload**       | `q=hello&limit=30`                                                    |
| **Expected Response**     | `200` paginated enriched matches                                      |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | None                                                                  |
| **Notes**                 | Route ordered before `/messages` list so `/search` resolves correctly |

### TC-PCHAT-032 — Search with empty q

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Search                                         |
| **API/Event Name**        | `GET /rooms/:roomId/messages/search?q=`                       |
| **Test Scenario**         | Blank/whitespace query                                        |
| **Category**              | Edge Case                                                     |
| **Priority**              | Low                                                           |
| **Preconditions**         | —                                                             |
| **Request Payload**       | `q=` (or omit)                                                |
| **Expected Response**     | `200` empty list (short-circuits, no DB hit)                  |
| **Expected DB Changes**   | None                                                          |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | Controller returns empty `buildListResponse` when query blank |

### TC-PCHAT-033 — Get conversation list (legacy cursor list)

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Private Chat / Conversations                          |
| **API/Event Name**        | `GET /conversations`                                  |
| **Test Scenario**         | List private rooms ordered by lastMessageAt           |
| **Category**              | Happy Path                                            |
| **Priority**              | Medium                                                |
| **Preconditions**         | A has rooms                                           |
| **Request Payload**       | query `limit`, `cursor`, `page` optional              |
| **Expected Response**     | `200` enriched rooms (peer snapshot, isMuted, peerId) |
| **Expected DB Changes**   | None                                                  |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | Superseded by unified `/inbox`; still shipped         |

### TC-PCHAT-034 — Delete conversation for me

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Conversations                                  |
| **API/Event Name**        | `DELETE /rooms/:roomId`                                       |
| **Test Scenario**         | A removes the room from their own list                        |
| **Category**              | Happy Path / DB State                                         |
| **Priority**              | Medium                                                        |
| **Preconditions**         | A is a participant                                            |
| **Request Payload**       | path `:roomId`                                                |
| **Expected Response**     | `200` `CHAT_CONVERSATION_DELETED`                             |
| **Expected DB Changes**   | `deletedFor[A]` set on the room; peer still sees it           |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | Non-participant → `404 CHAT_ROOM_NOT_FOUND` (masks existence) |

### TC-PCHAT-035 — Mute conversation (with muteUntil)

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Conversations                                         |
| **API/Event Name**        | `POST /rooms/:roomId/mute`                                           |
| **Test Scenario**         | Mute until a future ISO datetime                                     |
| **Category**              | Happy Path                                                           |
| **Priority**              | Low                                                                  |
| **Preconditions**         | A participant                                                        |
| **Request Payload**       | `{ muteUntil:"2026-12-31T00:00:00Z" }`                               |
| **Expected Response**     | `200` `CHAT_ROOM_MUTED`; room `mutedBy[A]` set                       |
| **Expected DB Changes**   | `mutedBy[A].muteUntil` recorded                                      |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | `muteUntil` null/omitted = mute indefinitely; invalid datetime → 400 |

### TC-PCHAT-036 — Mute invalid datetime

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Private Chat / Conversations                   |
| **API/Event Name**        | `POST /rooms/:roomId/mute`                     |
| **Test Scenario**         | `muteUntil:"not-a-date"`                       |
| **Category**              | Input Validation                               |
| **Priority**              | Low                                            |
| **Preconditions**         | —                                              |
| **Request Payload**       | `{ muteUntil:"not-a-date" }`                   |
| **Expected Response**     | `400` (`muteRoomSchema` z.string().datetime()) |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | —                                              |

### TC-PCHAT-037 — Unmute conversation

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Private Chat / Conversations                    |
| **API/Event Name**        | `POST /rooms/:roomId/unmute`                    |
| **Test Scenario**         | Clear mute state                                |
| **Category**              | Happy Path                                      |
| **Priority**              | Low                                             |
| **Preconditions**         | Room muted by A                                 |
| **Request Payload**       | path `:roomId`                                  |
| **Expected Response**     | `200` `CHAT_ROOM_UNMUTED`; `mutedBy[A]` cleared |
| **Expected DB Changes**   | mute removed                                    |
| **Expected Socket/Event** | None                                            |
| **Notes**                 | Non-participant → `404`                         |

### TC-PCHAT-038 — Get peer presence

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Presence                                          |
| **API/Event Name**        | `GET /presence/:userId`                                          |
| **Test Scenario**         | Fetch online + lastSeen of a peer                                |
| **Category**              | Happy Path                                                       |
| **Priority**              | Low                                                              |
| **Preconditions**         | Authenticated                                                    |
| **Request Payload**       | path `:userId=<B>`                                               |
| **Expected Response**     | `200` `{ userId, isOnline, lastSeen }`                           |
| **Expected DB Changes**   | None                                                             |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | Real-time changes also pushed via `presence:status` socket event |
