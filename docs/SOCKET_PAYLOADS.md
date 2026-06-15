# AIMess — Socket Payloads & Responses (FE Reference)

Concrete example JSON for **every** socket event: the **request** you emit, the
**ack response** you get back in the callback, and the **broadcast payload** you
receive. Use this to type your interfaces and to know exactly what lands on the
wire.

Companion docs: [`SOCKET_EVENT_CATALOG.md`](SOCKET_EVENT_CATALOG.md) (what each
event is) · [`SOCKET_FRONTEND_GUIDE.md`](SOCKET_FRONTEND_GUIDE.md) (architecture) ·
[`SOCKET_EVENTS.md`](SOCKET_EVENTS.md) (authoritative contract).

> **How to read this**
>
> - **Request** = the object you pass to `socket.emit(event, request, cb)`.
> - **Ack response** = the object delivered to your `cb` (the envelope below). Only
>   **acked** events have one.
> - **Broadcast** = what arrives in `socket.on(event, payload => …)`.
> - Values are illustrative. **Numbers in an ack `data` are stringified epoch-ms**
>   (gRPC int64 → string) — coerce with `Number()`. The same field in a **broadcast**
>   is a real number.

### The ack envelope (every acked event)

```jsonc
// SUCCESS
{
  "success": true,
  "message": "Message sent successfully",   // localized, display-ready — do NOT branch on it
  "data": { /* event-specific, shown per event below */ }
}

// SUCCESS with no data (e.g. conv:join)
{ "success": true, "message": "Joined the conversation successfully" }

// FAILURE
{
  "success": false,
  "error": "RATE_LIMITED",                  // INVALID_PAYLOAD|SERVICE_ERROR|RATE_LIMITED|FORBIDDEN|NOT_FOUND|CONFLICT
  "retryable": true,
  "message": "Too many requests, please slow down",
  "retryAfter": 1749633600000               // optional, epoch-ms — only on some RATE_LIMITED acks
}
```

---

## 1. `/chat` — conversation rooms

### `conv:join`

```jsonc
// → emit (request)
{ "conversationId": "conv_64f1a2b3c4d5e6f7" }

// ← ack response (no data)
{ "success": true, "message": "Joined the conversation successfully" }
```

### `conv:leave`

```jsonc
// → emit
{ "conversationId": "conv_64f1a2b3c4d5e6f7" }

// ← ack
{ "success": true, "message": "Left the conversation successfully" }
```

---

## 2. `/chat` — send & receive

### `message:send`

```jsonc
// → emit (request)
{
  "conversationId": "conv_64f1a2b3c4d5e6f7",
  "clientMessageId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "contentType": "TEXT",
  "contentText": "Hey, are we still on for 5pm?",
  "conversationType": "private",
  "receiverId": "usr_a1b2c3",
  "repliedToId": null
}

// ← ack response — MessageSendResult (numbers are STRINGIFIED here)
{
  "success": true,
  "message": "Message sent successfully",
  "data": {
    "messageId": "msg_66a0f1e2d3c4b5a6",
    "conversationId": "conv_64f1a2b3c4d5e6f7",
    "sequenceNumber": "1487",          // coerce: Number(data.sequenceNumber)
    "sentAt": "1749633123456",         // coerce: Number(data.sentAt)
    "alreadySent": false               // true if this clientMessageId was already processed (idempotent replay)
  }
}
```

**With media** (upload first, reference `objectKey`):

```jsonc
// → emit
{
  "conversationId": "conv_64f1a2b3c4d5e6f7",
  "clientMessageId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "contentType": "IMAGE",
  "files": [
    {
      "objectKey": "uploads/2026/06/abc.jpg",
      "name": "beach.jpg",
      "size": 284512,
      "mime": "image/jpeg",
      "width": 1080,
      "height": 1350,
    },
  ],
  "conversationType": "private",
  "receiverId": "usr_a1b2c3",
}
// ← ack: same MessageSendResult shape as above
```

### `message:new` (broadcast — canonical `ChatMessage`)

