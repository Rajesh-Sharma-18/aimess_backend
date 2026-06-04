# Community Chat — Event Reference & Test Cases

**Status:** ✅ Implemented (end-to-end).
**Generated:** 2026-06-03.

This document consolidates the **community chat** contract — every event type with a
description — plus the full test-case matrix. It is a reading aid; the canonical
sources remain:

- Socket events → [`docs/SOCKET_EVENTS.md`](SOCKET_EVENTS.md) §5 (`/community`) + §4 (`community:updated`)
- Socket test cases → [`test-cases/websocket-events/community-namespace.md`](../test-cases/websocket-events/community-namespace.md)
- REST/realtime test cases → [`test-cases/communities/community-chat.md`](../test-cases/communities/community-chat.md)

---

## 1. Architecture (who owns what)

| Concern                                                                   | Service                                    | Transport                                               |
| ------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| Membership, roles, join requests, invites, bans, mutes, warnings, reports | **community-service** (gRPC 4003, MongoDB) | REST `/communities/...`                                 |
| Messages: send, history, conversation, media, edit, delete, search        | **chat-service** (gRPC 4004, MongoDB)      | gateway `/community` ns + chat-service REST             |
| Socket fan-out                                                            | **api-gateway**                            | `/community` namespace, `/chat` for `community:updated` |

- A community maps to **one `GeneralRoom`** (`roomId === communityId`).
- Sends persist via `CommunityMessageService` ([community-message.service.ts](../apps/chat-service/src/services/community-message.service.ts)) and publish
  `community:message:new` to Redis channel `community:<communityId>`, which the gateway re-emits.
- **Split-brain caveat:** chat-service room membership and community-service
  membership are separate stores kept in sync via the RabbitMQ
  `community.chat.sync.queue` (`community.created` / `community.deleted` /
  `community.member.synced`). A user can theoretically be in one but not the other.
- community-service's gRPC `sendCommunityMessage`/`getCommunityMessages` are
  **intentional stubs** — messaging is served by chat-service directly.

---

## 2. Event Types

### 2.1 Client → Server (`/community` namespace, requires socket JWT auth)

| Event                      | Ack?    | Payload                                                                     | Description                                                                                                                                                                                                 |
| -------------------------- | ------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `community:join`           | no      | `{ communityId, roomId }`                                                   | Joins the socket to room `community:<communityId>` to receive broadcasts. Fire-and-forget; invalid payload silently ignored.                                                                                |
| `community:leave`          | no      | `{ communityId }`                                                           | Leaves room `community:<communityId>`.                                                                                                                                                                      |
| `community:message:send`   | **yes** | `{ communityId, roomId, clientMessageId, message, contentType, mediaKey? }` | Posts a message. Persists via chat-service, broadcasts `community:message:new`. `senderId` is forced to the authed user. `message` is `min(1)` (non-empty even for media). Idempotent on `clientMessageId`. |
| `community:messages:fetch` | **yes** | `{ roomId, cursor?, limit?≤100 }`                                           | Cursor-paged history (cursor = ISO timestamp, "older" direction). `requesterId` forced to authed user.                                                                                                      |

Ack shape: `{ success: boolean, data?, error?: "INVALID_PAYLOAD" | "SERVICE_ERROR" }`.

### 2.2 Server → Client (forwarded verbatim from Redis `community:*`)

| Event                      | Target room                    | Payload                                                                                                                           | Description                                                                                                      |
| -------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `community:message:new`    | `community:<communityId>`      | `{ messageId, communityId, roomId, senderId, senderName, senderAvatar, message, contentType, mediaKey, clientMessageId, sentAt }` | New message broadcast. `sentAt` is a **number** (epoch ms) — coerce defensively.                                 |
| `community:member:joined`  | `community:<communityId>`      | member DTO                                                                                                                        | A member joins the community.                                                                                    |
| `community:message:edited` | `community:<communityId>`      | `{ messageId, communityId, roomId, senderId, message, contentType, editedAt }`                                                    | Published when a message is edited via REST `PATCH /messages/:id`.                                               |
| `community:updated`        | `user:<userId>` on **`/chat`** | `{ communityId, roomId, lastMessageId, lastMessage:{ contentType, text }, lastMessageAt, senderId, unread }`                      | List bump-to-top — fired to every active member on each new message. **Delivered on `/chat`, not `/community`.** |
| `message:delete`           | `conv:<roomId>` on **`/chat`** | `{ messageId, type:"forEveryone"\|"forMe", deletedBy }`                                                                           | Community message deletes fan out on the `/chat` conv channel, **not** the community channel.                    |

> The `/community` namespace forwards **any** `{ event, data }` published to the
> channel verbatim — there is no event-name allow-list (see TC-WS-128).

