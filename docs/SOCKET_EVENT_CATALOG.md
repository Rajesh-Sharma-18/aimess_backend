# AIMess — Socket Event Catalog (React Developer Reference)

A complete, event-by-event catalog of **every** AIMess socket event a React /
Next.js client touches. For each event: the **feature** it powers, a plain-English
**description**, **direction**, **payload**, and a **usage** snippet.

Companion docs:

- [`SOCKET_FRONTEND_GUIDE.md`](SOCKET_FRONTEND_GUIDE.md) — how to architect the
  client (singleton, Redux slice, listeners, reconnect).
- [`SOCKET_EVENTS.md`](SOCKET_EVENTS.md) — the authoritative backend contract.

> **Conventions used below**
>
> - **Direction:** `→ emit` = client→server (you send), `← listen` = server→client
>   (you receive).
> - **Ack:** ✅ = acked (callback envelope), 🔕 = fire-and-forget (no ack, validate
>   client-side).
> - All `contentType` / `callType` values are **UPPER-CASE**.
> - Snippets assume `const { chat, community, notify } = getSockets()` and the
>   `emitAck` helper from the guide.

---

## 0. Snapshot — features at a glance

| Feature                  | Namespace    | You emit                                         | You listen for                                             |
| ------------------------ | ------------ | ------------------------------------------------ | ---------------------------------------------------------- |
| Join / leave a chat      | `/chat`      | `conv:join`, `conv:leave`                        | —                                                          |
| Send / receive messages  | `/chat`      | `message:send`                                   | `message:new`                                              |
| History pagination       | `/chat`      | `messages:fetch`                                 | (ack data)                                                 |
| Reconnect gap-fill       | `/chat`      | `chat:catchup`                                   | `chat:catchup:result`                                      |
| Read receipts            | `/chat`      | `message:read`                                   | `message:read`, `read_sync`                                |
| Delivery receipts (1-1)  | `/chat`      | `message:delivered`                              | `message:delivered`                                        |
| Typing indicator         | `/chat`      | `typing:start`, `typing:stop`                    | `typing:start`, `typing:stop`                              |
| Presence / online status | `/chat`      | `presence:subscribe/unsubscribe/heartbeat/list`  | `presence:status`                                          |
| Reactions                | `/chat`      | `message:react`, `message:reactions:get`         | `message:reaction`                                         |
| Edit / delete / forward  | `/chat`      | `message:edit`, `message:forward`                | `message:edited`, `message:delete`                         |
| Pinned messages          | `/chat`      | (REST)                                           | `pin:updated`                                              |
| Chat list bump-to-top    | `/chat`      | —                                                | `conv:updated`, `community:updated`                        |
| 1-1 calls (WebRTC)       | `/chat`      | `call:initiate/answer/decline/end/ice`           | `call:incoming/answered/declined/ended/ice`                |
| Community chat           | `/community` | `community:message:send`, `community:join`, …    | `community:message:new`, `community:message:reaction`, …   |
| Notifications & badge    | `/notify`    | `notifications:fetch`, `notifications:mark_read` | `notification:new`, `notification:count`, `…:count_update` |

---

## 1. Connection & namespaces

**Feature:** the transport everything rides on. One physical WebSocket multiplexes
three logical namespaces — `/chat`, `/community`, `/notify`.

**Description:** the JWT access token is sent on the handshake (`auth.token`); there
are no anonymous sockets. The server derives `{ userId, sessionId }` from the token
— the client never sends its own `userId`. On connect, every namespace auto-joins
the `user:<userId>` room for per-user fan-out (calls, presence, notifications).

**Usage:**

```ts
const chat = io(`${BASE_URL}/chat`, {
  path: "/socket.io/",
  transports: ["websocket", "polling"],
  auth: (cb) => cb({ token: getToken() }), // function form → fresh token on reconnect
  query: { platform: "web", clientType: "web" },
});
chat.on("connect", () => {
  /* chat.recovered tells you Tier-1 vs Tier-2 */
});
chat.on("connect_error", (e) => {
  /* "Authentication failed" → refresh token, reconnect */
});
```

**Rooms (server-computed — never sent by you):**