```jsonc
// ← listen — room conv:<id>. Numbers here are REAL numbers.
{
  "id": "msg_66a0f1e2d3c4b5a6",
  "clientMessageId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "roomId": "conv_64f1a2b3c4d5e6f7",
  "conversationType": "private",
  "senderId": "usr_me123",
  "senderName": "Vasundhara",
  "senderAvatar": "https://cdn.aimess.io/av/usr_me123.jpg",
  "senderRole": "MEMBER",
  "receiverId": "usr_a1b2c3",
  "contentType": "TEXT",
  "content": {
    "text": "Hey, are we still on for 5pm?",
    "files": [],
    "urls": [],
    "location": null,
    "contact": null,
  },
  "parentMessageId": null,
  "quoteData": null,
  "reactions": [],
  "isDeleted": false,
  "deletedType": null,
  "editedAt": null,
  "clientTs": 1749633123000,
  "serverTs": 1749633123456,
  "sequenceNumber": 1487,

  // V1 aliases (kept for back-compat — prefer the canonical fields above)
  "messageId": "msg_66a0f1e2d3c4b5a6",
  "conversationId": "conv_64f1a2b3c4d5e6f7",
  "contentText": "Hey, are we still on for 5pm?",
  "contentJson": "{\"text\":\"Hey, are we still on for 5pm?\"}",
  "sentAt": 1749633123456,
}
```

**Forwarded** message adds `"isForwarded": true`.

**Group SYSTEM** message variant:

```jsonc
{
  "id": "msg_77b1...",
  "roomId": "conv_group_998",
  "conversationType": "group",
  "senderId": "system",
  "contentType": "SYSTEM",
  "content": { "text": "Vasundhara added Arjun" },
  "systemEvent": "MEMBER_ADDED",
  "systemData": {
    "actorId": "usr_me123",
    "actorName": "Vasundhara",
    "targetUserId": "usr_x9",
    "targetName": "Arjun",
  },
  "contentText": "Vasundhara added Arjun", // English fallback — prefer rendering from systemEvent + systemData
  "sequenceNumber": 204,
  "reactions": [],
  "isDeleted": false,
}
```

---

## 3. `/chat` — receipts

### `message:read`

```jsonc
// → emit (request)
{ "conversationId": "conv_64f1a2b3c4d5e6f7", "upToMessageId": "msg_66a0f1e2d3c4b5a6" }

// ← ack
{ "success": true, "message": "Messages marked as read" }

// ← broadcast to conv:<id> (a peer read your messages)
{ "conversationId": "conv_64f1a2b3c4d5e6f7", "readerId": "usr_a1b2c3", "upToMessageId": "msg_66a0f1e2d3c4b5a6" }
```

### `message:delivered` (private only)

```jsonc
// → emit
{ "conversationId": "conv_64f1a2b3c4d5e6f7", "upToMessageId": "msg_66a0f1e2d3c4b5a6" }

// ← ack
{ "success": true, "message": "Messages marked as delivered" }

// ← broadcast to conv:<id>
{
  "conversationId": "conv_64f1a2b3c4d5e6f7",
  "recipientId": "usr_a1b2c3",
  "upToMessageId": "msg_66a0f1e2d3c4b5a6",
  "messageIds": ["msg_66a0f1e2d3c4b5a6", "msg_66a0f1e2d3c4b5a5"]
}
```

### `read_sync` (broadcast — your other devices)

```jsonc
// ← listen — room user:<readerId>
{
  "conversationId": "conv_64f1a2b3c4d5e6f7",
  "readerId": "usr_me123",
  "read_to_seq": 1487,
  "unreadCount": 0,
  "conversationType": "private",
}
```

---

## 4. `/chat` — history & catch-up

### `messages:fetch`

```jsonc
// → emit (request)
{ "conversationId": "conv_64f1a2b3c4d5e6f7", "cursor": null, "limit": 50, "conversationType": "private" }

// ← ack response
{
  "success": true,
  "message": "Messages fetched successfully",
  "data": {
    "messages": [ /* array of canonical ChatMessage (see §2 message:new) */ ],
    "nextCursor": "eyJzZXEiOjE0Mzd9",   // pass back as cursor for the next (older) page; null/absent = no more
    "hasMore": true
  }
}
```

### `chat:catchup`

