# WebSocket — Reconnect Gap-Fill (chat:catchup)

On reconnect (outside the 2-min connection-state-recovery window) a client emits
`chat:catchup` with, per room, the highest `sequenceNumber` it has stored
(`sinceSeq`). The gateway fans out per room to chat-service over gRPC
(`catchupRoom`, `Promise.allSettled`) and replies with one direct
`chat:catchup:result` emit per **authorized** room, plus one aggregate ack listing
each room's `{ roomId, hasMore, lastSeq, authorized }`.

**Source:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`
(`chat:catchup` handler), `docs/SOCKET_EVENTS.md` §4.3.

---

### TC-WS-170 — chat:catchup single room happy path

| Field                     | Value                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Catch-up                                                                                                                                                                                   |
| **API/Event Name**        | `client→server: chat:catchup`                                                                                                                                                                          |
| **Test Scenario**         | Happy path — fetch missed messages for one room since `sinceSeq`                                                                                                                                       |
| **Category**              | Happy Path                                                                                                                                                                                             |
| **Priority**              | High                                                                                                                                                                                                   |
| **Preconditions**         | User is a participant; messages exist with `sequenceNumber > sinceSeq`                                                                                                                                 |
| **Request Payload**       | `{ rooms:[{ roomId, sinceSeq:42, conversationType:"private", limit:100 }] }`                                                                                                                           |
| **Expected Response**     | Aggregate ack `{ success:true, data:{ rooms:[{ roomId, hasMore, lastSeq, authorized:true }] } }`                                                                                                       |
| **Expected DB Changes**   | None (read)                                                                                                                                                                                            |
| **Expected Socket/Event** | One direct `chat:catchup:result { roomId, events:[CatchupEvent], hasMore, lastSeq }` to the requesting socket (NOT broadcast). `sequenceNumber`/`sentAt`/`editedAt` coerced to **numbers** in the emit |
| **Notes**                 | `limit` defaults to 100 when omitted. Events include tombstones (deleted/edited not filtered).                                                                                                         |

### TC-WS-171 — chat:catchup default sinceSeq=0 (from beginning)

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Catch-up                                                  |
| **API/Event Name**        | `client→server: chat:catchup`                                         |
| **Test Scenario**         | Edge — omit `sinceSeq` defaults to 0 → returns from the start (paged) |
| **Category**              | Edge Case                                                             |
| **Priority**              | Medium                                                                |
| **Preconditions**         | Room with > limit messages                                            |
| **Request Payload**       | `{ rooms:[{ roomId }] }`                                              |
| **Expected Response**     | Ack with `hasMore:true`, `lastSeq` = highest seq in first page        |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | `chat:catchup:result` first page                                      |
| **Notes**                 | `sinceSeq` default `0`; `conversationType` default `"private"`.       |

### TC-WS-172 — chat:catchup pagination via hasMore + lastSeq cursor

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Catch-up                                                        |
| **API/Event Name**        | `client→server: chat:catchup`                                               |
| **Test Scenario**         | Pagination — re-emit with `sinceSeq = lastSeq` until `hasMore:false`        |
| **Category**              | Pagination/Filter/Sort                                                      |
| **Priority**              | Medium                                                                      |
| **Preconditions**         | Room with multiple pages of missed messages                                 |
| **Request Payload**       | `{ rooms:[{ roomId, sinceSeq:<prev lastSeq> }] }` (repeated)                |
| **Expected Response**     | Each call advances; final call returns `hasMore:false`                      |
| **Expected DB Changes**   | None                                                                        |
| **Expected Socket/Event** | One `chat:catchup:result` per call; events cursor-based on `sequenceNumber` |
| **Notes**                 | Client loops until `hasMore` is false.                                      |

### TC-WS-173 — chat:catchup multi-room batch

| Field                     | Value                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Catch-up                                                                                                                                         |
| **API/Event Name**        | `client→server: chat:catchup`                                                                                                                                |
| **Test Scenario**         | Happy path — up to 50 rooms in one request                                                                                                                   |
| **Category**              | Happy Path                                                                                                                                                   |
| **Priority**              | High                                                                                                                                                         |
| **Preconditions**         | User in several rooms, each with its own `sinceSeq`                                                                                                          |
| **Request Payload**       | `{ rooms:[{roomId:r1,sinceSeq:s1},…,{roomId:r50}] }`                                                                                                         |
| **Expected Response**     | Aggregate ack listing all rooms; one `chat:catchup:result` emit per authorized room                                                                          |
| **Expected DB Changes**   | None                                                                                                                                                         |
| **Expected Socket/Event** | N `chat:catchup:result` emits (one per authorized room); unauthorized rooms skip their emit but still appear in ack with `authorized:false`                  |
| **Notes**                 | `Promise.allSettled` — a single room's gRPC failure does not fail the batch (that room is omitted from ack entirely; only fulfilled rooms get an ack entry). |

### TC-WS-174 — chat:catchup over 50 rooms → INVALID_PAYLOAD

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Catch-up                                                                               |
| **API/Event Name**        | `client→server: chat:catchup`                                                                      |
| **Test Scenario**         | Input validation — 51 rooms exceeds cap                                                            |
| **Category**              | Input Validation                                                                                   |
| **Priority**              | Medium                                                                                             |
| **Preconditions**         | Connected                                                                                          |
| **Request Payload**       | `{ rooms:[…51…] }`                                                                                 |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }`                                                   |
| **Expected DB Changes**   | None                                                                                               |
| **Expected Socket/Event** | None                                                                                               |
| **Notes**                 | `rooms` is `.min(1).max(50)`. Empty `rooms:[]` also INVALID_PAYLOAD. Per-room `limit` `.max(200)`. |

