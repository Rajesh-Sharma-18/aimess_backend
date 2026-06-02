# AIMess — Socket.IO Event Reference

Real-time contract between mobile/web clients and the backend. All Socket.IO
traffic terminates at the **api-gateway**; the gateway validates payloads,
calls the owning microservice over gRPC, and fans events back out via the
**Redis adapter**. Backend services never hold sockets — they `publish` to a
Redis channel and the gateway re-emits to the matching room.

> Source of truth: `apps/api-gateway/src/sockets/`. If code and this doc
> disagree, code wins — then update this file in the same PR.

---

## 1. Connection

| Property       | Value                                                                 |
| -------------- | --------------------------------------------------------------------- |
| Transport path | `/socket.io/`                                                         |
| Base URL       | gateway origin (e.g. `https://api.aimess…` / `http://localhost:8000`) |
| Namespaces     | `/chat`, `/community`, `/notify`                                      |
| Max payload    | `1 MB` (`maxHttpBufferSize`)                                          |
| State recovery | `connectionStateRecovery` — up to **2 min** disconnection window      |
| CORS           | allow-list from `CORS_ALLOWED_ORIGINS`, `credentials: true`           |

### Authentication (required on every namespace)

JWT **access token** is read on the handshake, in this order:

1. `socket.handshake.auth.token` ← preferred
2. `Authorization: Bearer <token>` header

No anonymous sockets. A missing/invalid/expired token rejects the connection
with `Error("Authentication required")` or `Error("Authentication failed")`.
On success the socket carries `{ userId, sessionId }` derived from the token —
clients never send their own `userId`.

```js
import { io } from "socket.io-client";

const chat = io(`${BASE_URL}/chat`, {
  path: "/socket.io/",
  transports: ["websocket"],
  auth: { token: accessToken },
  query: { platform: "ios", clientType: "mobile" }, // optional, used for presence
});
```

### Handshake query (optional, `/chat` only)

| Field                                    | Purpose                              | Default     |
| ---------------------------------------- | ------------------------------------ | ----------- |
| `platform` (or header `x-platform`)      | device platform recorded in presence | `"unknown"` |
| `clientType` (or header `x-client-type`) | client kind recorded in presence     | `"unknown"` |

On `/chat` connect the gateway also calls presence `connect` with
`appState: "FOREGROUND"` (best-effort).

---

## 2. Rooms (server-computed — never sent by the client)

| Room                      | Joined when                               | Used for                                         |
| ------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `user:<userId>`           | automatically on connect (all namespaces) | per-user fan-out: calls, presence, notifications |
| `conv:<conversationId>`   | client emits `conv:join`                  | 1-1 **and** group message events                 |
| `community:<communityId>` | client emits `community:join`             | community chat events                            |
| `call:<callId>`           | implicit via `call:*` Redis pattern       | WebRTC signaling                                 |

`presence:subscribe` lets a client also join other users' `user:<peerId>` rooms
to receive their `presence:status` updates.

---

## 3. Conventions

### Acknowledgements

Most **request/response** events take an ack callback. The gateway always
answers with one of:

```jsonc
// success
{ "success": true, "data": { /* gRPC result */ } }

// failure
{ "success": false, "error": "INVALID_PAYLOAD" }   // Zod validation failed
{ "success": false, "error": "SERVICE_ERROR" }     // downstream gRPC error
```

Events marked **fire-and-forget** below have **no ack** — invalid payloads are
silently dropped (`safeParse` fails → `return`), so validate client-side.

> **Numeric fields in ack `data`:** values backed by gRPC `int64` (e.g.
> `sentAt`) arrive in the **ack** as a **stringified** epoch-ms (the gRPC client
> loads `longs` as strings). The same field in a **server→client broadcast**
> (e.g. `community:message:new`) is a plain **number**. Coerce defensively with
> `Number(sentAt)` on the ack path.

```js
chat.emit("message:send", payload, (res) => {
  if (res.success) {
    /* res.data */
  } else {
    /* res.error */
  }
});
```

### `conversationType`

Where present, accepts `"private"` | `"group"` (case-insensitive, defaults to
`"private"`). It selects the private vs. group code path in chat-service.

---

## 4. `/chat` namespace