```jsonc
// → emit (request) — up to 50 rooms
{
  "rooms": [
    { "roomId": "conv_64f1a2b3c4d5e6f7", "sinceSeq": 1480, "conversationType": "private", "limit": 100 },
    { "roomId": "conv_group_998", "sinceSeq": 200, "conversationType": "group" }
  ]
}

// ← aggregate ack response
{
  "success": true,
  "message": "Caught up successfully",
  "data": {
    "rooms": [
      { "roomId": "conv_64f1a2b3c4d5e6f7", "hasMore": false, "lastSeq": 1487, "authorized": true },
      { "roomId": "conv_group_998", "hasMore": true, "lastSeq": 260, "authorized": true }
    ]
  }
}
```

### `chat:catchup:result` (broadcast — one per room, direct to your socket)

```jsonc
{
  "roomId": "conv_64f1a2b3c4d5e6f7",
  "events": [
    {
      "messageId": "msg_66a0...87",
      "conversationId": "conv_64f1a2b3c4d5e6f7",
      "senderId": "usr_a1b2c3",
      "contentType": "TEXT",
      "contentText": "yep see you then",
      "contentJson": "{\"text\":\"yep see you then\"}",
      "sentAt": 1749633200000,
      "sequenceNumber": 1485,
      "isDeleted": false,
      "deletedType": "",
      "editedAt": 0,
      "systemEvent": "",
      "systemData": "",
    },
    {
      "messageId": "msg_66a0...86",
      "conversationId": "conv_64f1a2b3c4d5e6f7",
      "senderId": "usr_a1b2c3",
      "contentType": "TEXT",
      "contentText": "[removed]",
      "sentAt": 1749633100000,
      "sequenceNumber": 1483,
      "isDeleted": true, // tombstone — included so you reconcile offline state
      "deletedType": "forEveryone",
      "editedAt": 0,
    },
  ],
  "hasMore": false,
  "lastSeq": 1487, // re-request with sinceSeq=lastSeq while hasMore is true
}
```

---

## 5. `/chat` — typing

### `typing:start` / `typing:stop` (fire-and-forget — no ack)

The inbound payload is unchanged (`senderName` optional). Every broadcast now
carries server-authoritative `userDetails` + `timestamp`; the legacy top-level
`userId`/`senderName` are kept for back-compat (`senderName` always equals
`userDetails.displayName`). `userId` is the authenticated socket user — never
client-trusted. The same enriched shape is emitted on the 6 s auto-expiry stop
and the disconnect-flush stop.

```jsonc
// → emit
{ "conversationId": "conv_64f1a2b3c4d5e6f7" } // senderName optional (legacy)

// ← broadcast to conv:<id>
{
  "conversationId": "conv_64f1a2b3c4d5e6f7",
  "userId": "usr_a1b2c3",
  "userDetails": {
    "userId": "usr_a1b2c3",
    "username": "alice",
    "displayName": "Alice",
    "avatarUrl": "https://cdn.aimess.com/avatars/alice.jpg" // null when no avatar
  },
  "timestamp": "2026-06-15T10:00:10.000Z",
  "senderName": "Alice"
}
```

---

## 5b. `/community` — typing

### `typing:start` / `typing:stop` (fire-and-forget — no ack)

Mirrors `/chat`, broadcast to the `community:<communityId>` room. Server holds a
6 s per-socket auto-expiry and flushes a stop on disconnect.

```jsonc
// → emit
{ "communityId": "comm_64f1a2b3c4d5e6f7" } // roomId?, senderName? optional

// ← broadcast to community:<communityId>
{
  "conversationId": "comm_64f1a2b3c4d5e6f7", // == communityId
  "communityId": "comm_64f1a2b3c4d5e6f7",
  "userId": "usr_a1b2c3",
  "userDetails": {
    "userId": "usr_a1b2c3",
    "username": "alice",
    "displayName": "Alice",
    "avatarUrl": "https://cdn.aimess.com/avatars/alice.jpg" // null when no avatar
  },
  "timestamp": "2026-06-15T10:00:10.000Z",
  "senderName": "Alice"
}
```

---

## 6. `/chat` — presence

### `presence:subscribe` / `presence:unsubscribe`

```jsonc
// → emit
{ "peerIds": ["usr_a1b2c3", "usr_d4e5f6"] }

// ← ack
{ "success": true, "message": "Subscribed to presence updates" }
```

### `presence:unsubscribe_all`

