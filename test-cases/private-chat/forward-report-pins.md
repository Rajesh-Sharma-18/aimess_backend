# Private Chat — Forward, Report, Pins

> **Source:** `routes/private-message.routes.ts`
> (`POST /rooms/:roomId/messages/:messageId/forward`, `POST /messages/:messageId/report`,
> `GET /rooms/:roomId/pins`), `controllers/private-message.controller.ts`,
> `services/private-message.service.ts` (`forwardMessage`, `reportMessage`),
> `services/private-pin.service.ts`, validators `forwardMessageSchema`, `reportMessageSchema`.

---

### TC-PCHAT-121 — Forward a message (happy path)

| Field                     | Value                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Forward                                                                        |
| **API/Event Name**        | `POST /rooms/:roomId/messages/:messageId/forward`                                             |
| **Test Scenario**         | A forwards a message into a target room with B                                                |
| **Category**              | Happy Path                                                                                    |
| **Priority**              | High                                                                                          |
| **Preconditions**         | Source message exists, not deleted; A & receiver friends                                      |
| **Request Payload**       | `{ targetRoomId, receiverId:"<B>", clientMessageId:"f1" }`                                    |
| **Expected Response**     | `201` `CHAT_MESSAGE_FORWARDED` `{ data:{ id, messageType } }`                                 |
| **Expected DB Changes**   | New forwarded message in targetRoom with `forwardData`; target room bumped                    |
| **Expected Socket/Event** | `message:new` → `conv:<targetRoomId>` `{ isForwarded:true }`; `conv:updated` to [A, receiver] |
| **Notes**                 | Rate-limited by `sendLimit`                                                                   |

### TC-PCHAT-122 — Forward blocked: not friends

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Private Chat / Forward                            |
| **API/Event Name**        | `POST /rooms/:roomId/messages/:messageId/forward` |
| **Test Scenario**         | A and receiver not friends                        |
| **Category**              | Business Rule                                     |
| **Priority**              | High                                              |
| **Preconditions**         | `checkFriendship(A,receiver)=false`               |
| **Request Payload**       | valid body                                        |
| **Expected Response**     | `403` `CHAT_FRIENDSHIP_REQUIRED`                  |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | Friendship gate on forward target                 |

### TC-PCHAT-123 — Forward idempotency (same clientMessageId)

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Private Chat / Forward                            |
| **API/Event Name**        | `POST /rooms/:roomId/messages/:messageId/forward` |
| **Test Scenario**         | Re-forward with same clientMessageId              |
| **Category**              | Concurrency                                       |
| **Priority**              | Medium                                            |
| **Preconditions**         | First forward succeeded                           |
| **Request Payload**       | repeat `{ clientMessageId:"f1" }`                 |
| **Expected Response**     | `201` returns existing message (no duplicate)     |
| **Expected DB Changes**   | No new row                                        |
| **Expected Socket/Event** | Re-broadcast possible; no second persist          |
| **Notes**                 | `findByClientMessageId` dedupe                    |

### TC-PCHAT-124 — Forward deleted/missing source

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Private Chat / Forward                            |
| **API/Event Name**        | `POST /rooms/:roomId/messages/:messageId/forward` |
| **Test Scenario**         | Source message deleted or non-existent            |
| **Category**              | Error Handling                                    |
| **Priority**              | Medium                                            |
| **Preconditions**         | source.isDeleted or unknown id                    |
| **Request Payload**       | valid body                                        |
| **Expected Response**     | `404` `CHAT_MESSAGE_NOT_FOUND`                    |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | Checked after friendship + idempotency            |

### TC-PCHAT-125 — Forward validation (missing targetRoomId/receiverId)

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Forward                                    |
| **API/Event Name**        | `POST /rooms/:roomId/messages/:messageId/forward`         |
| **Test Scenario**         | Missing required fields                                   |
| **Category**              | Required Params                                           |
| **Priority**              | Medium                                                    |
| **Preconditions**         | —                                                         |
| **Request Payload**       | `{ }`                                                     |
| **Expected Response**     | `400`                                                     |
| **Expected DB Changes**   | None                                                      |
| **Expected Socket/Event** | None                                                      |
| **Notes**                 | `forwardMessageSchema` requires targetRoomId + receiverId |

### TC-PCHAT-126 — Report a message (happy path)

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Report                                                              |
| **API/Event Name**        | `POST /messages/:messageId/report`                                                 |
| **Test Scenario**         | B reports A's message as SPAM                                                      |
| **Category**              | Happy Path                                                                         |
| **Priority**              | Medium                                                                             |
| **Preconditions**         | B is a participant; message by A                                                   |
| **Request Payload**       | `{ reason:"SPAM", description:"…" }`                                               |
| **Expected Response**     | `201` `CHAT_MESSAGE_REPORTED`                                                      |
| **Expected DB Changes**   | New `PrivateMessageReport` (roomId, messageId, reporterId, reportedUserId, reason) |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | reason enum SPAM/HARASSMENT/HATE_SPEECH/NUDITY/VIOLENCE/SCAM/OTHER                 |

