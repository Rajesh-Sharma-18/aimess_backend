# Private Chat — Edit Message

> **Source:** `routes/private-message.routes.ts` (`PATCH /messages/:messageId`),
> `controllers/private-message.controller.ts#editMessage`,
> `validators/private-message.validator.ts#editMessageSchema`,
> `services/private-message.service.ts#editMessage`, `constants/media-limits.ts`
> (`CHAT_EDIT_WINDOW_MS = 15min`). Also `message:edit` socket event (`/chat` §4.1).

---

### TC-PCHAT-039 — Edit own text message (happy path)

| Field                     | Value                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Edit                                                                                    |
| **API/Event Name**        | `PATCH /messages/:messageId`                                                                           |
| **Test Scenario**         | Sender edits TEXT within the 15-min window                                                             |
| **Category**              | Happy Path                                                                                             |
| **Priority**              | High                                                                                                   |
| **Preconditions**         | A is sender; message TEXT; createdAt within 15 min; not deleted                                        |
| **Request Payload**       | `{ content:{ text:"updated", urls:[], files:[] } }`                                                    |
| **Expected Response**     | `200` `CHAT_MESSAGE_EDITED` `{ data:{ id, content, editedAt } }`                                       |
| **Expected DB Changes**   | `content` updated, `editedAt` set                                                                      |
| **Expected Socket/Event** | `message:edited` → `conv:<roomId>` `{ messageId, conversationId, contentText, contentJson, editedAt }` |
| **Notes**                 | Rate-limited by `sendLimit` (60/min)                                                                   |

### TC-PCHAT-040 — Edit not own message

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Private Chat / Edit                 |
| **API/Event Name**        | `PATCH /messages/:messageId`        |
| **Test Scenario**         | B tries to edit A's message         |
| **Category**              | AuthZ / Business Rule               |
| **Priority**              | High                                |
| **Preconditions**         | message.senderId = A; requester = B |
| **Request Payload**       | `{ content:{ text:"x" } }`          |
| **Expected Response**     | `400` `CHAT_EDIT_OWN_MESSAGES_ONLY` |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | Ownership compared by `senderId`    |

### TC-PCHAT-041 — Edit after window expired (>15 min)

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Private Chat / Edit                   |
| **API/Event Name**        | `PATCH /messages/:messageId`          |
| **Test Scenario**         | Edit a message older than 15 minutes  |
| **Category**              | Business Rule                         |
| **Priority**              | High                                  |
| **Preconditions**         | createdAt > 15 min ago                |
| **Request Payload**       | `{ content:{ text:"late" } }`         |
| **Expected Response**     | `410` Gone `CHAT_EDIT_WINDOW_EXPIRED` |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |
| **Notes**                 | `CHAT_EDIT_WINDOW_MS = 15*60*1000`    |

### TC-PCHAT-042 — Edit non-TEXT message

| Field                     | Value                            |
| ------------------------- | -------------------------------- |
| **Feature/Module**        | Private Chat / Edit              |
| **API/Event Name**        | `PATCH /messages/:messageId`     |
| **Test Scenario**         | Edit an IMAGE/VOICE/etc. message |
| **Category**              | Business Rule                    |
| **Priority**              | Medium                           |
| **Preconditions**         | messageType != TEXT              |
| **Request Payload**       | `{ content:{ text:"x" } }`       |
| **Expected Response**     | `400` `CHAT_EDIT_TEXT_ONLY`      |
| **Expected DB Changes**   | None                             |
| **Expected Socket/Event** | None                             |
| **Notes**                 | Only text messages editable      |

### TC-PCHAT-043 — Edit deleted message

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Private Chat / Edit                         |
| **API/Event Name**        | `PATCH /messages/:messageId`                |
| **Test Scenario**         | Edit a message already deleted-for-everyone |
| **Category**              | Business Rule                               |
| **Priority**              | Medium                                      |
| **Preconditions**         | message.isDeleted = true                    |
| **Request Payload**       | `{ content:{ text:"x" } }`                  |
| **Expected Response**     | `400` `CHAT_MESSAGE_ALREADY_DELETED`        |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | Checked before ownership/window             |

### TC-PCHAT-044 — Edit non-existent message