```jsonc
// → emit
{}
// ← ack
{ "success": true, "message": "Unsubscribed from all presence updates", "data": { "unsubscribedCount": 7 } }
```

### `presence:list`

```jsonc
// → emit
{}
// ← ack
{ "success": true, "message": "Presence subscription list fetched successfully", "data": { "peerIds": ["usr_a1b2c3", "usr_d4e5f6"] } }
```

### `presence:heartbeat` (fire-and-forget — no ack)

```jsonc
// → emit
{ "appState": "FOREGROUND" } // or "BACKGROUND"
```

### `presence:status` (broadcast)

```jsonc
// ← listen — room user:<peerId>
{
  "userId": "usr_a1b2c3",
  "isOnline": true,
  "lastActiveAt": 1749633120000,
  "lastSeen": 1749633120000,
}
```

---

## 7. `/chat` — reactions

### `message:react`

```jsonc
// → emit (request)
{ "messageId": "msg_66a0f1e2d3c4b5a6", "conversationId": "conv_64f1a2b3c4d5e6f7", "emoji": "👍" }

// ← ack response
{
  "success": true,
  "message": "Reaction added successfully",
  "data": { "messageId": "msg_66a0f1e2d3c4b5a6", "reactions": [ { "userId": "usr_me123", "emoji": "👍" } ] }
}
```

### `message:reactions:get`

```jsonc
// → emit
{ "messageId": "msg_66a0f1e2d3c4b5a6", "conversationId": "conv_64f1a2b3c4d5e6f7", "conversationType": "private" }

// ← ack
{
  "success": true,
  "message": "Reactions fetched successfully",
  "data": {
    "messageId": "msg_66a0f1e2d3c4b5a6",
    "reactions": [
      { "emoji": "👍", "count": 2, "users": [
        { "userId": "usr_me123", "displayName": "Vasundhara", "avatar": "https://cdn.aimess.io/av/usr_me123.jpg" },
        { "userId": "usr_a1b2c3", "displayName": "Priya", "avatar": null }
      ] }
    ]
  }
}
```

### `message:reaction` (broadcast — FULL current set, replace don't merge)

```jsonc
// ← listen — room conv:<id>
{
  "messageId": "msg_66a0f1e2d3c4b5a6",
  "conversationId": "conv_64f1a2b3c4d5e6f7",
  "reactions": [
    {
      "emoji": "👍",
      "count": 2,
      "users": [
        {
          "userId": "usr_me123",
          "displayName": "Vasundhara",
          "avatar": "https://cdn.aimess.io/av/usr_me123.jpg",
        },
        { "userId": "usr_a1b2c3", "displayName": "Priya", "avatar": null },
      ],
    },
    {
      "emoji": "🔥",
      "count": 1,
      "users": [
        { "userId": "usr_d4e5f6", "displayName": "Arjun", "avatar": null },
      ],
    },
  ],
}
// selfReacted is derived: reactions[].users[].userId === myUserId
```

---

## 8. `/chat` — edit, delete, forward

### `message:edit`

```jsonc
// → emit (request)
{ "messageId": "msg_66a0f1e2d3c4b5a6", "conversationId": "conv_64f1a2b3c4d5e6f7", "contentText": "Hey, are we still on for 6pm?", "conversationType": "private" }

// ← ack
{ "success": true, "message": "Message edited successfully", "data": { /* canonical ChatMessage, editedAt set */ } }
```

### `message:edited` (broadcast — same canonical shape as `message:new`)

```jsonc
// ← listen — room conv:<id>
{
  "id": "msg_66a0f1e2d3c4b5a6",
  "roomId": "conv_64f1a2b3c4d5e6f7",
  "conversationType": "private",
  "senderId": "usr_me123",
  "contentType": "TEXT",
  "content": { "text": "Hey, are we still on for 6pm?" },
  "reactions": [],
  "isDeleted": false,
  "editedAt": 1749633500000,
  "sequenceNumber": 1487,
  "contentText": "Hey, are we still on for 6pm?",
  "sentAt": 1749633123456,
}
```

### `message:delete` (broadcast — REST is the authoritative mutation)

