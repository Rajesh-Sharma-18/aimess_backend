# AIMESS Chat Socket — Backend Implementation Spec

**Audience:** the backend developer who will implement the real Socket.IO chat transport that the AIMESS Android (and later iOS) client will swap in for the in-app testing transport.

**Goal:** when you ship a backend that conforms to this spec, the Android client will flip from `BuildConfig.USE_FAKE_CHAT_REPOSITORY = true` to `false` and **every scenario in §6 should work end-to-end with zero client-side changes**.

> If a real-backend behaviour differs from this spec, that's a backend bug — the client is already wired to this contract. Open a conversation with the client team **before** diverging.

Last updated: 2026-05-26 · Owner: client team · Status: **READY FOR BACKEND IMPLEMENTATION**

---

## Table of contents

1. [TL;DR](#1-tldr)
2. [Architecture overview](#2-architecture-overview)
3. [Identity model](#3-identity-model)
4. [Chat types](#4-chat-types)
5. [Connection lifecycle](#5-connection-lifecycle)
6. [Event catalog](#6-event-catalog)
7. [Universal conventions](#7-universal-conventions)
8. [Idempotency, ordering, dedup](#8-idempotency-ordering-dedup)
9. [The ACK + echo dedupe contract](#9-the-ack--echo-dedupe-contract)
10. [Scenario walkthroughs](#10-scenario-walkthroughs)
11. [Chat-type-specific behaviour](#11-chat-type-specific-behaviour)
12. [Server-side data model](#12-server-side-data-model)
13. [Error contract](#13-error-contract)
14. [Implementation checklist](#14-implementation-checklist)
15. [Test scenarios](#15-test-scenarios)
16. [Glossary](#16-glossary)

---

## 1. TL;DR

- **Transport:** Socket.IO over WebSocket, namespace `/chat` (sibling to existing `/z-product`).
- **Auth:** JWT access token + `deviceId` + `platform` + `clientVersion` in the Socket.IO `auth` payload on connect.
- **Identity invariants:**
  - `userId` — authenticated, server-issued, opaque string. Only field that distinguishes "me" from "peer."
  - `clientMessageId` — UUIDv4, client-generated, the **idempotency key** for sends. Server **MUST** persist + echo on every event that references the message.
  - `serverMessageId` — opaque ULID, server-generated, lexicographically sortable.
  - `seq: Long` — monotonic per-room sequence, server-assigned at insert time. Every mutation event includes it.
- **All field names: camelCase.** No aliases. No `_id`/`id`/`clientId` synonyms.
- **All timestamps: epoch milliseconds, UTC, server-authoritative.** Client timestamps are advisory only.
- **Three chat types: `private` (1:1), `group`, `community`.** Same wire events; rendering deltas live on the client.
- **ACK + echo:** every send returns BOTH `chat:message:ack` (sender only) AND `chat:message:new` broadcast to all room members **including the sender** with `clientMessageId` echoed. Client dedupes by `clientMessageId` → `serverMessageId` → insert.
- **Offline-first contract:** the client persists every message to local Room before the wire round-trip. The server is authoritative for ordering (`seq`), conflict resolution (edits, deletes), and read state. The client never blocks the UI on the network.

---

## 2. Architecture overview

```
┌───────────────────────────────┐                ┌──────────────────────────────┐
│ Android client                │                │ Chat backend (you)           │
│                               │                │                              │
│  ┌─────────────────────────┐  │   WebSocket    │  ┌────────────────────────┐ │
│  │  SocketManager          │◄─┼────────────────┼─►│  Socket.IO namespace   │ │
│  │  /chat namespace        │  │  /chat path    │  │  /chat                 │ │
│  └─────────────┬───────────┘  │                │  └────────┬───────────────┘ │
│                │ events flow  │                │           │ session router   │
│  ┌─────────────▼───────────┐  │                │  ┌────────▼───────────────┐ │
│  │  SocketEventRouter      │  │                │  │  Auth + presence       │ │
│  │  parse + typed events   │  │                │  │  + room membership     │ │
│  └─────────────┬───────────┘  │                │  └────────┬───────────────┘ │
│                │              │                │           │                  │
│  ┌─────────────▼───────────┐  │                │  ┌────────▼───────────────┐ │
│  │  PrivateChatSocketBridge│  │                │  │  Message store + seq   │ │
│  │  upsert → MessageDao    │  │                │  │  generator per room    │ │
│  │              ChatDao    │  │                │  └────────┬───────────────┘ │
│  └─────────────┬───────────┘  │                │           │                  │
│                │              │                │  ┌────────▼───────────────┐ │
│  ┌─────────────▼───────────┐  │                │  │  Fanout: broadcast +   │ │
│  │  Room (encrypted DB)    │  │                │  │  push (FCM) on miss    │ │
│  │  messages + chats       │  │                │  └────────────────────────┘ │
│  └─────────────┬───────────┘  │                │                              │
│                │ Flow         │                └──────────────────────────────┘
│  ┌─────────────▼───────────┐  │
│  │  ViewModels + UI        │  │
│  └─────────────────────────┘  │
└───────────────────────────────┘
```

**Key client-side touchpoints (read these files in the Android repo if you want to see the receiving side):**

- `core/core-network/.../socket/SocketManager.kt` — connects to `${CHAT_SERVICE_URL}/chat` over WebSocket; auth headers; reconnect with backoff; stamps `senderId` from `AimessDataStore.getUserId()` on every outbound emit.
- `core/core-network/.../socket/SocketEventRouter.kt` — parses raw `JSONObject` payloads into typed event classes (`MessageAckEvent`, `NewMessageEvent`, etc.).
- `feature/feature-chat/.../data/socket/PrivateChatSocketBridge.kt` — single chokepoint that turns wire events into DAO writes (`MessageDao.upsert/markSent/editContent/softDelete/updateReactions` + `ChatDao.appendIncomingMessage` for unread + preview).
- `feature/feature-chat/.../data/repository/RoomBackedPrivateChatRepository.kt` — optimistic local writes for outbound; reads are pure Room Flows.

**Namespace + path (what to expose):**

- Socket.IO URL: `${CHAT_SERVICE_URL}/chat`
- Socket.IO path: `/z-socket/` (existing convention from the legacy `/z-product` namespace)
- Transport: WebSocket only (`transports: ['websocket']`)
- Reconnection: client retries with exponential backoff (1s → 30s, jitter 0.3); server should accept reconnects and let `chat:catchup` resume per-room state.

---

## 3. Identity model

| Concept                 | Type                           | Generated by                            | Lifetime              | Notes                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------ | --------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userId`                | `String` (opaque UUID)         | Backend at account creation             | Permanent             | Single source of truth for "who is the sender." Never expose phone number, email, or display name as identity on the wire.                                                                                                                                              |
| `deviceId`              | `String` (opaque UUID)         | Client at first install                 | Permanent per-install | Lets the server distinguish multiple devices for the same user (multi-device read sync needs this).                                                                                                                                                                     |
| `sessionId`             | `String` (opaque)              | Backend on every successful `chat:auth` | Until disconnect      | Server can use this to correlate a connection with a (user, device) pair for fanout.                                                                                                                                                                                    |
| `roomId`                | `String` (opaque)              | Backend at room creation                | Permanent             | The conversation key. Format-free: backend picks (UUID is fine). For 1:1 chats backend may use a deterministic hash of the two user ids — client doesn't care.                                                                                                          |
| `clientMessageId`       | `String` (UUIDv4)              | **Client** at message creation          | Forever               | **Idempotency key for sends.** Server MUST persist it on the message row + echo it on every event that references the message (`chat:message:ack`, `chat:message:new`, `chat:message:edit`, `chat:message:delete`, `chat:reaction:updated`).                            |
| `serverMessageId`       | `String` (ULID)                | Backend on insert                       | Forever               | Opaque to client — never parsed, only stored + compared for dedup. ULID gives free lexicographic ordering and time-prefix decoding for server-side queries.                                                                                                             |
| `seq: Long`             | `Long` (monotonic per room)    | Backend at insert                       | Forever per room      | **Authoritative ordering key.** Strictly increasing per `(roomId)`. Every event that mutates a message includes this. Clients order by `(seq ASC, serverTimestamp ASC)`, dedupe by `serverMessageId`, and use `MAX(seq)` per room as `sinceSeq` for reconnect catch-up. |
| `idempotencyKey`        | `String`                       | Client                                  | Per-operation         | For `chat:message:send`, this equals `clientMessageId`. For other C→S events, see the per-event spec.                                                                                                                                                                   |
| `editSeq: Long`         | `Long` (monotonic per message) | Backend at each edit                    | Forever per message   | Lets clients apply edits in order even if they arrive out of band; last-write-wins by `editSeq`.                                                                                                                                                                        |
| `reactionVersion: Long` | `Long` (monotonic per message) | Backend on each reaction change         | Forever per message   | Reactions are rolled-up state (not deltas) — client replaces local reactions whenever `reactionVersion` increases.                                                                                                                                                      |

### Why a server-assigned `seq`?

Client timestamps fail on clock skew, NTP jumps, and reconnect catch-up. A monotonic per-room `seq` gives:

- A canonical order for all messages in a room (sender, receiver, third device — all agree).
- A clean resume cursor: `chat:catchup({ rooms: [{ roomId, sinceSeq }] })`.
- A dedup mechanism that works across the ACK/echo collision (§9).
- Group/community ordering that doesn't reorder under load.

---

## 4. Chat types

The wire protocol is identical for all three. The differences are server-side enforcement + client-side UI.

| Type        | Member count      | Identity field                                  | Read state semantics                                  | Typical fanout cost |
| ----------- | ----------------- | ----------------------------------------------- | ----------------------------------------------------- | ------------------- |
| `private`   | 2 (the two users) | Each user's `userId`                            | Per-message: shown to sender when peer reads          | 1–2 connections     |
| `group`     | 3–~500            | Each member's `userId`                          | Aggregated: ✓✓ when **all** members read              | 3–500               |
| `community` | 500–unlimited     | Member `userId` + role (Member/Mod/Admin/Owner) | **Hidden** entirely — too many members, privacy issue | 500+                |

**Where the type is declared:** every `chat:room:join` payload includes `type: "private"|"group"|"community"`. The server already knows from its own data; the client passes it so the eventual room-state response is shaped right (e.g. members list is empty for community).

**Server-side rules that change per type:**

- **`private`:** ACL is "both members"; only the two `userId`s can read/write/react.
- **`group`:** ACL is the members list; admins can edit metadata, kick, etc.
- **`community`:**
  - Roles: `Owner | Admin | Mod | Member`. Admin/Mod can pin, delete-for-everyone any message; Member can only delete own.
  - Read receipts NOT broadcast (don't fan out `chat:read:updated` to community rooms — privacy + cost).
  - Membership may be open / approval / invite-only — surface via `chat:room:joined` payload (`isMember`, `joinRequestState`).

---

## 5. Connection lifecycle

```
Client                                Server
  │                                     │
  │── connect ws://.../chat ───────────►│
  │   auth: {                           │
  │     userId, deviceId,               │
  │     accessToken, platform,          │
  │     clientVersion                   │
  │   }                                 │
  │                                     │ validate JWT, allocate sessionId
  │◄──── chat:auth:ok ──────────────────│
  │      { sessionId, serverTime }      │
  │                                     │
  │── chat:room:join ──────────────────►│ (per open chat)
  │   { roomId, type, lastKnownSeq }    │
  │                                     │ ACL check + load room snapshot
  │◄──── chat:room:joined ──────────────│
  │      { roomId, latestSeq, members } │
  │                                     │
  │── chat:catchup ────────────────────►│ (immediately after rejoin)
  │   { rooms: [{ roomId, sinceSeq }] } │
  │                                     │ replay missed events in seq order
  │◄──── chat:catchup:result ───────────│ (paginated)
  │      { roomId, events, hasMore }    │
  │                                     │
  │                                     │ (steady state — bidirectional events)
  │                                     │
  │── disconnect ──────────────────────►│ presence:update broadcast (offline)
  │                                     │
```

### 5.1 Connect

Client opens a Socket.IO connection with `auth` payload:

```json
{
  "userId": "u_01HXYZABCDEF",
  "deviceId": "d_2026-05-26-pixel7",
  "accessToken": "<JWT bearer token>",
  "platform": "android",
  "clientVersion": "1.4.0+42"
}
```

Server validates JWT signature + expiry + match `userId`. On success, emits `chat:auth:ok`:

```json
{
  "sessionId": "s_01HXYZQWERTY",
  "serverTime": 1779708607123
}
```

On failure (bad token, banned user, version too old), emit `chat:error`:

```json
{
  "event": "chat:error",
  "forEvent": "chat:auth",
  "code": "UNAUTHORIZED" | "VERSION_TOO_OLD" | "BANNED",
  "message": "<user-facing reason>"
}
```

…then disconnect. Client treats this as terminal (no auto-reconnect; surface to UI).

### 5.2 Heartbeat

Client emits every 25 seconds:

```
event: "presence:heartbeat"
payload: { userId, deviceId }
```

Server uses this to keep presence "online." If no heartbeat for 60s, mark offline + broadcast `presence:update`.

### 5.3 Room join

Client sends one `chat:room:join` per open chat screen (typically 1–2 active at a time):

```json
{
  "roomId": "r_01HXYZABCDEF",
  "type": "private",
  "lastKnownSeq": 1247
}
```

Server:

1. ACL check: is `userId` a member of this room? If not, emit `chat:error{ code: "FORBIDDEN" }`.
2. Load room snapshot (latest `seq`, member list for non-community).
3. Emit `chat:room:joined`:

```json
{
  "roomId": "r_01HXYZABCDEF",
  "type": "private",
  "latestSeq": 1289,
  "members": [
    { "userId": "u_a", "role": "Member", "joinedAt": 1779608000000 },
    { "userId": "u_b", "role": "Member", "joinedAt": 1779608000000 }
  ],
  "isMember": true,
  "joinRequestState": null
}
```

For community: `members` may be empty (too large to ship); client uses a separate REST call.

### 5.4 Reconnect

Client auto-reconnects with exponential backoff. After reconnect:

1. Re-runs `chat:auth` (new sessionId).
2. Re-joins every room it had open (`chat:room:join`).
3. **Immediately emits `chat:catchup`** with the latest `seq` per room (from local Room DB):

```json
{
  "rooms": [
    { "roomId": "r_a", "sinceSeq": 1247 },
    { "roomId": "r_b", "sinceSeq": 891 }
  ]
}
```

Server replays every event with `seq > sinceSeq`, in `seq` order, paginated:

```json
{
  "roomId": "r_a",
  "events": [
    {
      "kind": "message",
      "seq": 1248,
      "payload": {
        /* full chat:message:new payload */
      }
    },
    {
      "kind": "edit",
      "seq": 1249,
      "payload": {
        /* full chat:message:edit payload */
      }
    },
    {
      "kind": "delete",
      "seq": 1250,
      "payload": {
        /* full chat:message:delete payload */
      }
    },
    {
      "kind": "reaction",
      "seq": 1251,
      "payload": {
        /* full chat:reaction:updated payload */
      }
    },
    {
      "kind": "read",
      "seq": 1252,
      "payload": {
        /* full chat:read:updated payload */
      }
    }
  ],
  "hasMore": true,
  "nextCursor": "c_eyJhbGciOi..."
}
```

Client re-requests with `sinceSeq = max(seq in last page)` until `hasMore=false`.

### 5.5 Disconnect

On client disconnect, server:

1. Marks `(userId, deviceId)` offline if no other sessions active.
2. Broadcasts `presence:update` to the user's friend graph.
3. Holds undelivered events for `chat:catchup` resume on next connect.

---

## 6. Event catalog

**Direction convention:** `C→S` (client to server), `S→C` (server to client). "Broadcast" events fan out to all members of the target room/topic.

### 6.1 Quick reference table

| Event name                    | Direction                              | Idempotency key                         | Per-room `seq`?              | Carries `clientMessageId`? |
| ----------------------------- | -------------------------------------- | --------------------------------------- | ---------------------------- | -------------------------- |
| `chat:auth`                   | C→S                                    | session                                 | n/a                          | n/a                        |
| `chat:auth:ok`                | S→C                                    | n/a                                     | n/a                          | n/a                        |
| `chat:room:join`              | C→S                                    | `(sessionId, roomId)`                   | n/a                          | n/a                        |
| `chat:room:joined`            | S→C                                    | n/a                                     | n/a                          | n/a                        |
| `chat:room:leave`             | C→S                                    | `(sessionId, roomId)`                   | n/a                          | n/a                        |
| `chat:message:send`           | C→S                                    | `clientMessageId`                       | n/a                          | **yes (you create)**       |
| `chat:message:ack`            | S→C (sender only)                      | n/a                                     | **yes**                      | **yes (echo)**             |
| `chat:message:new`            | S→C (broadcast incl. sender)           | n/a                                     | **yes**                      | **yes (echo)**             |
| `chat:message:edit`           | C→S                                    | `(serverMessageId, editSeq)`            | **yes (editSeq)**            | **yes (echo)**             |
| `chat:message:edit:updated`   | S→C (broadcast)                        | n/a                                     | **yes**                      | **yes**                    |
| `chat:message:delete`         | C→S                                    | `(serverMessageId, deletedFor, userId)` | **yes**                      | **yes (echo)**             |
| `chat:message:delete:updated` | S→C (broadcast)                        | n/a                                     | **yes**                      | **yes**                    |
| `chat:reaction:set`           | C→S                                    | `(serverMessageId, userId, emoji, op)`  | n/a                          | n/a                        |
| `chat:reaction:updated`       | S→C (broadcast)                        | n/a                                     | n/a (uses `reactionVersion`) | **yes**                    |
| `chat:read:upto`              | C→S                                    | `(roomId, userId, upToSeq)` (monotonic) | n/a                          | n/a                        |
| `chat:read:updated`           | S→C (broadcast — private + group only) | n/a                                     | n/a                          | n/a                        |
| `chat:typing`                 | C→S, S→C (broadcast minus sender)      | n/a (transient)                         | n/a                          | n/a                        |
| `presence:update`             | S→C (fanout to friend graph)           | n/a                                     | n/a                          | n/a                        |
| `presence:heartbeat`          | C→S                                    | n/a                                     | n/a                          | n/a                        |
| `chat:home:updated`           | S→C (per-user)                         | n/a                                     | n/a                          | n/a                        |
| `chat:catchup`                | C→S                                    | n/a                                     | n/a                          | n/a                        |
| `chat:catchup:result`         | S→C                                    | n/a                                     | **yes (per event)**          | n/a                        |
| `chat:error`                  | S→C                                    | n/a                                     | n/a                          | conditional                |

### 6.2 Detailed event specs

Every payload schema below is exhaustive — these are the only fields the client parses. Extra fields are silently ignored (forward-compatible). Missing required fields → client drops the event with a log warning and continues.

---

#### `chat:auth` — C→S — handshake

```json
{
  "userId": "u_01HXYZABCDEF",
  "deviceId": "d_2026-05-26-pixel7",
  "accessToken": "<JWT>",
  "platform": "android" | "ios" | "web",
  "clientVersion": "1.4.0+42"
}
```

**Server response:** `chat:auth:ok` on success, `chat:error` then disconnect on failure.

---

#### `chat:auth:ok` — S→C — handshake ACK

```json
{
  "sessionId": "s_01HXYZQWERTY",
  "serverTime": 1779708607123
}
```

`serverTime` lets the client estimate clock skew for diagnostics (not used for ordering).

---

#### `chat:room:join` — C→S — subscribe to a room

```json
{
  "roomId": "r_01HXYZABCDEF",
  "type": "private" | "group" | "community",
  "lastKnownSeq": 1247
}
```

`lastKnownSeq` is the highest `seq` the client has locally for this room (or `0` if first time). Server can pre-batch any missed events into `chat:catchup:result` instead of requiring a separate `chat:catchup` round-trip — optimization, not required.

---

#### `chat:room:joined` — S→C — room ACK

```json
{
  "roomId": "r_01HXYZABCDEF",
  "type": "private",
  "latestSeq": 1289,
  "members": [
    {
      "userId": "u_a",
      "role": "Member" | "Mod" | "Admin" | "Owner",
      "joinedAt": 1779608000000
    }
  ],
  "isMember": true,
  "joinRequestState": null | "Pending" | "Rejected"
}
```

For community rooms with > 100 members, `members` may be empty or contain only the requesting user + admins; client falls back to REST for the full list.

---

#### `chat:room:leave` — C→S — unsubscribe

```json
{
  "roomId": "r_01HXYZABCDEF"
}
```

Idempotent. Server stops fanout to this session for this room. No ACK required.

---

#### `chat:message:send` — C→S — outbound new message

```json
{
  "roomId": "r_01HXYZABCDEF",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "text" | "image" | "video" | "audio" | "file" | "location" | "contact" | "sticker" | "system",
  "content": "hello world",
  "attachments": [
    {
      "id": "att_01HXYZ",
      "kind": "image",
      "url": "https://cdn.aimess.app/abc.jpg",
      "mime": "image/jpeg",
      "sizeBytes": 248192,
      "width": 1024,
      "height": 768,
      "durationMs": null,
      "thumbnailUrl": "https://cdn.aimess.app/abc_thumb.jpg"
    }
  ],
  "replyToServerId": "msg_01HXYZPRIOR",
  "metadata": { /* optional opaque object for replies, mentions, etc. */ }
}
```

**Notes:**

- `content` is required for `text`; may be empty string for media (caption goes in `content`).
- `attachments` is required for `image`/`video`/`audio`/`file`; empty for text. Media must be uploaded via the existing TUS pipeline FIRST (see `MEDIA_UPLOAD_BACKEND.md`); the `url` is the final CDN URL after upload completes.
- `replyToServerId` is optional; `null` if not a reply.
- `senderId` is NOT in the payload — the server reads it from the authenticated session (any client-supplied `senderId` MUST be ignored / overwritten).

**Server response:** `chat:message:ack` to sender; `chat:message:new` broadcast to all room members (including sender — see §9).

---

#### `chat:message:ack` — S→C (sender only) — message persisted

```json
{
  "roomId": "r_01HXYZABCDEF",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440000",
  "serverMessageId": "01HYZA1B2C3D4E5F6G7H8J9K0L",
  "seq": 1290,
  "serverTimestamp": 1779708610456
}
```

Sender-only. Confirms persistence. Client's outbox marks the row `SENT` and stamps `serverMessageId` + `seq`.

---

#### `chat:message:new` — S→C (broadcast incl. sender) — new message in room

```json
{
  "roomId": "r_01HXYZABCDEF",
  "serverMessageId": "01HYZA1B2C3D4E5F6G7H8J9K0L",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440000",
  "senderId": "u_a",
  "type": "text",
  "content": "hello world",
  "attachments": [],
  "replyToServerId": null,
  "seq": 1290,
  "serverTimestamp": 1779708610456,
  "editedAt": null,
  "deletedAt": null,
  "metadata": null
}
```

**Critical:** `clientMessageId` is included for messages where the sender was on this connection (so the sender's other devices and the sender itself can dedupe by `clientMessageId`). For messages NOT originated by anyone on the current platform (e.g. iOS user sending to Android user), `clientMessageId` MAY be `null` or omitted — the client falls back to dedupe by `serverMessageId`.

**Order of operations on receipt (client side):**

1. Look up local row by `clientMessageId`. If found → UPDATE in place (`sendStatus="SENT"`, set `serverMessageId`, set `seq`).
2. Else look up by `serverMessageId`. If found → no-op (already deduped via ACK).
3. Else INSERT a new row.

---

#### `chat:message:edit` — C→S — edit a message

```json
{
  "roomId": "r_01HXYZABCDEF",
  "serverMessageId": "01HYZA1B2C3D4E5F6G7H8J9K0L",
  "newContent": "hello world! (edited)"
}
```

Only the original sender can edit (server enforces). Server picks the next `editSeq` for this message, persists, broadcasts.

---

#### `chat:message:edit:updated` — S→C (broadcast) — edit fanout

```json
{
  "roomId": "r_01HXYZABCDEF",
  "serverMessageId": "01HYZA1B2C3D4E5F6G7H8J9K0L",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440000",
  "newContent": "hello world! (edited)",
  "editSeq": 3,
  "editedAt": 1779708680000,
  "seq": 1294
}
```

Client applies if `editSeq > localEditSeq`. Otherwise drops (stale edit out of order).

---

#### `chat:message:delete` — C→S — delete a message

```json
{
  "roomId": "r_01HXYZABCDEF",
  "serverMessageId": "01HYZA1B2C3D4E5F6G7H8J9K0L",
  "deletedFor": "everyone" | "me"
}
```

`"me"` — only the requester's view (server stores per-user; doesn't broadcast). `"everyone"` — only the original sender (or Mod/Admin in groups/communities); broadcasts a tombstone to all members.

---

#### `chat:message:delete:updated` — S→C (broadcast for `"everyone"`, sender's devices only for `"me"`)

```json
{
  "roomId": "r_01HXYZABCDEF",
  "serverMessageId": "01HYZA1B2C3D4E5F6G7H8J9K0L",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440000",
  "deletedFor": "everyone",
  "deletedAt": 1779708700000,
  "deletedByUserId": "u_a",
  "seq": 1295
}
```

Client soft-deletes the local row (sets `isDeleted=true`; UI shows tombstone "This message was deleted").

---

#### `chat:reaction:set` — C→S — add or remove a reaction

```json
{
  "roomId": "r_01HXYZABCDEF",
  "serverMessageId": "01HYZA1B2C3D4E5F6G7H8J9K0L",
  "emoji": "❤️",
  "op": "add" | "remove"
}
```

Server updates the message's reactions, picks a new `reactionVersion`, broadcasts.

---

#### `chat:reaction:updated` — S→C (broadcast) — authoritative reactions snapshot

```json
{
  "roomId": "r_01HXYZABCDEF",
  "serverMessageId": "01HYZA1B2C3D4E5F6G7H8J9K0L",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440000",
  "reactions": {
    "❤️": ["u_a", "u_c"],
    "👍": ["u_b"]
  },
  "reactionVersion": 7,
  "updatedAt": 1779708720000
}
```

**Always the full rolled-up state, NOT a delta.** Client replaces `messages.reactions` whenever `reactionVersion > localReactionVersion`. This is intentional — solves race conditions in concurrent reactions far simpler than diffs.

For community rooms with many reactions, server SHOULD coalesce reaction events with a 250ms debounce window to avoid flooding the channel.

---

#### `chat:read:upto` — C→S — mark messages read up to a seq

```json
{
  "roomId": "r_01HXYZABCDEF",
  "upToSeq": 1290,
  "deviceId": "d_2026-05-26-pixel7"
}
```

Server stores `(roomId, userId, deviceId) → upToSeq` (monotonic — ignore if `upToSeq <= storedUpToSeq`). Broadcasts `chat:read:updated` per §6.2 below.

**Multi-device:** the sender's OTHER devices receive the broadcast too — they update their unread badge to match.

---

#### `chat:read:updated` — S→C (broadcast — private + group only) — read state changed

```json
{
  "roomId": "r_01HXYZABCDEF",
  "userId": "u_b",
  "upToSeq": 1290,
  "deviceId": "d_pixel7_u_b",
  "readAt": 1779708740000
}
```

**Skip for community rooms.** Privacy + cost — community rooms can have thousands of members; broadcasting "Y read up to seq N" for every member would be a fanout nightmare.

For private/group: clients show ✓✓-accent when ALL members (incl. own other devices) have `upToSeq >= messageSeq`.

---

#### `chat:typing` — C→S, then S→C (broadcast minus sender)

C→S:

```json
{
  "roomId": "r_01HXYZABCDEF",
  "isTyping": true
}
```

S→C (broadcast):

```json
{
  "roomId": "r_01HXYZABCDEF",
  "userId": "u_a",
  "isTyping": true
}
```

**Server-side auto-clear:** if no `isTyping:true` arrives from `(roomId, userId)` for 5 seconds, server broadcasts `isTyping:false` automatically. This prevents stuck typing indicators when the typing user crashes/disconnects.

**Client throttle:** client emits `isTyping:true` at most once per 3 seconds while the composer has focus and contains characters.

**Not persisted.** No `seq`. Transient.

---

#### `presence:heartbeat` — C→S — keepalive + presence refresh

```json
{
  "userId": "u_a",
  "deviceId": "d_pixel7_u_a"
}
```

Every 25 seconds while connected. Server marks `(userId, deviceId)` online, refreshes a 60s TTL.

---

#### `presence:update` — S→C (fanout to friend graph)

```json
{
  "userId": "u_a",
  "status": "online" | "offline" | "away",
  "lastSeen": 1779708800000
}
```

Fanout target: the user's friend graph + everyone in any room with the user (server's call). Used by the chat top bar's "online" / "last seen recently" indicator.

`status: "away"` is optional — backend can omit it and only emit `online`/`offline`.

---

#### `chat:home:updated` — S→C (per-user) — home feed delta

Emitted to the recipient whenever any of their conversations has a change worth showing on the home list (new message, member added, last message edited, unread count changed, etc.). Server-pushed — no client request triggers it.

```json
{
  "roomId": "r_01HXYZABCDEF",
  "lastMessage": {
    "serverMessageId": "01HYZA1B2C3D4E5F6G7H8J9K0L",
    "senderId": "u_b",
    "type": "text",
    "contentPreview": "hello world",
    "seq": 1290,
    "serverTimestamp": 1779708610456
  },
  "unreadCount": 3,
  "isMuted": false,
  "isPinned": false,
  "updatedAt": 1779708610500
}
```

Client upserts the matching `ChatEntity` row in Room; Home UI repaints via `ChatDao.observeChats()` Flow.

**Why this is its own event** (not a side effect of `chat:message:new`): the home feed is conceptually a server-projected view. Server can change it independently (membership change, mute toggle, server-side de-spam). The client never derives the home preview from the message stream — it trusts this event.

For now, server should emit `chat:home:updated` synthetically whenever it emits `chat:message:new` to a member (or every N seconds as a batched digest, if fanout cost is a concern).

---

#### `chat:catchup` — C→S — request missed events on reconnect

```json
{
  "rooms": [
    { "roomId": "r_a", "sinceSeq": 1247 },
    { "roomId": "r_b", "sinceSeq": 891 }
  ]
}
```

Sent immediately after `chat:room:joined` on reconnect.

---

#### `chat:catchup:result` — S→C — paged stream of missed events

```json
{
  "roomId": "r_a",
  "events": [
    {
      "kind": "message",
      "seq": 1248,
      "payload": {
        /* chat:message:new shape */
      }
    },
    {
      "kind": "edit",
      "seq": 1249,
      "payload": {
        /* chat:message:edit:updated shape */
      }
    },
    {
      "kind": "delete",
      "seq": 1250,
      "payload": {
        /* chat:message:delete:updated shape */
      }
    },
    {
      "kind": "reaction",
      "seq": 1251,
      "payload": {
        /* chat:reaction:updated shape */
      }
    },
    {
      "kind": "read",
      "seq": 1252,
      "payload": {
        /* chat:read:updated shape */
      }
    }
  ],
  "hasMore": true,
  "nextCursor": "c_eyJhbGciOi..."
}
```

Strictly ordered ascending by `seq`. Client re-emits `chat:catchup` with `sinceSeq = max(seq in last page)` until `hasMore=false`.

**Page size:** server's call — 100 events is a reasonable default.

---

#### `chat:error` — S→C — NACK / error

```json
{
  "event": "chat:error",
  "forEvent": "chat:message:send",
  "code": "RATE_LIMITED" | "FORBIDDEN" | "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "INTERNAL" | "UNAUTHORIZED" | "VERSION_TOO_OLD" | "BANNED",
  "message": "<user-facing reason>",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440000"
}
```

If `forEvent == "chat:message:send"`, `clientMessageId` MUST be present so the outbox can mark the row `FAILED` with the right id.

---

## 7. Universal conventions

### 7.1 Field naming

- **All field names use `camelCase` exactly as documented.** No `snake_case`, no aliases (`clientId`, `_id`, `id`). The client parser will be tightened to reject unknown variants in a future release; today's tolerance is a migration crutch, not a contract.

### 7.2 Timestamps

- All `*At` / `*Timestamp` fields: `Long`, epoch milliseconds, **UTC**, **server-authoritative**.
- Client timestamps are advisory only — never used for ordering or conflict resolution.

### 7.3 Sender attribution

- `senderId` is the authenticated `userId` from the connection's session. Server **MUST** overwrite whatever the client sent before broadcasting. Client may include it (to make the protocol easier to debug) but the server is the source of truth.

### 7.4 IDs

- `clientMessageId`: UUIDv4 string (8-4-4-4-12 hex, lowercase). Client-generated. Persisted server-side. Echoed on every event referencing the message.
- `serverMessageId`: ULID string (26 chars). Server-generated. Opaque to client.
- `roomId`: opaque string. Server picks format.
- `userId`: opaque string. Server picks format.

### 7.5 Pagination

- Cursor-based, opaque cursor string. Client passes back unchanged.
- `hasMore: true` → client may request more; `false` → end of stream.

---

## 8. Idempotency, ordering, dedup

### 8.1 Idempotency keys per operation

| Operation             | Key                                              | Behaviour on duplicate                                                                                                        |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `chat:message:send`   | `clientMessageId`                                | Server returns the same `chat:message:ack` (with the original `serverMessageId` + `seq`). No second message inserted.         |
| `chat:message:edit`   | `(serverMessageId, editSeq)`                     | Server assigns `editSeq` itself; duplicates are detected by `(serverMessageId, last editSeq)`. Caller doesn't pass `editSeq`. |
| `chat:message:delete` | `(serverMessageId, deletedFor, requesterUserId)` | No-op if already deleted with same scope.                                                                                     |
| `chat:reaction:set`   | `(serverMessageId, userId, emoji, op)`           | Adding an existing reaction → no-op. Removing a non-existent reaction → no-op.                                                |
| `chat:read:upto`      | `(roomId, userId, upToSeq)`                      | Server stores `MAX(storedUpToSeq, requestedUpToSeq)`. Lower values silently dropped.                                          |
| `chat:typing`         | (none — transient)                               | Each emit is a refresh; server resets 5s TTL.                                                                                 |

### 8.2 Ordering

- **Within a room:** strict `seq` order. Server assigns `seq` at INSERT time; never reused.
- **Between rooms:** no global ordering. Each room has its own `seq` space.
- **Edits/deletes within a message:** `editSeq` (monotonic per message); last-write-wins by `editSeq`.
- **Reactions on a message:** `reactionVersion` (monotonic per message); each broadcast carries the FULL rolled-up state, so out-of-order arrival doesn't corrupt.
- **Read receipts:** `upToSeq` monotonic per `(roomId, userId, deviceId)`. Server stores `MAX(stored, incoming)`.

### 8.3 Client-side dedup rules

For `chat:message:new`:

```
1. Lookup local row by `clientMessageId` (if present in payload)
   → if found, UPDATE in place: serverMessageId, seq, sendStatus=SENT
2. Else lookup by `serverMessageId`
   → if found, no-op (already deduped)
3. Else INSERT new row
```

For `chat:message:edit:updated`:

```
1. Resolve local row by `clientMessageId` → fallback to `serverMessageId`
2. If `editSeq <= localEditSeq` → drop
3. Else update content + localEditSeq + editedAt
```

For `chat:message:delete:updated`:

```
1. Resolve local row by `clientMessageId` → fallback to `serverMessageId`
2. Soft-delete (set isDeleted=true) — never hard-delete
3. UI renders tombstone for `deletedFor:"everyone"`; hides row for `deletedFor:"me"`
```

For `chat:reaction:updated`:

```
1. Resolve local row by `clientMessageId` → fallback to `serverMessageId`
2. If `reactionVersion <= localReactionVersion` → drop
3. Else REPLACE local `reactions` map with payload + update localReactionVersion
```

---

## 9. The ACK + echo dedupe contract

This is the most critical correctness rule. If the backend gets this wrong, sender's bubbles either flicker (insert → update → insert) or duplicate (two rows for one message).

### 9.1 The contract

On every `chat:message:send`, the server MUST emit BOTH:

1. **`chat:message:ack`** — sender-only, fast path. Carries `clientMessageId` + `serverMessageId` + `seq` + `serverTimestamp`.
2. **`chat:message:new`** — broadcast to ALL room members **including the sender**, with `clientMessageId` echoed in the payload.

### 9.2 Why both?

- ACK lets the sender mark the bubble "✓ Sent" within ~100ms.
- The broadcast is what reaches the OTHER members (and the sender's other devices).
- Both pieces share `clientMessageId` so the sender's client can recognise the broadcast as its own and merge it into the existing local row.

### 9.3 The race

The two events arrive over the same socket but with no guaranteed order. The sender's client MUST handle both orderings:

**Case A: ACK arrives first (typical).**

```
1. Send → optimistic row PENDING with clientMessageId
2. chat:message:ack arrives → mark SENT, set serverMessageId + seq
3. chat:message:new arrives → dedupe by clientMessageId (UPDATE in place; no insert)
```

**Case B: `new` arrives first (rare, can happen on slow ACK path).**

```
1. Send → optimistic row PENDING with clientMessageId
2. chat:message:new arrives → dedupe by clientMessageId (UPDATE in place: status SENT, serverMessageId, seq)
3. chat:message:ack arrives → row already has serverMessageId; ACK is a no-op for state, but client may use it to confirm reliability
```

**Case C: only ACK arrives, no broadcast (backend bug — must not happen).**

```
1. Send → optimistic row PENDING
2. chat:message:ack arrives → mark SENT
3. (peer never receives — backend forgot to broadcast)
```

If the backend skips the broadcast for the sender (assuming "they already know"), Case C becomes invisible from the sender's POV but breaks peer delivery — DO NOT skip the broadcast.

### 9.4 Sequence diagram

```
Sender                Server                Peer (different device)
  │                     │                       │
  │── send ────────────►│                       │
  │   { clientMessageId,│ assign serverMessageId│
  │     content, ... }  │ + seq, persist        │
  │                     │                       │
  │◄── ack ─────────────│                       │
  │   { clientMsgId,    │                       │
  │     serverMsgId,    │                       │
  │     seq, ts }       │                       │
  │                     │                       │
  │◄── new ─────────────│── new ───────────────►│
  │   (echoed back —    │   { clientMsgId,      │
  │    sender dedupes   │     serverMsgId,      │
  │    by clientMsgId)  │     seq, content, ... }
  │                     │                       │
```

---

## 10. Scenario walkthroughs

Each scenario lists: **trigger → client expectation → server actions → other-side effects**.

### 10.1 Send a text message (private 1:1)

**Trigger:** user A types "hi" and taps send.

**Client (sender):**

1. Generates `clientMessageId = UUID.randomUUID()`.
2. Inserts local `MessageEntity` with `sendStatus="PENDING"`, `senderId=<userA>`, `chatId=<roomId>`, `content="hi"`, `clientMessageId=<id>`.
3. Updates `ChatEntity.lastMessage="hi"`, `.lastMessageTimestamp=now()`.
4. UI bubble appears on the right with clock icon (Sending).
5. Enqueues `chat:message:send` via the outbox.
6. When connected, emits `chat:message:send`.

**Server:**

1. Receives `chat:message:send` over the authenticated session.
2. Validates ACL: user A is a member of `roomId`.
3. Validates content (length, profanity, etc.) — emit `chat:error{code:"VALIDATION"}` if rejected.
4. Persists message with new `serverMessageId` (ULID) + `seq = nextSeq(roomId)`.
5. Updates room's `lastMessageSeq`, `lastMessageTimestamp`.
6. Emits `chat:message:ack` to user A's session (sender only).
7. Emits `chat:message:new` broadcast to ALL room members including user A (with `clientMessageId` echoed).
8. Emits `chat:home:updated` to user B (sender's home update happens implicitly via the broadcast they receive).

**User A's client:**

- ACK → bubble flips to "✓ Sent".
- Broadcast → dedupes by `clientMessageId`, updates row (no-op for state, but seq/serverMessageId are stamped).

**User B's client (peer):**

- Receives `chat:message:new`, inserts local row (not deduped — no `clientMessageId` match).
- Updates `ChatEntity` via `appendIncomingMessage` (preview + unread++ in one transaction).
- If chat is open: bubble appears on left; UI immediately fires `chat:read:upto`.
- If chat is closed: notification (FCM fallback) + unread badge ticks up on home.

### 10.2 Send a media message

Identical to text, except:

1. Client uploads file via TUS first → gets back `attachments[].url`.
2. Then `chat:message:send` with `type="image"` (or video/audio/file) and the `attachments` array populated.
3. Local row's `localFilePath` is also set (for cached display before CDN URL is reachable).

### 10.3 Receive a message (peer sends to you)

**Trigger:** peer B sends a message to room R.

**Server:**

1. As §10.1, emits `chat:message:new` broadcast to all room members.
2. Emits `chat:home:updated` to user A (the recipient).

**Your client (recipient):**

1. Receives `chat:message:new`. No `clientMessageId` match (this isn't your message) → no `serverMessageId` match → INSERT new row.
2. Bridge calls `chatDao.appendIncomingMessage(roomId, preview, ts, senderId)` — updates preview + bumps unread atomically.
3. UI: bubble appears on left if chat is open; home row floats to top with new preview + incremented unread badge.
4. If chat is open + visible: immediately emit `chat:read:upto { upToSeq: <new seq> }`.

### 10.4 Edit a message

**Trigger:** user A taps "Edit" on own message → changes text → submits.

**Client:**

1. Emit `chat:message:edit { serverMessageId, newContent }`.
2. (Optional) optimistic local edit: update content + show "(edited)" inline.

**Server:**

1. ACL: only the original sender can edit (server check `senderId == requester`).
2. Time-window check: only within 24h of `serverTimestamp` (configurable).
3. Update message row: `content = newContent`, `editedAt = now()`, `editSeq = nextEditSeq(serverMessageId)`, `seq = nextSeq(roomId)` (the room seq bumps because the room mutated).
4. Broadcast `chat:message:edit:updated` to all members.

**All clients (incl. sender's other devices):**

- Apply if `editSeq > localEditSeq`. Update content + show "(edited)" inline. **Don't bump `lastMessageTimestamp`** — edits don't change conversation order (unless this WAS the last message and content changed; then update `lastMessage` text in the home row but keep the old `lastMessageTimestamp`).

### 10.5 Delete a message

**Trigger:** user A long-presses own message → "Delete for everyone."

**Client:**

- Emit `chat:message:delete { serverMessageId, deletedFor: "everyone" }`.

**Server:**

1. ACL: original sender (or Mod/Admin in group/community).
2. Time-window check: within 1h of `serverTimestamp` (configurable; community Mods may have longer).
3. Mark `isDeleted=true`, `deletedAt=now()`, `deletedByUserId=<requester>`, bump `seq`.
4. Broadcast `chat:message:delete:updated` to all members.

**All clients:**

- Soft-delete local row. UI renders "This message was deleted" tombstone.
- If this was the last message: home row preview becomes "This message was deleted" (tombstone is visible in the list too).

For `deletedFor: "me"`:

- Server stores `(serverMessageId, userId) → hidden`. Does NOT broadcast.
- The requester's other devices receive `chat:message:delete:updated` with `deletedFor:"me"` (multi-device sync).

### 10.6 React to a message

**Trigger:** user A taps 👍 on a message.

**Client:**

- Optimistically updates local reactions map. Emit `chat:reaction:set { serverMessageId, emoji: "👍", op: "add" }`.

**Server:**

1. Update reactions on message (add userA to `reactions["👍"]`).
2. Increment `reactionVersion`.
3. Broadcast `chat:reaction:updated` with the FULL rolled-up reactions snapshot.

**All clients:**

- Replace local reactions if `reactionVersion > localReactionVersion`.

**Coalesce note:** in community chats with many concurrent reactions, server SHOULD debounce 250ms — collect multiple changes, broadcast one consolidated snapshot. This avoids per-tap broadcasts when a popular message gets 50 reactions in a second.

### 10.7 Read receipt (private)

**Trigger:** user B opens a chat with user A.

**User B's client:**

- On chat open: emit `chat:read:upto { roomId, upToSeq: <latest seq seen>, deviceId }`.
- Locally: `chatDao.markRead(roomId)` → unread badge zeros on home.

**Server:**

1. Store `(roomId, userB, deviceB) → upToSeq`. If incoming `upToSeq <= stored`, drop.
2. Broadcast `chat:read:updated { roomId, userId: "u_b", upToSeq, deviceId, readAt }` to all room members (including user B's other devices — multi-device sync).

**User A's client:**

- Receives `chat:read:updated { userId: "u_b", upToSeq: 1290 }`.
- For each message with `senderId == userA && seq <= upToSeq`: mark as "Read" (✓✓ accent color).

**User B's other devices:**

- Receive same broadcast → set their `chatDao.markRead` too → unread badge syncs.

### 10.8 Read receipt (group)

Same as private, except: UI shows ✓✓-accent ONLY when **all members** have `upToSeq >= messageSeq`. Otherwise ✓✓-gray (delivered). Long-press a message → per-member read sheet.

### 10.9 Read receipt (community)

**Server: do NOT broadcast `chat:read:updated` for community rooms.** Privacy + cost. Community read state stays local-only on the reading device.

### 10.10 Typing indicator

**Client (user A typing):**

- On first keystroke: emit `chat:typing { roomId, isTyping: true }`.
- Throttle: re-emit at most once per 3s.
- On send / blur: emit `chat:typing { roomId, isTyping: false }`.

**Server:**

- Forward to all room members EXCEPT user A.
- Auto-clear: if no `isTyping:true` from `(roomId, userA)` for 5s, broadcast `isTyping:false`.

**Receivers' clients:**

- Show "Alice is typing…" in chat header / row.
- Group: "Alice, Bob are typing…"; cap names at 2 + "and N others".
- **Never show your own typing.**

### 10.11 Presence (online / offline / last seen)

**Server tracks `(userId, deviceId)` online state via heartbeats.**

- Heartbeat received → `online`, refresh 60s TTL.
- TTL expires → `offline`, `lastSeen = now()`.
- Connect → `online` immediately, broadcast `presence:update`.
- Disconnect → only mark offline if no other sessions; broadcast `presence:update` after grace period.

**Fanout:**

- Friend graph: every user who has friended the target.
- Room co-members: every user who's in any room with the target.

**Client:**

- Chat top bar: `Online` / `Last seen recently` / `Last seen <time>` / hidden (if privacy off).

### 10.12 Unread count update

**Authoritative source:** the server's `chat:home:updated` payload. Client trusts it.

**Client may also derive optimistically:**

- On `chat:message:new` from peer in non-open chat: `unreadCount++` locally.
- On chat open: `unreadCount = 0` locally + emit `chat:read:upto`.

The server's next `chat:home:updated` overwrites the local value when it differs (server is source of truth).

### 10.13 Latest-message update for home

Same as §10.12 — server's `chat:home:updated` is authoritative. Server emits it on:

- New message (own or received).
- Edit of the latest message.
- Delete of the latest message (preview becomes tombstone or recomputed from prior surviving message).
- Membership change.
- Mute/pin toggle.

### 10.14 Conversation ordering

Always by `lastMessageTimestamp DESC`, with pinned chats first.

`lastMessageTimestamp` updates on:

- New message → yes.
- Edit → **no** (don't reorder).
- Delete-for-everyone → **no** (tombstone replaces preview but doesn't bump).
- Reaction → **no**.

### 10.15 Offline → online (catch-up)

**Trigger:** user comes back online after some downtime.

**Client:**

1. Reconnect → `chat:auth` → `chat:auth:ok`.
2. Re-join every previously-open room → `chat:room:join` (with `lastKnownSeq`).
3. For each room: `chat:catchup { rooms: [{ roomId, sinceSeq }] }`.

**Server:**

1. For each room, fetch all events with `seq > sinceSeq`.
2. Emit `chat:catchup:result` paginated, ordered by `seq` ascending.
3. Client re-requests until `hasMore=false`.

**Client applies events idempotently:**

- Messages → §8.3 dedup rules.
- Edits → apply if `editSeq > localEditSeq`.
- Deletes → soft-delete idempotently.
- Reactions → replace if `reactionVersion > localReactionVersion`.
- Reads → set local `upToSeq = MAX(local, incoming)`.

### 10.16 Force-quit then reopen

**Client cold-start:**

1. Load Room DB → UI repaints from cached state instantly (offline-first).
2. Read `OfflineQueueManager.PendingOperationDao.getPendingOps()` → re-emit any unsent messages once connected.
3. Connect → §10.15 catch-up resumes.

**Server side:** no special handling required — the catch-up flow covers reconnect-after-process-death same as reconnect-after-airplane-mode.

### 10.17 Multi-device read sync

**Trigger:** user A opens chat on device D1. Wants device D2 to know.

**Device D1:**

- Emit `chat:read:upto { roomId, upToSeq, deviceId: "D1" }`.

**Server:**

- Store `(roomId, userA, D1) → upToSeq`.
- Broadcast `chat:read:updated` to ALL members AND user A's other devices (D2).

**Device D2:**

- Receives `chat:read:updated { userId: "userA", upToSeq, deviceId: "D1" }`.
- If `D1 != self`: own device of own user → `chatDao.markRead(roomId)` to sync unread badge.

### 10.18 Sender-receives-own-broadcast dedupe (the critical one)

Already covered in §9, but worth restating:

**Sender's outbound `chat:message:send`** → server sends ACK + broadcast. Both arrive at the sender. Without correct client dedup, this causes a DUPLICATE row.

**Server's responsibility:** echo `clientMessageId` in the broadcast.
**Client's responsibility:** dedup by `clientMessageId` first.

The Android client already does this (`PrivateChatSocketBridge.handleIncomingMessage` checks `clientMessageId` before insert). The backend must hold up its end by echoing `clientMessageId`.

### 10.19 Failed send (network error)

**Client:**

1. Emit `chat:message:send`.
2. No ACK arrives within timeout (5s).
3. Retry up to 3x with backoff.
4. On final failure: mark local row `sendStatus="FAILED"`. UI shows red ⚠ on bubble + tap-to-retry.

**Server:** may emit `chat:error{forEvent:"chat:message:send", clientMessageId}` for permanent failures (validation, rate limit). For transient (server overloaded), don't NACK — client retries.

### 10.20 Server-initiated kick / ban

**Trigger:** admin bans user from community.

**Server:**

1. Remove user from room's member list.
2. Emit to the banned user: `chat:error{ code: "BANNED", forEvent: "chat:room:join", message: "You have been removed from this community." }`.
3. Optionally emit `chat:room:left { roomId, reason: "banned" }` to the banned user.
4. Other room members continue normally (no broadcast to them — that's an in-app moderation feature, not a wire event).

### 10.21 Force-logout

**Trigger:** admin force-logs-out a user, or user logged in from a 3rd device beyond limit.

**Server:**

- Emit `chat:error{ code: "FORCE_LOGOUT" }` then disconnect.

**Client:**

- Clear `dataStore.session`, navigate to login screen.

---

## 11. Chat-type-specific behaviour

### 11.1 Private (1:1)

- Members: exactly 2.
- `roomId` may be deterministic (e.g. `sha256(min(userA, userB) + max(userA, userB))`) so the room is auto-discovered.
- Read receipts: ✓✓-accent when peer has read.
- Typing: "Alice is typing…"
- Member can mute, archive, delete chat.

### 11.2 Group

- Members: 3 to ~500 (configurable limit).
- `roomId` is created at group creation via REST (`POST /chats/group`).
- Member role: `Owner`, `Admin`, `Member`.
- Read receipts: ✓✓-accent when **all** members have read. Long-press → per-member read sheet.
- Typing: "Alice, Bob are typing…" (cap 2 names + "+N others").
- Owner/Admin can: add/remove members, rename, change avatar, pin, delete-for-everyone any message.
- Member can: send messages, react, delete own messages.

### 11.3 Community

- Members: 500 to unlimited.
- `roomId` is created at community creation via REST.
- Member role: `Owner`, `Admin`, `Mod`, `Member`.
- **Read receipts: NOT broadcast.** Privacy + fanout cost. Read state stays local on the reading device.
- **Reactions: coalesce 250ms server-side.** Avoids broadcast flooding.
- Typing: optional — server may suppress typing fanout for community rooms over a threshold (e.g. 200 members).
- Owner/Admin/Mod can: ban members, pin messages, delete-for-everyone any message.
- Member can: send messages (subject to community rules), react, delete own messages.
- Membership models:
  - **Open** — anyone can join.
  - **Approval** — `chat:room:join` returns `chat:error{code:"PENDING_APPROVAL"}` (or a custom `joinRequestState:"Pending"` in `chat:room:joined`); admin must approve.
  - **Invite-only** — join only via invite link or admin invite.
- Live state: communities can have a "live stream" badge (`isLive: true` in `chat:room:joined`); the live stream itself is out of scope of chat socket.

---

## 12. Server-side data model

Reference schema (Postgres + Redis pattern; backend may use any equivalent stack).

### 12.1 Tables (Postgres)

**`users`** — user identity (existing — out of scope).

**`rooms`** — chat room metadata.

```sql
CREATE TABLE rooms (
  id                     TEXT PRIMARY KEY,            -- opaque room id
  type                   TEXT NOT NULL,               -- 'private' | 'group' | 'community'
  name                   TEXT,                        -- group/community name; null for private
  avatar_url             TEXT,
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             BIGINT NOT NULL,
  last_message_seq       BIGINT NOT NULL DEFAULT 0,   -- monotonic per room
  last_message_id        TEXT,                        -- ULID of last message
  last_message_at        BIGINT,                      -- ms
  metadata               JSONB                        -- extras: privacy mode, member-count, isLive, etc.
);
CREATE INDEX rooms_type_idx ON rooms (type);
CREATE INDEX rooms_last_message_at_idx ON rooms (last_message_at DESC);
```

**`room_members`** — user-in-room ACL.

```sql
CREATE TABLE room_members (
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,                -- 'Owner' | 'Admin' | 'Mod' | 'Member'
  joined_at      BIGINT NOT NULL,
  muted_until    BIGINT,                       -- null = not muted
  is_pinned      BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user_idx ON room_members (user_id);
```

**`messages`** — the wire message store.

```sql
CREATE TABLE messages (
  server_message_id      TEXT PRIMARY KEY,                -- ULID
  room_id                TEXT NOT NULL REFERENCES rooms(id),
  client_message_id      TEXT NOT NULL,                   -- echoed back to clients
  sender_id              TEXT NOT NULL REFERENCES users(id),
  type                   TEXT NOT NULL,                   -- 'text'|'image'|'video'|'audio'|'file'|'system'|...
  content                TEXT NOT NULL DEFAULT '',
  attachments            JSONB NOT NULL DEFAULT '[]'::JSONB,
  reply_to_server_id     TEXT,                            -- nullable
  seq                    BIGINT NOT NULL,                 -- monotonic per room
  server_timestamp       BIGINT NOT NULL,
  edited_at              BIGINT,
  edit_seq               BIGINT NOT NULL DEFAULT 0,       -- monotonic per message
  deleted_at             BIGINT,
  deleted_by_user_id     TEXT REFERENCES users(id),
  deleted_for            TEXT,                            -- null | 'everyone' | 'me' (set per-user in messages_deleted_for_me)
  reactions              JSONB NOT NULL DEFAULT '{}'::JSONB,  -- { "❤️": ["u_a", "u_b"], ... }
  reaction_version       BIGINT NOT NULL DEFAULT 0,
  metadata               JSONB,
  UNIQUE (room_id, client_message_id),                    -- idempotency
  UNIQUE (room_id, seq)
);
CREATE INDEX messages_room_seq_idx ON messages (room_id, seq DESC);
CREATE INDEX messages_room_ts_idx  ON messages (room_id, server_timestamp DESC);
```

**`messages_deleted_for_me`** — per-user soft-delete (for `deletedFor:"me"`).

```sql
CREATE TABLE messages_deleted_for_me (
  server_message_id TEXT NOT NULL REFERENCES messages(server_message_id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  deleted_at        BIGINT NOT NULL,
  PRIMARY KEY (server_message_id, user_id)
);
```

**`read_state`** — per-user, per-device read pointer.

```sql
CREATE TABLE read_state (
  room_id     TEXT NOT NULL REFERENCES rooms(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  device_id   TEXT NOT NULL,
  up_to_seq   BIGINT NOT NULL,
  read_at     BIGINT NOT NULL,
  PRIMARY KEY (room_id, user_id, device_id)
);
```

**`presence`** — online state (could also live in Redis).

```sql
CREATE TABLE presence (
  user_id          TEXT NOT NULL REFERENCES users(id),
  device_id        TEXT NOT NULL,
  status           TEXT NOT NULL,           -- 'online'|'offline'|'away'
  last_seen        BIGINT NOT NULL,
  last_heartbeat   BIGINT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
```

**Recommendation:** put `presence` in Redis with 60s TTL on heartbeat. Postgres is overkill for state that turns over every minute.

### 12.2 Per-room seq generator

Critical implementation detail. Wrong-by-one breaks ordering forever.

**Recommended Postgres approach** (atomic, no races):

```sql
-- Inside the transaction that inserts the message:
INSERT INTO messages (server_message_id, room_id, ..., seq)
SELECT
  $1, $2, ..., COALESCE(MAX(seq), 0) + 1
FROM messages
WHERE room_id = $2;

-- And inside the same transaction:
UPDATE rooms
SET last_message_seq = (SELECT MAX(seq) FROM messages WHERE room_id = $2),
    last_message_id = $1,
    last_message_at = $server_timestamp
WHERE id = $2;
```

Or use a per-room counter row in Redis (`INCR room:r_id:seq`) — faster but requires careful failover handling.

### 12.3 Reaction storage

`messages.reactions` is `JSONB` shaped `{ "<emoji>": ["<userId>", ...] }`. On every change, rebuild from scratch + bump `reaction_version`. Don't try to do JSONB-path mutations in SQL — too easy to corrupt the structure.

```sql
-- Add reaction:
UPDATE messages
SET reactions = jsonb_set(
      reactions,
      ARRAY[$emoji],
      COALESCE(reactions->$emoji, '[]'::jsonb) || to_jsonb(ARRAY[$user_id]),
      true
    ),
    reaction_version = reaction_version + 1
WHERE server_message_id = $sm_id
  AND NOT (reactions->$emoji ? $user_id);  -- skip if already reacted
```

(Server-side: simpler to deserialise, mutate in code, serialise, write back. SQL example shown for reference.)

### 12.4 Per-device fanout pattern

When emitting a broadcast, server needs to know which sessions to fan out to. Recommended Redis structure:

- `room:{roomId}:sessions` → SET of `sessionId`s currently subscribed.
- `session:{sessionId}` → HASH with `{ userId, deviceId, joinedAt, ... }`.
- `user:{userId}:sessions` → SET of `sessionId`s (for multi-device fanout).

On `chat:message:new`: `SMEMBERS room:{roomId}:sessions` → for each → emit. Cost is O(members online).

On `chat:room:join`: `SADD room:{roomId}:sessions {sessionId}` + `SADD session:{sessionId}:rooms {roomId}`.

On disconnect: clean up `session:{sessionId}` + remove from every `room:*:sessions` SET it was in.

---

## 13. Error contract

Every `chat:error` includes:

- `event: "chat:error"` (literal)
- `forEvent: "<original event name>"`
- `code: <one of below>`
- `message: <user-facing English>`
- `clientMessageId: <if forEvent was chat:message:send>`

| Code               | Meaning                                   | Client action                   |
| ------------------ | ----------------------------------------- | ------------------------------- |
| `UNAUTHORIZED`     | JWT invalid / expired                     | Disconnect + force re-login     |
| `VERSION_TOO_OLD`  | Client version older than min supported   | Show force-update screen        |
| `BANNED`           | User is banned from this room or globally | Disconnect / hide chat          |
| `FORBIDDEN`        | User lacks permission for this op         | Show error toast                |
| `NOT_FOUND`        | Room or message doesn't exist             | Refresh state                   |
| `VALIDATION`       | Payload failed validation                 | Show error toast with `message` |
| `RATE_LIMITED`     | Too many ops too fast                     | Backoff + retry                 |
| `CONFLICT`         | Edit/delete on stale state                | Refresh message state           |
| `INTERNAL`         | Server error                              | Retry with backoff              |
| `FORCE_LOGOUT`     | Server kicked this session                | Clear session + login           |
| `PENDING_APPROVAL` | Join request awaiting admin               | Show "Request sent" UI          |

---

## 14. Implementation checklist for backend dev

Use this as a sprint board.

### Sprint 1 — Connection + auth + basic send/receive

- [ ] Socket.IO namespace `/chat` listening on `${CHAT_SERVICE_URL}/chat` (path `/z-socket/`, WebSocket only).
- [ ] `chat:auth` handler: validate JWT, allocate sessionId, store `(sessionId, userId, deviceId)` in Redis.
- [ ] `chat:auth:ok` response.
- [ ] `chat:error` envelope + all codes from §13.
- [ ] `chat:room:join` / `chat:room:joined` with ACL check.
- [ ] `chat:room:leave`.
- [ ] `chat:message:send` C→S with idempotency by `(room_id, client_message_id)`.
- [ ] Per-room `seq` generator (atomic).
- [ ] `chat:message:ack` (sender-only).
- [ ] `chat:message:new` broadcast incl. sender, with `clientMessageId` echoed.
- [ ] Postgres schema from §12.1.

### Sprint 2 — Mutations

- [ ] `chat:message:edit` + `chat:message:edit:updated` (broadcast).
- [ ] `chat:message:delete` + `chat:message:delete:updated` (broadcast for `everyone`; sender's devices only for `me`).
- [ ] `chat:reaction:set` + `chat:reaction:updated` (broadcast).
- [ ] `chat:home:updated` (per-user) — emit synthetically on every `chat:message:new` to start.

### Sprint 3 — Read + typing + presence

- [ ] `chat:read:upto` + `chat:read:updated` (broadcast — skip for community rooms).
- [ ] `chat:typing` with server-side auto-clear after 5s of no refresh.
- [ ] `presence:heartbeat` C→S with 60s TTL.
- [ ] `presence:update` S→C fanout to friend graph + room co-members.

### Sprint 4 — Catch-up + production hardening

- [ ] `chat:catchup` + `chat:catchup:result` with pagination and `seq`-ordered replay.
- [ ] Rate limiting per `(userId, event)`.
- [ ] Reaction coalesce 250ms for community rooms.
- [ ] FCM push fallback when target user offline.
- [ ] Metrics: per-event latency, fanout cost per room type, reconnect storms.

### Hardening notes

- **Atomic message insert + seq + last_message_seq update** must happen in one transaction. Otherwise reordering on concurrent sends.
- **`chat:message:new` MUST include `clientMessageId`** when the sender is on the chat platform (Android/iOS/web client that sent it). For server-initiated messages (system, bot), `clientMessageId` MAY be null.
- **Don't broadcast `chat:read:updated` for community rooms.** Privacy + cost.
- **Don't trust client `senderId`** — overwrite from session.
- **All field names camelCase, exactly as documented.** No `_id`/`snake_case` aliases.

---

## 15. Test scenarios

These are concrete test cases the backend should pass. Listed in priority order (start with §15.1, work down).

### 15.1 Happy path send + ack + broadcast (private)

- User A and user B in room R.
- A sends `chat:message:send { clientMessageId: X, content: "hi" }`.
- **Assert:** A receives `chat:message:ack { clientMessageId: X, serverMessageId: Y, seq: 1 }`.
- **Assert:** A AND B receive `chat:message:new { clientMessageId: X, serverMessageId: Y, seq: 1 }`.

### 15.2 Idempotent send (resend same clientMessageId)

- A sends twice with same `clientMessageId: X`.
- **Assert:** Only ONE message in DB. ACK returns the SAME `serverMessageId` both times.
- **Assert:** B only receives ONE `chat:message:new`.

### 15.3 Sender-receives-own-broadcast

- A sends message. Receives ACK + new.
- **Assert:** `new`'s `clientMessageId` is non-null and matches sent.
- **Assert:** A's client (using the dedupe rule) inserts only ONE row.

### 15.4 Reconnect catch-up

- A sends 5 messages while B is connected. B disconnects. A sends 3 more.
- B reconnects, emits `chat:catchup { rooms: [{ roomId, sinceSeq: <seq of last received> }] }`.
- **Assert:** B receives `chat:catchup:result` with exactly the 3 missed messages, in `seq` order.

### 15.5 Catch-up pagination

- Like §15.4 but with 200 missed events.
- **Assert:** B receives multiple `chat:catchup:result` pages; first page has `hasMore: true`; cursor resumes correctly.

### 15.6 Edit ordering

- A sends message. Edits twice rapidly: "a" → "b" → "c".
- **Assert:** Broadcast events have `editSeq: 1, 2, 3` in order.
- **Assert:** Final message content is "c" (last edit wins by `editSeq`).

### 15.7 Reaction coalescing (community)

- 10 users tap reactions on same message within 200ms in a community room.
- **Assert:** Server broadcasts ONE `chat:reaction:updated` event with all 10 reactions, not 10 events.

### 15.8 Multi-device read sync

- A logged in on D1 and D2. B sends a message. A reads on D1.
- **Assert:** D2 receives `chat:read:updated { userId: A, upToSeq, deviceId: D1 }`.
- **Assert:** D2's unread count for this room becomes 0.

### 15.9 No read receipt broadcast in community

- Community room with 100 members. One reads.
- **Assert:** NO `chat:read:updated` is broadcast.

### 15.10 Typing auto-clear

- A sends `chat:typing { isTyping: true }`. Stops sending heartbeats.
- After 5s: **assert** server broadcasts `chat:typing { userId: A, isTyping: false }`.

### 15.11 Failed send retry

- A sends; server is overloaded and doesn't ACK within 5s.
- Client retries 3 times.
- **Assert:** server's idempotency by `clientMessageId` prevents 4 messages (still only 1).

### 15.12 ACL enforcement

- User C tries to join a private room between A and B.
- **Assert:** Server emits `chat:error { code: "FORBIDDEN", forEvent: "chat:room:join" }`.

### 15.13 Edit only by sender

- B tries to edit A's message in their shared private chat.
- **Assert:** Server emits `chat:error { code: "FORBIDDEN", forEvent: "chat:message:edit" }`.

### 15.14 Force-logout

- Admin force-logs-out user A.
- **Assert:** A receives `chat:error { code: "FORCE_LOGOUT" }`.
- **Assert:** Server disconnects A's socket.

### 15.15 Per-room seq monotonicity

- A and B send messages concurrently to the same room.
- **Assert:** `seq` values are strictly increasing, no gaps, no duplicates.

### 15.16 Soft-delete tombstone visible

- A sends. A deletes for everyone.
- **Assert:** B receives `chat:message:delete:updated`. Message persists in DB with `isDeleted=true`.
- **Assert:** Subsequent `chat:catchup:result` includes the deleted message marked `isDeleted` (so a re-syncing client knows to render the tombstone).

---

## 16. Glossary

- **ACK** — `chat:message:ack`, server's acknowledgement of a successful send (sender only).
- **Broadcast** — server fanout to all room members (including sender for `chat:message:new`).
- **Catch-up** — replay of events missed during disconnect, via `chat:catchup` / `chat:catchup:result`.
- **`clientMessageId`** — UUIDv4 generated by client; idempotency key for sends; echoed by server.
- **Dedup** — client merging two events that refer to the same logical message (own ACK + own broadcast echo, or two reconnect-replays of the same event).
- **`deviceId`** — opaque per-install identifier; lets server distinguish multiple devices of the same user.
- **`editSeq`** — monotonic per-message counter for edits; last-write-wins by `editSeq`.
- **Fanout** — server sending one event to many connected clients.
- **Idempotency key** — a value that lets the server detect + ignore duplicate operations.
- **Outbox** — client-side queue of pending operations waiting to flush over the wire; retries on reconnect.
- **`reactionVersion`** — monotonic per-message counter for reactions; broadcasts the full rolled-up state.
- **`seq`** — monotonic per-room counter assigned by server at message-insert time; canonical ordering key.
- **`serverMessageId`** — opaque ULID generated by server; primary key in `messages` table.
- **Session** — one WebSocket connection; bound to `(userId, deviceId, sessionId)`.
- **Sender echo** — server broadcasting `chat:message:new` to ALL room members, including the original sender. Sender's client must dedup against the local PENDING row by `clientMessageId`.
- **Tombstone** — placeholder row left after a "delete for everyone"; UI renders as "This message was deleted".
- **TTL** — time-to-live; e.g. presence is `online` while heartbeats keep refreshing a 60s TTL.

---

**Questions / contract changes:** open an issue or DM the client team. The Android client follows this spec verbatim — if you need to deviate, sync with us before shipping.
