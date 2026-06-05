# WebSocket — /community Namespace

Many-member community chat. Served by chat-service's `CommunityService` over
gRPC. Sends persist via `CommunityMessageService` and publish
`community:message:new` to Redis channel `community:<communityId>`, which the
gateway re-emits to the `community:<communityId>` room. The namespace forwards
**any** event published to that channel verbatim. Note: community message
**deletes** are emitted as `message:delete` on the `conv:<roomId>` channel (on
`/chat`), not on the community channel.

**Source:** `apps/api-gateway/src/sockets/namespaces/community.ns.ts`,
`docs/SOCKET_EVENTS.md` §5.

---

### TC-WS-120 — community:message:send happy path

| Field                     | Value                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                                                                                                                                                                                                                    |
| **API/Event Name**        | `client→server: community:message:send`                                                                                                                                                                                                                       |
| **Test Scenario**         | Happy path — post a text message to a community room                                                                                                                                                                                                          |
| **Category**              | Happy Path                                                                                                                                                                                                                                                    |
| **Priority**              | High                                                                                                                                                                                                                                                          |
| **Preconditions**         | User is an active community member; joined `community:<id>`                                                                                                                                                                                                   |
| **Request Payload**       | `{ communityId, roomId, clientMessageId, message:"hi all", contentType:"TEXT" }`                                                                                                                                                                              |
| **Expected Response**     | Ack `{ success:true, data:{ messageId, sentAt(stringified int64), … } }`                                                                                                                                                                                      |
| **Expected DB Changes**   | Community message persisted via `CommunityMessageService`                                                                                                                                                                                                     |
| **Expected Socket/Event** | `community:message:new` to `community:<communityId>` `{ messageId, communityId, roomId, senderId, senderName, senderAvatar, message, contentType, mediaKey, clientMessageId, sentAt(number) }`; `community:updated` to active members' `user:<id>` on `/chat` |
| **Notes**                 | `senderId` forced to authed user. Mandatory callback (non-optional) — emitting without an ack fn would throw a client-side TypeError on response.                                                                                                             |

### TC-WS-121 — community:message:send with mediaKey

| Field                     | Value                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                                                                                                                                          |
| **API/Event Name**        | `client→server: community:message:send`                                                                                                                                             |
| **Test Scenario**         | File upload — image message via `mediaKey`                                                                                                                                          |
| **Category**              | File Upload                                                                                                                                                                         |
| **Priority**              | Medium                                                                                                                                                                              |
| **Preconditions**         | `mediaKey` already uploaded                                                                                                                                                         |
| **Request Payload**       | `{ communityId, roomId, clientMessageId, message:"", contentType:"IMAGE", mediaKey:"<key>" }`                                                                                       |
| **Expected Response**     | Ack success                                                                                                                                                                         |
| **Expected DB Changes**   | Message stored referencing `mediaKey`                                                                                                                                               |
| **Expected Socket/Event** | `community:message:new` carries `mediaKey`                                                                                                                                          |
| **Notes**                 | Note: `message` requires `min(1)` — a pure-media message must still send a non-empty `message` string (potential UX constraint / possible gap vs. chat ns which allows empty text). |

### TC-WS-122 — community:message:send empty message → INVALID_PAYLOAD

| Field                     | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                                 |
| **API/Event Name**        | `client→server: community:message:send`                                    |
| **Test Scenario**         | Input validation — `message:""`                                            |
| **Category**              | Input Validation                                                           |
| **Priority**              | Medium                                                                     |
| **Preconditions**         | Connected `/community`                                                     |
| **Request Payload**       | `{ communityId, roomId, clientMessageId, message:"", contentType:"TEXT" }` |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }`                           |
| **Expected DB Changes**   | None                                                                       |
| **Expected Socket/Event** | None                                                                       |
| **Notes**                 | `CommunityMsgSendSchema.message` is `string().min(1)`.                     |

### TC-WS-123 — community:message:send missing roomId → INVALID_PAYLOAD

| Field                     | Value                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                                            |
| **API/Event Name**        | `client→server: community:message:send`                                               |
| **Test Scenario**         | Input validation — required field missing                                             |
| **Category**              | Input Validation                                                                      |
| **Priority**              | Medium                                                                                |
| **Preconditions**         | Connected                                                                             |
| **Request Payload**       | `{ communityId, clientMessageId, message:"x", contentType:"TEXT" }`                   |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }`                                      |
| **Expected DB Changes**   | None                                                                                  |
| **Expected Socket/Event** | None                                                                                  |
| **Notes**                 | All of `communityId`, `roomId`, `clientMessageId`, `message`, `contentType` required. |

### TC-WS-124 — AuthZ: send to a community you're not a member of

| Field                     | Value                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                                                |
| **API/Event Name**        | `client→server: community:message:send`                                                   |
| **Test Scenario**         | AuthZ — non-member posts to a community                                                   |
| **Category**              | AuthZ                                                                                     |
| **Priority**              | High                                                                                      |
| **Preconditions**         | User not a member of `communityId`                                                        |
| **Request Payload**       | valid send payload for a foreign community                                                |
| **Expected Response**     | Ack `{ success:false, error:"SERVICE_ERROR" }` (chat-service rejects non-member)          |
| **Expected DB Changes**   | None                                                                                      |
| **Expected Socket/Event** | None                                                                                      |
| **Notes**                 | Authorization enforced server-side via `senderId`; gateway does not pre-check membership. |