```jsonc
// ← listen — room conv:<id>
{
  "messageId": "msg_66a0f1e2d3c4b5a6",
  "conversationId": "conv_64f1a2b3c4d5e6f7",
  "type": "forEveryone", // or "forMe"
  "deletedType": "forEveryone",
  "deletedBy": "usr_me123",
  "sequenceNumber": 1490,
}
// rule: forEveryone → hide for all; forMe → hide only if deletedBy === myUserId
```

### `message:forward`

```jsonc
// → emit (request)
{
  "messageId": "msg_66a0f1e2d3c4b5a6",
  "targetConversationId": "conv_other_555",
  "clientMessageId": "c0ffee00-1111-2222-3333-444455556666",
  "conversationType": "private",
  "receiverId": "usr_z9"
}

// ← ack — MessageSendResult (stringified numbers)
{
  "success": true,
  "message": "Message forwarded successfully",
  "data": { "messageId": "msg_88c2...", "conversationId": "conv_other_555", "sequenceNumber": "42", "sentAt": "1749633600000", "alreadySent": false }
}
// target room receives a message:new with "isForwarded": true
```

---

## 9. `/chat` — pin & list bumps

### `pin:updated` (broadcast)

```jsonc
// ← listen — room conv:<id>
{
  "roomId": "conv_64f1a2b3c4d5e6f7",
  "conversationId": "conv_64f1a2b3c4d5e6f7",
  "messageId": "msg_66a0f1e2d3c4b5a6",
  "action": "pinned", // or "unpinned"
  "pinnedBy": "usr_me123", // "unpinnedBy" on unpin
  "pinnedAt": 1749633700000,
  "pinnedCount": 3,
}
```

### `conv:updated` (broadcast — chat list bump-to-top)

```jsonc
// ← listen — room user:<id>
{
  "type": "PRIVATE", // or "GROUP"
  "roomId": "conv_64f1a2b3c4d5e6f7",
  "lastMessageId": "msg_66a0f1e2d3c4b5a6",
  "lastMessage": {
    "contentType": "TEXT",
    "text": "Hey, are we still on for 5pm?",
  },
  "lastMessageAt": 1749633123456, // epoch-ms, real number
  "senderId": "usr_a1b2c3",
  "unread": true, // v1 boolean hint (false on the sender's own copy)
}
```

### `community:updated` (broadcast — delivered on the `/chat` socket!)

```jsonc
// ← listen — room user:<id>, on the /chat namespace
{
  "communityId": "comm_12345",
  "roomId": "comm_room_678",
  "lastMessageId": "cmsg_99",
  "lastMessage": { "contentType": "IMAGE", "text": "📷 Photo" },
  "lastMessageAt": 1749633800000,
  "senderId": "usr_d4e5f6",
  "unread": true,
}
```

> `lastMessage.text` for non-text types is a placeholder, never the raw body:
> `📷 Photo`, `🎥 Video`, `🎞 GIF`, `🎵 Audio`, `🎤 Voice message`,
> `📎 {filename}`, `🌟 Sticker`, `📍 {placeName}`, `👤 {contactName}`.

---

## 10. `/chat` — 1-1 calls

### `call:initiate`

```jsonc
// → emit (request)
{ "calleeId": "usr_a1b2c3", "callType": "VIDEO" }

// ← ack response
{
  "success": true,
  "message": "Call initiated successfully",
  "data": {
    "callId": "call_aabbccdd",
    "status": "RINGING",
    "rtcConfig": {
      "iceServers": [
        { "urls": "stun:stun.aimess.io:3478" },
        { "urls": "turn:turn.aimess.io:3478", "username": "u123", "credential": "tok456" }
      ]
    }
  }
}
```

### `call:answer` / `call:decline` / `call:end`

```jsonc
// → emit
{ "callId": "call_aabbccdd" }

// ← ack (one of)
{ "success": true, "message": "Call answered successfully" }
{ "success": true, "message": "Call declined" }
{ "success": true, "message": "Call ended" }
```

### `call:ice` (fire-and-forget)

```jsonc
// → emit
{ "callId": "call_aabbccdd", "candidate": { "candidate": "candidate:842163049 1 udp …", "sdpMid": "0", "sdpMLineIndex": 0 } }

// ← broadcast to call:<callId>
{ "callId": "call_aabbccdd", "candidate": { /* RTCIceCandidate */ }, "from": "usr_a1b2c3" }
```

### Call broadcasts

