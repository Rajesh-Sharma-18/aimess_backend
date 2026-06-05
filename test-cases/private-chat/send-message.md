# Private Chat — Send Message

> **Source:** `apps/api-gateway/src/sockets/` (`/chat` namespace, `message:send`) → gRPC →
> `apps/chat-service/src/services/private-message.service.ts#sendMessage`,
> `private-message.validator.ts#sendPrivateMessageSchema`,
> `constants/media-limits.ts`, `docs/SOCKET_EVENTS.md` §4.1.

> **Transport note:** 1:1 message _creation_ is **not a REST endpoint**. It is the Socket.IO
> `message:send` event on the `/chat` namespace (gateway validates → calls chat-service
> `sendMessage` over gRPC → persists → publishes `message:new` + `conv:updated`). REST under
> `/api/v1/chat/private` only covers list/edit/delete/forward/report/reactions/media. Test cases
> below exercise the socket send path and its service-layer rules.

---

### TC-PCHAT-001 — Send a text message (happy path)

| Field                     | Value                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Send                                                                                                            |
| **API/Event Name**        | `message:send` (`/chat`)                                                                                                       |
| **Test Scenario**         | Friends A→B send TEXT with a fresh `clientMessageId`                                                                           |
| **Category**              | Happy Path                                                                                                                     |
| **Priority**              | High                                                                                                                           |
| **Preconditions**         | A and B are friends; room exists or `receiverId` set; A joined `conv:<id>`                                                     |
| **Request Payload**       | `{ conversationId, clientMessageId:"c1", contentType:"TEXT", contentText:"hi", conversationType:"private", receiverId:"<B>" }` |
| **Expected Response**     | ack `{ success:true, data:{ messageId, sequenceNumber, sentAt } }`                                                             |
| **Expected DB Changes**   | New `PrivateMessage` (content, senderId=A, receiverId=B, monotonic `sequenceNumber`); room `lastMessage*` updated              |
| **Expected Socket/Event** | `message:new` → `conv:<id>` (to A & B in room); `conv:updated` → `user:<A>` (unread:false) & `user:<B>` (unread:true)          |
| **Notes**                 | `sentAt` on ack is a **stringified** epoch-ms; on broadcast a plain number                                                     |

### TC-PCHAT-002 — Send with reply (parentMessageId / repliedToId)

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Send                                                                  |
| **API/Event Name**        | `message:send` (`/chat`)                                                             |
| **Test Scenario**         | Reply to an existing message; quote snapshot attached                                |
| **Category**              | Happy Path                                                                           |
| **Priority**              | Medium                                                                               |
| **Preconditions**         | Parent message exists in room                                                        |
| **Request Payload**       | `{ …, repliedToId:"<parentId>", contentText:"re" }`                                  |
| **Expected Response**     | ack `{ success:true, data:{ messageId } }`                                           |
| **Expected DB Changes**   | Message persisted with `parentMessageId` set and `quoteData:{ message, senderName }` |
| **Expected Socket/Event** | `message:new` → `conv:<id>`; `conv:updated` → participants                           |
| **Notes**                 | `quoteData.senderName` resolved from user snapshot; empty if parent missing content  |

### TC-PCHAT-003 — Idempotent re-send (same clientMessageId)

| Field                     | Value                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                                                     |
| **API/Event Name**        | `message:send` (`/chat`)                                                                                |
| **Test Scenario**         | Re-emit identical `clientMessageId` after first succeeds                                                |
| **Category**              | Concurrency                                                                                             |
| **Priority**              | High                                                                                                    |
| **Preconditions**         | A message with `clientMessageId="c1"` already exists for (roomId, sender)                               |
| **Request Payload**       | `{ …, clientMessageId:"c1" }` (repeat)                                                                  |
| **Expected Response**     | ack `{ success:true, data:{ messageId:<same id> } }`                                                    |
| **Expected DB Changes**   | **No** new row; existing message returned; **no** new `sequenceNumber` allocated                        |
| **Expected Socket/Event** | Implementation returns existing message — no duplicate persist; re-broadcast may occur at gateway layer |
| **Notes**                 | Seq is allocated _after_ the idempotency pre-check so retries never burn a seq                          |