Owns 1-1 messages, group messages, read/delivery receipts, reactions, typing,
presence, and 1-1 WebRTC call signaling. Delegates to **chat-service** over gRPC.

### 4.1 Client → Server

| Event                   | Ack | Payload                                                                                                            | Notes                                                                     |
| ----------------------- | --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `conv:join`             | no  | `{ conversationId }`                                                                                               | joins `conv:<id>`                                                         |
| `conv:leave`            | no  | `{ conversationId }`                                                                                               | leaves `conv:<id>`                                                        |
| `message:send`          | yes | see below                                                                                                          | create a message                                                          |
| `message:read`          | yes | `{ conversationId, upToMessageId }`                                                                                | mark read up to a message                                                 |
| `message:delivered`     | yes | `{ conversationId, upToMessageId }`                                                                                | delivered receipt (client emits on receiving `message:new`); private only |
| `message:react`         | yes | `{ messageId, conversationId, emoji }`                                                                             | toggle/add reaction                                                       |
| `message:reactions:get` | yes | `{ messageId, conversationId, conversationType? }`                                                                 | list who reacted                                                          |
| `message:edit`          | yes | `{ messageId, conversationId, contentText?, contentJson?, conversationType? }`                                     | edit own message                                                          |
| `message:forward`       | yes | `{ messageId, targetConversationId, clientMessageId, conversationType?, receiverId?, senderName?, senderAvatar? }` | forward into another conversation                                         |
| `messages:fetch`        | yes | `{ conversationId, cursor?, limit?≤100, conversationType? }`                                                       | cursor-paged history                                                      |
| `chat:catchup`          | yes | `{ rooms: [{ roomId, sinceSeq?≥0, conversationType?, limit?≤200 }]≤50 }`                                           | reconnect gap-fill by per-room `sequenceNumber` (see below)               |
| `typing:start`          | no  | `{ conversationId }`                                                                                               | broadcast to `conv:<id>`                                                  |
| `typing:stop`           | no  | `{ conversationId }`                                                                                               | broadcast to `conv:<id>`                                                  |
| `presence:heartbeat`    | no  | `{ appState? }`                                                                                                    | keep presence alive; `appState` default `"FOREGROUND"`                    |
| `presence:subscribe`    | yes | `{ peerIds: string[]≤500 }`                                                                                        | watch peers' presence                                                     |
| `presence:unsubscribe`  | yes | `{ peerIds: string[]≤500 }`                                                                                        | stop watching                                                             |
| `call:initiate`         | yes | `{ calleeId, type?: "AUDIO"\|"VIDEO", privateRoomId? }`                                                            | start a call                                                              |
| `call:answer`           | yes | `{ callId }`                                                                                                       | accept                                                                    |
| `call:decline`          | yes | `{ callId }`                                                                                                       | reject a ringing call                                                     |
| `call:end`              | yes | `{ callId }`                                                                                                       | hang up (caller or callee)                                                |
| `call:ice`              | no  | `{ callId, candidate }`                                                                                            | relay ICE candidate (Redis-only, not persisted)                           |

**`message:send` payload**

```jsonc
{
  "conversationId": "string", // required
  "clientMessageId": "string", // required — client-generated idempotency key
  "contentType": "TEXT", // required (TEXT|IMAGE|VIDEO|FILE|AUDIO|LOCATION|CONTACT…)
  "contentText": "hello", // optional
  "mediaKey": "string", // optional — single object key shorthand
  "files": [
    // optional — attachments
    {
      "objectKey": "…",
      "url": "…",
      "name": "",
      "size": 0,
      "mime": "",
      "width": 0,
      "height": 0,
      "durationMs": 0,
    },
  ],
  "urls": ["https://…"], // optional — link previews
  "location": { "lat": 0, "lng": 0, "placeName": "…", "placeAddress": "…" },
  "contact": { "name": "…", "phone": "…", "avatar": "…", "userId": "…" },
  "repliedToId": "string", // optional — reply target
  "conversationType": "private", // private|group
  "receiverId": "string", // optional — peer (private)
  "senderName": "string", // optional — denormalized for fan-out
  "senderAvatar": "string", // optional
}
```

> Either `objectKey` **or** `url` is expected on a file entry. If `mediaKey`
> is set and no file carries an `objectKey`, the gateway injects one file from
> `mediaKey`. The gateway packs `contentText`/`urls`/`files`/`location`/`contact`
> into `contentJson` before the gRPC call.