### TC-WS-125 — community:message:send spoof senderId ignored

| Field                     | Value                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                                                            |
| **API/Event Name**        | `client→server: community:message:send`                                                               |
| **Test Scenario**         | Security — payload includes a foreign `senderId`                                                      |
| **Category**              | Security                                                                                              |
| **Priority**              | High                                                                                                  |
| **Preconditions**         | Connected as A                                                                                        |
| **Request Payload**       | `{ …, senderId:"<B>" }`                                                                               |
| **Expected Response**     | Ack success but stored with `senderId:A`                                                              |
| **Expected DB Changes**   | Message authored by A                                                                                 |
| **Expected Socket/Event** | `community:message:new { senderId:A }`                                                                |
| **Notes**                 | Gateway does `{ ...r.data, senderId: userId }`; schema has no `senderId` so it's stripped regardless. |

### TC-WS-126 — community:messages:fetch pagination

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                          |
| **API/Event Name**        | `client→server: community:messages:fetch`                           |
| **Test Scenario**         | Pagination — cursor-paged community history                         |
| **Category**              | Pagination/Filter/Sort                                              |
| **Priority**              | Medium                                                              |
| **Preconditions**         | Member of community room                                            |
| **Request Payload**       | `{ roomId, cursor?, limit:50 }`                                     |
| **Expected Response**     | Ack `{ success:true, data:{ messages, nextCursor } }`               |
| **Expected DB Changes**   | None (read)                                                         |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | `limit` capped at 100; `requesterId=userId` used for authorization. |

### TC-WS-127 — community:member:joined broadcast

| Field                     | Value                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                                               |
| **API/Event Name**        | `server→client: community:member:joined`                                                 |
| **Test Scenario**         | DB state — a member joins; room is notified                                              |
| **Category**              | DB State                                                                                 |
| **Priority**              | Low                                                                                      |
| **Preconditions**         | Member join occurs in community-service/chat-service which publishes to `community:<id>` |
| **Request Payload**       | n/a                                                                                      |
| **Expected Response**     | n/a                                                                                      |
| **Expected DB Changes**   | Membership row added                                                                     |
| **Expected Socket/Event** | `community:member:joined` (member DTO) to `community:<communityId>`                      |
| **Notes**                 | Forwarded verbatim from the Redis channel.                                               |

### TC-WS-128 — Verbatim forwarding of arbitrary community channel events

| Field                     | Value                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                                                                                                                                                                                 |
| **API/Event Name**        | `server→client: *` (Redis `community:*` forward)                                                                                                                                                                           |
| **Test Scenario**         | Edge — any `{ event, data }` published to `community:<id>` is re-emitted under that event name                                                                                                                             |
| **Category**              | Edge Case                                                                                                                                                                                                                  |
| **Priority**              | Low                                                                                                                                                                                                                        |
| **Preconditions**         | Backend publishes a non-contract event to `community:<id>`                                                                                                                                                                 |
| **Request Payload**       | n/a                                                                                                                                                                                                                        |
| **Expected Response**     | n/a                                                                                                                                                                                                                        |
| **Expected DB Changes**   | n/a                                                                                                                                                                                                                        |
| **Expected Socket/Event** | Gateway emits `parsed.event` with `parsed.data` to the room blindly (no allow-list of event names)                                                                                                                         |
| **Notes**                 | Security consideration: the namespace trusts whatever name backend services publish — a compromised publisher could emit arbitrary client events. Channel access is restricted to backend Redis, mitigating external risk. |

### TC-WS-129 — Community message delete arrives on /chat conv channel

| Field                     | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                                                               |
| **API/Event Name**        | `server→client: message:delete`                                                                          |
| **Test Scenario**         | Business rule — deleting a community message fans out on `conv:<roomId>` (`/chat`), not `community:<id>` |
| **Category**              | Business Rule                                                                                            |
| **Priority**              | Medium                                                                                                   |
| **Preconditions**         | Community message deleted; client listening on `/chat` `conv:<roomId>`                                   |
| **Request Payload**       | n/a                                                                                                      |
| **Expected Response**     | n/a                                                                                                      |
| **Expected DB Changes**   | Message tombstoned                                                                                       |
| **Expected Socket/Event** | `message:delete { messageId, type, deletedBy }` to `conv:<roomId>` on `/chat`                            |
| **Notes**                 | FE must also join `conv:<roomId>` on `/chat` to catch community deletes — a cross-namespace subtlety.    |

### TC-WS-130 — Malformed JSON on community channel is dropped, not crashed

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community chat                                        |
| **API/Event Name**        | Redis `pmessage` handler                                          |
| **Test Scenario**         | Error handling — non-JSON message published to `community:<id>`   |
| **Category**              | Error Handling                                                    |
| **Priority**              | Low                                                               |
| **Preconditions**         | Garbage payload on the channel                                    |
| **Request Payload**       | n/a                                                               |
| **Expected Response**     | n/a                                                               |
| **Expected DB Changes**   | None                                                              |
| **Expected Socket/Event** | Nothing emitted; gateway logs a parse-error warning and continues |
| **Notes**                 | `JSON.parse` in try/catch — resilient to bad publishes.           |
