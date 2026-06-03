# Private Chat — Reactions

> **Source:** `routes/private-message.routes.ts` (`GET /rooms/:roomId/messages/:messageId/reactions`),
> `controllers/private-message.controller.ts#getMessageReactions`,
> `services/private-message.service.ts#getMessageReactions` / `react`,
> `repositories/private-message.repository.ts#addReactions`,
> socket `message:react` / `message:reactions:get` / `message:reaction` (`/chat` §4.1, §7.3).

> **Note:** adding/removing a reaction is the **socket** `message:react` event (gateway applies the
> toggle, calls chat-service `react` which **replaces the full reactions map**). REST only exposes a
> **GET** of the current reaction set with resolved user details.

---

### TC-PCHAT-061 — Add reaction (happy path, socket)

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Reactions                                                         |
| **API/Event Name**        | `message:react` (`/chat`)                                                        |
| **Test Scenario**         | A reacts 👍 to a message                                                         |
| **Category**              | Happy Path                                                                       |
| **Priority**              | Medium                                                                           |
| **Preconditions**         | A is a participant; message exists                                               |
| **Request Payload**       | `{ messageId, conversationId, emoji:"👍" }`                                      |
| **Expected Response**     | ack `{ success:true, data:{ messageId, reactions:[{ userId:A, emoji:"👍" }] } }` |
| **Expected DB Changes**   | `reactions` map updated (full set written)                                       |
| **Expected Socket/Event** | `message:reaction` → `conv:<id>` with the FULL current reaction set              |
| **Notes**                 | Persisted as JSON map emoji→[userIds]; gateway computes toggle                   |

### TC-PCHAT-062 — Toggle: react twice with same emoji removes it