### 4.2 Server → Client

Published by chat-service to a Redis channel; the gateway re-emits to the room.

| Event                 | Room (channel)     | Payload                                                                                                                                                                                                                   | Trigger                                                                       |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `message:new`         | `conv:<id>`        | `{ messageId, conversationId, senderId, contentType, contentText, contentJson, sentAt, sequenceNumber }` (+`isForwarded` on forward; for **group system events** `contentType:"SYSTEM"` plus `systemEvent`, `systemData`) | a message is created/forwarded, or a group lifecycle system message is posted |
| `message:edited`      | `conv:<id>`        | `{ messageId, conversationId, contentText, contentJson, editedAt, sequenceNumber }`                                                                                                                                       | message edited                                                                |
| `chat:catchup:result` | (direct to socket) | `{ roomId, events: [CatchupEvent], hasMore, lastSeq }` (see below)                                                                                                                                                        | reconnect gap-fill response, one per room                                     |
| `message:read`        | `conv:<id>`        | `{ conversationId, readerId, upToMessageId }`                                                                                                                                                                             | read receipt                                                                  |
| `message:delivered`   | `conv:<id>`        | `{ conversationId, recipientId, upToMessageId, messageIds[] }`                                                                                                                                                            | delivery receipt (private)                                                    |
| `message:reaction`    | `conv:<id>`        | `{ messageId, conversationId, reactions: [{ emoji, userId }] }`                                                                                                                                                           | reaction added/removed (full current set)                                     |
| `message:delete`      | `conv:<id>`        | `{ messageId, type: "forEveryone"\|"forMe", deletedBy }`                                                                                                                                                                  | message deleted                                                               |
| `typing:start`        | `conv:<id>`        | `{ userId, conversationId }`                                                                                                                                                                                              | a peer starts typing                                                          |
| `typing:stop`         | `conv:<id>`        | `{ userId, conversationId }`                                                                                                                                                                                              | a peer stops typing                                                           |
| `presence:status`     | `user:<id>`        | `{ userId, isOnline, lastActiveAt, lastSeen }`                                                                                                                                                                            | a watched peer's online status changes                                        |
| `call:incoming`       | `user:<calleeId>`  | `{ callId, callerId, type }`                                                                                                                                                                                              | someone calls you                                                             |
| `call:answered`       | `call:<callId>`    | `{ callId }`                                                                                                                                                                                                              | callee accepted                                                               |
| `call:declined`       | `call:<callId>`    | `{ callId }`                                                                                                                                                                                                              | callee rejected                                                               |
| `call:ended`          | `call:<callId>`    | `{ callId, endedBy, durationSec }`                                                                                                                                                                                        | call ended                                                                    |
| `call:ice`            | `call:<callId>`    | `{ callId, candidate, from }`                                                                                                                                                                                             | peer ICE candidate                                                            |

> **Delete note:** message deletes are published to `conv:<roomId>` for both
> 1-1/group and community rooms. Client rule: on `forEveryone` hide for all; on
> `forMe` hide only when `deletedBy === myUserId`.

> **Group system messages:** group lifecycle actions post a `message:new` with
> `contentType:"SYSTEM"`. `systemEvent` ∈ `GROUP_CREATED`, `MEMBER_ADDED`,
> `MEMBER_JOINED`, `MEMBER_LEFT`, `MEMBER_REMOVED`, `ROLE_CHANGED`,
> `ROOM_RENAMED`, `AVATAR_CHANGED`, `DESCRIPTION_CHANGED`; `systemData` carries
> `actorId`/`actorName` (and `targetUserId`/`targetName`, `newRole`, `newName`
> where relevant). `contentText` is an English fallback — prefer rendering from
> `systemEvent` + `systemData` for i18n. These bump the room's last-message
> (so it sorts in the unified inbox **`GET /api/v1/chat/inbox`**) but do **not**
> raise unread counts.

### 4.3 Reconnect gap-fill — `chat:catchup`

Every message in a private/group room carries a per-room monotonic
`sequenceNumber` (1, 2, 3, …; allocated atomically at send time). On reconnect a
client emits **`chat:catchup`** with, per room, the highest `sequenceNumber` it
has already stored (`sinceSeq`). The gateway fans out to chat-service over gRPC
and replies with one **`chat:catchup:result`** emit per room (direct to the
requesting socket, not broadcast), plus an aggregate ack.