### TC-WS-175 — AuthZ: catchup a room you don't belong to → authorized:false

| Field                     | Value                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Catch-up                                                                                                                                                                   |
| **API/Event Name**        | `client→server: chat:catchup`                                                                                                                                                          |
| **Test Scenario**         | AuthZ — request catch-up for a room the user is not a participant/member of                                                                                                            |
| **Category**              | AuthZ                                                                                                                                                                                  |
| **Priority**              | High                                                                                                                                                                                   |
| **Preconditions**         | `roomId` user does not belong to                                                                                                                                                       |
| **Request Payload**       | `{ rooms:[{ roomId:"<foreign>" }] }`                                                                                                                                                   |
| **Expected Response**     | Ack room entry `{ roomId, …, authorized:false }`; **no** `chat:catchup:result` emit for that room                                                                                      |
| **Expected DB Changes**   | None                                                                                                                                                                                   |
| **Expected Socket/Event** | Result emit skipped (no message contents leaked)                                                                                                                                       |
| **Notes**                 | This is the primary server-side authorization for catch-up. Note `requesterId=userId` is passed to `catchupRoom`. Confirms catch-up cannot be used to exfiltrate foreign room history. |

### TC-WS-176 — chat:catchup includes tombstones

| Field                     | Value                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Catch-up                                                                                                                                                                         |
| **API/Event Name**        | `client→server: chat:catchup`                                                                                                                                                                |
| **Test Scenario**         | Business rule — deleted/edited messages returned (not filtered) for reconciliation                                                                                                           |
| **Category**              | Business Rule                                                                                                                                                                                |
| **Priority**              | Medium                                                                                                                                                                                       |
| **Preconditions**         | Room contains messages deleted/edited while client was offline                                                                                                                               |
| **Request Payload**       | `{ rooms:[{ roomId, sinceSeq }] }`                                                                                                                                                           |
| **Expected Response**     | `chat:catchup:result` events include `isDeleted:true`, `deletedType` (group tombstones; `""` for private), `editedAt` (epoch ms, 0 if never), `systemEvent`/`systemData` for SYSTEM messages |
| **Expected DB Changes**   | None                                                                                                                                                                                         |
| **Expected Socket/Event** | Events carry tombstone/edit/system fields                                                                                                                                                    |
| **Notes**                 | Client reconciles state missed offline. SYSTEM group messages are also returned so the client can replay lifecycle events.                                                                   |

### TC-WS-177 — chat:catchup group SYSTEM messages included