### 2.3 REST endpoints (chat-service community router)

| Method + Path                                         | Auth   | Description                                                             |
| ----------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `GET /rooms`                                          | none\* | List community chat rooms (paginated, `hasUnread`).                     |
| `GET /rooms/search?query=&page=&limit=`               | none\* | Search rooms by name.                                                   |
| `POST /rooms/:roomId/join`                            | yes    | Join chat room (upserts RoomMember, `memberNumber += 1`).               |
| `POST /rooms/:roomId/leave`                           | yes    | Leave chat room.                                                        |
| `GET /rooms/:roomId/messages?cursor=&limit=&page=`    | yes    | Paginated message history.                                              |
| `GET /rooms/:roomId/conversation`                     | yes    | Timeline page + advances read pointer.                                  |
| `GET /rooms/:roomId/media?type=&cursor=&limit=`       | yes    | Media-only listing.                                                     |
| `GET /rooms/:roomId/messages/search?q=&limit=&page=`  | yes    | Full-text search.                                                       |
| `PATCH /messages/:messageId`                          | yes    | Edit own text message (≤15 min). Broadcasts `community:message:edited`. |
| `DELETE /messages/:messageId?type=forEveryone\|forMe` | yes    | Delete message. Broadcasts `message:delete` on `conv:<roomId>`.         |

\* `GET /rooms` and `/rooms/search` are unauthenticated in the router — flagged as a gap (roster listing effectively public).

### 2.4 Async / internal events (RabbitMQ)

| Event / Queue                                           | Direction      | Description                                                                       |
| ------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| `community.created` → `community.chat.sync.queue`       | community→chat | Provisions a `GeneralRoom`.                                                       |
| `community.deleted` → `community.chat.sync.queue`       | community→chat | Deactivates room, marks members left.                                             |
| `community.member.synced` → `community.chat.sync.queue` | community→chat | Upserts `RoomMember` status (active/banned/left) + role (admin/moderator/member). |
| `community.activity.queue`                              | chat→community | Updates `Community.lastActivityAt` for `/communities/mine` ordering.              |

---

## 3. Test Cases

### 3.1 Socket — `/community` namespace (TC-WS-120 → 130)

| ID        | Event                      | Scenario                             | Category         | Pri  | Expected                                                                                                                            |
| --------- | -------------------------- | ------------------------------------ | ---------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| TC-WS-120 | `community:message:send`   | Happy path text post                 | Happy Path       | High | Ack `{success:true,data:{messageId,sentAt}}`; persists; `community:message:new` to room + `community:updated` to members on `/chat` |
| TC-WS-121 | `community:message:send`   | Image via `mediaKey`                 | File Upload      | Med  | Ack success; `community:message:new` carries `mediaKey` (note: `message` must still be non-empty)                                   |
| TC-WS-122 | `community:message:send`   | `message:""`                         | Input Validation | Med  | Ack `{success:false,error:"INVALID_PAYLOAD"}`; no DB/event                                                                          |
| TC-WS-123 | `community:message:send`   | Missing `roomId`                     | Input Validation | Med  | Ack `INVALID_PAYLOAD`; no DB/event                                                                                                  |
| TC-WS-124 | `community:message:send`   | Non-member posts                     | AuthZ            | High | Ack `{success:false,error:"SERVICE_ERROR"}` (chat-service rejects); no DB                                                           |
| TC-WS-125 | `community:message:send`   | Spoofed `senderId` in payload        | Security         | High | Stored with authed `senderId` (schema strips it; gateway overrides)                                                                 |
| TC-WS-126 | `community:messages:fetch` | Cursor pagination                    | Pagination       | Med  | Ack `{success:true,data:{messages,nextCursor}}`; `limit≤100`, `requesterId` forced                                                  |
| TC-WS-127 | `community:member:joined`  | Member join broadcast                | DB State         | Low  | `community:member:joined` (member DTO) to `community:<id>`                                                                          |
| TC-WS-128 | `*` (Redis forward)        | Arbitrary event forwarded            | Edge Case        | Low  | Gateway emits `parsed.event`+`parsed.data` blindly (no allow-list) — security note                                                  |
| TC-WS-129 | `message:delete`           | Community delete fans out on `/chat` | Business Rule    | Med  | `message:delete{messageId,type,deletedBy}` on `conv:<roomId>` (NOT community channel)                                               |
| TC-WS-130 | Redis `pmessage`           | Malformed JSON on channel            | Error Handling   | Low  | Dropped; parse-error warning logged; no crash                                                                                       |

### 3.2 REST + Realtime — community chat (TC-COMM-117 → 130)