### TC-PCHAT-004 — Send blocked: not friends (friendship gate)

| Field                     | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                                             |
| **API/Event Name**        | `message:send` (`/chat`)                                                                        |
| **Test Scenario**         | A and B are not friends                                                                         |
| **Category**              | Business Rule                                                                                   |
| **Priority**              | High                                                                                            |
| **Preconditions**         | `userServiceClient.checkFriendship(A,B)` returns false                                          |
| **Request Payload**       | valid TEXT payload                                                                              |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }` (service throws `CHAT_FRIENDSHIP_REQUIRED`, 403) |
| **Expected DB Changes**   | None                                                                                            |
| **Expected Socket/Event** | None                                                                                            |
| **Notes**                 | Friendship gate is **active** via gRPC to user-service; see memory `friendship_gate_rewire`     |

### TC-PCHAT-005 — Send with attachments (IMAGE) — happy path

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                           |
| **API/Event Name**        | `message:send` (`/chat`)                                                      |
| **Test Scenario**         | IMAGE message with 1–10 files referencing committed objectKeys                |
| **Category**              | File Upload                                                                   |
| **Priority**              | High                                                                          |
| **Preconditions**         | Files uploaded via presign (see media-upload.md); A & B friends               |
| **Request Payload**       | `{ contentType:"IMAGE", files:[{ objectKey, mime:"image/png", size:1234 }] }` |
| **Expected Response**     | ack `{ success:true }`                                                        |
| **Expected DB Changes**   | Message persisted with `content.files[]`                                      |
| **Expected Socket/Event** | `message:new` (`contentType:"IMAGE"`); `conv:updated`                         |
| **Notes**                 | `assertAttachmentsValid` runs on the socket path (Zod validators don't)       |

### TC-PCHAT-006 — IMAGE count exceeds max (>10 files)

| Field                     | Value                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                               |
| **API/Event Name**        | `message:send` (`/chat`)                                                          |
| **Test Scenario**         | 11 image files in one IMAGE message                                               |
| **Category**              | File Upload                                                                       |
| **Priority**              | Medium                                                                            |
| **Preconditions**         | —                                                                                 |
| **Request Payload**       | `{ contentType:"IMAGE", files:[ …11 entries… ] }`                                 |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }` (`CHAT_IMAGE_COUNT_EXCEEDED`, 400) |
| **Expected DB Changes**   | None                                                                              |
| **Expected Socket/Event** | None                                                                              |
| **Notes**                 | `MEDIA_LIMITS.IMAGE.maxCount = 10`                                                |

### TC-PCHAT-007 — File too large (size > cap)

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                       |
| **API/Event Name**        | `message:send` (`/chat`)                                  |
| **Test Scenario**         | IMAGE/VOICE/GIF/DOC file `size` > `CHAT_UPLOAD_MAX_BYTES` |
| **Category**              | File Upload                                               |
| **Priority**              | Medium                                                    |
| **Preconditions**         | —                                                         |
| **Request Payload**       | `{ contentType:"IMAGE", files:[{ size: 999999999 }] }`    |
| **Expected Response**     | ack `{ success:false }` (`CHAT_FILE_TOO_LARGE`, 400)      |
| **Expected DB Changes**   | None                                                      |
| **Expected Socket/Event** | None                                                      |
| **Notes**                 | VIDEO uses a separate higher cap → `CHAT_VIDEO_TOO_LARGE` |

### TC-PCHAT-008 — VIDEO too long (duration > 180s)

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                 |
| **API/Event Name**        | `message:send` (`/chat`)                                            |
| **Test Scenario**         | VIDEO with `durationMs` > 180000                                    |
| **Category**              | File Upload                                                         |
| **Priority**              | Medium                                                              |
| **Preconditions**         | —                                                                   |
| **Request Payload**       | `{ contentType:"VIDEO", files:[{ durationMs:200000, size:1000 }] }` |
| **Expected Response**     | ack `{ success:false }` (`CHAT_VIDEO_TOO_LONG`, 400)                |
| **Expected DB Changes**   | None                                                                |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | `MEDIA_LIMITS.VIDEO.maxDurationMs = 180_000`                        |