| Room                      | Joined when               | Carries                                    |
| ------------------------- | ------------------------- | ------------------------------------------ |
| `user:<userId>`           | automatically on connect  | calls, presence, notifications, list bumps |
| `conv:<conversationId>`   | you emit `conv:join`      | 1-1 **and** group message events           |
| `community:<communityId>` | you emit `community:join` | community chat events                      |
| `call:<callId>`           | implicit on `call:*`      | WebRTC signaling                           |

---

## 2. The acknowledgement envelope

**Feature:** uniform request/response for every acked event.

```jsonc
// success                         // failure
{ "success": true,                 { "success": false,
  "message": "…localized…",          "error": "SERVICE_ERROR",
  "data": { /* result */ } }         "retryable": true,
                                     "message": "…localized…" }
```

Branch on `success` / `error` / `retryable` — **never** on `message` (it's a
localized display string). Error codes: `INVALID_PAYLOAD` (false), `SERVICE_ERROR`
(true), `RATE_LIMITED` (true), `FORBIDDEN` (false), `NOT_FOUND` (false), `CONFLICT`
(false). Handle all six. Coerce ack numeric fields (e.g. `sentAt`) with `Number()`.

---

## 3. `/chat` namespace — events

### 3.1 `conv:join` — open a conversation room

- **Feature:** Join / leave a chat · **Direction:** → emit · **Ack:** ✅
- **Description:** Joins `conv:<id>` so you receive that room's `message:new`,
  receipts, typing, reactions. **Idempotent** — re-joining is always `success:true`.
  Membership/NOT_FOUND/FORBIDDEN are enforced later at `message:send`, not here.
- **Payload:** `{ conversationId }`

```ts
await emitAck(chat, "conv:join", { conversationId });
```

### 3.2 `conv:leave` — close a conversation room

- **Feature:** Join / leave a chat · **Direction:** → emit · **Ack:** ✅
- **Description:** Leaves `conv:<id>`. Idempotent (leaving a non-joined room still
  succeeds). Call it when the user navigates away from the chat screen.
- **Payload:** `{ conversationId }`

```ts
await emitAck(chat, "conv:leave", { conversationId });
```

### 3.3 `message:send` — create a message

- **Feature:** Send messages · **Direction:** → emit · **Ack:** ✅ (`MessageSendResult`)
- **Description:** Creates a 1-1 or group message. `clientMessageId` is the
  **idempotency key** — replays never duplicate (`alreadySent:true`). File bytes
  never cross the socket: upload first, send `objectKey` in `files[]`. Ack returns
  `{ messageId, conversationId, sequenceNumber, sentAt, alreadySent }`. The room
  receives the canonical `message:new`.
- **Payload (common fields):**

```jsonc
{
  "conversationId": "…", // required
  "clientMessageId": "uuid", // required — idempotency key
  "contentType": "TEXT", // TEXT|IMAGE|VIDEO|AUDIO|VOICE|DOCUMENT|GIF|STICKER|LOCATION|CONTACT|SYSTEM
  "contentText": "hello", // ≤4000
  "files": [
    {
      "objectKey": "…",
      "name": "",
      "size": 0,
      "mime": "",
      "width": 0,
      "height": 0,
      "durationMs": 0,
    },
  ], // ≤30
  "urls": ["https://…"], // link previews ≤20
  "location": { "lat": 0, "lng": 0, "placeName": "…", "placeAddress": "…" },
  "contact": { "name": "…", "phone": "…", "avatar": "…", "userId": "…" },
  "repliedToId": "…", // reply target
  "conversationType": "private", // private|group
  "receiverId": "…", // peer (private)
}
```

```ts
const clientMessageId = crypto.randomUUID();
const res = await emitAck(chat, "message:send", {
  conversationId,
  clientMessageId,
  contentType: "TEXT",
  contentText,
  conversationType: "private",
});
if (res.success) console.log("seq", res.data.sequenceNumber);
```

### 3.4 `message:new` — a message arrived

- **Feature:** Receive messages · **Direction:** ← listen · **Room:** `conv:<id>`
- **Description:** Fired when a message is created/forwarded, or a group lifecycle
  system message is posted (`contentType:"SYSTEM"` + `systemEvent` + `systemData`).
  Payload is the **canonical `ChatMessage`** (plus V1 aliases `messageId`,
  `conversationId`, `contentText`, `contentJson`, `sentAt`; `isForwarded` on
  forwards). Use **one mapper** for this, `message:edited`, and forwards.