| Field                     | Value                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Catch-up                                                                                                                                      |
| **API/Event Name**        | `client→server: chat:catchup`                                                                                                                             |
| **Test Scenario**         | Business rule — group lifecycle system messages surface in catch-up                                                                                       |
| **Category**              | Business Rule                                                                                                                                             |
| **Priority**              | Medium                                                                                                                                                    |
| **Preconditions**         | Group room with `conversationType:"group"`; lifecycle events occurred offline                                                                             |
| **Request Payload**       | `{ rooms:[{ roomId, sinceSeq, conversationType:"group" }] }`                                                                                              |
| **Expected Response**     | Events with `systemEvent` (e.g. `ROOM_RENAMED`) and JSON-encoded `systemData`                                                                             |
| **Expected DB Changes**   | None                                                                                                                                                      |
| **Expected Socket/Event** | `chat:catchup:result` with SYSTEM events                                                                                                                  |
| **Notes**                 | Recent feature (commit 8bdd3cd: include group system messages in chat:catchup gap-fill). `conversationType` must be `"group"` to hit the group code path. |

### TC-WS-178 — chat:catchup malformed payload → INVALID_PAYLOAD

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Catch-up                                        |
| **API/Event Name**        | `client→server: chat:catchup`                               |
| **Test Scenario**         | Input validation — `rooms` missing or room missing `roomId` |
| **Category**              | Input Validation                                            |
| **Priority**              | Medium                                                      |
| **Preconditions**         | Connected                                                   |
| **Request Payload**       | `{ rooms:[{ sinceSeq:5 }] }` (no roomId)                    |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }`            |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | Negative `sinceSeq` also rejected (`nonnegative`).          |

### TC-WS-179 — Reconnect during in-flight send (out-of-order delivery)

| Field                     | Value                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Catch-up                                                                                         |
| **API/Event Name**        | `chat:catchup` + `message:send`                                                                              |
| **Test Scenario**         | Concurrency — client disconnects mid-send, reconnects, runs catch-up; the in-flight message may arrive twice |
| **Category**              | Concurrency                                                                                                  |
| **Priority**              | High                                                                                                         |
| **Preconditions**         | A `message:send` ack lost on a dropped connection                                                            |
| **Request Payload**       | resend with same `clientMessageId`, then `chat:catchup`                                                      |
| **Expected Response**     | Resend dedups by `clientMessageId` (same `messageId`); catch-up returns the message by `sequenceNumber`      |
| **Expected DB Changes**   | No duplicate row                                                                                             |
| **Expected Socket/Event** | Client dedups locally by `messageId`/`clientMessageId` and orders by `sequenceNumber`                        |
| **Notes**                 | `sequenceNumber` is the canonical ordering key; client must order by it, not arrival time.                   |

### TC-WS-180 — Catch-up gRPC failure for one room doesn't break batch

| Field                     | Value                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Catch-up                                                                                                                                                                                                    |
| **API/Event Name**        | `client→server: chat:catchup`                                                                                                                                                                                           |
| **Test Scenario**         | Error handling — one room's `catchupRoom` rejects                                                                                                                                                                       |
| **Category**              | Error Handling                                                                                                                                                                                                          |
| **Priority**              | Medium                                                                                                                                                                                                                  |
| **Preconditions**         | Multi-room batch; chat-service errors for one roomId                                                                                                                                                                    |
| **Request Payload**       | `{ rooms:[{roomId:ok},{roomId:fails}] }`                                                                                                                                                                                |
| **Expected Response**     | Ack `{ success:true, data:{ rooms:[ ...only fulfilled rooms... ] } }` — the failed room is **absent** from `ackRooms` (no entry) and emits no result                                                                    |
| **Expected DB Changes**   | None                                                                                                                                                                                                                    |
| **Expected Socket/Event** | `chat:catchup:result` only for the successful room; warning logged for the failed one                                                                                                                                   |
| **Notes**                 | `Promise.allSettled` → rejected entries are logged and skipped. Client should treat a missing ack entry as "unknown — retry that room". Subtle: a failed room is indistinguishable in the ack from one never requested. |
