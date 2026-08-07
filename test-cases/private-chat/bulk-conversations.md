# Private + Group Chat — Bulk (multi-select) Conversation Operations

> **Source:** `apps/chat-service/src/api/routes/conversation-bulk.routes.ts` →
> `api/controllers/conversation-bulk.controller.ts` → `services/conversation-bulk.service.ts`
> → the SAME single-conversation services the one-off routes use
> (`PrivateRoomService.deleteForMe/muteRoom/unmuteRoom`, `GroupMemberService.leave/muteRoom/
unmuteRoom`, `GroupRoomService.clearConversation`, `ChatMessageOrchestrator.markReadDirect`).
> Push suppression oracle: `grpc/service-impl.ts` `checkPrivateMute` / `checkGroupMute`, consumed
> by notifications-service `consumers/chat.consumer.ts`.

> **Why these exist:** the chat counterparts of `POST /communities/{leave,mute,read}/bulk`
> (TC-COMM). They span BOTH conversation kinds — one request may mix `prv_…` and `grp_…` ids and
> the server derives the type from the prefix (`lib/conversation-type.ts`), so the client never
> sends a `type`. Filed under PCHAT because they are driven from the unified inbox, which lives
> here; group-specific expectations are called out per case.

> **Two different "mutes":** these cases cover the **conversation** mute (the list row's bell),
> which suppresses PUSH ONLY. The **moderation** mute (an admin silencing a member, which blocks
> writes) is covered by `group-chat/moderation-mute-warn.md` and is unaffected by anything here.

Endpoints:

- `POST /api/v1/chat/conversations/leave/bulk`
- `POST /api/v1/chat/conversations/mute/bulk`
- `POST /api/v1/chat/conversations/read/bulk`

Shared limits: 1–50 ids per call, de-duplicated server-side; 30 bulk calls / minute / user.

---

## Bulk leave

### TC-PCHAT-134 — Mixed private + group selection is dispatched by id prefix

| Field                     | Value                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Bulk conversations / Leave                                                                                                                                               |
| **API/Event Name**        | `POST /api/v1/chat/conversations/leave/bulk`                                                                                                                             |
| **Test Scenario**         | Caller selects 2 DMs and 2 groups and confirms Leave                                                                                                                     |
| **Category**              | Happy Path                                                                                                                                                               |
| **Priority**              | High                                                                                                                                                                     |
| **Preconditions**         | Caller is a participant of both DMs and a non-admin ACTIVE member of both groups                                                                                         |
| **Request Payload**       | `{ "roomIds": ["prv_a","prv_b","grp_a","grp_b"] }` (`groupAction` omitted → `LEAVE`)                                                                                     |
| **Expected Response**     | `200`; `results[]` with `type:"PRIVATE" status:"DELETED"` for the DMs and `type:"GROUP" status:"LEFT"` for the groups; `summary {requested:4, succeeded:4, failed:0}`    |
| **Expected DB Changes**   | DMs: `PrivateRoom.deletedFor[caller]` set + caller's unread zeroed. Groups: `GroupMember.status=LEFT` + `leftAt`, `GroupRoom.memberCount` −1, MEMBER_LEFT system message |
| **Expected Socket/Event** | `conv:deleted` (per DM) and `group:removed` (per group) on the caller's own channel; `group:member:removed` on `conv:<groupId>` for the remaining roster                 |
| **Notes**                 | Byte-identical to calling the four single-conversation endpoints; that is the invariant under test                                                                       |

### TC-PCHAT-135 — `groupAction:"DELETE"` clears history and KEEPS membership

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Leave                                                                         |
| **API/Event Name**        | `POST …/conversations/leave/bulk`                                                                  |
| **Test Scenario**         | Sidebar "Delete Conversation" on a group row                                                       |
| **Category**              | Business Rule                                                                                      |
| **Priority**              | High                                                                                               |
| **Preconditions**         | Caller is an ACTIVE member                                                                         |
| **Request Payload**       | `{ "roomIds": ["grp_a"], "groupAction": "DELETE" }`                                                |
| **Expected Response**     | `200`; `status:"DELETED"`                                                                          |
| **Expected DB Changes**   | `GroupMember.clearedAt` set; **`status` stays ACTIVE**; `memberCount` unchanged; no system message |
| **Expected Socket/Event** | `conv:deleted {type:"GROUP"}` on the caller's own channel only                                     |
| **Notes**                 | Regression guard: the two group semantics must not collapse into one                               |

### TC-PCHAT-136 — Partial failure: an owned group is refused, the rest still complete

| Field                     | Value                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Leave                                                                                                                                              |
| **API/Event Name**        | `POST …/conversations/leave/bulk`                                                                                                                                       |
| **Test Scenario**         | Selection includes a group where the caller is the ADMIN and other members remain                                                                                       |
| **Category**              | Error Handling                                                                                                                                                          |
| **Priority**              | High                                                                                                                                                                    |
| **Preconditions**         | Caller ADMIN of `grp_owned`; ordinary participant of `prv_a`                                                                                                            |
| **Request Payload**       | `{ "roomIds": ["prv_a","grp_owned"] }`                                                                                                                                  |
| **Expected Response**     | `200` (never 4xx for a per-item refusal); `prv_a → DELETED`, `grp_owned → FAILED` with `errorCode:"OWNER_CANNOT_LEAVE"`; `summary {requested:2, succeeded:1, failed:1}` |
| **Expected DB Changes**   | `prv_a` delete-for-me applied and **NOT rolled back**; `grp_owned` untouched                                                                                            |
| **Expected Socket/Event** | Only `prv_a`'s `conv:deleted`                                                                                                                                           |
| **Notes**                 | Mirrors community's `ADMIN_CANNOT_LEAVE`; there is no cross-item transaction because there is no cross-item invariant                                                   |

### TC-PCHAT-137 — A room the caller does not belong to fails without side effects

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Feature/Module**        | Bulk conversations / Leave                                                     |
| **API/Event Name**        | `POST …/conversations/leave/bulk`                                              |
| **Test Scenario**         | Caller sends a valid-looking roomId for someone else's conversation            |
| **Category**              | Security (IDOR)                                                                |
| **Priority**              | High                                                                           |
| **Preconditions**         | `prv_x` exists; caller is not in `participants`                                |
| **Request Payload**       | `{ "roomIds": ["prv_x"] }`                                                     |
| **Expected Response**     | `200`; `status:"FAILED"`, `errorCode:"NOT_FOUND"` (existence is not disclosed) |
| **Expected DB Changes**   | None — `deletedFor` untouched                                                  |
| **Expected Socket/Event** | None                                                                           |
| **Notes**                 | Authorization is the single-conversation service's, not re-implemented here    |

### TC-PCHAT-138 — Empty / oversized / duplicate id lists

| Field                     | Value                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Leave                                                                                                                            |
| **API/Event Name**        | `POST …/conversations/leave/bulk`                                                                                                                     |
| **Test Scenario**         | (a) `roomIds: []` (b) 51 ids (c) the same id three times                                                                                              |
| **Category**              | Input Validation                                                                                                                                      |
| **Priority**              | Medium                                                                                                                                                |
| **Preconditions**         | Authenticated                                                                                                                                         |
| **Request Payload**       | as above                                                                                                                                              |
| **Expected Response**     | (a) `400` "Select at least one conversation" (b) `400` "You can select at most 50 conversations" (c) `200`, processed once — `summary.requested` is 1 |
| **Expected DB Changes**   | (a)(b) none; (c) one write                                                                                                                            |
| **Expected Socket/Event** | (c) one event, not three                                                                                                                              |
| **Notes**                 | Same caps and de-dup transform as community's `communityIds`                                                                                          |

### TC-PCHAT-139 — Unauthenticated and rate-limited

| Field                     | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Leave                                             |
| **API/Event Name**        | `POST …/conversations/leave/bulk`                                      |
| **Test Scenario**         | (a) no bearer token (b) 31st call inside one minute                    |
| **Category**              | AuthN / Rate Limit                                                     |
| **Priority**              | High                                                                   |
| **Preconditions**         | —                                                                      |
| **Request Payload**       | valid body                                                             |
| **Expected Response**     | (a) `401` (b) `429` with `retryAfterSec`                               |
| **Expected DB Changes**   | None                                                                   |
| **Expected Socket/Event** | None                                                                   |
| **Notes**                 | The limiter is keyed by userId, not IP — `authenticate` runs before it |

### TC-PCHAT-140 — Re-leaving an already-left group is a reported failure, not a crash

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Leave                                    |
| **API/Event Name**        | `POST …/conversations/leave/bulk`                             |
| **Test Scenario**         | Same request replayed (double-tap / retry after timeout)      |
| **Category**              | Edge Case / Idempotency                                       |
| **Priority**              | Medium                                                        |
| **Preconditions**         | Caller already LEFT `grp_a`                                   |
| **Request Payload**       | `{ "roomIds": ["grp_a"] }`                                    |
| **Expected Response**     | `200`; `status:"FAILED"`, `errorCode:"NOT_MEMBER"`            |
| **Expected DB Changes**   | None; `memberCount` is **not** decremented a second time      |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | Double-decrement of `memberCount` is the specific bug guarded |

---

## Bulk mute / unmute

### TC-PCHAT-141 — Mute with `durationMinutes` uses ONE server-computed expiry

| Field                     | Value                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Mute                                                                                                                       |
| **API/Event Name**        | `POST /api/v1/chat/conversations/mute/bulk`                                                                                                     |
| **Test Scenario**         | Mute a DM and a group for 8 hours                                                                                                               |
| **Category**              | Happy Path                                                                                                                                      |
| **Priority**              | High                                                                                                                                            |
| **Preconditions**         | Caller participates in both                                                                                                                     |
| **Request Payload**       | `{ "action":"mute", "roomIds":["prv_a","grp_a"], "durationMinutes":480 }`                                                                       |
| **Expected Response**     | `200`; `{ muted:["prv_a","grp_a"], skipped:[] }`                                                                                                |
| **Expected DB Changes**   | `PrivateRoom.mutedBy[caller] = {mutedAt, muteUntil}`; `GroupMember.notificationSettings = {mute:true, muteUntil}` — **both expiries identical** |
| **Expected Socket/Event** | One `conv:muted` per room on the caller's own channel with `isMuted:true` + ISO `mutedUntil`                                                    |
| **Notes**                 | Expiry comes from the SERVER clock (community parity) and is computed once for the batch, so a 50-room call cannot drift                        |

### TC-PCHAT-142 — Omitted `durationMinutes` means indefinite

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| **Feature/Module**        | Bulk conversations / Mute                  |
| **API/Event Name**        | `POST …/conversations/mute/bulk`           |
| **Test Scenario**         | Mute with no duration                      |
| **Category**              | Required/Optional Params                   |
| **Priority**              | High                                       |
| **Preconditions**         | —                                          |
| **Request Payload**       | `{ "action":"mute", "roomIds":["prv_a"] }` |
| **Expected Response**     | `200`                                      |
| **Expected DB Changes**   | `muteUntil: null`                          |
| **Expected Socket/Event** | `conv:muted` with `mutedUntil: null`       |
| **Notes**                 | `null` and omitted behave identically      |

### TC-PCHAT-143 — A muted conversation still DELIVERS everything except push

| Field                     | Value                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Mute                                                                                                                                       |
| **API/Event Name**        | `POST …/conversations/mute/bulk` then a peer `message:send`                                                                                                     |
| **Test Scenario**         | B sends into a room A has muted                                                                                                                                 |
| **Category**              | Business Rule                                                                                                                                                   |
| **Priority**              | High                                                                                                                                                            |
| **Preconditions**         | A muted the room; A is online on one device and backgrounded on another                                                                                         |
| **Request Payload**       | normal send from B                                                                                                                                              |
| **Expected Response**     | n/a                                                                                                                                                             |
| **Expected DB Changes**   | Message persisted; A's unread **incremented**                                                                                                                   |
| **Expected Socket/Event** | A still receives `message:new` and `conv:updated` (row bumps to top, highlighted); read receipts and typing still flow. **No FCM/APNs push** is generated for A |
| **Notes**                 | Suppression happens in notifications-service `chat.consumer` via `checkPrivateMute` / `checkGroupMute` — nothing upstream of it changes                         |

### TC-PCHAT-144 — Timed mute lapses on its own, with no refresh or re-login

| Field                     | Value                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Mute                                                                                         |
| **API/Event Name**        | `checkPrivateMute` / `checkGroupMute`                                                                             |
| **Test Scenario**         | Mute for 1 minute; wait past expiry; peer sends                                                                   |
| **Category**              | Business Rule / Time                                                                                              |
| **Priority**              | High                                                                                                              |
| **Preconditions**         | `muteUntil` now in the past; the client has NOT reconnected                                                       |
| **Request Payload**       | peer send                                                                                                         |
| **Expected Response**     | Push **is** delivered                                                                                             |
| **Expected DB Changes**   | None — the stored row is left as-is; expiry is evaluated lazily at push time                                      |
| **Expected Socket/Event** | **No** `conv:unmuted` is emitted on expiry (by design — nothing wrote a new state)                                |
| **Notes**                 | No sweeper exists or is needed. Clients must derive "is muted now" from `mutedUntil`, not cache a boolean forever |

### TC-PCHAT-145 — Unmute restores push and syncs every device

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Mute                                                        |
| **API/Event Name**        | `POST …/conversations/mute/bulk`                                                 |
| **Test Scenario**         | Unmute from web while Android and iOS sessions are live                          |
| **Category**              | Happy Path / Multi-device                                                        |
| **Priority**              | High                                                                             |
| **Preconditions**         | Room currently muted; three sessions for the same user                           |
| **Request Payload**       | `{ "action":"unmute", "roomIds":["prv_a","grp_a"] }`                             |
| **Expected Response**     | `200`; `{ unmuted:[…], skipped:[] }`                                             |
| **Expected DB Changes**   | `mutedBy[caller]` deleted; `notificationSettings = {mute:false, muteUntil:null}` |
| **Expected Socket/Event** | `conv:unmuted` per room reaches **all three** sessions with no refetch           |
| **Notes**                 | `durationMinutes` is ignored on unmute even if sent                              |

### TC-PCHAT-146 — Mute events never leak to presence watchers

| Field                     | Value                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Mute                                                                                                                            |
| **API/Event Name**        | `conv:muted` / `conv:unmuted`                                                                                                                        |
| **Test Scenario**         | Peer C has called `presence:subscribe` on A (which joins C's socket into `user:<A>`); A then mutes the DM with C                                     |
| **Category**              | Security / Privacy                                                                                                                                   |
| **Priority**              | High                                                                                                                                                 |
| **Preconditions**         | C subscribed to A's presence                                                                                                                         |
| **Request Payload**       | A mutes                                                                                                                                              |
| **Expected Response**     | `200`                                                                                                                                                |
| **Expected DB Changes**   | Normal mute write                                                                                                                                    |
| **Expected Socket/Event** | Only A's own sockets receive `conv:muted`. C receives **nothing** — the gateway rewrites the event to `self:<A>` (`isSelfOnlyEvent` in `chat.ns.ts`) |
| **Notes**                 | Same class as `conv:deleted` / `conv:updated`; the payload names the room, so it must never fan out to watchers                                      |

### TC-PCHAT-147 — Unreachable rooms are skipped, not fatal; bad `action` is rejected

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Mute                                                   |
| **API/Event Name**        | `POST …/conversations/mute/bulk`                                            |
| **Test Scenario**         | (a) one valid + one deleted/non-member room (b) `action:"silence"`          |
| **Category**              | Error Handling / Input Validation                                           |
| **Priority**              | Medium                                                                      |
| **Preconditions**         | —                                                                           |
| **Request Payload**       | as above                                                                    |
| **Expected Response**     | (a) `200` with the valid id in `muted` and the other in `skipped` (b) `400` |
| **Expected DB Changes**   | (a) only the valid room written (b) none                                    |
| **Expected Socket/Event** | (a) one `conv:muted` (b) none                                               |
| **Notes**                 | Community parity: a mute that cannot apply is not an error                  |

### TC-PCHAT-148 — Race: message arrives while the mute is being written

| Field                     | Value                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Bulk conversations / Mute                                                                                                                                          |
| **API/Event Name**        | `POST …/conversations/mute/bulk` ∥ `message:send`                                                                                                                  |
| **Test Scenario**         | Peer sends in the same instant the mute request lands, in both orders                                                                                              |
| **Category**              | Concurrency                                                                                                                                                        |
| **Priority**              | Medium                                                                                                                                                             |
| **Preconditions**         | —                                                                                                                                                                  |
| **Request Payload**       | concurrent                                                                                                                                                         |
| **Expected Response**     | `200`                                                                                                                                                              |
| **Expected DB Changes**   | Final state is deterministic: the room ends up muted                                                                                                               |
| **Expected Socket/Event** | The in-flight message is delivered either way; whether ITS push is suppressed depends on which side of the write it read the oracle — both outcomes are acceptable |
| **Notes**                 | Only the persisted mute state is required to be deterministic; a single borderline push is not a defect                                                            |

---

## Bulk mark-as-read

### TC-PCHAT-149 — Unread zeroed and full read fan-out fires per room

| Field                     | Value                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Read                                                                                                                                                                                                     |
| **API/Event Name**        | `POST /api/v1/chat/conversations/read/bulk`                                                                                                                                                                                   |
| **Test Scenario**         | Mark 2 DMs and 2 groups read (unread 3/5/8/2)                                                                                                                                                                                 |
| **Category**              | Happy Path                                                                                                                                                                                                                    |
| **Priority**              | High                                                                                                                                                                                                                          |
| **Preconditions**         | Caller can read all four                                                                                                                                                                                                      |
| **Request Payload**       | `{ "roomIds": ["prv_a","prv_b","grp_a","grp_b"] }`                                                                                                                                                                            |
| **Expected Response**     | `200`; `{ updatedCount: 4 }`                                                                                                                                                                                                  |
| **Expected DB Changes**   | Each room's read pointer advanced to its own current last message; per-user unread → 0. **No messages deleted, no timestamps rewritten, `lastMessageAt` / list order untouched**                                              |
| **Expected Socket/Event** | Per room: `message:read` to `conv:<roomId>` **and** to each other participant's own channel (their ticks turn blue); `read_sync` to the caller's other devices; `chat:unread_summary` recomputed; tray notification dismissed |
| **Notes**                 | Routed through `ChatMessageOrchestrator.markReadDirect`, the same entry point `POST …/rooms/:roomId/read` uses                                                                                                                |

### TC-PCHAT-150 — The read boundary is resolved server-side, per conversation kind

| Field                     | Value                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Read                                                                             |
| **API/Event Name**        | `POST …/conversations/read/bulk`                                                                      |
| **Test Scenario**         | Group row in the selection                                                                            |
| **Category**              | Business Rule                                                                                         |
| **Priority**              | High                                                                                                  |
| **Preconditions**         | `GroupRoom.lastMessageId` set                                                                         |
| **Request Payload**       | `{ "roomIds": ["grp_a"] }`                                                                            |
| **Expected Response**     | `200`; `updatedCount: 1`                                                                              |
| **Expected DB Changes**   | `GroupMember.advanceReadPointer` called with the GROUP room's last message — never the private lookup |
| **Expected Socket/Event** | as TC-PCHAT-149                                                                                       |
| **Notes**                 | The client sends no message id at all, so it cannot mark a room read past a message it never saw      |

### TC-PCHAT-151 — Race: a newer message must NOT be swallowed to zero

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Read                                                                                     |
| **API/Event Name**        | `POST …/conversations/read/bulk` ∥ `message:send`                                                             |
| **Test Scenario**         | A new message lands between boundary resolution and the read write                                            |
| **Category**              | Concurrency                                                                                                   |
| **Priority**              | High                                                                                                          |
| **Preconditions**         | Room has unread                                                                                               |
| **Request Payload**       | concurrent                                                                                                    |
| **Expected Response**     | `200`                                                                                                         |
| **Expected DB Changes**   | Pointer stops at the OLDER boundary; remaining unread is recomputed as `> 0`, never hard-zeroed               |
| **Expected Socket/Event** | `read_sync` carries the non-zero `unreadCount`                                                                |
| **Notes**                 | Guaranteed by the forward-only pointer + recomputed remaining-unread in `markReadUpTo` / `advanceReadPointer` |

### TC-PCHAT-152 — Empty or unreadable rooms are skipped and not counted

| Field                     | Value                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Read                                                             |
| **API/Event Name**        | `POST …/conversations/read/bulk`                                                      |
| **Test Scenario**         | (a) a conversation with no messages (b) a group the caller has left                   |
| **Category**              | Edge Case                                                                             |
| **Priority**              | Medium                                                                                |
| **Preconditions**         | —                                                                                     |
| **Request Payload**       | `{ "roomIds": ["prv_empty","grp_left"] }`                                             |
| **Expected Response**     | `200`; `{ updatedCount: 0 }`                                                          |
| **Expected DB Changes**   | None                                                                                  |
| **Expected Socket/Event** | None — no phantom `message:read` for a room with nothing to read                      |
| **Notes**                 | `updatedCount` counts rooms actually advanced, matching `POST /communities/read/bulk` |

### TC-PCHAT-153 — Global unread badge reflects the batch

| Field                     | Value                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Bulk conversations / Read                                                                                             |
| **API/Event Name**        | `POST …/conversations/read/bulk` → `chat:unread_summary`                                                              |
| **Test Scenario**         | Caller has 18 unread across 4 rooms and marks all four read                                                           |
| **Category**              | DB State                                                                                                              |
| **Priority**              | High                                                                                                                  |
| **Preconditions**         | Nav badge showing 18                                                                                                  |
| **Request Payload**       | all four ids                                                                                                          |
| **Expected Response**     | `200`                                                                                                                 |
| **Expected DB Changes**   | Per-room unread all 0                                                                                                 |
| **Expected Socket/Event** | `chat:unread_summary` pushed on the caller's own (self) channel with the new total; badge reaches 0 without a refetch |
| **Notes**                 | Emitted once per room by `notifyUnreadChanged`; clients must treat it as a replace, not a delta                       |

---

**Total: 20 test cases (TC-PCHAT-134…153).**