| ID          | API/Event                                              | Scenario                       | Category         | Pri  | Expected                                                                                                                                   |
| ----------- | ------------------------------------------------------ | ------------------------------ | ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-COMM-117 | `GET /rooms`                                           | List rooms w/ unread           | Pagination       | Med  | 200 paginated; `hasUnread` per caller. **Unauthenticated — flag**                                                                          |
| TC-COMM-118 | `GET /rooms/search`                                    | Search by name                 | Pagination       | Low  | 200 matches / empty message. Unauthenticated                                                                                               |
| TC-COMM-119 | `POST /rooms/:roomId/join`                             | Join room                      | Happy Path       | High | 200 `CHAT_ROOM_JOINED`; RoomMember upsert; `memberNumber+=1`                                                                               |
| TC-COMM-120 | `POST /rooms/:roomId/join`                             | Unknown room                   | Error Handling   | Med  | 404 `CHAT_ROOM_NOT_FOUND`                                                                                                                  |
| TC-COMM-121 | `POST /rooms/:roomId/join`                             | Banned user joins              | Security         | High | 400 `CHAT_BANNED_FROM_ROOM`                                                                                                                |
| TC-COMM-122 | `POST /rooms/:roomId/leave`                            | Leave room                     | Happy Path       | Med  | 200 `CHAT_ROOM_LEFT`; `leftAt` set; `memberNumber-=1`                                                                                      |
| TC-COMM-123 | `GET /rooms/:roomId/messages`                          | History                        | Pagination       | High | 200 paginated by createdAt cursor; auth required                                                                                           |
| TC-COMM-124 | `GET .../conversation` · `/media` · `/messages/search` | Timeline/media/search          | Pagination       | Med  | 200 cursor/paginated; empty `q` → empty list                                                                                               |
| TC-COMM-125 | `PATCH /messages/:messageId`                           | Edit own text ≤15min           | Happy Path       | High | 200 `CHAT_MESSAGE_EDITED`; broadcasts `community:message:edited`. `communityId` required in body                                           |
| TC-COMM-126 | `PATCH /messages/:messageId`                           | Not owner / expired / non-text | Business Rule    | High | 4xx — `CHAT_EDIT_OWN_MESSAGES_ONLY` / `CHAT_EDIT_WINDOW_EXPIRED` (410) / `CHAT_EDIT_TEXT_ONLY`                                             |
| TC-COMM-127 | `PATCH /messages/:messageId`                           | Empty / too-long text          | Input Validation | Med  | 400 (`text` min 1, max `CHAT_TEXT_MAX_CHARS`)                                                                                              |
| TC-COMM-128 | `DELETE /messages/:messageId`                          | forMe / forEveryone            | Happy Path       | High | 200; soft-delete or per-user hide; `message:delete` on `conv:<roomId>`. Non-sender needs admin/moderator (`CHAT_INSUFFICIENT_PERMISSIONS`) |
| TC-COMM-129 | `community:updated`                                    | New-message bump-to-top        | Realtime         | Med  | `community:updated` to `user:<id>` on `/chat`; room lastMessage updated                                                                    |
| TC-COMM-130 | `PATCH`/`DELETE /messages`                             | Rate limit                     | Rate Limit       | Med  | 429 after 30 mutations/60s (`cm:send`)                                                                                                     |

### 3.3 Additional service-level rules worth covering

These are enforced in [community-message.service.ts](../apps/chat-service/src/services/community-message.service.ts) and are good explicit test targets:

- **Idempotency:** resending the same `clientMessageId` returns the same `messageId` (no duplicate row) — covered by cache key + sparse unique index (P2002 path).
- **Membership gate on read:** `getConversation` / `listMedia` throw `ForbiddenError("CHAT_NOT_A_MEMBER")` if member missing or `status !== "active"`.
- **Read pointer:** `getConversation` advances `readAt` forward-only to the newest message in the page; `getMessages` (history) does NOT advance it.
- **Reply quoting:** sending with `parentMessageId` denormalizes `quoteData{message,senderName}` from the original.
- **Sender snapshot:** `senderName`/`senderAvatar` are denormalized from the user snapshot at send time.

---

## 4. Known gaps / flags (verify before sign-off)

1. `GET /rooms` and `/rooms/search` are **unauthenticated** — roster listing is effectively public.
2. `community:message:send` requires `message.min(1)` — a pure-media message must send non-empty text (inconsistent with `/chat` which allows empty text).
3. The `/community` namespace forwards arbitrary Redis events with **no allow-list** — a compromised publisher could emit arbitrary client events (mitigated: channel is backend-only).
4. **Split-brain** between chat-service and community-service membership — kept in sync via `community.chat.sync.queue`; reconciled at chat-service boot via `reconcile-community-rooms`.