**`chat:catchup` (client → server)**

```jsonc
{
  "rooms": [
    // 1..50 rooms
    {
      "roomId": "string", // required
      "sinceSeq": 0, // optional, ≥0 (default 0 = from the beginning)
      "conversationType": "private", // optional: private|group (default private)
      "limit": 100, // optional, 1..200 (default 100)
    },
  ],
}
```

**`chat:catchup:result` (server → client, one per room)**

```jsonc
{
  "roomId": "string",
  "events": [
    {
      "messageId": "string",
      "conversationId": "string",
      "senderId": "string",
      "contentType": "TEXT",
      "contentText": "string",
      "contentJson": "{…}",
      "sentAt": 0, // epoch ms
      "sequenceNumber": 0,
      "isDeleted": false,
      "deletedType": "", // group tombstones only; "" for private
      "editedAt": 0, // epoch ms, 0 if never edited
    },
  ],
  "hasMore": false, // more rows beyond `limit` — re-request with sinceSeq=lastSeq
  "lastSeq": 0, // cursor: highest sequenceNumber in this page
}
```

> Catch-up **includes tombstones** (deleted/edited messages are returned, not
> filtered) so the client can reconcile state it missed while offline. Pagination
> is cursor-based on `sequenceNumber`: when `hasMore` is true, re-emit
> `chat:catchup` for that room with `sinceSeq = lastSeq` until `hasMore` is false.
> The ack payload is `{ success, data: { rooms: [{ roomId, hasMore, lastSeq,
authorized }] } }`; `authorized:false` means the user is not a participant /
> active member of that room (its result emit is skipped).

---

## 5. `/community` namespace

Community (many-member) chat.

Community chat is served by **chat-service**'s `CommunityService` (gRPC on
`4004`): it persists messages via `CommunityMessageService` and publishes
`community:message:new` to the Redis channel `community:<communityId>`, which the
gateway re-emits to the `community:<communityId>` room.

### 5.1 Client → Server

| Event                      | Ack | Payload                                                                     | Notes                            |
| -------------------------- | --- | --------------------------------------------------------------------------- | -------------------------------- |
| `community:join`           | no  | `{ communityId, roomId }`                                                   | joins `community:<communityId>`  |
| `community:leave`          | no  | `{ communityId }`                                                           | leaves `community:<communityId>` |
| `community:message:send`   | yes | `{ communityId, roomId, clientMessageId, message, contentType, mediaKey? }` | post a message                   |
| `community:messages:fetch` | yes | `{ roomId, cursor?, limit?≤100 }`                                           | cursor-paged history             |

### 5.2 Server → Client

The namespace forwards **any** event published to the `community:<communityId>`
Redis channel verbatim. Contract events:

| Event                     | Room             | Payload                                                                                                                           | Trigger               |
| ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `community:message:new`   | `community:<id>` | `{ messageId, communityId, roomId, senderId, senderName, senderAvatar, message, contentType, mediaKey, clientMessageId, sentAt }` | new community message |
| `community:member:joined` | `community:<id>` | member DTO                                                                                                                        | a member joins        |

> Community message **deletes** are emitted as `message:delete` on the
> `conv:<roomId>` channel (see §4.2), not on the community channel.

---

## 6. `/notify` namespace

In-app notification feed + unread badge. Delegates to **notifications-service**.
Each connected user's `notify:<userId>` Redis channel is subscribed
(ref-counted across multiple sockets) and re-emitted to `user:<userId>`.

### 6.1 Client → Server

| Event                     | Ack | Payload                         | Notes                           |
| ------------------------- | --- | ------------------------------- | ------------------------------- |
| `notifications:fetch`     | yes | `{ cursor?, limit?≤100 }`       | cursor-paged feed               |
| `notifications:mark_read` | yes | `{ notificationIds: string[] }` | mark read (empty array allowed) |

### 6.2 Server → Client

| Event                | When                           | Payload                                 |
| -------------------- | ------------------------------ | --------------------------------------- |
| `notification:count` | emitted once on connect        | `{ count }` (unread count)              |
| _forwarded events_   | published to `notify:<userId>` | event name + payload forwarded verbatim |

