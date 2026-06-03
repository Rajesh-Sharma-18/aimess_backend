# WebSocket — Read / Delivery Receipts, Inbox Bump & Unread

`message:read` and `message:delivered` are ack'd events delegating to
chat-service; the receipts fan out to `conv:<id>`. `conv:updated` /
`community:updated` are the move-to-top hints delivered to `user:<id>` on the
`/chat` namespace. Group **system messages** bump last-message but do not raise
unread.

**Source:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`,
`docs/SOCKET_EVENTS.md` §4.2, the "List bump events" + "Group system messages"
notes, §7.6.

---

### TC-WS-100 — message:read marks read up to a message

| Field                     | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Read receipts                                                                                |
| **API/Event Name**        | `client→server: message:read`                                                                            |
| **Test Scenario**         | Happy path — reader marks conversation read up to `upToMessageId`                                        |
| **Category**              | Happy Path                                                                                               |
| **Priority**              | High                                                                                                     |
| **Preconditions**         | Reader in `conv:<id>`; messages exist up to `upToMessageId`                                              |
| **Request Payload**       | `{ conversationId, upToMessageId }`                                                                      |
| **Expected Response**     | Ack `{ success:true, data:{ … } }`                                                                       |
| **Expected DB Changes**   | Read watermark advanced for `readerId=userId`; unread count for that reader reset to 0 up to the message |
| **Expected Socket/Event** | `message:read` to `conv:<id>` `{ conversationId, readerId, upToMessageId }`                              |
| **Notes**                 | `readerId` forced to authed user — cannot mark read on behalf of others.                                 |

### TC-WS-101 — message:read malformed payload → INVALID_PAYLOAD

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | WebSocket / Read receipts                        |
| **API/Event Name**        | `client→server: message:read`                    |
| **Test Scenario**         | Input validation — missing `upToMessageId`       |
| **Category**              | Input Validation                                 |
| **Priority**              | Medium                                           |
| **Preconditions**         | Connected                                        |
| **Request Payload**       | `{ conversationId }`                             |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }` |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | Both fields `min(1)` required.                   |

### TC-WS-102 — message:delivered (private only)

| Field                     | Value                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Delivery receipts                                                                     |
| **API/Event Name**        | `client→server: message:delivered`                                                                |
| **Test Scenario**         | Happy path — recipient emits on receiving `message:new`                                           |
| **Category**              | Happy Path                                                                                        |
| **Priority**              | Medium                                                                                            |
| **Preconditions**         | Private conversation; recipient received `message:new`                                            |
| **Request Payload**       | `{ conversationId, upToMessageId }`                                                               |
| **Expected Response**     | Ack `{ success:true, data:{ … } }`                                                                |
| **Expected DB Changes**   | Delivery watermark advanced for `recipientId=userId`                                              |
| **Expected Socket/Event** | `message:delivered` to `conv:<id>` `{ conversationId, recipientId, upToMessageId, messageIds[] }` |
| **Notes**                 | Documented private-only. `recipientId` from token. Group delivery receipts not modeled.           |

### TC-WS-103 — Read receipt does not fire for sender's own read