| Field                     | Value                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Reactions                                                                 |
| **API/Event Name**        | `message:react` (`/chat`)                                                                |
| **Test Scenario**         | A sends 👍 then 👍 again                                                                 |
| **Category**              | Business Rule                                                                            |
| **Priority**              | Medium                                                                                   |
| **Preconditions**         | A already reacted 👍                                                                     |
| **Request Payload**       | `{ messageId, conversationId, emoji:"👍" }`                                              |
| **Expected Response**     | ack `{ success:true }` with 👍 removed for A                                             |
| **Expected DB Changes**   | A removed from 👍 set; emoji key dropped if empty                                        |
| **Expected Socket/Event** | `message:reaction` full set (without A's 👍)                                             |
| **Notes**                 | "can't react twice" → second identical emit toggles OFF; verify gateway toggle semantics |

### TC-PCHAT-063 — Change reaction emoji

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Reactions                                    |
| **API/Event Name**        | `message:react` (`/chat`)                                   |
| **Test Scenario**         | A reacted 👍, now reacts ❤️                                 |
| **Category**              | Business Rule                                               |
| **Priority**              | Low                                                         |
| **Preconditions**         | A reacted 👍                                                |
| **Request Payload**       | `{ …, emoji:"❤️" }`                                         |
| **Expected Response**     | ack `{ success:true }`                                      |
| **Expected DB Changes**   | A under ❤️ (and removed from 👍 per gateway toggle policy)  |
| **Expected Socket/Event** | `message:reaction` full set                                 |
| **Notes**                 | Verify whether one-reaction-per-user is enforced at gateway |

### TC-PCHAT-064 — Get reactions with resolved users (happy path)

| Field                     | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Reactions                                                                       |
| **API/Event Name**        | `GET /rooms/:roomId/messages/:messageId/reactions`                                             |
| **Test Scenario**         | Fetch detailed reactor list                                                                    |
| **Category**              | Happy Path                                                                                     |
| **Priority**              | Medium                                                                                         |
| **Preconditions**         | Message has reactions                                                                          |
| **Request Payload**       | path params                                                                                    |
| **Expected Response**     | `200` `{ reactions:{ "👍":{ count, users:[{ userId, displayName, avatar }], selfReacted } } }` |
| **Expected DB Changes**   | None                                                                                           |
| **Expected Socket/Event** | None                                                                                           |
| **Notes**                 | `selfReacted` computed against requester; user snapshots resolved                              |

### TC-PCHAT-065 — Get reactions on message with none

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Private Chat / Reactions                           |
| **API/Event Name**        | `GET /rooms/:roomId/messages/:messageId/reactions` |
| **Test Scenario**         | Message exists but has no reactions                |
| **Category**              | Edge Case                                          |
| **Priority**              | Low                                                |
| **Preconditions**         | Message exists, reactions empty                    |
| **Request Payload**       | path params                                        |
| **Expected Response**     | `200` `{ reactions:{} }`                           |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | Empty map, no snapshot fetch                       |

### TC-PCHAT-066 — Get reactions on non-existent message

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Private Chat / Reactions                           |
| **API/Event Name**        | `GET /rooms/:roomId/messages/:messageId/reactions` |
| **Test Scenario**         | Unknown messageId                                  |
| **Category**              | Error Handling                                     |
| **Priority**              | Medium                                             |
| **Preconditions**         | —                                                  |
| **Request Payload**       | path params                                        |
| **Expected Response**     | `404` `CHAT_MESSAGE_NOT_FOUND`                     |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | `getReactions` returns null → NotFound             |

### TC-PCHAT-067 — Get reactions unauthenticated

| Field                     | Value                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Reactions                                                                                                            |
| **API/Event Name**        | `GET /rooms/:roomId/messages/:messageId/reactions`                                                                                  |
| **Test Scenario**         | No token                                                                                                                            |
| **Category**              | AuthN                                                                                                                               |
| **Priority**              | High                                                                                                                                |
| **Preconditions**         | —                                                                                                                                   |
| **Request Payload**       | —                                                                                                                                   |
| **Expected Response**     | `401`                                                                                                                               |
| **Expected DB Changes**   | None                                                                                                                                |
| **Expected Socket/Event** | None                                                                                                                                |
| **Notes**                 | GAP: GET reactions does **not** verify participation — any authed user with a messageId can read reactor identities (IDOR). File it |

### TC-PCHAT-068 — React via socket as non-participant

| Field                     | Value                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Reactions                                                                                                          |
| **API/Event Name**        | `message:react` (`/chat`)                                                                                                         |
| **Test Scenario**         | C not in room reacts to a message                                                                                                 |
| **Category**              | AuthZ / Security                                                                                                                  |
| **Priority**              | High                                                                                                                              |
| **Preconditions**         | C authed, not a participant                                                                                                       |
| **Request Payload**       | `{ messageId, conversationId, emoji:"👍" }`                                                                                       |
| **Expected Response**     | Expected reject — **GAP:** verify gateway/service enforce participation before `addReactions`; `react()` itself has no room check |
| **Expected DB Changes**   | Should be none                                                                                                                    |
| **Expected Socket/Event** | None if rejected                                                                                                                  |
| **Notes**                 | Confirm authz at gateway socket handler                                                                                           |

### TC-PCHAT-069 — Concurrent reactions from both users

| Field                     | Value                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Reactions                                                                                                     |
| **API/Event Name**        | `message:react` (`/chat`) x2                                                                                                 |
| **Test Scenario**         | A and B react simultaneously                                                                                                 |
| **Category**              | Concurrency                                                                                                                  |
| **Priority**              | Medium                                                                                                                       |
| **Preconditions**         | Both participants                                                                                                            |
| **Request Payload**       | A:👍, B:❤️ at once                                                                                                           |
| **Expected Response**     | both ack success                                                                                                             |
| **Expected DB Changes**   | **Risk:** `addReactions` writes the **whole map** (read-modify-write) — a lost update may drop one reaction under contention |
| **Expected Socket/Event** | Two `message:reaction` emits; final set should contain both                                                                  |
| **Notes**                 | GAP: non-atomic full-map replace; file potential lost-update race                                                            |