- **Payload (canonical):** `{ id, clientMessageId, roomId, conversationType, senderId, senderName, senderAvatar, senderRole, receiverId, contentType, content{…}, parentMessageId, quoteData{…}, reactions[], isDeleted, deletedType, editedAt, clientTs, serverTs, sequenceNumber }`

```ts
chat.on("message:new", (p) => dispatch(messageReceived(mapMessage(p))));
```

### 3.5 `message:read` — read receipt

- **Feature:** Read receipts · **Direction:** → emit ✅ **and** ← listen
- **Description:** You emit it when the user views the conversation, marking read up
  to a message. Peers receive `message:read` to render "seen". Your **own** other
  devices receive `read_sync` instead (multi-device unread clear).
- **Emit payload:** `{ conversationId, upToMessageId }`
- **Listen payload:** `{ conversationId, readerId, upToMessageId }`

```ts
await emitAck(chat, "message:read", { conversationId, upToMessageId });
chat.on("message:read", (p) =>
  markPeerReadUpTo(p.conversationId, p.upToMessageId)
);
```

### 3.6 `message:delivered` — delivery receipt (1-1 only)

- **Feature:** Delivery receipts · **Direction:** → emit ✅ **and** ← listen
- **Description:** Emit on **receiving** a `message:new` in a private chat to tell
  the sender it was delivered. **Private only** — groups/communities have no
  per-member delivery receipt.
- **Emit payload:** `{ conversationId, upToMessageId }`
- **Listen payload:** `{ conversationId, recipientId, upToMessageId, messageIds[] }`

```ts
chat.on("message:new", (p) => {
  if ((p.conversationType ?? "private") === "private")
    chat.emit("message:delivered", {
      conversationId: p.conversationId ?? p.roomId,
      upToMessageId: p.id ?? p.messageId,
    });
});
```

### 3.7 `read_sync` — my other devices read it

- **Feature:** Multi-device sync · **Direction:** ← listen · **Room:** `user:<readerId>`
- **Description:** When you read on one device, your other devices receive this to
  clear unread together (high-water-mark sync).
- **Payload:** `{ conversationId, readerId, read_to_seq, unreadCount, conversationType }`

```ts
chat.on("read_sync", (p) => setUnread(p.conversationId, p.unreadCount));
```

### 3.8 `messages:fetch` — paged history

- **Feature:** History pagination · **Direction:** → emit · **Ack:** ✅
- **Description:** Cursor-paged message history for a room (`limit ≤ 100`). Use for
  initial load and scroll-back. Distinct from `chat:catchup` (which is for reconnect
  gap-fill by `sequenceNumber`).
- **Payload:** `{ conversationId, cursor?, limit?≤100, conversationType? }`

```ts
const res = await emitAck(chat, "messages:fetch", {
  conversationId,
  limit: 50,
  conversationType: "private",
});
```

### 3.9 `chat:catchup` / `chat:catchup:result` — reconnect gap-fill

- **Feature:** Reconnect gap-fill · **Direction:** → emit ✅ + ← listen
- **Description:** On a Tier-2 reconnect, request everything missed since your stored
  `sequenceNumber` per room. Accepts **≤ 50 rooms** per call (batch beyond that).
  Results stream back as one `chat:catchup:result` per room (direct to your socket).
  **Includes tombstones** so you reconcile edits/deletes missed offline. When
  `hasMore:true`, re-request that room with `sinceSeq = lastSeq`.
- **Emit payload:** `{ rooms: [{ roomId, sinceSeq?≥0, conversationType?, limit?≤200 }]≤50 }`
- **Result payload:** `{ roomId, events:[…], hasMore, lastSeq }`

```ts
await emitAck(chat, "chat:catchup", {
  rooms: [{ roomId, sinceSeq: lastSeq, conversationType: "private" }],
});
chat.on("chat:catchup:result", (p) => {
  dispatch(
    messagesLoaded({ roomId: p.roomId, messages: p.events.map(mapMessage) })
  );
  if (p.hasMore)
    emitAck(chat, "chat:catchup", {
      rooms: [{ roomId: p.roomId, sinceSeq: p.lastSeq }],
    });
});
```