```jsonc
// ← call:incoming — room user:<calleeId>
{ "callId": "call_aabbccdd", "callerId": "usr_me123", "callType": "VIDEO" }

// ← call:answered — room call:<callId>
{ "callId": "call_aabbccdd" }

// ← call:declined — room call:<callId>
{ "callId": "call_aabbccdd" }

// ← call:ended — room call:<callId>
{ "callId": "call_aabbccdd", "endedBy": "usr_a1b2c3", "durationSec": 142 }
```

---

## 11. `/community` namespace

### `community:join` / `community:leave`

```jsonc
// → emit
{ "communityId": "comm_12345", "roomId": "comm_room_678" }   // leave: { communityId }
// ← ack
{ "success": true, "message": "Joined the community successfully" }
```

### `community:message:send`

```jsonc
// → emit (request)
{
  "communityId": "comm_12345",
  "roomId": "comm_room_678",
  "clientMessageId": "aaa11122-bbb3-cccc-ddd4-eeeeffff5555",
  "message": "Welcome everyone 👋",
  "contentType": "TEXT",
  "parentMessageId": null
}

// ← ack — CommunityMessageSendResult
{
  "success": true,
  "message": "Message sent successfully",
  "data": {
    "messageId": "cmsg_66f00112",
    "communityId": "comm_12345",
    "roomId": "comm_room_678",
    "clientMessageId": "aaa11122-bbb3-cccc-ddd4-eeeeffff5555",
    "sentAt": "1749633900000",      // stringified on ack
    "serverTs": "1749633900000"
  }
}
```

### `community:message:new` (broadcast)

```jsonc
// ← listen — room community:<id>
{
  "messageId": "cmsg_66f00112",
  "communityId": "comm_12345",
  "roomId": "comm_room_678",
  "senderId": "usr_me123",
  "senderName": "Vasundhara",
  "senderAvatar": "https://cdn.aimess.io/av/usr_me123.jpg",
  "message": "Welcome everyone 👋",
  "contentType": "TEXT",
  "content": { "text": "Welcome everyone 👋" },
  "parentMessageId": null,
  "quoteData": null,
  "reactions": [],
  "clientMessageId": "aaa11122-bbb3-cccc-ddd4-eeeeffff5555",
  "serverTs": 1749633900000,
  "sentAt": 1749633900000,
}
```

### `community:messages:fetch`

```jsonc
// → emit
{ "roomId": "comm_room_678", "cursor": "2026-06-11T08:00:00.000Z", "limit": 30 }

// ← ack
{
  "success": true,
  "message": "Community messages fetched successfully",
  "data": {
    "messages": [ /* array of community message objects (see community:message:new) */ ],
    "nextCursor": "2026-06-11T07:30:00.000Z",   // ISO-8601-UTC, past only; null = no more
    "hasMore": true
  }
}
```

### `community:catchup` / `community:catchup:result`

```jsonc
// → emit (≤ 20 rooms)
{ "rooms": [ { "roomId": "comm_room_678", "sinceId": "cmsg_66f00100", "limit": 100 } ] }

// ← aggregate ack
{ "success": true, "message": "Caught up successfully", "data": { "rooms": [ { "roomId": "comm_room_678", "hasMore": false, "lastId": "cmsg_66f00112", "nextTs": "2026-06-11T08:05:00.000Z" } ] } }

// ← community:catchup:result (one per room)
{
  "roomId": "comm_room_678",
  "events": [
    { "messageId": "cmsg_66f00110", "syncEventType": "new",     "senderId": "usr_x", "message": "hi", "contentType": "TEXT", "reactions": [], "sentAt": 1749633850000 },
    { "messageId": "cmsg_66f00108", "syncEventType": "edited",  "message": "edited text", "editedAt": 1749633860000, "reactions": [] },
    { "messageId": "cmsg_66f00105", "syncEventType": "deleted", "deleteType": "forEveryone", "deletedBy": "usr_mod" },
    { "messageId": "cmsg_66f00102", "syncEventType": "reacted", "reactions": [ { "emoji": "👍", "count": 1, "users": [ { "userId": "usr_y", "displayName": "Sam", "avatar": null } ] } ] }
  ],
  "hasMore": false,
  "lastId": "cmsg_66f00112",
  "nextTs": "2026-06-11T08:05:00.000Z"
}
```