### TC-PCHAT-009 — VOICE note too long (duration > 300s)

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                 |
| **API/Event Name**        | `message:send` (`/chat`)                                            |
| **Test Scenario**         | VOICE with `durationMs` > 300000                                    |
| **Category**              | File Upload                                                         |
| **Priority**              | Medium                                                              |
| **Preconditions**         | —                                                                   |
| **Request Payload**       | `{ contentType:"VOICE", files:[{ durationMs:301000, size:1000 }] }` |
| **Expected Response**     | ack `{ success:false }` (`CHAT_VOICE_TOO_LONG`, 400)                |
| **Expected DB Changes**   | None                                                                |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | `MEDIA_LIMITS.VOICE.maxDurationMs = 300_000`                        |

### TC-PCHAT-010 — Text too long (> CHAT_TEXT_MAX_CHARS)

| Field                     | Value                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                                                     |
| **API/Event Name**        | `message:send` (`/chat`)                                                                                |
| **Test Scenario**         | `contentText` longer than the configured max                                                            |
| **Category**              | Input Validation                                                                                        |
| **Priority**              | Medium                                                                                                  |
| **Preconditions**         | —                                                                                                       |
| **Request Payload**       | `{ contentText:"<very long string>" }`                                                                  |
| **Expected Response**     | ack `{ success:false }` (`CHAT_TEXT_TOO_LONG`, 400) — also rejected at Zod gateway as `INVALID_PAYLOAD` |
| **Expected DB Changes**   | None                                                                                                    |
| **Expected Socket/Event** | None                                                                                                    |
| **Notes**                 | Defensive service guard mirrors validator (`CHAT_TEXT_MAX_CHARS`)                                       |

### TC-PCHAT-011 — Empty TEXT message (no text, no files)

| Field                     | Value                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                                                 |
| **API/Event Name**        | `message:send` (`/chat`)                                                                            |
| **Test Scenario**         | TEXT with empty `contentText` and no attachments                                                    |
| **Category**              | Edge Case                                                                                           |
| **Priority**              | Low                                                                                                 |
| **Preconditions**         | A & B friends                                                                                       |
| **Request Payload**       | `{ contentType:"TEXT", contentText:"" }`                                                            |
| **Expected Response**     | ack `{ success:true }` — `content.text` defaults to `""`; send is **not** blocked at service layer  |
| **Expected DB Changes**   | Empty-text message persisted                                                                        |
| **Expected Socket/Event** | `message:new` (empty text)                                                                          |
| **Notes**                 | GAP: no service-level non-empty-content guard; client should prevent. Document as observed behavior |

### TC-PCHAT-012 — Unauthenticated send (no JWT)

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Send                                                                              |
| **API/Event Name**        | `message:send` (`/chat`)                                                                         |
| **Test Scenario**         | Socket handshake without/invalid token                                                           |
| **Category**              | AuthN                                                                                            |
| **Priority**              | High                                                                                             |
| **Preconditions**         | —                                                                                                |
| **Request Payload**       | n/a (connection rejected)                                                                        |
| **Expected Response**     | `connect_error` `Authentication required` / `Authentication failed`; event never reaches handler |
| **Expected DB Changes**   | None                                                                                             |
| **Expected Socket/Event** | None                                                                                             |
| **Notes**                 | `senderId` always derived from token — client never supplies it                                  |