### TC-PCHAT-127 — Report own message

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Private Chat / Report              |
| **API/Event Name**        | `POST /messages/:messageId/report` |
| **Test Scenario**         | A reports their own message        |
| **Category**              | Business Rule                      |
| **Priority**              | Medium                             |
| **Preconditions**         | message.senderId = reporter        |
| **Request Payload**       | `{ reason:"OTHER" }`               |
| **Expected Response**     | `400` `CHAT_REPORT_OWN_MESSAGE`    |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | —                                  |

### TC-PCHAT-128 — Report by non-participant

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| **Feature/Module**        | Private Chat / Report                      |
| **API/Event Name**        | `POST /messages/:messageId/report`         |
| **Test Scenario**         | C (not in room) reports a message          |
| **Category**              | AuthZ / Security                           |
| **Priority**              | High                                       |
| **Preconditions**         | C not a participant                        |
| **Request Payload**       | `{ reason:"SPAM" }`                        |
| **Expected Response**     | `403` `CHAT_REPORT_NOT_PARTICIPANT`        |
| **Expected DB Changes**   | None                                       |
| **Expected Socket/Event** | None                                       |
| **Notes**                 | Report path correctly checks participation |

### TC-PCHAT-129 — Duplicate report

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Private Chat / Report                               |
| **API/Event Name**        | `POST /messages/:messageId/report`                  |
| **Test Scenario**         | B reports the same message twice                    |
| **Category**              | Business Rule                                       |
| **Priority**              | Low                                                 |
| **Preconditions**         | A report already exists for (reporter, message)     |
| **Request Payload**       | `{ reason:"SPAM" }`                                 |
| **Expected Response**     | `400` `CHAT_ALREADY_REPORTED` (Prisma P2002 unique) |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | Unique constraint mapped to friendly code           |

### TC-PCHAT-130 — Report invalid reason

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Private Chat / Report              |
| **API/Event Name**        | `POST /messages/:messageId/report` |
| **Test Scenario**         | reason outside enum                |
| **Category**              | Input Validation                   |
| **Priority**              | Low                                |
| **Preconditions**         | —                                  |
| **Request Payload**       | `{ reason:"FOO" }`                 |
| **Expected Response**     | `400`                              |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | description ≤1000 chars, optional  |

### TC-PCHAT-131 — Report non-existent message

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Private Chat / Report              |
| **API/Event Name**        | `POST /messages/:messageId/report` |
| **Test Scenario**         | Unknown messageId                  |
| **Category**              | Error Handling                     |
| **Priority**              | Low                                |
| **Preconditions**         | —                                  |
| **Request Payload**       | `{ reason:"SPAM" }`                |
| **Expected Response**     | `404` `CHAT_MESSAGE_NOT_FOUND`     |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | —                                  |

### TC-PCHAT-132 — Get pins (happy path)

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Pins                                                  |
| **API/Event Name**        | `GET /rooms/:roomId/pins`                                            |
| **Test Scenario**         | List pinned messages in a room                                       |
| **Category**              | Happy Path                                                           |
| **Priority**              | Low                                                                  |
| **Preconditions**         | Room has pins                                                        |
| **Request Payload**       | query `limit`, `cursor`, `page` optional                             |
| **Expected Response**     | `200` paginated pins ordered by `pinnedAt`                           |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | GAP: pins GET does not assert participation — possible IDOR; file it |

### TC-PCHAT-133 — Get pins empty

| Field                     | Value                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Pins                                                                                                                                               |
| **API/Event Name**        | `GET /rooms/:roomId/pins`                                                                                                                                         |
| **Test Scenario**         | Room with no pins                                                                                                                                                 |
| **Category**              | Edge Case                                                                                                                                                         |
| **Priority**              | Low                                                                                                                                                               |
| **Preconditions**         | —                                                                                                                                                                 |
| **Request Payload**       | none                                                                                                                                                              |
| **Expected Response**     | `200` empty `CHAT_NO_PINS_FOUND`                                                                                                                                  |
| **Expected DB Changes**   | None                                                                                                                                                              |
| **Expected Socket/Event** | None                                                                                                                                                              |
| **Notes**                 | NOTE: pin/unpin write paths (`pinMessageSchema`/`unpinMessageSchema`) exist as validators but no REST route here — likely socket/other surface. Flag for coverage |