### `community:message:react` / `community:message:reaction`

```jsonc
// → emit
{ "messageId": "cmsg_66f00112", "communityId": "comm_12345", "emoji": "🔥" }
// ← ack
{ "success": true, "message": "Reaction added successfully", "data": { "messageId": "cmsg_66f00112", "reactions": [ { "userId": "usr_me123", "emoji": "🔥" } ] } }

// ← broadcast — room community:<id> (FULL current set)
{
  "messageId": "cmsg_66f00112",
  "communityId": "comm_12345",
  "reactions": [ { "emoji": "🔥", "count": 1, "users": [ { "userId": "usr_me123", "displayName": "Vasundhara", "avatar": null } ] } ]
}
```

### `community:message:edit` / `community:message:edited`

```jsonc
// → emit
{ "messageId": "cmsg_66f00112", "communityId": "comm_12345", "roomId": "comm_room_678", "content": { "text": "Welcome all 👋 (edited)" } }
// ← ack
{ "success": true, "message": "Message edited successfully" }

// ← broadcast — room community:<id>
{ "messageId": "cmsg_66f00112", "communityId": "comm_12345", "roomId": "comm_room_678", "senderId": "usr_me123", "message": "Welcome all 👋 (edited)", "contentType": "TEXT", "editedAt": 1749634000000 }
```

### `community:message:delete` / `community:message:deleted`

```jsonc
// → emit
{ "messageId": "cmsg_66f00112", "communityId": "comm_12345", "roomId": "comm_room_678", "type": "forEveryone" }
// ← ack
{ "success": true, "message": "Message deleted successfully" }

// ← broadcast — room community:<id> (forEveryone only; forMe is NOT broadcast)
{ "messageId": "cmsg_66f00112", "communityId": "comm_12345", "roomId": "comm_room_678", "deleteType": "forEveryone", "deletedBy": "usr_me123" }
```

### `community:message:pin` / `unpin` → `pinned` / `unpinned`

```jsonc
// → emit
{ "messageId": "cmsg_66f00112", "communityId": "comm_12345", "roomId": "comm_room_678" }
// ← ack
{ "success": true, "message": "Message pinned successfully" }

// ← broadcast community:message:pinned — room community:<id> (pinnedIds is the COMPLETE list)
{ "messageId": "cmsg_66f00112", "communityId": "comm_12345", "roomId": "comm_room_678", "pinnedIds": ["cmsg_66f00112", "cmsg_66f00090"], "pinnedCount": 2, "pinnedAt": 1749634100000, "pinnedBy": "usr_me123" }

// ← broadcast community:message:unpinned (remaining complete list)
{ "messageId": "cmsg_66f00112", "communityId": "comm_12345", "roomId": "comm_room_678", "pinnedIds": ["cmsg_66f00090"], "pinnedCount": 1, "unpinnedBy": "usr_me123" }
```

> Community message **deletes** are also emitted as `message:delete` on the
> `conv:<roomId>` channel (see §8). Community **list bumps** arrive as
> `community:updated` on the **`/chat`** socket (see §9).

---

## 12. `/notify` namespace

### `notifications:fetch`

```jsonc
// → emit
{ "cursor": null, "limit": 30 }

// ← ack
{
  "success": true,
  "message": "Notifications fetched successfully",
  "data": {
    "notifications": [
      {
        "notificationId": "ntf_abc123",
        "type": "friend.requested",
        "title": "New friend request",
        "body": "Priya sent you a friend request",
        "referenceId": "usr_a1b2c3",
        "isRead": false,
        "createdAt": 1749634200000,
        "data": { "fromUserId": "usr_a1b2c3", "fromName": "Priya" }
      }
    ],
    "nextCursor": "eyJpZCI6Im50Zl9hYmMxMjMifQ==",
    "hasMore": false
  }
}
```

### `notifications:mark_read`

```jsonc
// → emit
{ "notificationIds": ["ntf_abc123", "ntf_def456"] }
// ← ack
{ "success": true, "message": "Notifications marked as read" }
```

### `notification:new` (broadcast)

