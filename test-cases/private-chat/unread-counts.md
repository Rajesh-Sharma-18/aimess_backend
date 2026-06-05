# Private Chat — Unread Counts

> **Source:** `services/inbox.service.ts`, `services/private-room.service.ts`,
> `repositories/private-room.repository.ts` (read cursor / unread derivation),
> `events/publish-conv-updated.ts`, `docs/SOCKET_EVENTS.md` (`conv:updated.unread`).

> **Note:** there is no dedicated REST "unread count" endpoint in private-chat routes. Unread is
> surfaced two ways: (1) per-item on the unified **inbox** (`GET /api/v1/chat/inbox`), and (2) the
> real-time **`conv:updated`** bump event's `unread` boolean hint. An absolute numeric unread count
> on the bump event is a **planned** enhancement (`unread` is a v1 boolean).

---

### TC-PCHAT-078 — New message raises recipient unread

| Field                     | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Unread                                                        |
| **API/Event Name**        | `message:send` → `conv:updated`                                              |
| **Test Scenario**         | A sends to B; B not reading                                                  |
| **Category**              | DB State                                                                     |
| **Priority**              | High                                                                         |
| **Preconditions**         | A & B friends; B has the room                                                |
| **Request Payload**       | a normal send                                                                |
| **Expected Response**     | n/a (event-driven)                                                           |
| **Expected DB Changes**   | B's unread for room incremented                                              |
| **Expected Socket/Event** | `conv:updated` → `user:<B>` `{ unread:true }`; `user:<A>` `{ unread:false }` |
| **Notes**                 | Sender's own copy always `unread:false`                                      |

### TC-PCHAT-079 — Inbox reflects per-room unread

| Field                     | Value                             |
| ------------------------- | --------------------------------- |
| **Feature/Module**        | Private Chat / Unread             |
| **API/Event Name**        | `GET /api/v1/chat/inbox`          |
| **Test Scenario**         | B fetches inbox with unread rooms |
| **Category**              | Happy Path                        |
| **Priority**              | High                              |
| **Preconditions**         | B has unread messages             |
| **Request Payload**       | inbox query                       |
| **Expected Response**     | `200` items carry unread state    |
| **Expected DB Changes**   | None                              |
| **Expected Socket/Event** | None                              |
| **Notes**                 | See inbox.md for full inbox cases |

### TC-PCHAT-080 — Read collapses unread to zero

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Private Chat / Unread                        |
| **API/Event Name**        | `message:read` then `GET /api/v1/chat/inbox` |
| **Test Scenario**         | B reads to latest, re-fetches inbox          |
| **Category**              | DB State                                     |
| **Priority**              | High                                         |
| **Preconditions**         | B had unread N                               |
| **Request Payload**       | read receipt + inbox refetch                 |
| **Expected Response**     | unread now 0 for that room                   |
| **Expected DB Changes**   | read cursor advanced; unread derived = 0     |
| **Expected Socket/Event** | `message:read`                               |
| **Notes**                 | —                                            |

### TC-PCHAT-081 — Own sent message does not raise own unread

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Private Chat / Unread                   |
| **API/Event Name**        | `message:send`                          |
| **Test Scenario**         | A sends; A's own unread unaffected      |
| **Category**              | Business Rule                           |
| **Priority**              | Medium                                  |
| **Preconditions**         | —                                       |
| **Request Payload**       | a send                                  |
| **Expected Response**     | n/a                                     |
| **Expected DB Changes**   | A's unread unchanged                    |
| **Expected Socket/Event** | `conv:updated` to A with `unread:false` |
| **Notes**                 | —                                       |

### TC-PCHAT-082 — System messages do not raise unread

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Unread                                      |
| **API/Event Name**        | `message:new` (SYSTEM)                                     |
| **Test Scenario**         | A SYSTEM message bumps room but not unread                 |
| **Category**              | Business Rule                                              |
| **Priority**              | Low                                                        |
| **Preconditions**         | —                                                          |
| **Request Payload**       | n/a                                                        |
| **Expected Response**     | n/a                                                        |
| **Expected DB Changes**   | lastMessage bumped; unread not raised                      |
| **Expected Socket/Event** | bump only                                                  |
| **Notes**                 | Per SOCKET_EVENTS group system note; verify private parity |

### TC-PCHAT-083 — Deleting unread message decrements/leaves counter consistent

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Unread                                                            |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forEveryone`                                   |
| **Test Scenario**         | Sender deletes an unread message for everyone                                    |
| **Category**              | Edge Case                                                                        |
| **Priority**              | Low                                                                              |
| **Preconditions**         | Recipient hasn't read it                                                         |
| **Request Payload**       | delete forEveryone                                                               |
| **Expected Response**     | `200`                                                                            |
| **Expected DB Changes**   | **GAP:** verify recipient unread is reconciled after tombstone (may still count) |
| **Expected Socket/Event** | `message:delete`                                                                 |
| **Notes**                 | File if unread counts tombstones                                                 |