### 3.10 `typing:start` / `typing:stop` — typing indicator

- **Feature:** Typing indicator · **Direction:** → emit 🔕 **and** ← listen
- **Description:** Fire-and-forget (no ack — validate client-side). Throttle
  `typing:start` to ≤ 1 per 3 s per conversation. The receiver must also self-expire
  its "typing…" after ~6 s (the server auto-expires after 6 s too).
- **Payload (both ways):** `{ conversationId }` emit / `{ userId, conversationId }` listen

```ts
chat.emit("typing:start", { conversationId }); // throttled
chat.on("typing:start", (p) => showTyping(p.conversationId, p.userId));
chat.on("typing:stop", (p) => hideTyping(p.conversationId, p.userId));
```

### 3.11 `presence:subscribe` / `unsubscribe` / `unsubscribe_all` / `list`

- **Feature:** Presence · **Direction:** → emit · **Ack:** ✅
- **Description:** Watch peers' online status. `subscribe`/`unsubscribe` take up to
  500 peer ids; `unsubscribe_all` clears everything (ack `data.unsubscribedCount`);
  `list` returns the currently-watched ids (ack `data.peerIds`).
- **Payloads:** `{ peerIds: string[]≤500 }` / `{}` / `{}`

```ts
await emitAck(chat, "presence:subscribe", { peerIds: [friendId] });
await emitAck(chat, "presence:unsubscribe", { peerIds: [friendId] });
const { data } = await emitAck(chat, "presence:list", {}); // data.peerIds
```

### 3.12 `presence:heartbeat` — stay online

- **Feature:** Presence · **Direction:** → emit · **Ack:** 🔕
- **Description:** Keeps you marked online (server TTL 10 min, renewed each beat).
  Send ≤ 1 per 30–60 s in foreground; **don't** heartbeat in background — instead
  send one `{ appState:"BACKGROUND" }` when backgrounding.
- **Payload:** `{ appState? }` (default `"FOREGROUND"`)

```ts
const hb = setInterval(
  () => chat.emit("presence:heartbeat", { appState: "FOREGROUND" }),
  45_000
);
// on background: chat.emit("presence:heartbeat", { appState: "BACKGROUND" }); clearInterval(hb);
```

### 3.13 `presence:status` — a peer's status changed

- **Feature:** Presence · **Direction:** ← listen · **Room:** `user:<peerId>`
- **Description:** A watched peer went online/offline. Update your presence map.
- **Payload:** `{ userId, isOnline, lastActiveAt, lastSeen }`

```ts
chat.on("presence:status", (p) => dispatch(presenceChanged(p)));
```

### 3.14 `message:react` / `message:reactions:get` / `message:reaction`

- **Feature:** Reactions · **Direction:** → emit ✅ + ← listen
- **Description:** `message:react` toggles a reaction (same emoji again removes it;
  ≤ 10/min). `message:reactions:get` lists who reacted. The broadcast
  `message:reaction` carries the **full current set** — replace, don't merge.
  `selfReacted` is derived client-side (`users[].userId === myUserId`).
- **Emit payload:** `{ messageId, conversationId, emoji }`
- **Listen payload:** `{ messageId, conversationId, reactions:[{ emoji, count, users:[{ userId, displayName, avatar }] }] }`

```ts
await emitAck(chat, "message:react", {
  messageId,
  conversationId,
  emoji: "👍",
});
chat.on("message:reaction", (p) =>
  dispatch(
    reactionUpdated({
      roomId: p.conversationId,
      messageId: p.messageId,
      reactions: p.reactions,
    })
  )
);
```

### 3.15 `message:edit` / `message:edited`

- **Feature:** Edit · **Direction:** → emit ✅ + ← listen · **Room:** `conv:<id>`
- **Description:** Edit your own message. REST `PATCH …/messages/:id` is the
  authoritative mutation; the socket is the broadcast (last-write-wins — don't
  double-apply). `message:edited` carries the **same canonical shape** as
  `message:new`, so re-render with the same mapper.
- **Emit payload:** `{ messageId, conversationId, contentText?, contentJson?, conversationType? }`

```ts
await emitAck(chat, "message:edit", {
  messageId,
  conversationId,
  contentText,
  conversationType: "private",
});
chat.on("message:edited", (p) => dispatch(messageEdited(mapMessage(p))));
```