| Field                     | Value                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Read receipts                                                                 |
| **API/Event Name**        | `server→client: message:read`                                                             |
| **Test Scenario**         | Business rule — sender sees recipient's read state                                        |
| **Category**              | Business Rule                                                                             |
| **Priority**              | Medium                                                                                    |
| **Preconditions**         | A sent, B reads                                                                           |
| **Request Payload**       | B emits `message:read`                                                                    |
| **Expected Response**     | A (in `conv:<id>`) receives `message:read { readerId:B }`                                 |
| **Expected DB Changes**   | B's read watermark                                                                        |
| **Expected Socket/Event** | `message:read` to `conv:<id>` (A and B both in room receive it; A renders B's checkmarks) |
| **Notes**                 | Broadcast is to the whole room, not sender-only.                                          |

### TC-WS-104 — conv:updated bump-to-top on new message

| Field                     | Value                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Inbox bump                                                                                                                                                                                   |
| **API/Event Name**        | `server→client: conv:updated`                                                                                                                                                                            |
| **Test Scenario**         | Happy path — list screen reorders without refetch on a new message                                                                                                                                       |
| **Category**              | Happy Path                                                                                                                                                                                               |
| **Priority**              | High                                                                                                                                                                                                     |
| **Preconditions**         | A on chat-list screen (joined only `user:<A>`, no `conv:join`)                                                                                                                                           |
| **Request Payload**       | n/a (someone sends a message in a chat A belongs to)                                                                                                                                                     |
| **Expected Response**     | n/a                                                                                                                                                                                                      |
| **Expected DB Changes**   | Conversation `lastMessage`/`lastMessageAt` updated                                                                                                                                                       |
| **Expected Socket/Event** | `conv:updated` to every participant's `user:<id>` on `/chat`: `{ type:"PRIVATE"\|"GROUP", roomId, lastMessageId, lastMessage:{ contentType, text }, lastMessageAt(number, epoch ms), senderId, unread }` |
| **Notes**                 | Sender's own copy `unread:false`; recipients `unread:true`. Independent of `message:new` — a user inside the conv receives both. Idempotent (key `roomId`).                                              |

### TC-WS-105 — community:updated delivered on /chat (not /community)

| Field                     | Value                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Inbox bump                                                                                                                                                             |
| **API/Event Name**        | `server→client: community:updated`                                                                                                                                                 |
| **Test Scenario**         | Business rule — unified inbox bump for communities arrives on the `/chat` socket                                                                                                   |
| **Category**              | Business Rule                                                                                                                                                                      |
| **Priority**              | High                                                                                                                                                                               |
| **Preconditions**         | A is an active member of a community; A connected on `/chat`                                                                                                                       |
| **Request Payload**       | n/a (a new community message arrives)                                                                                                                                              |
| **Expected Response**     | n/a                                                                                                                                                                                |
| **Expected DB Changes**   | Community last-message updated                                                                                                                                                     |
| **Expected Socket/Event** | `community:updated` to `user:<A>` on **`/chat`**: `{ communityId, roomId, lastMessageId, lastMessage, lastMessageAt, senderId, unread }`                                           |
| **Notes**                 | Intentional: unified list/inbox uses the `/chat` socket, so FE must listen on `/chat`. Delivered to all active members. Easy to miss — common FE bug is listening on `/community`. |

### TC-WS-106 — Group system message bumps inbox but not unread

| Field                     | Value                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Inbox bump                                                                                                                                                                                                                        |
| **API/Event Name**        | `server→client: message:new` (`contentType:"SYSTEM"`)                                                                                                                                                                                         |
| **Test Scenario**         | Business rule — a group lifecycle event posts a SYSTEM message that sorts the inbox but doesn't raise unread                                                                                                                                  |
| **Category**              | Business Rule                                                                                                                                                                                                                                 |
| **Priority**              | Medium                                                                                                                                                                                                                                        |
| **Preconditions**         | Group exists; an action like `ROOM_RENAMED` occurs                                                                                                                                                                                            |
| **Request Payload**       | n/a                                                                                                                                                                                                                                           |
| **Expected Response**     | n/a                                                                                                                                                                                                                                           |
| **Expected DB Changes**   | SYSTEM message persisted; room last-message updated; unread NOT incremented                                                                                                                                                                   |
| **Expected Socket/Event** | `message:new` to `conv:<id>` with `contentType:"SYSTEM"`, `systemEvent`, `systemData` (`actorId`/`actorName`, etc.); `conv:updated` may fire to reorder the inbox                                                                             |
| **Notes**                 | `systemEvent` ∈ GROUP_CREATED, MEMBER_ADDED, MEMBER_JOINED, MEMBER_LEFT, MEMBER_REMOVED, ROLE_CHANGED, ROOM_RENAMED, AVATAR_CHANGED, DESCRIPTION_CHANGED. Render from `systemEvent`+`systemData` for i18n; `contentText` is English fallback. |

### TC-WS-107 — Idempotent re-delivery of conv:updated

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Inbox bump                                                           |
| **API/Event Name**        | `server→client: conv:updated`                                                    |
| **Test Scenario**         | Concurrency — same `conv:updated` received twice (e.g. multi-fan-out, reconnect) |
| **Category**              | Concurrency                                                                      |
| **Priority**              | Low                                                                              |
| **Preconditions**         | Item already at top with same `lastMessageId`                                    |
| **Request Payload**       | duplicate `conv:updated`                                                         |
| **Expected Response**     | n/a                                                                              |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | No-op on client; safe to receive more than once                                  |
| **Notes**                 | Doc guarantees idempotency keyed by `roomId`/`communityId`.                      |

### TC-WS-108 — unread boolean hint semantics

| Field                     | Value                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Unread                                                                                                                                   |
| **API/Event Name**        | `server→client: conv:updated` (`unread` field)                                                                                                       |
| **Test Scenario**         | Business rule — `unread` is a v1 boolean hint, not an absolute count                                                                                 |
| **Category**              | Business Rule                                                                                                                                        |
| **Priority**              | Low                                                                                                                                                  |
| **Preconditions**         | New message                                                                                                                                          |
| **Request Payload**       | n/a                                                                                                                                                  |
| **Expected Response**     | n/a                                                                                                                                                  |
| **Expected DB Changes**   | None                                                                                                                                                 |
| **Expected Socket/Event** | `unread:true` for non-sender recipients, `false` on sender's copy                                                                                    |
| **Notes**                 | **GAP/planned:** absolute unread count is a planned enhancement — not yet emitted over sockets. FE computes counts from its own state or REST inbox. |

### TC-WS-109 — Multi-device read sync

| Field                     | Value                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Read receipts                                                                                                     |
| **API/Event Name**        | `client→server: message:read` (multi-device)                                                                                  |
| **Test Scenario**         | Concurrency — user reads on phone; web client should reflect read state                                                       |
| **Category**              | Concurrency                                                                                                                   |
| **Priority**              | Medium                                                                                                                        |
| **Preconditions**         | Same user on two `/chat` sockets, both in `conv:<id>`                                                                         |
| **Request Payload**       | phone emits `message:read`                                                                                                    |
| **Expected Response**     | Ack to phone                                                                                                                  |
| **Expected DB Changes**   | Read watermark advanced once                                                                                                  |
| **Expected Socket/Event** | `message:read { readerId:self }` to `conv:<id>` — web device (in the room) also receives it and can clear its unread badge    |
| **Notes**                 | Cross-device consistency relies on both devices being in the room; the chat-list bump for own-read is not separately emitted. |