---

## 7. End-to-end scenarios

### 7.1 Send a 1-1 message

```
A: connect /chat (auth token)            → joins user:<A>
A: emit conv:join { conversationId }     → joins conv:<id>
A: emit message:send {…, clientMessageId}
        gateway → chat-service.sendMessage (gRPC)
        chat-service persists + publish conv:<id> "message:new"
   ← ack { success:true, data:{ messageId, … } }   (to A)
B (in conv:<id>): receives "message:new"
B: emit message:delivered { conversationId, upToMessageId }  → publishes "message:delivered"
B (opens chat): emit message:read { conversationId, upToMessageId } → publishes "message:read"
A: receives "message:delivered" then "message:read"
```

Idempotency: `clientMessageId` dedupes retries — re-sending the same id does
**not** create a second message (offline-first replays are safe).

### 7.2 Typing indicator

```
A: emit typing:start { conversationId }  → broadcast "typing:start" to conv:<id>
…A stops…
A: emit typing:stop  { conversationId }  → broadcast "typing:stop"  to conv:<id>
```

Fire-and-forget; no persistence, no ack.

### 7.3 Reactions

```
A: emit message:react { messageId, conversationId, emoji }
   ← ack { success:true, data:{ messageId, reactions:[{userId,emoji}] } }
conv:<id> receives "message:reaction" with the FULL current reaction set
(anyone can call message:reactions:get for the detailed user list)
```

### 7.4 Presence

```
A: emit presence:subscribe { peerIds:[B,C] }   → joins user:<B>, user:<C>
   ← ack { success:true }
B goes online/offline → A receives "presence:status" { userId:B, isOnline, lastSeen }
A: emit presence:heartbeat { appState:"FOREGROUND" } periodically to stay online
A: emit presence:unsubscribe { peerIds:[B] } when leaving the screen
```

### 7.5 1-1 call (WebRTC signaling)

```
Caller: emit call:initiate { calleeId, type:"VIDEO" }
        ← ack { success:true, data:{ callId, status, rtcConfig } }
        callee's user:<calleeId> receives "call:incoming" { callId, callerId, type }
Callee: emit call:answer { callId }   → call:<callId> receives "call:answered"
   (or)  emit call:decline { callId }  → call:<callId> receives "call:declined"
Both:   exchange emit call:ice { callId, candidate } → peers receive "call:ice" { …, from }
Either: emit call:end { callId }       → call:<callId> receives "call:ended" { endedBy, durationSec }
```

ICE candidates are relayed through Redis only — never persisted. The backend is
**signaling-only**; media flows peer-to-peer / via TURN (`rtcConfig`).

---

## 8. Error handling

| Ack `error`       | Meaning                              | Client action                   |
| ----------------- | ------------------------------------ | ------------------------------- |
| `INVALID_PAYLOAD` | Zod validation failed at the gateway | fix payload; do not retry as-is |
| `SERVICE_ERROR`   | downstream gRPC/service error        | retry with backoff              |

Fire-and-forget events (`conv:join`, `typing:*`, `call:ice`, `presence:heartbeat`)
return nothing on bad input — they are dropped silently. Connection-level auth
failures surface as a `connect_error` with message `Authentication required` /
`Authentication failed`.

---

## 9. Quick index

**Client → Server:** `conv:join` · `conv:leave` · `message:send` · `message:read` ·
`message:delivered` · `message:react` · `message:reactions:get` · `message:edit` ·
`message:forward` · `messages:fetch` · `chat:catchup` · `typing:start` · `typing:stop` ·
`presence:heartbeat` · `presence:subscribe` · `presence:unsubscribe` ·
`call:initiate` · `call:answer` · `call:decline` · `call:end` · `call:ice` ·
`community:join` · `community:leave` · `community:message:send` ·
`community:messages:fetch` · `notifications:fetch` · `notifications:mark_read`

**Server → Client:** `message:new` · `message:edited` · `chat:catchup:result` · `message:read` ·
`message:delivered` · `message:reaction` · `message:delete` · `typing:start` ·
`typing:stop` · `presence:status` · `call:incoming` · `call:answered` ·
`call:declined` · `call:ended` · `call:ice` · `community:message:new` ·
`community:member:joined` · `notification:count`
