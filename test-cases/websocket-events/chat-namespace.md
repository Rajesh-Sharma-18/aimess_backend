# WebSocket — /chat Namespace: Messages, Reactions, Edit/Delete, Forward

Core 1-1 and group messaging events on `/chat`. All these are ack'd
request/response events delegating to chat-service over gRPC
(`MessagingClient`). The gateway packs `contentText`/`urls`/`files`/`location`/
`contact` into `contentJson` and always injects `senderId = socket.data.userId`
(client-supplied sender is never trusted). Server→client broadcasts arrive via
the Redis `conv:*` pattern re-emitted to `conv:<id>`.

**Source:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`,
`docs/SOCKET_EVENTS.md` §4.

---

### TC-WS-040 — message:send happy path (text, private)

| Field                     | Value                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                                                                                                             |
| **API/Event Name**        | `client→server: message:send`                                                                                                                                                          |
| **Test Scenario**         | Happy path — send a TEXT message in a 1-1 conversation                                                                                                                                 |
| **Category**              | Happy Path                                                                                                                                                                             |
| **Priority**              | High                                                                                                                                                                                   |
| **Preconditions**         | Connected `/chat`; both peers in `conv:<id>`                                                                                                                                           |
| **Request Payload**       | `{ conversationId, clientMessageId, contentType:"TEXT", contentText:"hi", conversationType:"private", receiverId }`                                                                    |
| **Expected Response**     | Ack `{ success:true, data:{ messageId, sequenceNumber, sentAt, … } }` (`sentAt`/`sequenceNumber` are **stringified** int64 in the ack)                                                 |
| **Expected DB Changes**   | New message row in chat-service; per-room `sequenceNumber` allocated atomically; conversation `lastMessage` updated                                                                    |
| **Expected Socket/Event** | `message:new` broadcast to `conv:<id>` (`sentAt`/`sequenceNumber` as **numbers**); `conv:updated` to each participant's `user:<id>` (sender copy `unread:false`, others `unread:true`) |
| **Notes**                 | Gateway builds `contentJson = { text, urls:[], files:[], … }`. `senderId` forced to authed user.                                                                                       |

### TC-WS-041 — message:send with media (mediaKey shorthand)

| Field                     | Value                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                                  |
| **API/Event Name**        | `client→server: message:send`                                                                               |
| **Test Scenario**         | Happy path — image message via `mediaKey` shorthand, no explicit `files`                                    |
| **Category**              | File Upload                                                                                                 |
| **Priority**              | Medium                                                                                                      |
| **Preconditions**         | `mediaKey` is a valid object key already uploaded to storage                                                |
| **Request Payload**       | `{ conversationId, clientMessageId, contentType:"IMAGE", mediaKey:"<objKey>", conversationType:"private" }` |
| **Expected Response**     | Ack `{ success:true, data:{ messageId, … } }`                                                               |
| **Expected DB Changes**   | Message persisted with one file entry `{ objectKey:mediaKey, name:"", size:0, mime:"" }`                    |
| **Expected Socket/Event** | `message:new` to `conv:<id>`                                                                                |
| **Notes**                 | Gateway injects a file from `mediaKey` only when no `files` entry already carries an `objectKey`.           |

### TC-WS-042 — message:send group path

| Field                     | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                               |
| **API/Event Name**        | `client→server: message:send`                                                                            |
| **Test Scenario**         | Happy path — `conversationType:"group"` selects the group code path                                      |
| **Category**              | Business Rule                                                                                            |
| **Priority**              | High                                                                                                     |
| **Preconditions**         | User is a group member; group room joined                                                                |
| **Request Payload**       | `{ conversationId, clientMessageId, contentType:"TEXT", contentText:"team!", conversationType:"GROUP" }` |
| **Expected Response**     | Ack success                                                                                              |
| **Expected DB Changes**   | Group message persisted; per-room seq allocated                                                          |
| **Expected Socket/Event** | `message:new` to `conv:<id>`; `conv:updated` `{ type:"GROUP" }` to each member's `user:<id>`             |
| **Notes**                 | `conversationType` is case-insensitive (`preprocess` lowercases) and defaults to `"private"`.            |

### TC-WS-043 — message:send idempotency via clientMessageId

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                       |
| **API/Event Name**        | `client→server: message:send`                                                    |
| **Test Scenario**         | Concurrency — same `clientMessageId` re-sent (offline retry) does not duplicate  |
| **Category**              | Concurrency                                                                      |
| **Priority**              | High                                                                             |
| **Preconditions**         | A message with `clientMessageId=X` already created                               |
| **Request Payload**       | identical payload with `clientMessageId=X`                                       |
| **Expected Response**     | Ack success returning the **same** `messageId` (no second row)                   |
| **Expected DB Changes**   | No new row (dedup by `clientMessageId` in chat-service)                          |
| **Expected Socket/Event** | No duplicate `message:new` (idempotent)                                          |
| **Notes**                 | Offline-first replay safety. Dedup logic lives in chat-service, not the gateway. |

### TC-WS-044 — message:send malformed payload → INVALID_PAYLOAD ack

| Field                     | Value                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                                     |
| **API/Event Name**        | `client→server: message:send`                                                                                  |
| **Test Scenario**         | Input validation — missing `clientMessageId` / `contentType` / `conversationId`                                |
| **Category**              | Input Validation                                                                                               |
| **Priority**              | High                                                                                                           |
| **Preconditions**         | Connected socket                                                                                               |
| **Request Payload**       | `{ conversationId:"c", contentText:"x" }` (no `clientMessageId`, no `contentType`)                             |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }`                                                               |
| **Expected DB Changes**   | None                                                                                                           |
| **Expected Socket/Event** | None                                                                                                           |
| **Notes**                 | `MessageSendSchema` requires `conversationId`,`clientMessageId`,`contentType` all `min(1)`. No gRPC call made. |

