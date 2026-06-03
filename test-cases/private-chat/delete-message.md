# Private Chat — Delete Message

> **Source:** `routes/private-message.routes.ts` (`DELETE /messages/:messageId`),
> `controllers/private-message.controller.ts#deleteMessage`,
> `validators/private-message.validator.ts#deleteMessageQuerySchema`,
> `services/private-message.service.ts#deleteForMe` / `deleteForEveryone`, `docs/SOCKET_EVENTS.md` §4.2.

---

### TC-PCHAT-050 — Delete for me (happy path)

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Delete                                                         |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forMe`                                      |
| **Test Scenario**         | A hides a message for themselves only                                         |
| **Category**              | Happy Path / DB State                                                         |
| **Priority**              | High                                                                          |
| **Preconditions**         | Message exists, not deleted, A hasn't already deleted-for-me                  |
| **Request Payload**       | query `type=forMe`                                                            |
| **Expected Response**     | `200` `{ data:{ id, roomId } }`                                               |
| **Expected DB Changes**   | `deletedFor[A]` flag set; message remains visible to peer                     |
| **Expected Socket/Event** | `message:delete` → `conv:<roomId>` `{ messageId, type:"forMe", deletedBy:A }` |
| **Notes**                 | Client rule: hide only if `deletedBy===myId`                                  |

### TC-PCHAT-051 — Delete for everyone (own message)

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Delete                                                               |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forEveryone`                                      |
| **Test Scenario**         | Sender deletes their message for both participants                                  |
| **Category**              | Happy Path / DB State                                                               |
| **Priority**              | High                                                                                |
| **Preconditions**         | A is sender; not already deleted                                                    |
| **Request Payload**       | query `type=forEveryone`                                                            |
| **Expected Response**     | `200` `{ data:{ id, roomId } }`                                                     |
| **Expected DB Changes**   | `isDeleted=true`, deletedBy recorded (tombstone)                                    |
| **Expected Socket/Event** | `message:delete` → `conv:<roomId>` `{ messageId, type:"forEveryone", deletedBy:A }` |
| **Notes**                 | Tombstone returned by `chat:catchup` for offline reconcile                          |

### TC-PCHAT-052 — Delete for everyone — not sender

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Private Chat / Delete                          |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forEveryone` |
| **Test Scenario**         | B tries to delete-for-everyone A's message     |
| **Category**              | AuthZ / Business Rule                          |
| **Priority**              | High                                           |
| **Preconditions**         | message.senderId=A; requester=B                |
| **Request Payload**       | `type=forEveryone`                             |
| **Expected Response**     | `400` `CHAT_DELETE_OWN_MESSAGES_ONLY`          |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | Only the sender may delete-for-everyone        |

### TC-PCHAT-053 — Delete-for-me twice

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Delete                                  |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forMe`               |
| **Test Scenario**         | A deletes-for-me a message they already deleted-for-me |
| **Category**              | Business Rule / Idempotency                            |
| **Priority**              | Medium                                                 |
| **Preconditions**         | `deletedFor[A]` already set                            |
| **Request Payload**       | `type=forMe`                                           |
| **Expected Response**     | `400` `CHAT_MESSAGE_ALREADY_DELETED`                   |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | `if (userId in deletedFor)` guard                      |