### 3.16 `message:delete` — delete broadcast

- **Feature:** Delete · **Direction:** ← listen · **Room:** `conv:<id>`
- **Description:** REST `DELETE …` is authoritative; this is the broadcast (now also
  for **group** deletes). Self-describing: `forEveryone` → hide for all; `forMe` →
  hide only when `deletedBy === myUserId` (track your own `hiddenMessageIds` locally;
  catch-up may still return the row).
- **Payload:** `{ messageId, conversationId, type:"forEveryone"|"forMe", deletedType, deletedBy, sequenceNumber }`

```ts
chat.on("message:delete", (p) =>
  dispatch(
    messageDeleted({
      roomId: p.conversationId,
      messageId: p.messageId,
      type: p.type,
      deletedBy: p.deletedBy,
      myUserId,
    })
  )
);
```

### 3.17 `message:forward`

- **Feature:** Forward · **Direction:** → emit · **Ack:** ✅
- **Description:** Forward a message into another conversation. The target room
  receives a `message:new` with `isForwarded:true`. Supply a fresh `clientMessageId`.
- **Payload:** `{ messageId, targetConversationId, clientMessageId, conversationType?, receiverId?, senderName?, senderAvatar? }`

```ts
await emitAck(chat, "message:forward", {
  messageId,
  targetConversationId,
  clientMessageId: crypto.randomUUID(),
  conversationType: "private",
});
```

### 3.18 `pin:updated` — pinned banner changed

- **Feature:** Pinned messages · **Direction:** ← listen · **Room:** `conv:<id>`
- **Description:** A message was pinned/unpinned (pin/unpin actions are REST). Update
  the live pinned banner from `action` + `pinnedCount`.
- **Payload:** `{ roomId, conversationId, messageId, action:"pinned"|"unpinned", pinnedBy|unpinnedBy, pinnedAt, pinnedCount }`

```ts
chat.on("pin:updated", (p) =>
  updatePinnedBanner(p.conversationId, p.action, p.pinnedCount)
);
```

### 3.19 `conv:updated` — chat list bump-to-top

- **Feature:** Chat list / inbox · **Direction:** ← listen · **Room:** `user:<id>`
- **Description:** WhatsApp/Telegram-style "move-to-top" hint for the **list** screen
  (delivered to `user:<id>`, so a client on the list — not inside the chat — can
  reorder without refetching). A user inside a conversation gets **both** this and
  `message:new` — handle independently; idempotent. `unread` is a v1 boolean hint;
  `lastMessageAt` is epoch-ms.
- **Payload:** `{ type:"PRIVATE"|"GROUP", roomId, lastMessageId, lastMessage:{ contentType, text }, lastMessageAt, senderId, unread }`

```ts
chat.on("conv:updated", (p) =>
  spliceInboxToTop({
    key: p.roomId,
    preview: p.lastMessage.text,
    at: p.lastMessageAt,
    unread: p.unread,
  })
);
```

### 3.20 `community:updated` — community list bump (on `/chat`!)

- **Feature:** Chat list / inbox · **Direction:** ← listen · **Room:** `user:<id>`
- **Description:** Same as `conv:updated` but for communities. **Delivered on the
  `/chat` namespace** (not `/community`) because the unified inbox uses the chat
  socket — listen there.
- **Payload:** `{ communityId, roomId, lastMessageId, lastMessage:{ contentType, text }, lastMessageAt, senderId, unread }`

```ts
chat.on("community:updated", (p) =>
  spliceInboxToTop({
    key: p.communityId,
    preview: p.lastMessage.text,
    at: p.lastMessageAt,
    unread: p.unread,
  })
);
```

> **`lastMessage.text` preview vocabulary** (same across `conv:updated`,
> `community:updated`, REST inbox, push): `TEXT`→first ~200 chars · `IMAGE`→`📷 Photo`
> · `VIDEO`→`🎥 Video` · `GIF`→`🎞 GIF` · `AUDIO`→`🎵 Audio` · `VOICE`→`🎤 Voice
message` · `DOCUMENT`→`📎 {filename}` · `STICKER`→`🌟 Sticker` ·
> `LOCATION`→`📍 {placeName}` · `CONTACT`→`👤 {contactName}` · `SYSTEM`→rendered
> sentence. Never the raw body for media types.