| Field                     | Value                          |
| ------------------------- | ------------------------------ |
| **Feature/Module**        | Private Chat / Edit            |
| **API/Event Name**        | `PATCH /messages/:messageId`   |
| **Test Scenario**         | Unknown messageId              |
| **Category**              | Error Handling                 |
| **Priority**              | Medium                         |
| **Preconditions**         | —                              |
| **Request Payload**       | `{ content:{ text:"x" } }`     |
| **Expected Response**     | `404` `CHAT_MESSAGE_NOT_FOUND` |
| **Expected DB Changes**   | None                           |
| **Expected Socket/Event** | None                           |
| **Notes**                 | —                              |

### TC-PCHAT-045 — Edit with empty text (validation)

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Private Chat / Edit                              |
| **API/Event Name**        | `PATCH /messages/:messageId`                     |
| **Test Scenario**         | `content.text` empty string                      |
| **Category**              | Input Validation                                 |
| **Priority**              | Medium                                           |
| **Preconditions**         | —                                                |
| **Request Payload**       | `{ content:{ text:"" } }`                        |
| **Expected Response**     | `400` (editMessageSchema requires text `min(1)`) |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | Edit requires non-empty text unlike send         |

### TC-PCHAT-046 — Edit text too long

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Private Chat / Edit                            |
| **API/Event Name**        | `PATCH /messages/:messageId`                   |
| **Test Scenario**         | text > CHAT_TEXT_MAX_CHARS                     |
| **Category**              | Input Validation                               |
| **Priority**              | Low                                            |
| **Preconditions**         | —                                              |
| **Request Payload**       | `{ content:{ text:"<too long>" } }`            |
| **Expected Response**     | `400` (Zod max) / service `CHAT_TEXT_TOO_LONG` |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | Double guard (validator + service)             |

### TC-PCHAT-047 — Edit unauthenticated

| Field                     | Value                        |
| ------------------------- | ---------------------------- |
| **Feature/Module**        | Private Chat / Edit          |
| **API/Event Name**        | `PATCH /messages/:messageId` |
| **Test Scenario**         | No token                     |
| **Category**              | AuthN                        |
| **Priority**              | High                         |
| **Preconditions**         | —                            |
| **Request Payload**       | —                            |
| **Expected Response**     | `401`                        |
| **Expected DB Changes**   | None                         |
| **Expected Socket/Event** | None                         |
| **Notes**                 | —                            |

### TC-PCHAT-048 — Edit + delete race (concurrency)

| Field                     | Value                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Edit                                                                                                  |
| **API/Event Name**        | `PATCH /messages/:messageId` + `DELETE /messages/:messageId?type=forEveryone`                                        |
| **Test Scenario**         | Simultaneous edit and delete-for-everyone of same message                                                            |
| **Category**              | Concurrency                                                                                                          |
| **Priority**              | Medium                                                                                                               |
| **Preconditions**         | A owns message, within window                                                                                        |
| **Request Payload**       | parallel requests                                                                                                    |
| **Expected Response**     | One wins; the loser sees `CHAT_MESSAGE_ALREADY_DELETED` (if delete commits first) or edit on a tombstone is rejected |
| **Expected DB Changes**   | Final state consistent (isDeleted true if delete wins)                                                               |
| **Expected Socket/Event** | Whichever commits: `message:edited` or `message:delete`                                                              |
| **Notes**                 | GAP: no transactional lock; both read-then-write — verify last-writer behavior                                       |

### TC-PCHAT-049 — XSS in edited text

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Private Chat / Edit                                   |
| **API/Event Name**        | `PATCH /messages/:messageId`                          |
| **Test Scenario**         | Edit text to `<img src=x onerror=alert(1)>`           |
| **Category**              | Security                                              |
| **Priority**              | Medium                                                |
| **Preconditions**         | A owns message                                        |
| **Request Payload**       | `{ content:{ text:"<img src=x onerror=alert(1)>" } }` |
| **Expected Response**     | `200` stored verbatim                                 |
| **Expected DB Changes**   | Raw text persisted                                    |
| **Expected Socket/Event** | `message:edited` with raw text                        |
| **Notes**                 | No server sanitization — client must escape           |
