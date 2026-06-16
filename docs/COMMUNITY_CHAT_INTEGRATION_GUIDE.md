# Community Chat — Frontend Integration Guide

> **Audience:** Frontend developers (mobile & web) implementing AIMess Community Chat.
> **Generated from:** live codebase audit of `apps/api-gateway`, `apps/chat-service`, `packages/constants`, `docs/MEDIA_UPLOAD.md`, and `asyncapi.yaml` — 2026-06-15.
> **Rule:** When this guide contradicts an older doc (`SOCKET_EVENTS.md`, `COMMUNITY-CHAT-EVENTS-AND-TESTS.md`, `asyncapi.yaml`), **this guide wins**. Those docs contain stale payload shapes documented in the mismatch report at the end.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Connection & Auth](#2-connection--auth)
3. [Phase 1 — Socket Event Audit](#phase-1--socket-event-audit)
4. [Phase 2 — REST API Audit](#phase-2--rest-api-audit)
5. [Phase 3 — Complete Chat Lifecycle Flow](#phase-3--complete-chat-lifecycle-flow)
6. [Phase 4 — Message Send Flow](#phase-4--message-send-flow)
7. [Phase 5 — Reply Flow](#phase-5--reply-flow)
8. [Phase 6 — Reaction Flow](#phase-6--reaction-flow)
9. [Phase 7 — Edit Message Flow](#phase-7--edit-message-flow)
10. [Phase 8 — Delete Message Flow](#phase-8--delete-message-flow)
11. [Phase 9 — Read Receipt Flow](#phase-9--read-receipt-flow)
12. [Phase 10 — Typing Indicator Flow](#phase-10--typing-indicator-flow)
13. [Phase 11 — Media Flow](#phase-11--media-flow)
14. [Phase 12 — Message Sync & Offline Recovery](#phase-12--message-sync--offline-recovery)
15. [Phase 13 — Error Handling Reference](#phase-13--error-handling-reference)
16. [Phase 14 — Contract Consistency Review](#phase-14--contract-consistency-review)
17. [Appendix A — Message Shape Reference](#appendix-a--message-shape-reference)
18. [Appendix B — Content Types](#appendix-b--content-types)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Client (Frontend)                    │
│  Socket.IO /community namespace  +  REST via gateway     │
└────────────────┬──────────────────────┬─────────────────┘
                 │ WebSocket            │ HTTP
                 ▼                      ▼
┌─────────────────────────────────────────────────────────┐
│               api-gateway (:8000)                        │
│  • /community namespace (Socket.IO)                      │
│  • Proxies /api/v1/chat/* → chat-service                 │
│  • Proxies /api/v1/media/* → media-service               │
└────────────┬──────────────────────────┬─────────────────┘
             │ gRPC :4004               │ HTTP proxy
             ▼                          ▼
┌────────────────────┐      ┌──────────────────────────────┐
│    chat-service    │      │        media-service          │
│  (:3004)           │      │  (:3007)                     │
│  MongoDB messages  │      │  MinIO presign/download       │
│  GeneralRoom model │      └──────────────────────────────┘
└────────┬───────────┘
         │ Redis pub/sub
         ▼
┌─────────────────────────────────────────────────────────┐
│  Redis channel: community:<communityId>                  │
│  Gateway subscribes via psubscribe("community:*")        │
│  and re-emits {event,data} to socket room community:<id> │
└─────────────────────────────────────────────────────────┘
```

**Key architectural facts:**

- Community messages are owned by **chat-service**, not community-service. Community-service handles membership/roles/bans; chat-service handles all messages.
- A community maps to exactly **one `GeneralRoom`** where `GeneralRoom.id === communityId`.
- Real-time events travel: chat-service → Redis pub → gateway → Socket.IO room `community:<communityId>`.
- Socket namespace: `/community`. Base path: `/community` at `<gatewayHost>/socket.io/`.
- REST base path: `/api/v1/chat/community/` (gateway proxies to chat-service).
- Media upload/download: `/api/v1/chat/media/` (proxied to chat-service/media-service).

---

## 2. Connection & Auth

### Socket.IO connection

```js
const socket = io("<gatewayHost>/community", {
  auth: { token: "<accessJWT>" }, // preferred
  // OR: extraHeaders: { Authorization: 'Bearer <accessJWT>' }
  transports: ["websocket"],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});
```

**What is set on the socket after auth** (`socket.data`):

| Field            | Type                | Source                                       |
| ---------------- | ------------------- | -------------------------------------------- |
| `userId`         | `string`            | JWT `userId` claim                           |
| `sessionId`      | `string`            | JWT `sessionId` claim                        |
| `locale`         | `"en"` or `"vi"`    | `x-lang` header → `accept-language` → `"en"` |
| `tokenExpiresAt` | `number` (epoch ms) | JWT `exp * 1000`                             |
| `accessToken`    | `string`            | raw JWT                                      |
| `userDetails`    | `SocketUserDetails` | resolved async via gRPC user snapshot        |

**`SocketUserDetails`**: `{ userId, username, displayName, avatarUrl: string | null }`

**On connect:** the gateway automatically joins the socket to `user:<userId>` (for personal pushes).

**On auth failure:** connection is rejected with `Error("Authentication required")` or `Error("Authentication failed")`.

### Locale

Include `x-lang: "vi"` in socket handshake headers for Vietnamese messages. Default is `"en"`. All ack `message` strings are localized.

### Ack envelope

Every emitted event that takes an ack callback receives one of these:

**Success** (with data):

```jsonc
{ "success": true, "message": "<localized string>", "data": { ... } }
```

**Success** (no data — e.g. join/leave):

```jsonc
{ "success": true, "message": "<localized string>" }
```

**Error:**

```jsonc
{
  "success": false,
  "error": "INVALID_PAYLOAD" | "SERVICE_ERROR" | "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMITED" | "CONFLICT",
  "retryable": true | false,
  "message": "<localized error string>"
}
```

**Retryable policy:**

| `error`           | `retryable` | When to use                                         |
| ----------------- | ----------- | --------------------------------------------------- |
| `INVALID_PAYLOAD` | `false`     | Fix the payload; retrying will fail again           |
| `SERVICE_ERROR`   | `true`      | Transient backend error; safe to retry with backoff |
| `FORBIDDEN`       | `false`     | Permissions denied; don't retry                     |
| `NOT_FOUND`       | `false`     | Resource not found                                  |
| `RATE_LIMITED`    | `true`      | Back off; retry after delay                         |
| `CONFLICT`        | `false`     | Action already applied                              |

---

## Phase 1 — Socket Event Audit

### Client → Server events

| Event                          | Ack? | Purpose                                                    | Payload                                                                                                                     | Error codes                                     |
| ------------------------------ | ---- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `community:join`               | Yes  | Join room `community:<communityId>` to receive broadcasts  | `{ communityId, roomId? }`                                                                                                  | `INVALID_PAYLOAD`                               |
| `community:leave`              | Yes  | Leave room `community:<communityId>`                       | `{ communityId }`                                                                                                           | `INVALID_PAYLOAD`                               |
| `community:message:send`       | Yes  | Send a message (text/media/location/contact/sticker/reply) | `{ communityId, roomId?, clientMessageId?, message, contentType, media?, location?, contact?, sticker?, parentMessageId? }` | `INVALID_PAYLOAD`, `SERVICE_ERROR`              |
| `community:messages:fetch`     | Yes  | Fetch paginated message history                            | `{ roomId, cursor?, limit? }`                                                                                               | `INVALID_PAYLOAD`, `SERVICE_ERROR`              |
| `community:catchup`            | Yes  | Reconnect sync for up to 10 rooms at once                  | `{ rooms: [{ roomId, sinceId?, sinceTs?, limit? }] }`                                                                       | `INVALID_PAYLOAD`                               |
| `community:message:react`      | Yes  | Toggle a reaction emoji on a message                       | `{ messageId, communityId, emoji }`                                                                                         | `INVALID_PAYLOAD`, `SERVICE_ERROR`              |
| `community:message:edit`       | Yes  | Edit own text message (within 15-min window)               | `{ messageId, communityId, roomId?, content: { text } }`                                                                    | `INVALID_PAYLOAD`, `SERVICE_ERROR`              |
| `community:message:delete`     | Yes  | Delete a message for self or everyone                      | `{ messageId, communityId, roomId?, type: "forEveryone"\|"forMe" }`                                                         | `INVALID_PAYLOAD`, `SERVICE_ERROR`              |
| `community:message:pin`        | Yes  | Pin a message (moderator/admin only)                       | `{ messageId, communityId, roomId? }`                                                                                       | `INVALID_PAYLOAD`, `SERVICE_ERROR`, `FORBIDDEN` |
| `community:message:unpin`      | Yes  | Unpin a message (moderator/admin only)                     | `{ messageId, communityId, roomId? }`                                                                                       | `INVALID_PAYLOAD`, `SERVICE_ERROR`, `FORBIDDEN` |
| `typing:start`                 | No   | Notify room user is typing                                 | `{ communityId, roomId?, senderName? }`                                                                                     | —                                               |
| `typing:stop`                  | No   | Notify room user stopped typing                            | `{ communityId, roomId?, senderName? }`                                                                                     | —                                               |
| `community.member.kick`        | Yes  | Kick a member (admin/moderator)                            | `{ communityId, targetUserId, reason? }`                                                                                    | `INVALID_PAYLOAD`, `SERVICE_ERROR`, `FORBIDDEN` |
| `community.member.ban`         | Yes  | Ban a member (admin/moderator)                             | `{ communityId, targetUserId, reason? }`                                                                                    | `INVALID_PAYLOAD`, `SERVICE_ERROR`, `FORBIDDEN` |
| `community.member.unban`       | Yes  | Unban a member (admin/moderator)                           | `{ communityId, targetUserId }`                                                                                             | `INVALID_PAYLOAD`, `SERVICE_ERROR`, `FORBIDDEN` |
| `community.admin.transfer`     | Yes  | Transfer admin rights                                      | `{ communityId, newAdminId }`                                                                                               | `INVALID_PAYLOAD`, `SERVICE_ERROR`, `FORBIDDEN` |
| `community.member.role_change` | Yes  | Change member role                                         | `{ communityId, targetUserId, newRole: "MODERATOR"\|"MEMBER" }`                                                             | `INVALID_PAYLOAD`, `SERVICE_ERROR`, `FORBIDDEN` |
| `community.report.create`      | Yes  | Report a message or community                              | `{ communityId, reason, targetMessageId? }`                                                                                 | `INVALID_PAYLOAD`, `SERVICE_ERROR`              |
| `community.delete`             | Yes  | Delete the community (admin only)                          | `{ communityId, reason? }`                                                                                                  | `INVALID_PAYLOAD`, `SERVICE_ERROR`, `FORBIDDEN` |

### Server → Client events

| Event                           | Direction   | Target                                          | Purpose                                                                                                                                                                                                                                                        | Payload                                                                                                    |
| ------------------------------- | ----------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `community:message:new`         | Broadcast   | `community:<communityId>` room                  | New message posted                                                                                                                                                                                                                                             | See [Appendix A — Live Broadcast Shape](#live-broadcast--send-response-shape)                              |
| `community:message:reaction`    | Broadcast   | `community:<communityId>` room                  | Reaction toggled                                                                                                                                                                                                                                               | `{ messageId, communityId, reactions: ReactionGroup[] }`                                                   |
| `community:message:edited`      | Broadcast   | `community:<communityId>` room                  | Message edited                                                                                                                                                                                                                                                 | `{ messageId, communityId, roomId, senderId, message, contentType, editedAt }`                             |
| `community:message:deleted`     | Broadcast   | `community:<communityId>` room                  | Message deleted                                                                                                                                                                                                                                                | `{ messageId, communityId, roomId, deleteType, deletedBy }`                                                |
| `community:message:pinned`      | Broadcast   | `community:<communityId>` room                  | Message pinned                                                                                                                                                                                                                                                 | `{ messageId, communityId, roomId, pinnedIds, pinnedCount, pinnedAt, pinnedBy }`                           |
| `community:message:unpinned`    | Broadcast   | `community:<communityId>` room                  | Message unpinned                                                                                                                                                                                                                                               | `{ messageId, communityId, roomId, pinnedIds, pinnedCount, unpinnedBy }`                                   |
| `community:catchup:result`      | Sender only | Emitting socket                                 | Catchup events per room                                                                                                                                                                                                                                        | `{ roomId, events: CatchupEvent[], hasMore, lastId, nextTs }`                                              |
| `community.deleted`             | Broadcast   | `community:<communityId>` room                  | Community deleted                                                                                                                                                                                                                                              | `{ communityId, deletedBy }`                                                                               |
| `community:member:joined`       | Broadcast   | `community:<communityId>` room                  | A member became ACTIVE (add_members, join-request approve/bulk-approve, invite-link redeem) — published by community-service                                                                                                                                   | `{ userId, username, displayName, avatarUrl\|null, role, joinedAt (epoch-ms) }`                            |
| `community:join_request:update` | Personal    | `user:<userId>` room on **`/notify`** namespace | An ADMIN/MODERATOR approved or rejected the user's join request — drives the FE state flip (pending → joined / rejected). A paired in-app `notification:new` (`community.join_request_approved` / `community.join_request_rejected`) is delivered alongside it | `{ communityId, requestId, status: "APPROVED"\|"REJECTED", communityName, decidedAt }`                     |
| `typing:start`                  | Broadcast   | `community:<communityId>` room                  | User started typing                                                                                                                                                                                                                                            | `{ conversationId, communityId, userId, userDetails, timestamp, senderName }`                              |
| `typing:stop`                   | Broadcast   | `community:<communityId>` room                  | User stopped typing                                                                                                                                                                                                                                            | same as `typing:start`                                                                                     |
| `community:updated`             | Personal    | `user:<userId>` room on **`/chat`** namespace   | Bump-to-top on new message                                                                                                                                                                                                                                     | `{ communityId, roomId, lastMessageId, lastMessage: {contentType,text}, lastMessageAt, senderId, unread }` |

> **Important:** `community:updated` is delivered on the **`/chat`** namespace, not `/community`. Clients must be connected to both namespaces to receive inbox list updates.

> **Join-request decisions are realtime — not REST/poll-only.** When an
> ADMIN/MODERATOR approves or rejects a user's community join request (single or
> bulk), the requester receives a `community:join_request:update` event on the
> **`/notify`** namespace (room `user:<userId>`) with payload
> `{ communityId, requestId, status: "APPROVED"|"REJECTED", communityName, decidedAt }`,
> plus a paired in-app `notification:new`
> (`community.join_request_approved` / `community.join_request_rejected`).
> The FE should flip the request UI state (pending → joined / rejected) off this
> socket event rather than polling the join-request status. On **approve**, the
> new member is additionally broadcast to the community room as
> `community:member:joined`.

---

## Phase 2 — REST API Audit

All paths below are the **public gateway paths** (prefix: `/api/v1/chat/community`).

Authentication: `Authorization: Bearer <accessJWT>` on all routes marked Auth=Yes.

Rate limit (send/react/edit/delete/pin/unpin): **30 requests / 60 seconds / user** → `429` on breach.

| #   | Method | Path                                                          | Auth | Purpose                                                        |
| --- | ------ | ------------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| 1   | GET    | `/rooms`                                                      | No   | List active community rooms (with `hasUnread` per authed user) |
| 2   | GET    | `/rooms/search?query=&page=&limit=`                           | No   | Search rooms by name                                           |
| 3   | POST   | `/rooms/:roomId/join`                                         | Yes  | Join a community room                                          |
| 4   | POST   | `/rooms/:roomId/leave`                                        | Yes  | Leave a community room                                         |
| 5   | GET    | `/rooms/:roomId/sync?since_ts=&limit=`                        | Yes  | Incremental sync: all mutations since epoch-ms timestamp       |
| 6   | GET    | `/rooms/:roomId/messages?before_ts=&after_ts=&around=&limit=` | Yes  | History (three modes: scroll, sync, jump-to-message)           |
| 7   | GET    | `/rooms/:roomId/conversation?pageNumber=&limit=&timestamp=`   | Yes  | Offset-paginated timeline; advances read pointer               |
| 8   | GET    | `/rooms/:roomId/media?type=&cursor=&limit=`                   | Yes  | Media-only listing with cursor pagination                      |
| 9   | GET    | `/rooms/:roomId/messages/search?q=&limit=&page=`              | Yes  | Full-text message search                                       |
| 10  | POST   | `/rooms/:roomId/messages`                                     | Yes  | Send a message (REST fallback)                                 |
| 11  | POST   | `/rooms/:roomId/read`                                         | Yes  | Mark room as read (coarse: read-to-now)                        |
| 12  | PATCH  | `/messages/:messageId`                                        | Yes  | Edit own text message (≤15 min window)                         |
| 13  | DELETE | `/messages/:messageId?type=forEveryone\|forMe`                | Yes  | Delete message                                                 |
| 14  | POST   | `/messages/:messageId/react`                                  | Yes  | Toggle reaction (add or remove)                                |
| 15  | POST   | `/rooms/:roomId/pins`                                         | Yes  | Pin a message (mod/admin only)                                 |
| 16  | DELETE | `/rooms/:roomId/pins/:messageId?communityId=`                 | Yes  | Unpin a message (mod/admin only)                               |
| 17  | GET    | `/rooms/:roomId/pins?cursor=&limit=`                          | Yes  | List pinned messages                                           |

**Media endpoints** (prefix: `/api/v1/chat/media`):

| Method | Path                  | Auth | Purpose                                   |
| ------ | --------------------- | ---- | ----------------------------------------- |
| POST   | `/media/upload-url`   | Yes  | Get a presigned PUT URL for upload        |
| POST   | `/media/download-url` | Yes  | Get a presigned GET URL for an object key |

**Media service cleanup** (prefix: `/api/v1/media`):

| Method | Path                                           | Auth | Purpose                                   |
| ------ | ---------------------------------------------- | ---- | ----------------------------------------- |
| DELETE | `/uploads/:objectKey?category=CHAT_ATTACHMENT` | Yes  | Cancel an upload (delete orphaned object) |

---

## Phase 3 — Complete Chat Lifecycle Flow

### STEP 1 — Discover communities

```
GET /api/v1/communities            (community-service REST — not chat-service)
```

Returns a paginated list of communities the user has joined or can discover. Note the `isJoined` flag (a single canonical field — `isCommunityJoined` / `isGroupJoined` aliases have been removed).

### STEP 2 — Connect to Socket.IO

```js
// Connect to BOTH namespaces — /community for chat events, /chat for inbox bumps
const commSocket = io(host + "/community", { auth: { token } });
const chatSocket = io(host + "/chat", { auth: { token } });
```

Listen for connection events:

```js
commSocket.on("connect", () => {
  /* proceed to STEP 3 */
});
commSocket.on("connect_error", (err) => {
  /* err.message: "Authentication failed" */
});
```

### STEP 3 — Join the community room

```js
commSocket.emit("community:join", { communityId }, (ack) => {
  if (ack.success) {
    // Now receiving broadcasts for community:<communityId>
  }
});
```

**Payload:** `{ communityId: string, roomId?: string }`

**Ack success:** `{ success: true, message: "Joined the community successfully" }` (no `data`)

### STEP 4 — Load initial message history

Choose one of two REST paths:

**Option A — Conversation (recommended for first load, advances read pointer):**

```
GET /api/v1/chat/community/rooms/:roomId/conversation?pageNumber=1&limit=30
```

**Option B — Timeline scroll (does NOT advance read pointer):**

```
GET /api/v1/chat/community/rooms/:roomId/messages?limit=30
```

Both return [`CommunityMessageWire[]`](#rest-read-history-shape) with `reactionGroups`, `readBy`, `deliveredTo`.

See [Phase 12](#phase-12--message-sync--offline-recovery) for pagination cursors.

### STEP 5 — Subscribe to real-time events

```js
commSocket.on("community:message:new", handleNewMessage);
commSocket.on("community:message:edited", handleEdit);
commSocket.on("community:message:deleted", handleDelete);
commSocket.on("community:message:reaction", handleReaction);
commSocket.on("community:message:pinned", handlePinned);
commSocket.on("community:message:unpinned", handleUnpinned);
commSocket.on("community.deleted", handleCommunityDeleted);
commSocket.on("typing:start", handleTypingStart);
commSocket.on("typing:stop", handleTypingStop);

// On /chat namespace — inbox bump
chatSocket.on("community:updated", handleInboxBump);
```

### STEP 6 — Mark room as read

```
POST /api/v1/chat/community/rooms/:roomId/read
Body: { "upToMessageId": "<any string — currently ignored by server, coarse read-to-now>" }
```

Response: `{ "success": true, "data": { "ok": true } }`

> The server marks all messages as read to "now" regardless of `upToMessageId`. Call this when the user focuses the chat screen.

### STEP 7 — Disconnect (app background / navigate away)

```js
commSocket.emit("community:leave", { communityId }, (ack) => {
  /* optional */
});
// or simply disconnect:
commSocket.disconnect();
```

---

## Phase 4 — Message Send Flow

### 4.1 Socket send (primary path)

**Emit:**

```js
commSocket.emit(
  "community:message:send",
  {
    communityId: "6843e1a2b5c3d4e5f6a7b8c9",
    roomId: "6843e1a2b5c3d4e5f6a7b8c9", // optional; defaults to communityId
    clientMessageId: "<uuid>", // idempotency key — generate client-side
    message: "Hello everyone!", // text body; empty string "" is valid for media
    contentType: "TEXT", // UPPER-CASE (see Appendix B)
  },
  (ack) => {
    if (ack.success) {
      const msg = ack.data; // same shape as community:message:new
      // msg.id, msg.sequenceNumber, msg.sentAt
    } else {
      // ack.error: "SERVICE_ERROR" (retryable) | "INVALID_PAYLOAD"
    }
  }
);
```

**Full payload schema:**

```jsonc
{
  "communityId": "string (required)",
  "roomId": "string (optional, defaults to communityId)",
  "clientMessageId": "string (optional, recommended — UUID for dedup)",
  "message": "string (max 4000 chars, default '')",
  "contentType": "TEXT|IMAGE|VIDEO|AUDIO|VOICE|DOCUMENT|GIF|STICKER|LOCATION|CONTACT",
  "media": {
    // for IMAGE, VIDEO, AUDIO, etc.
    "files": [
      {
        "objectKey": "chat-uploads/<userId>/<uuid>.jpg", // from upload-url response
        "url": "https://…", // alternative to objectKey (for GIFs/stickers)
        "name": "photo.jpg",
        "mime": "image/jpeg",
        "size": 204800, // bytes
        "width": 1080, // images/video
        "height": 720,
        "durationMs": 0, // audio/video ms
        "blurhash": "LEHV6nWB2yk8pyo0adR*.7kCMdnj", // image/video blur preview
        "waveform": [], // voice note amplitude bars (max 2048)
      },
    ],
  },
  "location": {
    "lat": 10.762622,
    "lng": 106.660172,
    "placeName": "HCMC",
    "placeAddress": "...",
  },
  "contact": {
    "name": "Nguyen Van A",
    "phone": "+84901234567",
    "avatar": "https://...",
    "userId": "...",
  },
  "sticker": {
    "objectKey": "stickers/pack1/001.webp",
    "url": "https://...",
    "packId": "pack1",
    "stickerId": "001",
  },
  "parentMessageId": "<objectId string>", // for replies — see Phase 5
}
```

**Limits:**

- `message` max 4000 chars
- `media.files` max 30 entries
- `emoji` max 32 graphemes
- Images: max 10 per message

**Ack success:** `{ success: true, message: "Message sent successfully", data: <community:message:new shape> }`

### 4.2 Server processing

1. Validates payload (Zod); invalid → `INVALID_PAYLOAD` ack.
2. Forwards to chat-service via gRPC with `senderId = authenticated userId` (client cannot spoof sender).
3. chat-service checks room is active (not suspended/disabled).
4. Allocates a monotonic `sequenceNumber`.
5. Persists message.
6. Checks idempotency: if `clientMessageId` already exists → returns existing message (`alreadySent: true`, HTTP 200 on REST path).
7. Publishes `community:message:new` to Redis → gateway re-emits to room `community:<communityId>`.
8. Publishes `community:updated` → gateway emits to all active members' `user:<userId>` rooms on `/chat`.

### 4.3 Broadcast received by all members

```js
commSocket.on("community:message:new", (msg) => {
  // msg shape: see Appendix A — Live Broadcast Shape
  console.log(
    msg.id,
    msg.senderId,
    msg.content.text,
    msg.contentType,
    msg.sentAt
  );
});
```

**If the sender receives their own message via broadcast, deduplicate** by comparing `clientMessageId` against pending sends.

### 4.4 REST fallback (when socket unavailable)

```
POST /api/v1/chat/community/rooms/:roomId/messages
Authorization: Bearer <token>
Content-Type: application/json

{
  "communityId":     "<communityId>",
  "message":         "Hello",
  "messageType":     "text",            // NOTE: lowercase on REST (normalized server-side)
  "clientMessageId": "<uuid>",
  "parentMessageId": null,
  "media": { "files": [...] }
}
```

**Response 201 (new):**

```jsonc
{
  "success": true,
  "message": "Message sent",
  "data": {
    "id": "...",
    "messageId": "...",
    "communityId": "...",
    "roomId": "...",
    "senderId": "...",
    "senderName": "...",
    "senderAvatar": "<presigned URL>",
    "content": { "text": "Hello", "files": [] },
    "message": "Hello",
    "contentType": "TEXT",
    "clientMessageId": "...",
    "serverTs": 1718438400000,
    "sentAt": 1718438400000,
    "sequenceNumber": 42,
    "reactions": [],
    "quoteData": null,
    "parentMessageId": "",
    "idempotent": false,
  },
}
```

**Response 200 (idempotent replay):** same shape with `"idempotent": true`.

> On REST `messageType` input is **lower-case** and case-insensitive (`"text"`, `"image"`, etc.). All responses use **UPPER-CASE** `contentType`.

### 4.5 Error cases

| Scenario                    | Error                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------- |
| Empty/missing `contentType` | `INVALID_PAYLOAD` ack                                                                   |
| `message` > 4000 chars      | `INVALID_PAYLOAD` ack (socket) / `400 { error: { code: "CHAT_TEXT_TOO_LONG" } }` (REST) |
| Community suspended         | `SERVICE_ERROR` ack (socket) / `403 COMMUNITY_SUSPENDED` (REST)                         |
| Community room missing      | `SERVICE_ERROR` ack (socket) / `403 COMMUNITY_CHAT_DISABLED` (REST)                     |
| > 10 images in one message  | `INVALID_PAYLOAD` ack (socket) / `400 CHAT_IMAGE_COUNT_EXCEEDED` (REST)                 |
| File too large              | `400 CHAT_FILE_TOO_LARGE` (REST)                                                        |
| Rate limit exceeded         | `429` response (REST); no socket rate limit currently                                   |

---

## Phase 5 — Reply Flow

A reply is a send with `parentMessageId` set. There is no separate event.

### 5.1 Socket emit (reply)

```js
commSocket.emit(
  "community:message:send",
  {
    communityId: "<communityId>",
    clientMessageId: "<uuid>",
    message: "Replying to that!",
    contentType: "TEXT",
    parentMessageId: "<objectId of original message>", // the only addition
  },
  (ack) => {
    /* same as normal send */
  }
);
```

### 5.2 quoteData in broadcasts

When a reply is sent, `community:message:new` contains `quoteData`:

```jsonc
{
  "id": "...", "communityId": "...",
  "parentMessageId": "<originalMessageId>",
  "quoteData": {
    "messageId":   "",           // empty for community messages (legacy storage)
    "senderId":    "",           // empty for community messages (legacy storage)
    "senderName":  "Nguyen Van A",
    "messageType": "",           // empty for community messages
    "preview":     "Original message text here",
    "isDeleted":   false
  },
  "content": { "text": "Replying to that!", "files": [] },
  ...
}
```

> **Community-specific limitation:** `quoteData.messageId`, `senderId`, and `messageType` are empty strings for community replies because the server stores only `{message, senderName}` in the quote snapshot. If you need to navigate to the original message, use `parentMessageId` (the ObjectId) and fetch it separately.

### 5.3 REST fallback

Same as message send; include `parentMessageId` in body.

### 5.4 quoteData in REST history

REST read paths (history/conversation) return `quoteData` in the **raw stored shape** (not the canonical shape above):

```jsonc
"quoteData": { "message": "Original text", "senderName": "Nguyen Van A" }
```

Normalize this in your model layer to be consistent with the live shape.

---

## Phase 6 — Reaction Flow

### 6.1 Toggle reaction via socket

```js
commSocket.emit(
  "community:message:react",
  {
    messageId: "<objectId>",
    communityId: "<communityId>",
    emoji: "👍", // max 32 graphemes
  },
  (ack) => {
    if (ack.success) {
      // ack.data = { messageId, communityId, reactions: ReactionGroup[] }
    }
  }
);
```

**Toggle semantics:** sending the same emoji twice removes the reaction. There is no separate "remove" event.

### 6.2 Broadcast received

```js
commSocket.on(
  "community:message:reaction",
  ({ messageId, communityId, reactions }) => {
    // reactions: ReactionGroup[]
    // Replace the message's reactions in your local store entirely with this array
  }
);
```

**`ReactionGroup[]` shape:**

```jsonc
[
  {
    "emoji": "👍",
    "count": 3,
    "users": [
      { "userId": "...", "displayName": "...", "avatar": "<presigned URL>" },
    ],
  },
]
```

**To check if the current user has reacted:** `reaction.users.some(u => u.userId === myUserId)`.

> **Warning:** `users[].avatar` in the reaction broadcast from message history may be an empty string (reactors are stored without names/avatars at insert time). The **REST react endpoint** enriches them via a user snapshot lookup; the socket reaction broadcast from `community:message:reaction` also carries enriched data. Fresh send `community:message:new` always has `reactions: []`.

### 6.3 REST fallback

```
POST /api/v1/chat/community/messages/:messageId/react
Authorization: Bearer <token>

{ "communityId": "<communityId>", "emoji": "👍" }
```

**Response 200:**

```jsonc
{
  "success": true,
  "message": "Message edited",           // ⚠️ known typo: should be "Message reacted"
  "data": {
    "messageId":   "...",
    "communityId": "...",
    "reactions":   [ <ReactionGroup[]> ]  // enriched with displayName + avatar
  }
}
```

### 6.4 Error cases

| Scenario                        | Error                                    |
| ------------------------------- | ---------------------------------------- |
| Message not found or cross-room | `404 { code: "CHAT_MESSAGE_NOT_FOUND" }` |
| Message already deleted         | `400 CHAT_MESSAGE_ALREADY_DELETED`       |
| Not an active member            | `403 CHAT_NOT_A_MEMBER`                  |

---

## Phase 7 — Edit Message Flow

### 7.1 Socket emit

```js
commSocket.emit(
  "community:message:edit",
  {
    messageId: "<objectId>",
    communityId: "<communityId>",
    roomId: "<roomId>", // optional
    content: { text: "Updated text here" },
  },
  (ack) => {
    if (ack.success) {
      // ack.data = { messageId, communityId, roomId, senderId, message, contentType, editedAt }
    }
  }
);
```

### 7.2 Broadcast received

```js
commSocket.on("community:message:edited", (payload) => {
  const {
    messageId,
    communityId,
    roomId,
    senderId,
    message,
    contentType,
    editedAt,
  } = payload;
  // editedAt is epoch ms (number)
  // Update the message body in your local store; set an "edited" indicator
});
```

**`community:message:edited` payload:**

```jsonc
{
  "messageId": "<objectId>",
  "communityId": "<communityId>",
  "roomId": "<roomId>",
  "senderId": "<userId>",
  "message": "Updated text here",
  "contentType": "TEXT",
  "editedAt": 1718438500000,
}
```

### 7.3 REST fallback

```
PATCH /api/v1/chat/community/messages/:messageId
Authorization: Bearer <token>

{
  "communityId": "<communityId>",
  "content": { "text": "Updated text" }
}
```

**Response 200:** returns the full updated `CommunityMessageWire` (REST read shape, not the canonical live shape).

### 7.4 Validation rules

| Rule                               | Error                              |
| ---------------------------------- | ---------------------------------- |
| Not your own message               | `400 CHAT_EDIT_OWN_MESSAGES_ONLY`  |
| Message is not `contentType: TEXT` | `400 CHAT_EDIT_TEXT_ONLY`          |
| Message already deleted            | `400 CHAT_MESSAGE_ALREADY_DELETED` |
| More than 15 minutes since send    | `410 CHAT_EDIT_WINDOW_EXPIRED`     |
| Text > 4000 chars                  | `400 CHAT_TEXT_TOO_LONG`           |
| Text empty                         | `400` (Zod: `text` min 1)          |
| Cross-room access                  | `404 CHAT_MESSAGE_NOT_FOUND`       |

**Show an edit timer UI:** the edit window is exactly 15 minutes from `sentAt`. After that, the edit option should be disabled.

---

## Phase 8 — Delete Message Flow

### 8.1 Socket emit

```js
// Delete for everyone (requires: you are the sender, OR you are admin/moderator)
commSocket.emit(
  "community:message:delete",
  {
    messageId: "<objectId>",
    communityId: "<communityId>",
    type: "forEveryone", // or 'forMe'
  },
  (ack) => {
    if (ack.success) {
      // ack.data = { messageId, communityId, roomId, deleteType, deletedBy }
    }
  }
);
```

### 8.2 Broadcast received

```js
commSocket.on("community:message:deleted", (payload) => {
  const { messageId, communityId, roomId, deleteType, deletedBy } = payload;
  if (deleteType === "forEveryone") {
    // Remove/tombstone the message for all users
    // The message text is NOT cleared server-side — only deletedForAll=true is set
    // Your UI should show "Message deleted" placeholder
  } else {
    // 'forMe' — only the sender's client deletes it from their own view
    // No broadcast is sent to other users for forMe deletes
  }
});
```

> **Soft delete:** `deleteType: "forEveryone"` sets `deletedForAll: true` on the stored document but **does not erase** the message text. The server sends a broadcast; the frontend is responsible for replacing the display with a tombstone.

### 8.3 REST fallback

```
DELETE /api/v1/chat/community/messages/:messageId?type=forEveryone
Authorization: Bearer <token>
```

No request body. `type` query param: `"forEveryone"` → delete for all; anything else → delete for me.

**Response 200:**

```jsonc
{
  "success": true,
  "data": <CommunityMessageWire>   // the tombstoned/updated message (or null if not found)
}
```

### 8.4 Delete-for-me vs delete-for-everyone

| `type`          | Who can do it                                  | Broadcast sent                      | Other users see              |
| --------------- | ---------------------------------------------- | ----------------------------------- | ---------------------------- |
| `"forMe"`       | Any active member                              | No broadcast                        | No change                    |
| `"forEveryone"` | Sender always; admin/moderator for any message | `community:message:deleted` to room | Tombstone (message replaced) |

### 8.5 Error cases

| Scenario                                            | Error                               |
| --------------------------------------------------- | ----------------------------------- |
| Message not found / cross-room                      | `404 CHAT_MESSAGE_NOT_FOUND`        |
| Delete-for-all by non-sender without mod/admin role | `400 CHAT_INSUFFICIENT_PERMISSIONS` |

---

## Phase 9 — Read Receipt Flow

Community read receipts are **coarser** than private/group chat. There are no per-message receipts and **no socket broadcast** on mark-read.

### 9.1 Mark room as read

```
POST /api/v1/chat/community/rooms/:roomId/read
Authorization: Bearer <token>

{ "upToMessageId": "<any string>" }   // body required but upToMessageId is ignored
```

**Effect:** Sets the caller's `lastReadAt = now()` in the room member table.

**Response:** `{ "success": true, "data": { "ok": true } }`

**When to call:** when the user opens the chat screen and when they scroll to the bottom.

### 9.2 Unread count

The `community:updated` push on `/chat` includes an `unread` flag. The rooms list (GET `/rooms`) returns `hasUnread: boolean` per room derived from `lastMessageAt > lastReadAt`.

### 9.3 readBy / deliveredTo in REST history

REST read paths (history/conversation/search) include:

```jsonc
"readBy":      [ { "userId": "...", "readAt": 1718438400000 } ],
"deliveredTo": [ { "userId": "...", "deliveredAt": 1718438400000 } ]
```

- `readBy` = active members whose `lastReadAt >= message.createdAt`
- `deliveredTo` = all active members whose `joinedAt <= message.createdAt` (deliveredAt = message createdAt)
- These are **not available** in the live `community:message:new` broadcast (which has `reactions: []` and no readBy/deliveredTo)

### 9.4 No socket mark-read event

Unlike private/group chat, the `/community` namespace has **no `message:read` socket event**. Read state is REST-only and has no real-time broadcast.

---

## Phase 10 — Typing Indicator Flow

### 10.1 Start typing

```js
// Emit when user begins typing (debounce: emit once, not on every keystroke)
commSocket.emit("typing:start", {
  communityId: "<communityId>",
  senderName: "Nguyen Van A", // optional display name hint
});
// No ack — fire and forget
```

**Server auto-stop:** the server sets a **6-second timer** per (socket, communityId). If `typing:stop` is not received within 6 s, it broadcasts `typing:stop` automatically. Reset the timer by re-emitting `typing:start`.

### 10.2 Stop typing

```js
commSocket.emit("typing:stop", { communityId: "<communityId>" });
// No ack — fire and forget
```

**Also call on:** message sent, input cleared, component unmount, app backgrounded.

### 10.3 Broadcasts received

```js
commSocket.on("typing:start", (payload) => {
  const { communityId, userId, userDetails, senderName, timestamp } = payload;
  // Show "<senderName> is typing…" indicator
  // Start a local 7-second timeout (slightly longer than the 6 s server timer)
  // to auto-clear in case the stop event is missed
});

commSocket.on("typing:stop", (payload) => {
  const { communityId, userId } = payload;
  // Remove the typing indicator for this userId
});
```

**Broadcast payload shape (both `typing:start` and `typing:stop`):**

```jsonc
{
  "conversationId": "<communityId>",
  "communityId": "<communityId>",
  "userId": "<string>",
  "userDetails": {
    "userId": "<string>",
    "username": "<string>",
    "displayName": "<string>",
    "avatarUrl": "<presigned URL | null>",
  },
  "timestamp": 1718438400000,
  "senderName": "<displayName or fallback>",
}
```

### 10.4 Expected frontend behavior

```
User types keystroke 1 → emit typing:start (start debounce timer)
User types keystroke 2–N → (debounce: no re-emit while timer running)
After 4s of inactivity → emit typing:stop
User submits message → emit typing:stop immediately

On receiving typing:start from userId X:
  → Show "X is typing…"
  → Start 7s safety timeout

On receiving typing:stop from userId X OR safety timeout fires:
  → Hide "X is typing…"
```

**Multiple typists:** accumulate a `Map<userId, TypingState>` and show "A, B are typing…".

**Own typing events:** the broadcast goes to the **whole room including the sender** (gateway uses `community.to(room).emit`, not `socket.to(room).emit`). Filter by `userId !== myUserId`.

> `userId` is **always present** in the typing payload (set from `socket.data.userId`). The `senderName` is a soft hint from the client; prefer `userDetails.displayName` for display.

---

## Phase 11 — Media Flow

File bytes **never** travel over the socket or through the gateway. The pattern is: presign → PUT to MinIO → reference `objectKey` in a message.

### 11.1 Step 1 — Request presigned upload URL

```
POST /api/v1/chat/media/upload-url
Authorization: Bearer <token>

{
  "filename":    "vacation.jpg",
  "contentType": "image/jpeg"
}
```

**Response 200:**

```jsonc
{
  "success": true,
  "data": {
    "objectKey": "chat-uploads/<userId>/<uuid>.jpg",
    "uploadUrl": "https://minio.example.com/chat-uploads/…?X-Amz-Signature=…",
    "contentType": "image/jpeg",
    "media": {
      "fileId": "<uuid>",
      "objectKey": "chat-uploads/<userId>/<uuid>.jpg",
      "fileName": "vacation.jpg",
      "contentType": "image/jpeg",
      "uploadUrl": "https://minio…",
      "uploadUrlExpiresIn": 300, // seconds (5 minutes)
      "uploadHeaders": { "Content-Type": "image/jpeg" },
      "downloadUrl": "https://minio…?X-Amz-Signature=…", // instant preview after PUT
      "downloadUrlExpiresIn": 3600, // seconds (~1 hour)
    },
  },
}
```

- `objectKey` is server-generated and owner-scoped. Never construct it yourself.
- `media.downloadUrl` is a short-lived presigned GET. Use it for an instant preview after upload. **Never persist it.**
- Upload URL expires in 5 minutes. If the PUT has not started by then, re-request.

### 11.2 Step 2 — PUT bytes to MinIO

```
PUT <uploadUrl>
Content-Type: image/jpeg

<raw bytes>
```

Include the headers from `media.uploadHeaders` (at minimum `Content-Type`). No auth header needed — the presigned URL contains credentials.

**Allowed MIME types (chat attachments):**

| Kind     | MIME types                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image    | `image/jpeg`, `image/png`, `image/webp`, `image/gif`                                                                                                                                                                                                                                                                                                                                               |
| Video    | `video/mp4`, `video/quicktime`, `video/x-matroska`, `video/webm`, `video/x-msvideo`, `video/x-m4v`                                                                                                                                                                                                                                                                                                 |
| Audio    | `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/mp4`, `audio/x-m4a`, `audio/aac`, `audio/flac`                                                                                                                                                                                                                                                                                                      |
| Document | `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `text/plain`, `text/csv`, `application/json`, `application/xml` |

Size limits are enforced at **send time**, not upload time. Check client-side before uploading.

**On PUT failure:** retry against the same `uploadUrl` if still valid. If expired, re-request from Step 1.

### 11.3 Step 3 — Send message with attachment

After a successful `200` PUT, include the `objectKey` in the message send:

```js
commSocket.emit("community:message:send", {
  communityId: "<communityId>",
  clientMessageId: "<uuid>",
  message: "", // empty string is fine for media-only messages
  contentType: "IMAGE", // UPPER-CASE
  media: {
    files: [
      {
        objectKey: "chat-uploads/<userId>/<uuid>.jpg",
        name: "vacation.jpg",
        mime: "image/jpeg",
        size: 204800,
        width: 1080,
        height: 720,
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", // computed client-side
        durationMs: 0,
        waveform: [],
      },
    ],
  },
});
```

### 11.4 Per-content-type guidance

| contentType | Field                                                     | Client responsibility                                         |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `IMAGE`     | `width`, `height`, `blurhash`                             | Compute before upload; include in files[] for instant preview |
| `VIDEO`     | `width`, `height`, `durationMs`, `blurhash` (first frame) | Generate thumbnail client-side; send blurhash                 |
| `AUDIO`     | `durationMs`, `waveform`                                  | Compute amplitude samples (max 2048 points)                   |
| `VOICE`     | `durationMs`, `waveform`                                  | Same as AUDIO                                                 |
| `DOCUMENT`  | `name`, `size`, `mime`                                    | `contentType: "DOCUMENT"` for all doc types                   |
| `GIF`       | `url` (external, e.g. Tenor) OR `objectKey` (uploaded)    | Use `url` for CDN-hosted GIFs; skip upload                    |
| `STICKER`   | `objectKey` or `url`, `packId`, `stickerId`               | Must include either objectKey or url                          |

> The server does **not** transcode, generate thumbnails, or compute previews. All dimension/preview data must be client-supplied.

### 11.5 Downloading / rendering

**You usually don't need a separate API call.** All read paths (history, `community:message:new`, reactions, pins) return files with a fully-qualified presigned `url` field. Render directly.

Presigned URLs expire (~1 hour). The server re-signs on every read. **Never persist the URL — persist the `objectKey`.**

**Fallback — when you only have an objectKey:**

```
POST /api/v1/chat/media/download-url
{ "objectKey": "chat-uploads/<userId>/<uuid>.jpg" }

Response: { "success": true, "data": { "objectKey": "...", "downloadUrl": "https://minio…" } }
```

### 11.6 Cancel upload

If the user aborts:

```
DELETE /api/v1/media/uploads/chat-uploads%2F<userId>%2F<uuid>.jpg?category=CHAT_ATTACHMENT
Authorization: Bearer <token>
```

`objectKey` must be URL-encoded. Returns `200` on success and also if already deleted.

### 11.7 Media gallery listing

```
GET /api/v1/chat/community/rooms/:roomId/media?type=IMAGE&limit=30
```

`type` filter: `IMAGE`, `VIDEO`, `GIF`, `VOICE`, `DOCUMENT`, `STICKER`.

Response uses cursor pagination:

```jsonc
{
  "success": true,
  "data": {
    "items":       [ <CommunityMessageWire[]> ],
    "nextCursor":  "<string | null>",
    "hasMore":     true
  }
}
```

Pass `cursor=<nextCursor>` to fetch the next page.

---

## Phase 12 — Message Sync & Offline Recovery

### 12.1 Initial load (first open)

```
GET /api/v1/chat/community/rooms/:roomId/conversation?pageNumber=1&limit=30
```

Returns newest 30 messages, advances read pointer. `nextCursor` is the stringified epoch-ms of the oldest message in the page.

### 12.2 Scroll pagination (older messages)

```
GET /api/v1/chat/community/rooms/:roomId/messages?before_ts=<nextCursor>&limit=30
```

Use `before_ts` with the cursor from the previous page to load older history. `nextCursor` in the response is the epoch-ms boundary for the next older page.

### 12.3 Incremental sync (reconnect / after_ts)

After reconnecting, fetch all changes since the last known timestamp:

```
GET /api/v1/chat/community/rooms/:roomId/messages?after_ts=<lastKnownTs>&limit=200
```

Response shape (different from scroll mode — flat object, no nested pagination):

```jsonc
{
  "success": true,
  "data": {
    "data":       [ SyncItem[] ],   // oldest-first
    "hasMore":    true,
    "nextCursor": "1718438500000"   // epoch-ms string; feed back as after_ts
  }
}
```

**`SyncItem` shape** (includes all mutations since `after_ts`):

```jsonc
{
  "id":            "<objectId>",
  "roomId":        "<string>",
  "sentBy":        "<userId>",
  "senderName":    "<string | null>",
  "senderAvatar":  "<presigned URL | null>",
  "message":       "<string | null>",
  "contentType":   "TEXT",
  "attachments":   [ <resolved files> ],
  "reactions":     [ <ReactionGroup[]> ],
  "reactionGroups":[ <ReactionGroup[]> ],
  "deletedForAll": false,
  "editedAt":      null,
  "createdAt":     1718438400000,
  "updatedAt":     1718438450000,
  "syncEventType": "new" | "edited" | "deleted" | "reacted"
}
```

**`syncEventType` derivation (server-side):**

- `"deleted"` — `deletedForAll === true`
- `"edited"` — `editedAt !== null`
- `"reacted"` — `updatedAt - createdAt > 2000ms` (was touched but not edited/deleted)
- `"new"` — otherwise

Continue paginating while `hasMore === true`, using `nextCursor` as the next `after_ts`.

### 12.4 Dedicated sync endpoint

```
GET /api/v1/chat/community/rooms/:roomId/sync?since_ts=<epochMs>&limit=50
```

Same response shape and `syncEventType` semantics as `after_ts` mode above.

### 12.5 Multi-room catch-up via socket (reconnect)

For efficient reconnect when the user was in multiple community rooms:

```js
commSocket.emit(
  "community:catchup",
  {
    rooms: [
      { roomId: "<room1>", sinceTs: 1718430000000, limit: 100 }, // sinceTs = last known updatedAt
      { roomId: "<room2>", sinceId: "<lastMessageId>", limit: 50 }, // OR sinceId
    ],
  },
  (ack) => {
    // ack.data.rooms: [{ roomId, hasMore, lastId, nextTs, authorized }]
    // Each room's events arrive separately via 'community:catchup:result'
  }
);

commSocket.on(
  "community:catchup:result",
  ({ roomId, events, hasMore, lastId, nextTs }) => {
    // events: array of CatchupEvent objects (each has sentAt, editedAt, reactions fields cast to numbers)
    // Process events for roomId
    // If hasMore, call sinceId: lastId or REST after_ts for the remainder
  }
);
```

**Limits:** max 10 rooms per `community:catchup` call; max 100 events per room.

### 12.6 connectionStateRecovery

Socket.IO is configured with `connectionStateRecovery.maxDisconnectionDuration = 2 * 60 * 1000` (2 minutes). If the client reconnects within 2 minutes, Socket.IO may replay missed events automatically. Regardless, always run the catch-up flow on reconnect to handle longer disconnections.

### 12.7 Recommended reconnect flow

```
1. socket.on('reconnect') fires
2. Re-emit community:join for each active room (rooms may have been auto-left)
3. Emit community:catchup with { rooms: [...] } for up to 10 rooms
4. On each community:catchup:result → apply events to local store
5. For rooms with hasMore === true → call GET sync?since_ts=... to drain the remainder
6. Call POST /rooms/:roomId/read to advance the server read pointer
```

---

## Phase 13 — Error Handling Reference

### 13.1 Error envelope shapes (there are TWO)

**Shape A — Domain / application errors** (thrown by service layer):

```jsonc
{
  "success": false,
  "error": {
    "statusCode": 400,
    "code": "CHAT_MESSAGE_NOT_FOUND", // UPPER_SNAKE_CASE
    "message": "Message not found", // localized
  },
}
```

HTTP status: 400, 403, 404, 410, 500.

**Shape B — Validation errors** (Zod schema failures):

```jsonc
{
  "success": false,
  "message": "Unsupported community messageType, Provide either before_ts or after_ts, not both",
}
```

HTTP status: 400. Note: uses top-level `message`, no `error` object.

**Shape C — Rate limit** (429):

```jsonc
{
  "success": false,
  "message": "Too many requests, please try again later.",
  "retryAfterSec": 45,
}
```

**Shape D — Gateway proxy error** (502):

```jsonc
{
  "success": false,
  "message": "Service temporarily unavailable. Please try again later.",
}
```

Always check `success === false` first; then check for `error.code` (Shape A), `message` (Shape B/C/D).

### 13.2 Full error code reference

| HTTP | Code                            | Cause                                          |
| ---- | ------------------------------- | ---------------------------------------------- |
| 400  | `CHAT_TEXT_TOO_LONG`            | Message/edit text exceeds 4000 chars           |
| 400  | `CHAT_MESSAGE_ALREADY_DELETED`  | Edit/react on tombstoned message               |
| 400  | `CHAT_EDIT_OWN_MESSAGES_ONLY`   | Editing another user's message                 |
| 400  | `CHAT_EDIT_TEXT_ONLY`           | Editing a non-TEXT message                     |
| 400  | `CHAT_IMAGE_COUNT_EXCEEDED`     | > 10 images in one send                        |
| 400  | `CHAT_FILE_TOO_LARGE`           | File exceeds per-type size cap                 |
| 400  | `CHAT_VIDEO_TOO_LARGE`          | Video exceeds size cap                         |
| 400  | `CHAT_VIDEO_TOO_LONG`           | Video exceeds 180 s                            |
| 400  | `CHAT_VOICE_TOO_LONG`           | Voice note exceeds 300 s                       |
| 400  | `CHAT_INSUFFICIENT_PERMISSIONS` | Delete-for-all by non-sender non-mod           |
| 400  | `CHAT_PIN_LIMIT_REACHED`        | Pin count at room limit                        |
| 400  | `CHAT_BANNED_FROM_ROOM`         | Banned user attempting to join                 |
| 400  | `INVALID_JSON_BODY`             | Malformed JSON body                            |
| 400  | `INVALID_ID_FORMAT`             | Malformed ObjectId in path                     |
| 400  | `DATABASE_REQUEST_ERROR`        | Other Prisma DB error                          |
| 403  | `CHAT_NOT_A_MEMBER`             | Not an active room member                      |
| 403  | `COMMUNITY_SUSPENDED`           | Room/community is suspended                    |
| 403  | `COMMUNITY_CHAT_DISABLED`       | Community room not provisioned                 |
| 403  | `CHAT_INSUFFICIENT_PERMISSIONS` | Pin/unpin without mod/admin role               |
| 404  | `CHAT_ROOM_NOT_FOUND`           | Unknown roomId                                 |
| 404  | `CHAT_NOT_A_MEMBER`             | Leave when not a member                        |
| 404  | `CHAT_MESSAGE_NOT_FOUND`        | Unknown messageId or cross-room access attempt |
| 404  | `CHAT_PIN_NOT_FOUND`            | Unpin non-existent pin                         |
| 409  | `CONFLICT`                      | Duplicate key (P2002)                          |
| 410  | `CHAT_EDIT_WINDOW_EXPIRED`      | Edit attempted after 15-min window             |
| 500  | `INTERNAL_ERROR`                | Unhandled server error                         |

### 13.3 Socket ack error recovery guide

| `error`           | `retryable` | Action                                                                  |
| ----------------- | ----------- | ----------------------------------------------------------------------- |
| `INVALID_PAYLOAD` | `false`     | Log the payload; fix the schema; do not retry                           |
| `SERVICE_ERROR`   | `true`      | Exponential backoff (1s, 2s, 4s); max 3 retries; then fall back to REST |
| `FORBIDDEN`       | `false`     | Show "You don't have permission" UI; do not retry                       |

### 13.4 REST fallback strategy

Use the socket path as the primary. On socket `SERVICE_ERROR` after 3 retries, or when the socket is disconnected, fall back to the REST equivalent:

| Socket event               | REST fallback                                           |
| -------------------------- | ------------------------------------------------------- |
| `community:message:send`   | `POST /rooms/:roomId/messages`                          |
| `community:messages:fetch` | `GET /rooms/:roomId/messages`                           |
| `community:message:edit`   | `PATCH /messages/:messageId`                            |
| `community:message:delete` | `DELETE /messages/:messageId?type=...`                  |
| `community:message:react`  | `POST /messages/:messageId/react`                       |
| `community:message:pin`    | `POST /rooms/:roomId/pins`                              |
| `community:message:unpin`  | `DELETE /rooms/:roomId/pins/:messageId?communityId=...` |

---

## Phase 14 — Contract Consistency Review

### 14.1 AsyncAPI vs implementation mismatches

The following differences were found between `asyncapi.yaml` and the live implementation:

| #   | AsyncAPI / old doc claim                                                                  | Actual implementation                                                                                                                                                                                                                                           | Impact                                                     |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `community:join` has **no ack** (`COMMUNITY-CHAT-EVENTS-AND-TESTS.md §2.1`)               | Has a full ack `{ success, message }`                                                                                                                                                                                                                           | Medium — FE may miss the success signal                    |
| 2   | `community:message:send` payload has `mediaKey?` (old tests, AsyncAPI)                    | Actual: `media: { files: MediaFile[] }` (no `mediaKey`)                                                                                                                                                                                                         | **High** — attachment send will fail                       |
| 3   | `community:message:new` broadcast has `mediaKey` field (AsyncAPI)                         | Actual: `content: { text, files: [] }` (no `mediaKey`)                                                                                                                                                                                                          | **High** — FE cannot render attachments                    |
| 4   | Ack error shape: `{ success:false, error: "INVALID_PAYLOAD"\|"SERVICE_ERROR" }` (old doc) | Actual: `{ success:false, error: <code>, retryable: bool, message: <string> }`                                                                                                                                                                                  | Medium — missing `retryable`                               |
| 5   | `community:message:send` requires `message.min(1)` (old doc)                              | Actual: `message.max(4000).default("")` — empty string is **valid**                                                                                                                                                                                             | High — FE will block sending media-only messages           |
| 6   | `message:delete` fan-out on `/chat` namespace `conv:<roomId>` (old doc §2.2, TC-WS-129)   | Actual: `community:message:deleted` on `/community` namespace                                                                                                                                                                                                   | **Critical** — FE listening on wrong namespace for deletes |
| 7   | `community:member:joined` broadcast listed in docs + AsyncAPI                             | **Implemented** — the producer now lives in **community-service** (`notifyMemberJoined` publishes to `community:<id>` on every path a member becomes ACTIVE: add_members, join-request approve/bulk-approve, invite-link redeem). FE receives it on member join | Resolved — no longer dead                                  |
| 8   | `community:messages:fetch` cursor described as `afterMessageId`                           | Actual: `cursor` is a **UTC ISO-8601 datetime string** (not a message ID)                                                                                                                                                                                       | High — pagination will break                               |
| 9   | `community:message:new` in AsyncAPI: `quoteData: { message, senderName }` (raw)           | Actual broadcast: canonical `{ messageId, senderId, senderName, messageType, preview, isDeleted }`                                                                                                                                                              | Medium — FE needs the canonical shape                      |
| 10  | REST `/rooms/:roomId/messages` described as cursor-paginated with `cursor=<messageId>`    | Actual query params: `before_ts`, `after_ts`, `around` (timestamp/messageId-based, **not** a cursor string)                                                                                                                                                     | **High** — pagination call structure is wrong              |
| 11  | `community:message:new` `reactions` is a map `{ emoji: users[] }` (old shape)             | Actual: `reactions: []` (empty array on new send); reactions arrive via `community:message:reaction` broadcast                                                                                                                                                  | Medium — FE may misparse                                   |
| 12  | AsyncAPI shows `community:member:joined` as a subscribe channel event with member DTO     | **Published by community-service** (`notifyMemberJoined` → `community:<id>`) — implemented and forwarded to the FE on member join                                                                                                                               | Resolved — no longer a dead channel                        |
| 13  | `typing:start` / `typing:stop` payload in AsyncAPI lacks `userDetails` object             | Actual: includes `userDetails: { userId, username, displayName, avatarUrl }`                                                                                                                                                                                    | Medium — richer data available                             |

### 14.2 Two distinct message shapes (critical knowledge)

The backend returns **two different message shapes** depending on path. Your model layer must normalize both:

**Path A — REST history reads** (history, conversation, search, media, around):

- Field name: `sentBy` (not `senderId`)
- Text field: `message` (flat string)
- Quote: raw `quoteData: { message, senderName }` (not canonical)
- Reactions: both deprecated `reactions` map AND `reactionGroups[]`
- Extra fields: `readBy[]`, `deliveredTo[]`, `deletedBy[]`, `editHistory[]`
- `contentType` present; `messageType` removed

**Path B — Live socket broadcasts + REST send response**:

- Field name: `senderId` (not `sentBy`)
- Text: nested as `content.text` (plus flat `message` alias)
- Quote: canonical `quoteData: { messageId, senderId, senderName, messageType, preview, isDeleted }` (with empty strings for community)
- `reactions: []` (always empty on new message)
- Extra aliases: `messageId` (= `id`), `serverTs` = `sentAt`

**Recommended normalization:** on receipt of any message from any path, map to a single client-side `ChatMessage` model:

```ts
interface ChatMessage {
  id: string;
  communityId: string;
  roomId: string;
  senderId: string; // normalize sentBy → senderId
  senderName: string;
  senderAvatar: string;
  text: string; // normalize message / content.text → text
  contentType: string; // always UPPER
  files: MediaFile[];
  quoteData: CanonicalQuote | null;
  reactions: ReactionGroup[];
  sequenceNumber: number;
  sentAt: number; // normalize serverTs / createdAt → sentAt (epoch ms)
  editedAt: number | null;
  deletedForAll: boolean;
  clientMessageId: string;
}
```

---

## Appendix A — Message Shape Reference

### REST read / history shape (`CommunityMessageWire`)

Returned by: GET history, GET conversation, GET search, GET media, GET around-mode.

```jsonc
{
  "id":              "<objectId string>",
  "roomId":          "<objectId string>",
  "sentBy":          "<userId UUID>",           // ⚠️ NOT senderId
  "senderName":      "<string | null>",
  "senderAvatar":    "<presigned URL | null>",  // resolved, never raw key

  "message":         "<string | null>",         // raw text body
  "attachments":     [                          // resolved media files
    {
      "objectKey":  "<string>",
      "url":        "<presigned URL>",
      "name":       "<string>",
      "mime":       "<string>",
      "size":       <number>,
      "width":      <number | null>,
      "height":     <number | null>,
      "durationMs": <number | null>,
      "blurhash":   "<string | null>",
      "waveform":   [<number>]
    }
  ],
  "contentType":     "TEXT",                    // UPPER-CASE (messageType removed)
  "reactions":       {},                        // deprecated map — use reactionGroups
  "reactionGroups":  [
    { "emoji": "👍", "count": 2, "users": [{ "userId","displayName","avatar" }] }
  ],
  "parentMessageId": "<objectId | null>",
  "quoteData":       { "message": "<text>", "senderName": "<name>" }, // raw stored shape
  "clientMessageId": "<string | null>",
  "sequenceNumber":  <number>,
  "deletedBy":       ["<userId>"],              // users who deleted-for-me
  "deletedForAll":   false,
  "editedAt":        <epoch ms | null>,
  "editHistory":     [{ "text": "...", "editedAt": "<ISO>" }],
  "createdAt":       <epoch ms>,
  "updatedAt":       <epoch ms>,
  "readBy":          [{ "userId": "...", "readAt": <epoch ms> }],
  "deliveredTo":     [{ "userId": "...", "deliveredAt": <epoch ms> }]
}
```

### Live broadcast + send response shape (`community:message:new`)

Received on socket `community:message:new`. Also returned in `ack.data` from `community:message:send` and in REST send response `data.message`.

```jsonc
{
  "id":              "<objectId string>",
  "messageId":       "<objectId string>",       // alias for id (V1 compat)
  "communityId":     "<string>",
  "roomId":          "<string>",
  "senderId":        "<userId UUID>",           // ⚠️ NOT sentBy
  "senderName":      "<string>",
  "senderAvatar":    "<presigned URL>",         // resolved

  "parentMessageId": "<objectId | ''>",         // empty string when no reply
  "quoteData": {                                // null when no reply; canonical shape
    "messageId":   "",                          // empty for community legacy rows
    "senderId":    "",                          // empty for community legacy rows
    "senderName":  "<string>",
    "messageType": "",                          // empty for community legacy rows
    "preview":     "<original text>",
    "isDeleted":   false
  },
  "content": {
    "text":      "<string>",
    "files":     [ <MediaFile[]> ],             // resolved
    "location":  { "lat", "lng", "placeName", "placeAddress" },  // present only if set
    "contact":   { "name", "phone", "avatar", "userId" },        // present only if set
    "sticker":   { "objectKey", "url", "packId", "stickerId" }   // present only if set
  },
  "reactions":       [],                        // always empty on new message
  "message":         "<string>",                // flat alias for content.text
  "contentType":     "TEXT",                    // UPPER-CASE
  "clientMessageId": "<string>",
  "serverTs":        <epoch ms>,
  "sentAt":          <epoch ms>,                // alias for serverTs
  "sequenceNumber":  <number>
}
```

### `community:message:edited` broadcast

```jsonc
{
  "messageId":   "<objectId>",
  "communityId": "<string>",
  "roomId":      "<string>",
  "senderId":    "<userId>",
  "message":     "<updated text>",
  "contentType": "TEXT",
  "editedAt":    <epoch ms>
}
```

### `community:message:deleted` broadcast

```jsonc
{
  "messageId":   "<objectId>",
  "communityId": "<string>",
  "roomId":      "<string>",
  "deleteType":  "forEveryone" | "<other>",
  "deletedBy":   "<userId>"
}
```

### `community:message:reaction` broadcast

```jsonc
{
  "messageId":   "<objectId>",
  "communityId": "<string>",
  "reactions":   [
    { "emoji": "👍", "count": 3, "users": [{ "userId", "displayName", "avatar" }] }
  ]
}
```

### `community:message:pinned` broadcast

```jsonc
{
  "messageId":   "<objectId>",
  "communityId": "<string>",
  "roomId":      "<string>",
  "pinnedIds":   ["<objectId>", ...],   // all currently pinned message IDs
  "pinnedCount": <number>,
  "pinnedAt":    <epoch ms>,
  "pinnedBy":    "<userId>"
}
```

### `community:message:unpinned` broadcast

```jsonc
{
  "messageId":   "<objectId>",
  "communityId": "<string>",
  "roomId":      "<string>",
  "pinnedIds":   ["<objectId>", ...],   // remaining pinned IDs after unpin
  "pinnedCount": <number>,
  "unpinnedBy":  "<userId>"
}
```

### `community:updated` (on `/chat` namespace)

```jsonc
{
  "communityId":   "<string>",
  "roomId":        "<string>",
  "lastMessageId": "<objectId>",
  "lastMessage": {
    "contentType": "TEXT",
    "text":        "Hello everyone!"   // truncated to 80 chars
  },
  "lastMessageAt": <epoch ms>,
  "senderId":      "<userId>",
  "unread":        true
}
```

---

## Appendix B — Content Types

All `contentType` values are **UPPER-CASE** on every wire surface.

| Value      | Usage                                        |
| ---------- | -------------------------------------------- |
| `TEXT`     | Plain text message                           |
| `IMAGE`    | Photo (jpeg/png/webp/gif)                    |
| `VIDEO`    | Video file (mp4/mov/mkv/webm/avi/m4v)        |
| `AUDIO`    | Audio file (mp3/ogg/wav/m4a/aac/flac)        |
| `VOICE`    | Voice note recording                         |
| `DOCUMENT` | PDF, Office docs, text files, CSV, JSON, XML |
| `GIF`      | Animated GIF (from CDN URL or uploaded)      |
| `STICKER`  | Sticker from a pack                          |
| `LOCATION` | Lat/lng + optional place name                |
| `CONTACT`  | Contact card (name + phone)                  |

> `SYSTEM` exists in the enum but is excluded from the community content types. Do not send it from clients.

**REST send uses lower-case input** (`"text"`, `"image"`, etc.) — case-insensitive, normalized server-side. **Socket send uses UPPER-CASE** (`contentType` field).

---

_End of Community Chat Frontend Integration Guide — generated 2026-06-15._