---

## 4. `/chat` namespace — 1-1 calls (WebRTC signaling)

The backend is **signaling-only** (media is P2P / TURN via `rtcConfig`). **1-1 only**
in V1.

### 4.1 `call:initiate`

- **Direction:** → emit · **Ack:** ✅ `{ callId, status, rtcConfig }`
- **Description:** Start a call. The callee's `user:<calleeId>` receives
  `call:incoming`. Feed `rtcConfig` into your `RTCPeerConnection`.
- **Payload:** `{ calleeId, callType?:"AUDIO"|"VIDEO", privateRoomId? }`

```ts
const res = await emitAck(chat, "call:initiate", {
  calleeId,
  callType: "VIDEO",
});
const pc = new RTCPeerConnection(res.data.rtcConfig);
```

### 4.2 `call:answer` / `call:decline` / `call:end`

- **Direction:** → emit · **Ack:** ✅ · **Payload:** `{ callId }`
- **Description:** Accept / reject / hang up. Broadcasts to `call:<callId>` as
  `call:answered` / `call:declined` / `call:ended`. **Caller cancel (V1):** emit
  `call:end` before answer → callee sees `call:ended { durationSec:0 }`.

```ts
await emitAck(chat, "call:answer", { callId });
await emitAck(chat, "call:end", { callId });
```

### 4.3 `call:ice`

- **Direction:** → emit 🔕 **and** ← listen · **Room:** `call:<callId>`
- **Description:** Relay ICE candidates as the WebRTC engine produces them (Redis-
  only, never persisted). Received candidates carry `from`.
- **Payload:** `{ callId, candidate }` emit / `{ callId, candidate, from }` listen

```ts
pc.onicecandidate = (e) =>
  e.candidate && chat.emit("call:ice", { callId, candidate: e.candidate });
chat.on("call:ice", (p) => pc.addIceCandidate(p.candidate));
```

### 4.4 Call listeners

| Event           | Room            | Payload                            | Meaning           |
| --------------- | --------------- | ---------------------------------- | ----------------- |
| `call:incoming` | `user:<callee>` | `{ callId, callerId, callType }`   | someone calls you |
| `call:answered` | `call:<callId>` | `{ callId }`                       | callee accepted   |
| `call:declined` | `call:<callId>` | `{ callId }`                       | callee rejected   |
| `call:ended`    | `call:<callId>` | `{ callId, endedBy, durationSec }` | call ended        |

```ts
chat.on("call:incoming", (p) => showIncomingCallUI(p));
chat.on("call:ended", (p) => teardownCall(p.callId, p.durationSec));
```

---

## 5. `/community` namespace — events

Many-member chat. Uses **ISO-8601 cursors** and `id`/`ts` catch-up (not
`sequenceNumber`). Deletes broadcast on `conv:<roomId>`; list bumps arrive on
`/chat` as `community:updated`.

### 5.1 `community:join` / `community:leave`

- **Direction:** → emit · **Ack:** ✅
- **Payload:** `{ communityId, roomId }` / `{ communityId }`

```ts
await emitAck(community, "community:join", { communityId, roomId });
```

### 5.2 `community:message:send` / `community:message:new`

- **Feature:** Community chat · **Direction:** → emit ✅ + ← listen
- **Description:** Post / receive a community message (≤ 30/min). Community supports a
  dedicated `sticker` attachment. Ack is `CommunityMessageSendResult`.
- **Emit payload:** `{ communityId, roomId, clientMessageId, message≤4000, contentType, media?:{ files[]≤30 }, location?, contact?, sticker?, parentMessageId? }`
- **Listen payload:** `{ messageId, communityId, roomId, senderId, senderName, senderAvatar, message, contentType, content{…}, parentMessageId, quoteData, reactions[], clientMessageId, serverTs, sentAt }`

```ts
await emitAck(community, "community:message:send", {
  communityId,
  roomId,
  clientMessageId: crypto.randomUUID(),
  message,
  contentType: "TEXT",
});
community.on("community:message:new", (p) =>
  dispatch(communityMessageReceived(p))
);
```

### 5.3 `community:messages:fetch`