### TC-PCHAT-054 — Delete an already-deleted-for-everyone message

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Delete                                     |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forMe` (or forEveryone) |
| **Test Scenario**         | Target message has `isDeleted=true`                       |
| **Category**              | Business Rule                                             |
| **Priority**              | Medium                                                    |
| **Preconditions**         | message.isDeleted=true                                    |
| **Request Payload**       | any type                                                  |
| **Expected Response**     | `400` `CHAT_MESSAGE_ALREADY_DELETED`                      |
| **Expected DB Changes**   | None                                                      |
| **Expected Socket/Event** | None                                                      |
| **Notes**                 | Both paths short-circuit on `isDeleted`                   |

### TC-PCHAT-055 — Invalid type query value

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Delete                                     |
| **API/Event Name**        | `DELETE /messages/:messageId?type=foo`                    |
| **Test Scenario**         | type not in enum                                          |
| **Category**              | Input Validation                                          |
| **Priority**              | Medium                                                    |
| **Preconditions**         | —                                                         |
| **Request Payload**       | `type=foo`                                                |
| **Expected Response**     | `400` (`deleteMessageQuerySchema` enum forMe/forEveryone) |
| **Expected DB Changes**   | None                                                      |
| **Expected Socket/Event** | None                                                      |
| **Notes**                 | `type` is required                                        |

### TC-PCHAT-056 — Missing type query

| Field                     | Value                         |
| ------------------------- | ----------------------------- |
| **Feature/Module**        | Private Chat / Delete         |
| **API/Event Name**        | `DELETE /messages/:messageId` |
| **Test Scenario**         | No `type` param               |
| **Category**              | Required Params               |
| **Priority**              | Medium                        |
| **Preconditions**         | —                             |
| **Request Payload**       | none                          |
| **Expected Response**     | `400`                         |
| **Expected DB Changes**   | None                          |
| **Expected Socket/Event** | None                          |
| **Notes**                 | `type` has no default         |

### TC-PCHAT-057 — Delete non-existent message

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Private Chat / Delete                    |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forMe` |
| **Test Scenario**         | Unknown messageId                        |
| **Category**              | Error Handling                           |
| **Priority**              | Medium                                   |
| **Preconditions**         | —                                        |
| **Request Payload**       | `type=forMe`                             |
| **Expected Response**     | `404` `CHAT_MESSAGE_NOT_FOUND`           |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | —                                        |

### TC-PCHAT-058 — Delete unauthenticated

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Private Chat / Delete                    |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forMe` |
| **Test Scenario**         | No token                                 |
| **Category**              | AuthN                                    |
| **Priority**              | High                                     |
| **Preconditions**         | —                                        |
| **Request Payload**       | —                                        |
| **Expected Response**     | `401`                                    |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | —                                        |

### TC-PCHAT-059 — Delete IDOR (delete-for-everyone someone else's via non-participant)

| Field                     | Value                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Delete                                                                                                                                         |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forEveryone`                                                                                                                |
| **Test Scenario**         | User C (not in room) targets a message id                                                                                                                     |
| **Category**              | Security                                                                                                                                                      |
| **Priority**              | High                                                                                                                                                          |
| **Preconditions**         | C not sender, not participant                                                                                                                                 |
| **Request Payload**       | `type=forEveryone`                                                                                                                                            |
| **Expected Response**     | `400` `CHAT_DELETE_OWN_MESSAGES_ONLY` (sender check blocks); for `forMe` — **GAP:** no participant check, C could set `deletedFor[C]` on an unrelated message |
| **Expected DB Changes**   | None for forEveryone; forMe gap noted                                                                                                                         |
| **Expected Socket/Event** | None / spurious delete emit possible on forMe gap                                                                                                             |
| **Notes**                 | File the `deleteForMe` participant-check gap                                                                                                                  |

### TC-PCHAT-060 — Concurrent forEveryone by sender (double-delete race)

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Delete                                                                |
| **API/Event Name**        | `DELETE /messages/:messageId?type=forEveryone` x2                                    |
| **Test Scenario**         | Two simultaneous delete-for-everyone of same msg                                     |
| **Category**              | Concurrency                                                                          |
| **Priority**              | Low                                                                                  |
| **Preconditions**         | A is sender                                                                          |
| **Request Payload**       | parallel                                                                             |
| **Expected Response**     | One `200`; the other `400 CHAT_MESSAGE_ALREADY_DELETED` (or both 200 if race window) |
| **Expected DB Changes**   | Single tombstone                                                                     |
| **Expected Socket/Event** | At least one `message:delete` emit                                                   |
| **Notes**                 | Idempotent end-state                                                                 |