### TC-PCHAT-013 — Invalid contentType enum

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                   |
| **API/Event Name**        | `message:send` (`/chat`)                                              |
| **Test Scenario**         | `contentType:"GIBBERISH"`                                             |
| **Category**              | Input Validation                                                      |
| **Priority**              | Medium                                                                |
| **Preconditions**         | —                                                                     |
| **Request Payload**       | `{ contentType:"GIBBERISH" }`                                         |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }`                      |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | None                                                                  |
| **Notes**                 | Enum: TEXT/IMAGE/DOCUMENT/VIDEO/VOICE/SYSTEM/LOCATION/CONTACT/STICKER |

### TC-PCHAT-014 — Send flood / rate limit (socket)

| Field                     | Value                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                                                                        |
| **API/Event Name**        | `message:send` (`/chat`)                                                                                                   |
| **Test Scenario**         | Burst of sends from one user                                                                                               |
| **Category**              | Rate Limit                                                                                                                 |
| **Priority**              | Medium                                                                                                                     |
| **Preconditions**         | —                                                                                                                          |
| **Request Payload**       | many sends in <60s                                                                                                         |
| **Expected Response**     | gateway/socket throttling applies (verify gateway socket limiter); REST forward/edit/report paths use `pm:send` 60 req/60s |
| **Expected DB Changes**   | Capped                                                                                                                     |
| **Expected Socket/Event** | None beyond accepted sends                                                                                                 |
| **Notes**                 | GAP: confirm a per-socket send limiter exists on the gateway; REST `sendLimit` (60/min) covers forward/edit/report/delete  |

### TC-PCHAT-015 — XSS payload in contentText

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                                 |
| **API/Event Name**        | `message:send` (`/chat`)                                                            |
| **Test Scenario**         | `contentText:"<script>alert(1)</script>"`                                           |
| **Category**              | Security                                                                            |
| **Priority**              | High                                                                                |
| **Preconditions**         | A & B friends                                                                       |
| **Request Payload**       | `{ contentText:"<script>alert(1)</script>" }`                                       |
| **Expected Response**     | ack `{ success:true }` — stored verbatim (no server-side sanitization)              |
| **Expected DB Changes**   | Raw string persisted                                                                |
| **Expected Socket/Event** | `message:new` with raw text                                                         |
| **Notes**                 | Backend stores raw; **clients must escape on render**. Flag as security expectation |

### TC-PCHAT-016 — STICKER message (objectKey or url required)

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                                 |
| **API/Event Name**        | `message:send` (`/chat`)                                                            |
| **Test Scenario**         | STICKER with `{ packId, stickerId }` but no objectKey/url                           |
| **Category**              | Input Validation                                                                    |
| **Priority**              | Low                                                                                 |
| **Preconditions**         | —                                                                                   |
| **Request Payload**       | `{ contentType:"STICKER", content:{ sticker:{ packId:"p", stickerId:"s" } } }`      |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }` ("sticker needs objectKey or url") |
| **Expected DB Changes**   | None                                                                                |
| **Expected Socket/Event** | None                                                                                |
| **Notes**                 | `stickerSchema.refine` requires objectKey OR url                                    |

### TC-PCHAT-017 — LOCATION out of range (lat/lng)

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                         |
| **API/Event Name**        | `message:send` (`/chat`)                                    |
| **Test Scenario**         | LOCATION with lat=120 / lng=200                             |
| **Category**              | Input Validation                                            |
| **Priority**              | Low                                                         |
| **Preconditions**         | —                                                           |
| **Request Payload**       | `{ contentType:"LOCATION", location:{ lat:120, lng:200 } }` |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }`            |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | `locationSchema`: lat ∈ [-90,90], lng ∈ [-180,180]          |

### TC-PCHAT-018 — Message to self

| Field                     | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Send                                                                          |
| **API/Event Name**        | `message:send` (`/chat`)                                                                     |
| **Test Scenario**         | `receiverId === senderId`                                                                    |
| **Category**              | Edge Case                                                                                    |
| **Priority**              | Low                                                                                          |
| **Preconditions**         | —                                                                                            |
| **Request Payload**       | `{ receiverId:"<A>" }` from A                                                                |
| **Expected Response**     | `checkFriendship(A,A)` result governs — likely false → `CHAT_FRIENDSHIP_REQUIRED`            |
| **Expected DB Changes**   | None (if gated)                                                                              |
| **Expected Socket/Event** | None                                                                                         |
| **Notes**                 | GAP: no explicit self-send guard; behavior depends on user-service friendship check for self |