### TC-WS-045 — message:send invalid url in urls[] → INVALID_PAYLOAD

| Field                     | Value                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                                     |
| **API/Event Name**        | `client→server: message:send`                                                                                  |
| **Test Scenario**         | Input validation — `urls` contains a non-URL string                                                            |
| **Category**              | Input Validation                                                                                               |
| **Priority**              | Low                                                                                                            |
| **Preconditions**         | Connected socket                                                                                               |
| **Request Payload**       | `{ …, urls:["not a url"] }`                                                                                    |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }`                                                               |
| **Expected DB Changes**   | None                                                                                                           |
| **Expected Socket/Event** | None                                                                                                           |
| **Notes**                 | `z.array(z.string().url())`. Also `location.lat/lng` bounds, file `objectKey`/`url` length caps are validated. |

### TC-WS-046 — AuthZ: spoof senderId in payload is ignored

| Field                     | Value                                                                                                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                                                                                                                                                                                      |
| **API/Event Name**        | `client→server: message:send`                                                                                                                                                                                                                                   |
| **Test Scenario**         | Security — payload includes `senderId` of another user                                                                                                                                                                                                          |
| **Category**              | Security                                                                                                                                                                                                                                                        |
| **Priority**              | High                                                                                                                                                                                                                                                            |
| **Preconditions**         | Connected as user A                                                                                                                                                                                                                                             |
| **Request Payload**       | `{ …, senderId:"<userB>" }` (extra field)                                                                                                                                                                                                                       |
| **Expected Response**     | Ack success but message stored with `senderId = A`                                                                                                                                                                                                              |
| **Expected DB Changes**   | Message authored by A, not B                                                                                                                                                                                                                                    |
| **Expected Socket/Event** | `message:new` carries `senderId:A`                                                                                                                                                                                                                              |
| **Notes**                 | Gateway spreads `...r.data` then **overwrites** `senderId: userId` from the token. `MessageSendSchema` has no `senderId` field so any client value is stripped anyway. `senderName`/`senderAvatar` are accepted as denormalized hints (cosmetic, not identity). |

### TC-WS-047 — message:send downstream gRPC failure → SERVICE_ERROR

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                       |
| **API/Event Name**        | `client→server: message:send`                                                    |
| **Test Scenario**         | Error handling — chat-service unavailable / gRPC error                           |
| **Category**              | Error Handling                                                                   |
| **Priority**              | High                                                                             |
| **Preconditions**         | Valid payload; chat-service down or circuit open                                 |
| **Request Payload**       | valid `message:send` payload                                                     |
| **Expected Response**     | Ack `{ success:false, error:"SERVICE_ERROR" }`                                   |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | None                                                                             |
| **Notes**                 | Caught in `.catch`, warning logged. Client retries with backoff per error table. |

### TC-WS-048 — message:edit own message

| Field                     | Value                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                          |
| **API/Event Name**        | `client→server: message:edit`                                                                       |
| **Test Scenario**         | Happy path — edit text of a message you authored                                                    |
| **Category**              | Happy Path                                                                                          |
| **Priority**              | Medium                                                                                              |
| **Preconditions**         | User authored `messageId`; in `conv:<id>`                                                           |
| **Request Payload**       | `{ messageId, conversationId, contentText:"fixed", conversationType:"private" }`                    |
| **Expected Response**     | Ack `{ success:true, data:{ … } }`                                                                  |
| **Expected DB Changes**   | Message `contentText`/`contentJson` updated; `editedAt` set; `sequenceNumber` returned              |
| **Expected Socket/Event** | `message:edited` to `conv:<id>` `{ messageId, contentText, contentJson, editedAt, sequenceNumber }` |
| **Notes**                 | `editorId = userId`.                                                                                |

### TC-WS-049 — AuthZ: edit a message you did not author

| Field                     | Value                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                            |
| **API/Event Name**        | `client→server: message:edit`                                                         |
| **Test Scenario**         | AuthZ — attempt to edit someone else's message                                        |
| **Category**              | AuthZ                                                                                 |
| **Priority**              | High                                                                                  |
| **Preconditions**         | `messageId` authored by another user                                                  |
| **Request Payload**       | `{ messageId:"<other's>", conversationId, contentText:"hacked" }`                     |
| **Expected Response**     | Ack `{ success:false, error:"SERVICE_ERROR" }` (chat-service rejects non-author edit) |
| **Expected DB Changes**   | None                                                                                  |
| **Expected Socket/Event** | None                                                                                  |
| **Notes**                 | Gateway forwards `editorId=userId`; authorization enforced in chat-service.           |

### TC-WS-050 — message:forward into another conversation

| Field                     | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                     |
| **API/Event Name**        | `client→server: message:forward`                                                               |
| **Test Scenario**         | Happy path — forward an existing message to a target conversation                              |
| **Category**              | Happy Path                                                                                     |
| **Priority**              | Medium                                                                                         |
| **Preconditions**         | User can read source message and post to `targetConversationId`                                |
| **Request Payload**       | `{ messageId, targetConversationId, clientMessageId, conversationType:"private", receiverId }` |
| **Expected Response**     | Ack success with new forwarded `messageId`                                                     |
| **Expected DB Changes**   | New message in target conversation flagged forwarded                                           |
| **Expected Socket/Event** | `message:new` (with `isForwarded`) to `conv:<targetId>`; `conv:updated` to participants        |
| **Notes**                 | `senderId=userId`; `receiverId`/`senderName`/`senderAvatar` default to `""`.                   |

### TC-WS-051 — message:react toggle/add

| Field                     | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat reactions                                                   |
| **API/Event Name**        | `client→server: message:react`                                               |
| **Test Scenario**         | Happy path — add a reaction emoji to a message                               |
| **Category**              | Happy Path                                                                   |
| **Priority**              | Medium                                                                       |
| **Preconditions**         | In `conv:<id>`; valid `messageId`                                            |
| **Request Payload**       | `{ messageId, conversationId, emoji:"👍" }`                                  |
| **Expected Response**     | Ack `{ success:true, data:{ messageId, reactions:[{ userId, emoji }] } }`    |
| **Expected DB Changes**   | Reaction upserted/toggled in chat-service                                    |
| **Expected Socket/Event** | `message:reaction` to `conv:<id>` with the **full current** reaction set     |
| **Notes**                 | Toggling the same emoji again removes it (toggle semantics in chat-service). |

### TC-WS-052 — message:react empty emoji string

| Field                     | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat reactions                                                                               |
| **API/Event Name**        | `client→server: message:react`                                                                           |
| **Test Scenario**         | Input validation — `emoji` is empty string                                                               |
| **Category**              | Input Validation                                                                                         |
| **Priority**              | Low                                                                                                      |
| **Preconditions**         | Connected                                                                                                |
| **Request Payload**       | `{ messageId, conversationId, emoji:"" }`                                                                |
| **Expected Response**     | Ack success at gateway (schema is `z.string()` with no `min`); chat-service may reject → `SERVICE_ERROR` |
| **Expected DB Changes**   | Depends on chat-service validation                                                                       |
| **Expected Socket/Event** | None if rejected downstream                                                                              |
| **Notes**                 | Note: `MessageReactSchema.emoji` lacks `.min(1)`, so empty passes gateway validation — possible gap.     |

### TC-WS-053 — message:reactions:get lists who reacted

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat reactions                                        |
| **API/Event Name**        | `client→server: message:reactions:get`                            |
| **Test Scenario**         | Happy path — fetch detailed reaction user list                    |
| **Category**              | Happy Path                                                        |
| **Priority**              | Low                                                               |
| **Preconditions**         | In `conv:<id>`; valid `messageId`                                 |
| **Request Payload**       | `{ messageId, conversationId, conversationType:"private" }`       |
| **Expected Response**     | Ack `{ success:true, data:{ reactions:[{ emoji, userId, … }] } }` |
| **Expected DB Changes**   | None (read)                                                       |
| **Expected Socket/Event** | None (direct ack only)                                            |
| **Notes**                 | `requesterId=userId`.                                             |

### TC-WS-054 — message:delete broadcast (forEveryone / forMe)

| Field                     | Value                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                                                                                                        |
| **API/Event Name**        | `server→client: message:delete`                                                                                                                                                   |
| **Test Scenario**         | DB state — a delete performed (via REST or service) fans out to the room                                                                                                          |
| **Category**              | DB State                                                                                                                                                                          |
| **Priority**              | Medium                                                                                                                                                                            |
| **Preconditions**         | Message deleted in chat-service which publishes to `conv:<roomId>`                                                                                                                |
| **Request Payload**       | n/a (server-originated)                                                                                                                                                           |
| **Expected Response**     | n/a                                                                                                                                                                               |
| **Expected DB Changes**   | Message tombstoned (`forEveryone`) or per-user hidden (`forMe`)                                                                                                                   |
| **Expected Socket/Event** | `message:delete` to `conv:<roomId>` `{ messageId, type:"forEveryone"\|"forMe", deletedBy }`. Community deletes are also published to `conv:<roomId>` (not the community channel). |
| **Notes**                 | Client rule: `forEveryone` hide for all; `forMe` hide only when `deletedBy === myUserId`.                                                                                         |

### TC-WS-055 — messages:fetch cursor pagination

| Field                     | Value                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat history                                                                                    |
| **API/Event Name**        | `client→server: messages:fetch`                                                                             |
| **Test Scenario**         | Pagination — cursor-paged history, `limit ≤ 100`                                                            |
| **Category**              | Pagination/Filter/Sort                                                                                      |
| **Priority**              | Medium                                                                                                      |
| **Preconditions**         | Conversation with > limit messages                                                                          |
| **Request Payload**       | `{ conversationId, cursor?, limit:50, conversationType:"private" }`                                         |
| **Expected Response**     | Ack `{ success:true, data:{ messages:[…], nextCursor } }`                                                   |
| **Expected DB Changes**   | None (read)                                                                                                 |
| **Expected Socket/Event** | None                                                                                                        |
| **Notes**                 | `limit` capped at 100 by schema (`.max(100)`). `requesterId=userId` used for authorization in chat-service. |

### TC-WS-056 — messages:fetch limit over 100 → INVALID_PAYLOAD

| Field                     | Value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat history                                                                |
| **API/Event Name**        | `client→server: messages:fetch`                                                         |
| **Test Scenario**         | Input validation — `limit:101` exceeds cap                                              |
| **Category**              | Input Validation                                                                        |
| **Priority**              | Low                                                                                     |
| **Preconditions**         | Connected                                                                               |
| **Request Payload**       | `{ conversationId, limit:101 }`                                                         |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }`                                        |
| **Expected DB Changes**   | None                                                                                    |
| **Expected Socket/Event** | None                                                                                    |
| **Notes**                 | Same cap on `community:messages:fetch` (100) and `chat:catchup` per-room `limit` (200). |

### TC-WS-057 — Emit message:send before joining conv room

| Field                     | Value                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Chat messaging                                                                                                                                        |
| **API/Event Name**        | `client→server: message:send`                                                                                                                                     |
| **Test Scenario**         | Edge — send without having emitted `conv:join`                                                                                                                    |
| **Category**              | Edge Case                                                                                                                                                         |
| **Priority**              | Medium                                                                                                                                                            |
| **Preconditions**         | Connected but not in `conv:<id>`                                                                                                                                  |
| **Request Payload**       | valid `message:send`                                                                                                                                              |
| **Expected Response**     | Ack success — message is persisted regardless of room membership                                                                                                  |
| **Expected DB Changes**   | Message created; `message:new` published to `conv:<id>`                                                                                                           |
| **Expected Socket/Event** | The **sender** does NOT receive its own `message:new` (not in the room), but gets `conv:updated` on `user:<id>`. Other in-room participants receive `message:new` |
| **Notes**                 | Sending does not require joining; receiving in-room broadcasts does. Sender should optimistically render from the ack.                                            |