- **Direction:** → emit · **Ack:** ✅
- **Description:** Cursor-paged history. Cursor is **ISO-8601-UTC, past only** —
  invalid/future cursor → `INVALID_PAYLOAD`.
- **Payload:** `{ roomId, cursor?, limit?:1–100 (default 30) }`

```ts
await emitAck(community, "community:messages:fetch", { roomId, limit: 30 });
```

### 5.4 `community:catchup` / `community:catchup:result`

- **Direction:** → emit ✅ + ← listen
- **Description:** Reconnect gap-fill, **≤ 20 rooms** per call. Results carry a
  `syncEventType` (`new`|`edited`|`deleted`|`reacted`); paginate with `lastId`/`nextTs`.
- **Emit payload:** `{ rooms:[{ roomId, sinceId?|sinceTs?, limit?≤200 }]≤20 }`
- **Result payload:** `{ roomId, events:[{ …, syncEventType, reactions[] }], hasMore, lastId, nextTs }`

```ts
await emitAck(community, "community:catchup", {
  rooms: [{ roomId, sinceId, limit: 100 }],
});
community.on("community:catchup:result", (p) => reconcileCommunity(p));
```

### 5.5 `community:message:react` / `community:message:reaction`

- **Direction:** → emit ✅ + ← listen
- **Description:** Toggle a reaction (≤ 10/min). Broadcast carries the full current
  set; derive `selfReacted` client-side.
- **Emit payload:** `{ messageId, communityId, emoji }`
- **Listen payload:** `{ messageId, communityId, reactions:[{ emoji, count, users:[{ userId, displayName, avatar }] }] }`

```ts
await emitAck(community, "community:message:react", {
  messageId,
  communityId,
  emoji: "🔥",
});
community.on("community:message:reaction", (p) => updateCommunityReactions(p));
```

### 5.6 `community:message:edit` / `community:message:edited`

- **Direction:** → emit ✅ + ← listen
- **Emit payload:** `{ messageId, communityId, roomId, content:{ text } }`
- **Listen payload:** `{ messageId, communityId, roomId, senderId, message, contentType, editedAt }`

```ts
await emitAck(community, "community:message:edit", {
  messageId,
  communityId,
  roomId,
  content: { text },
});
community.on("community:message:edited", (p) => rerenderCommunityBubble(p));
```

### 5.7 `community:message:delete` / `community:message:deleted`

- **Direction:** → emit ✅ + ← listen
- **Description:** `forEveryone` (sender/mod/admin) is broadcast as
  `community:message:deleted`; `forMe` is hidden server-side for the caller and
  **not** broadcast.
- **Emit payload:** `{ messageId, communityId, roomId, type:"forEveryone"|"forMe" }`
- **Listen payload:** `{ messageId, communityId, roomId, deleteType:"forEveryone", deletedBy }`

```ts
await emitAck(community, "community:message:delete", {
  messageId,
  communityId,
  roomId,
  type: "forEveryone",
});
community.on("community:message:deleted", (p) =>
  removeCommunityMessage(p.messageId)
);
```

### 5.8 `community:message:pin` / `unpin` → `community:message:pinned` / `unpinned`

- **Direction:** → emit ✅ (moderator/admin only) + ← listen
- **Description:** Pin/unpin. The broadcast's `pinnedIds` is the **COMPLETE** list —
  replace your local pinned set, don't merge.
- **Emit payload:** `{ messageId, communityId, roomId }`
- **Listen payload:** `{ messageId, communityId, roomId, pinnedIds[], pinnedCount, pinnedAt, pinnedBy }` (unpin: `unpinnedBy`)

```ts
await emitAck(community, "community:message:pin", {
  messageId,
  communityId,
  roomId,
});
community.on("community:message:pinned", (p) =>
  setPinned(p.communityId, p.pinnedIds)
);
community.on("community:message:unpinned", (p) =>
  setPinned(p.communityId, p.pinnedIds)
);
```

---

## 6. `/notify` namespace — events

In-app notification feed + unread badge.

### 6.1 `notifications:fetch`

- **Direction:** → emit · **Ack:** ✅ · **Payload:** `{ cursor?, limit?≤100 }`
- **Description:** Cursor-paged notification feed.