```jsonc
// ← listen — room user:<id>
{
  "notificationId": "ntf_ghi789",
  "type": "community.member_banned", // discriminator — handle unknown types defensively
  "title": "You were banned",
  "body": "You were banned from Designers Hub",
  "referenceId": "comm_12345",
  "isRead": false,
  "createdAt": 1749634300000,
  "data": { "communityId": "comm_12345", "reason": "spam", "duration": 86400 },
}
// read notificationId ?? id  (id is a deprecated alias)
```

### `notification:count` / `notification:count_update` (broadcast)

```jsonc
// ← notification:count — once on connect
{ "count": 4 }

// ← notification:count_update — after mark_read (all devices) or a new notification
{ "count": 5 }
```

---

## 13. Failure ack examples (per error code)

```jsonc
// bad payload — fix it, do not retry
{ "success": false, "error": "INVALID_PAYLOAD", "retryable": false, "message": "The request data is invalid" }

// downstream hiccup — exponential backoff (500ms→1s→2s, max 3), same clientMessageId
{ "success": false, "error": "SERVICE_ERROR", "retryable": true, "message": "Something went wrong, please try again" }

// rate limit — wait until retryAfter (epoch-ms) if present, else 30s, then ONE retry
{ "success": false, "error": "RATE_LIMITED", "retryable": true, "message": "Too many requests, please slow down", "retryAfter": 1749634400000 }

// not allowed (not a member / blocked / role) — surface, do not retry
{ "success": false, "error": "FORBIDDEN", "retryable": false, "message": "You are not allowed to perform this action" }

// target missing — surface, do not retry
{ "success": false, "error": "NOT_FOUND", "retryable": false, "message": "The requested item was not found" }

// conflicts with current state (already applied / edit window expired) — reconcile, do not blind-retry
{ "success": false, "error": "CONFLICT", "retryable": false, "message": "This action conflicts with the current state" }
```

**Connection-level auth failure** surfaces as a `connect_error` (not an ack):

```ts
socket.on("connect_error", (err) => {
  // err.message === "Authentication required" | "Authentication failed"
});
```

---

## 14. TypeScript interfaces (drop-in)

```ts
export type ContentType =
  | "TEXT"
  | "IMAGE"
  | "VIDEO"
  | "AUDIO"
  | "VOICE"
  | "DOCUMENT"
  | "GIF"
  | "STICKER"
  | "LOCATION"
  | "CONTACT"
  | "SYSTEM";

export interface ReactionGroup {
  emoji: string;
  count: number;
  users: { userId: string; displayName: string; avatar: string | null }[];
}

export interface ChatMessage {
  id: string;
  clientMessageId?: string;
  roomId: string;
  conversationType: "private" | "group";
  senderId: string;
  senderName?: string;
  senderAvatar?: string;
  senderRole?: string;
  receiverId?: string;
  contentType: ContentType;
  content: {
    text?: string;
    files?: unknown[];
    urls?: string[];
    location?: unknown;
    contact?: unknown;
  };
  parentMessageId?: string | null;
  quoteData?: unknown | null;
  reactions: ReactionGroup[];
  isDeleted: boolean;
  deletedType?: string | null;
  editedAt?: number | null;
  clientTs?: number;
  serverTs?: number;
  sequenceNumber: number;
  isForwarded?: boolean;
  systemEvent?: string;
  systemData?: Record<string, unknown>;
}

export interface MessageSendResult {
  messageId: string;
  conversationId: string;
  sequenceNumber: string; // stringified on ack — Number(it)
  sentAt: string; // stringified on ack — Number(it)
  alreadySent: boolean;
}

export interface ListBump {
  type?: "PRIVATE" | "GROUP";
  roomId: string;
  communityId?: string;
  lastMessageId: string;
  lastMessage: { contentType: ContentType; text: string };
  lastMessageAt: number;
  senderId: string;
  unread: boolean;
}

export interface NotificationItem {
  notificationId: string;
  id?: string; // deprecated alias
  type: string;
  title: string;
  body: string;
  referenceId: string;
  isRead: boolean;
  createdAt: number;
  data: Record<string, unknown>;
}
```

---

See [`SOCKET_EVENT_CATALOG.md`](SOCKET_EVENT_CATALOG.md) for descriptions and
[`SOCKET_EVENTS.md`](SOCKET_EVENTS.md) for the authoritative contract + AsyncAPI
spec.
