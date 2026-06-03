# Private Chat — Read & Delivery Receipts

> **Source:** socket `message:read` / `message:delivered` (`/chat` §4.1, §4.2, §7.1),
> `services/private-message.service.ts#markRead` / `markDelivered`,
> `repositories/private-message.repository.ts` (`markReadUpTo`, `markDeliveredUpTo`),
> `validators/private-message.validator.ts#markReadSchema`.

> **Transport note:** read/delivery receipts are **socket-only** events, not REST. `message:read`
> and `message:delivered` are emitted by the recipient and fan out to `conv:<id>`.

---

### TC-PCHAT-070 — Mark read up to message (happy path)

| Field                     | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Read Receipts                                                 |
| **API/Event Name**        | `message:read` (`/chat`)                                                     |
| **Test Scenario**         | B reads up to a message in room with A                                       |
| **Category**              | Happy Path                                                                   |
| **Priority**              | High                                                                         |
| **Preconditions**         | B is a participant; message exists                                           |
| **Request Payload**       | `{ conversationId, upToMessageId }`                                          |
| **Expected Response**     | ack `{ success:true }`                                                       |
| **Expected DB Changes**   | Room read cursor for B advanced (`markReadUpTo`); unread count for B reset   |
| **Expected Socket/Event** | `message:read` → `conv:<id>` `{ conversationId, readerId:B, upToMessageId }` |
| **Notes**                 | Sender A sees read indicator                                                 |

### TC-PCHAT-071 — Mark delivered up to message

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Delivery Receipts                                                                   |
| **API/Event Name**        | `message:delivered` (`/chat`)                                                                      |
| **Test Scenario**         | B's client confirms delivery on receiving message:new                                              |
| **Category**              | Happy Path                                                                                         |
| **Priority**              | Medium                                                                                             |
| **Preconditions**         | B participant                                                                                      |
| **Request Payload**       | `{ conversationId, upToMessageId }`                                                                |
| **Expected Response**     | ack `{ success:true }`                                                                             |
| **Expected DB Changes**   | Messages up to id flagged delivered for B (`markDeliveredUpTo` returns count + ids)                |
| **Expected Socket/Event** | `message:delivered` → `conv:<id>` `{ conversationId, recipientId:B, upToMessageId, messageIds[] }` |
| **Notes**                 | Private only (no group delivery receipts)                                                          |

### TC-PCHAT-072 — Mark read missing fields (validation)

| Field                     | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Read Receipts                                            |
| **API/Event Name**        | `message:read` (`/chat`)                                                |
| **Test Scenario**         | Missing `upToMessageId`                                                 |
| **Category**              | Input Validation                                                        |
| **Priority**              | Medium                                                                  |
| **Preconditions**         | —                                                                       |
| **Request Payload**       | `{ conversationId }`                                                    |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }`                        |
| **Expected DB Changes**   | None                                                                    |
| **Expected Socket/Event** | None                                                                    |
| **Notes**                 | `markReadSchema` requires receiverId, roomId, lastMessageId server-side |

### TC-PCHAT-073 — Mark read by non-participant

| Field                     | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Read Receipts                                                                   |
| **API/Event Name**        | `message:read` (`/chat`)                                                                       |
| **Test Scenario**         | C (not in room) marks read                                                                     |
| **Category**              | AuthZ / Security                                                                               |
| **Priority**              | High                                                                                           |
| **Preconditions**         | C authed, not participant                                                                      |
| **Request Payload**       | `{ conversationId:<A,B>, upToMessageId }`                                                      |
| **Expected Response**     | Expected no-op/error — **GAP:** `markRead` does not verify participation; verify gateway authz |
| **Expected DB Changes**   | Should be none                                                                                 |
| **Expected Socket/Event** | Spurious `message:read` if unguarded                                                           |
| **Notes**                 | File participation-check gap on receipt path                                                   |

### TC-PCHAT-074 — Mark read unauthenticated

| Field                     | Value                                |
| ------------------------- | ------------------------------------ |
| **Feature/Module**        | Private Chat / Read Receipts         |
| **API/Event Name**        | `message:read` (`/chat`)             |
| **Test Scenario**         | No socket auth                       |
| **Category**              | AuthN                                |
| **Priority**              | High                                 |
| **Preconditions**         | —                                    |
| **Request Payload**       | —                                    |
| **Expected Response**     | `connect_error` — handler never runs |
| **Expected DB Changes**   | None                                 |
| **Expected Socket/Event** | None                                 |
| **Notes**                 | —                                    |

### TC-PCHAT-075 — Mark read to a message not in this room

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Read Receipts                                  |
| **API/Event Name**        | `message:read` (`/chat`)                                      |
| **Test Scenario**         | `upToMessageId` belongs to a different room                   |
| **Category**              | Edge Case                                                     |
| **Priority**              | Low                                                           |
| **Preconditions**         | —                                                             |
| **Request Payload**       | mismatched ids                                                |
| **Expected Response**     | ack success but no rows updated (scoped by roomId)            |
| **Expected DB Changes**   | None                                                          |
| **Expected Socket/Event** | `message:read` may still emit — verify it is scoped to roomId |
| **Notes**                 | `markReadUpTo` filters by roomId                              |

### TC-PCHAT-076 — Simultaneous read receipts (concurrency)

| Field                     | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Read Receipts                                    |
| **API/Event Name**        | `message:read` (`/chat`) x2                                     |
| **Test Scenario**         | B emits read for two ids near-simultaneously                    |
| **Category**              | Concurrency                                                     |
| **Priority**              | Low                                                             |
| **Preconditions**         | B participant                                                   |
| **Request Payload**       | two reads                                                       |
| **Expected Response**     | both ack success                                                |
| **Expected DB Changes**   | Cursor advances monotonically (higher id wins); never regresses |
| **Expected Socket/Event** | Two `message:read` emits                                        |
| **Notes**                 | Verify "up to" cursor cannot move backwards                     |

### TC-PCHAT-077 — Read receipt resets unread count

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Read Receipts                                                |
| **API/Event Name**        | `message:read` (`/chat`)                                                    |
| **Test Scenario**         | B had unread N, marks read                                                  |
| **Category**              | DB State                                                                    |
| **Priority**              | Medium                                                                      |
| **Preconditions**         | B has unread messages                                                       |
| **Request Payload**       | `{ conversationId, upToMessageId:<latest> }`                                |
| **Expected Response**     | ack success                                                                 |
| **Expected DB Changes**   | B's unread counter for the room reset to 0                                  |
| **Expected Socket/Event** | `message:read`; subsequent inbox/`conv:updated` reflects unread:false for B |
| **Notes**                 | Cross-check unread-counts.md                                                |