```ts
const res = await emitAck(notify, "notifications:fetch", { limit: 30 });
```

### 6.2 `notifications:mark_read`

- **Direction:** → emit · **Ack:** ✅ · **Payload:** `{ notificationIds: string[] }`
- **Description:** Mark notifications read. Triggers `notification:count_update` on
  **all** your devices.

```ts
await emitAck(notify, "notifications:mark_read", { notificationIds });
```

### 6.3 `notification:new`

- **Direction:** ← listen
- **Description:** A new notification (forwarded verbatim). `type` is the
  discriminator — handle unknown values defensively. Read `notificationId ?? id`
  (`id` is a deprecated alias). This is **also how REST-only features surface**:
  friend requests (`friend.requested`/`friend.accepted`) and community moderation
  (`community.member_kicked`, `community.member_banned`, `community.admin_transferred`,
  `community.member_role_changed`, `community.deleted`, `community.report_actioned`).
- **Payload:** `{ notificationId, type, title, body, referenceId, isRead, createdAt, data }`

```ts
notify.on("notification:new", (p) =>
  prependNotification({ id: p.notificationId ?? p.id, ...p })
);
```

### 6.4 `notification:count` / `notification:count_update`

- **Direction:** ← listen
- **Description:** `notification:count` fires **once on connect** with the current
  unread total. `notification:count_update` fires after a mark-read (all devices) or
  when a new notification arrives — **replace** the badge with `count`.
- **Payload:** `{ count }`

```ts
notify.on("notification:count", (p) => setBadge(p.count));
notify.on("notification:count_update", (p) => setBadge(p.count));
```

---

## 7. REST-only features (no socket emit — react to notifications)

These have **no client→server socket event**; perform them over REST and react to
the resulting `notification:new` (and refetch where noted).

| Feature                    | REST                                             | Socket signal                                             |
| -------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| Friend request/accept/etc. | `POST/DELETE /api/v1/friendships/*`              | `notification:new` `friend.requested/accepted`            |
| Community moderation       | `…/communities/:id/members/:userId/{kick,ban,…}` | `notification:new` `community.member_*`                   |
| Group lifecycle (rename…)  | `POST/PATCH /api/v1/groups/:id…`                 | `message:new` `contentType:"SYSTEM"` in the room          |
| Edit / delete (authority)  | `PATCH/DELETE …/messages/:id`                    | `message:edited` / `message:delete` broadcast             |
| Pin / unpin (chat)         | REST                                             | `pin:updated` broadcast                                   |
| Conversation create/delete | REST                                             | none — refetch `GET /api/v1/chat/inbox`, then `conv:join` |
| Search                     | REST                                             | none                                                      |
| Media upload               | presign → `PUT` MinIO → `objectKey` in `files[]` | none (bytes never cross the socket)                       |

---

## 8. Cross-cutting rules React devs trip on

1. **Order & dedupe by `sequenceNumber`** (chat) / `id`+`ts` (community) — never by
   arrival time.
2. **No cross-channel ordering** — `conv:updated` (user room) can beat `message:new`
   (conv room). Handle out-of-order.
3. **One mapper** for `message:new` / `message:edited` / forwards (shared canonical
   shape).
4. **Coerce ack numerics** (`Number(sentAt)`); broadcasts already send numbers.
5. **`contentType` is UPPER-CASE** everywhere; calls use `callType`.
6. **Idempotency** via `clientMessageId` on every send; replay-safe.
7. **Full-set replaces** — reactions and `pinnedIds` always send the complete set;
   replace, don't merge.
8. **REST is authoritative** for edit/delete/pin — socket is the broadcast; don't
   double-apply your own echo.
9. **Reconnect:** Tier-1 (`recovered`) → do nothing; Tier-2 → re-join + re-subscribe
   - `chat:catchup`/`community:catchup` (≤ 50 / ≤ 20 rooms).
10. **Background:** one `presence:heartbeat { appState:"BACKGROUND" }`, stop the
    foreground heartbeat, expect messages via push.

---

For architecture and ready-to-paste hooks, see
[`SOCKET_FRONTEND_GUIDE.md`](SOCKET_FRONTEND_GUIDE.md). For the authoritative
contract and AsyncAPI spec, see [`SOCKET_EVENTS.md`](SOCKET_EVENTS.md).
