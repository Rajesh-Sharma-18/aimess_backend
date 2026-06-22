# AIMess — Frontend Socket Events Guide

A practical reference for frontend/mobile engineers. Covers every Socket.IO event, its exact payload shape, a concrete code example, and when to use it.

> **Source of truth:** `apps/api-gateway/src/sockets/` (code wins over all docs).
> **Machine-readable spec:** `apps/api-gateway/asyncapi/asyncapi.yaml`.
> **Deep contract notes:** `docs/SOCKET_EVENTS.md`.

---

## Table of Contents

1. [Connection Setup](#1-connection-setup)
2. [Ack Envelope (all namespaces)](#2-ack-envelope-all-namespaces)
3. [/chat — Private & Group Chat](#3-chat-namespace)
   - 3.1 [Client → Server](#31-client--server)
   - 3.2 [Server → Client](#32-server--client)
   - 3.3 [Reconnect gap-fill (chat:catchup)](#33-reconnect-gap-fill)
4. [/community — Community Chat](#4-community-namespace)
   - 4.1 [Client → Server](#41-client--server)
   - 4.2 [Server → Client](#42-server--client)
   - 4.3 [Community System Messages](#43-community-system-messages)
5. [/notify — Notifications](#5-notify-namespace)
   - 5.1 [Client → Server](#51-client--server)
   - 5.2 [Server → Client](#52-server--client)
6. [Key Message Shapes](#6-key-message-shapes)
7. [Common Patterns & Scenarios](#7-common-patterns--scenarios)
8. [Rate Limits & Caps](#8-rate-limits--caps)
9. [Error Handling](#9-error-handling)
10. [V2 Breaking Changes Heads-up](#10-v2-breaking-changes)
11. [Quick Index](#11-quick-index)

---

## 1. Connection Setup

### Infrastructure

| Property              | Value                                               |
| --------------------- | --------------------------------------------------- |
| Transport path        | `/socket.io/`                                       |
| Base URL              | `https://api.aimess…` / `http://localhost:8000`     |
| Namespaces            | `/chat`, `/community`, `/notify`                    |
| Max payload           | 1 MB                                                |
| State recovery window | 2 minutes                                           |
| Heartbeat             | ping every 25 s / timeout 20 s (Socket.IO defaults) |

### Authentication

Every namespace requires a JWT **access token** on the handshake. Missing or invalid tokens reject the connection immediately.

```js
import { io } from "socket.io-client";

const BASE_URL = "https://api.aimess.io"; // or http://localhost:8000

// Open all three namespaces — they share ONE multiplexed transport
const chat = io(`${BASE_URL}/chat`, {
  path: "/socket.io/",
  transports: ["websocket", "polling"], // WS-first, polling fallback
  auth: { token: accessToken }, // <-- JWT access token here
  query: {
    platform: "ios", // "android" | "ios" | "web" (optional, for presence)
    clientType: "mobile", // "mobile" | "web" (optional, for presence)
  },
});

const community = io(`${BASE_URL}/community`, {
  path: "/socket.io/",
  transports: ["websocket", "polling"],
  auth: { token: accessToken },
});

const notify = io(`${BASE_URL}/notify`, {
  path: "/socket.io/",
  transports: ["websocket", "polling"],
  auth: { token: accessToken },
});
```

### Rooms (never set by client — auto-managed by server)

| Room                      | Joined when                     | Used for                                                    |
| ------------------------- | ------------------------------- | ----------------------------------------------------------- |
| `user:<userId>`           | Auto on every namespace connect | Per-user events: calls, presence, notifications, list bumps |
| `conv:<conversationId>`   | Client emits `conv:join`        | 1-1 and group message events                                |
| `community:<communityId>` | Client emits `community:join`   | Community chat events                                       |
| `call:<callId>`           | Implicit via `call:*` flow      | WebRTC ICE signaling                                        |

### Token expiry on a live socket

```js
// Listen on both /chat and /community — each sends its own expiry warning
chat.on("session:expired", ({ reason, expiresAt, gracePeriod }) => {
  // Refresh token within `gracePeriod` seconds to stay connected
  chat.emit("auth:refresh", { refreshToken }, (res) => {
    if (res.success) {
      // store res.data.accessToken — no reconnect needed
    }
  });
});
```

---

## 2. Ack Envelope (all namespaces)

Every `emit` with a callback uses the same response shape:

```ts
// Success (with data)
{ success: true, message: "Message sent successfully", data: { messageId, ... } }

// Success (no data, e.g. conv:join)
{ success: true, message: "Joined the conversation successfully" }

// Failure
{ success: false, error: "SERVICE_ERROR", retryable: true, message: "Something went wrong, please try again" }
```

| Field       | Description                                                                |
| ----------- | -------------------------------------------------------------------------- |
| `success`   | `true` / `false` — branch on this first                                    |
| `message`   | Localized, display-ready sentence — show to user as-is                     |
| `data`      | Result payload (success only, event-specific)                              |
| `error`     | Error code — see §9 for the full taxonomy                                  |
| `retryable` | `true` → safe to retry with same payload; `false` → fix or surface to user |

```js
// Generic ack handler pattern
socket.emit("some:event", payload, (res) => {
  if (!res.success) {
    if (res.retryable) {
      scheduleRetry(payload); // exponential backoff
    } else {
      showError(res.message); // permanent — don't retry
    }
    return;
  }
  const { data } = res;
  // use data
});
```

> **Fire-and-forget events** (`typing:start`, `typing:stop`, `presence:heartbeat`, `call:ice`) have **no ack** — invalid payloads are silently dropped. Validate client-side before sending.

---

## 3. `/chat` Namespace

Handles 1-1 messages, group messages, read/delivery receipts, reactions, typing indicators, presence, and 1-1 WebRTC call signaling.

---

### 3.1 Client → Server

#### `conv:join`

Join a conversation room to start receiving its `message:new` events.

```js
chat.emit("conv:join", { conversationId: "abc123" }, (res) => {
  // res.success is always true (idempotent — re-joining is safe)
  console.log(res.message); // "Joined the conversation successfully"
});
```

**Payload:** `{ conversationId: string }`
**Ack data:** none
**Notes:** Idempotent. Access is enforced at `message:send` time, not here.

---

#### `conv:leave`

Leave a conversation room (stop receiving its broadcasts).

```js
chat.emit("conv:leave", { conversationId: "abc123" }, (res) => {
  console.log(res.success); // true — idempotent
});
```

**Payload:** `{ conversationId: string }`

---

#### `message:send`

Send a new 1-1 or group message.

```js
// Text message
chat.emit(
  "message:send",
  {
    conversationId: "abc123",
    clientMessageId: crypto.randomUUID(), // your idempotency key — KEEP for retries
    contentType: "TEXT",
    contentText: "Hello!",
    conversationType: "private", // "private" | "group"
    receiverId: "user456", // peer userId (private only)
    senderName: "John", // optional — your display name
    senderAvatar: "https://cdn…/avatar.jpg", // optional
  },
  (res) => {
    if (res.success) {
      const { messageId, sequenceNumber, sentAt, alreadySent } = res.data;
      // alreadySent: true means a retry hit the same clientMessageId
    }
  }
);

// Image message (upload file first via POST /api/v1/upload/sign, then send objectKey)
chat.emit(
  "message:send",
  {
    conversationId: "abc123",
    clientMessageId: crypto.randomUUID(),
    contentType: "IMAGE",
    files: [
      {
        objectKey: "uploads/user123/image.jpg", // from the presigned upload flow
        name: "photo.jpg",
        size: 204800,
        mime: "image/jpeg",
        width: 1080,
        height: 720,
      },
    ],
    conversationType: "private",
  },
  (res) => {
    /* ... */
  }
);

// Reply to a message
chat.emit(
  "message:send",
  {
    conversationId: "abc123",
    clientMessageId: crypto.randomUUID(),
    contentType: "TEXT",
    contentText: "Nice!",
    repliedToId: "msg789", // the message being replied to
    conversationType: "private",
  },
  (res) => {
    /* ... */
  }
);
```

**Full payload:**

```ts
{
  conversationId: string;          // required
  clientMessageId: string;         // required — UUID, keep for retry (idempotent)
  contentType: ContentType;        // required — UPPER-CASE enum (see §6)
  contentText?: string;            // ≤4000 chars
  files?: FileAttachment[];        // ≤30 attachments (see §6)
  urls?: string[];                 // link previews ≤20
  location?: { lat, lng, placeName?, placeAddress? };
  contact?: { name, phone, avatar?, userId? };
  repliedToId?: string;            // reply target messageId
  conversationType?: "private" | "group"; // default "private"
  receiverId?: string;             // peer userId (private only)
  senderName?: string;             // ≤120 chars
  senderAvatar?: string;           // ≤3000 chars
}
```

**Ack data:** `{ messageId, conversationId, sequenceNumber, sentAt (epoch-ms), alreadySent }`

> **Media:** never send file bytes through the socket. Upload to presigned URL first, then send the `objectKey`. See `docs/MEDIA_UPLOAD.md`.

---

#### `message:read`

Mark messages as read up to a specific message.

```js
chat.emit(
  "message:read",
  {
    conversationId: "abc123",
    upToMessageId: "msg789",
  },
  (res) => {
    console.log(res.success); // true
  }
);
```

**Payload:** `{ conversationId: string, upToMessageId: string }`
**Broadcasts:** `message:read` to all members of `conv:<id>` + `read_sync` to your other devices.

---

#### `message:delivered`

Signal that messages were delivered to this device (private conversations only).

```js
// Emit this when you receive a message:new event
chat.on("message:new", (msg) => {
  chat.emit(
    "message:delivered",
    {
      conversationId: msg.conversationId,
      upToMessageId: msg.messageId,
    },
    (res) => {
      /* optional */
    }
  );
});
```

**Payload:** `{ conversationId: string, upToMessageId: string }`

---

#### `message:react`

Toggle a reaction (same emoji = remove it, new emoji = add it).

```js
chat.emit(
  "message:react",
  {
    messageId: "msg789",
    conversationId: "abc123",
    emoji: "👍",
  },
  (res) => {
    if (res.success) {
      // res.data.reactions — full current reaction list
    }
  }
);
```

**Payload:** `{ messageId: string, conversationId: string, emoji: string, conversationType?: string }`
**Broadcasts:** `message:reaction` to `conv:<id>` with the FULL updated reaction set.

---

#### `message:reactions:get`

Fetch who reacted to a message (for the reaction detail sheet).

```js
chat.emit(
  "message:reactions:get",
  {
    messageId: "msg789",
    conversationId: "abc123",
  },
  (res) => {
    // res.data — array of { emoji, count, users: [{ userId, displayName, avatar }] }
  }
);
```

**Payload:** `{ messageId: string, conversationId: string, conversationType?: string }`

---

#### `message:edit`

Edit your own message.

```js
chat.emit(
  "message:edit",
  {
    messageId: "msg789",
    conversationId: "abc123",
    contentText: "Updated text",
    conversationType: "private",
  },
  (res) => {
    if (res.success) {
      // Broadcasts message:edited to conv:<id>
    }
  }
);
```

**Payload:** `{ messageId: string, conversationId: string, contentText?: string, contentJson?: string, conversationType?: string }`

---

#### `message:forward`

Forward a message to another conversation.

```js
chat.emit(
  "message:forward",
  {
    messageId: "msg789",
    targetConversationId: "xyz999",
    clientMessageId: crypto.randomUUID(),
    conversationType: "private",
  },
  (res) => {
    /* ... */
  }
);
```

**Payload:** `{ messageId, targetConversationId, clientMessageId, conversationType?, receiverId?, senderName?, senderAvatar? }`
**Broadcasts:** `message:new` with `isForwarded: true` to the target conversation.

---

#### `messages:fetch`

Load paginated message history for a conversation.

```js
chat.emit(
  "messages:fetch",
  {
    conversationId: "abc123",
    limit: 50,
    cursor: "msg700", // omit for first load; use last oldest messageId for next page
    conversationType: "private",
  },
  (res) => {
    if (res.success) {
      const { messages, hasMore, cursor } = res.data;
    }
  }
);
```

**Payload:** `{ conversationId: string, cursor?: string, limit?: number (≤100), conversationType?: string }`

---

#### `typing:start` / `typing:stop`

Broadcast typing state. **No ack** — fire-and-forget.

```js
// Throttle to at most 1 per 3 seconds while the user is typing
chat.emit("typing:start", { conversationId: "abc123" });

// When user clears input / changes screen
chat.emit("typing:stop", { conversationId: "abc123" });
```

**Payload:** `{ conversationId: string }`
**Notes:** Server auto-cancels after **6 s** if no `typing:stop` arrives (handles crashes). Client should also expire its own UI after ~6 s.

---

#### `presence:heartbeat`

Keep your own online presence alive. **No ack** — fire-and-forget.

```js
// Send every 30–60 seconds while in foreground
const interval = setInterval(() => {
  chat.emit("presence:heartbeat", { appState: "FOREGROUND" });
}, 45_000);

// On backgrounding
chat.emit("presence:heartbeat", { appState: "BACKGROUND" });
clearInterval(interval);
```

**Payload:** `{ appState?: "FOREGROUND" | "BACKGROUND" }`

---

#### `presence:subscribe`

Watch other users' online status.

```js
chat.emit(
  "presence:subscribe",
  {
    peerIds: ["user456", "user789"],
  },
  (res) => {
    console.log(res.success); // true
  }
);

// Now you receive presence:status whenever they come online/offline
chat.on("presence:status", ({ userId, isOnline, lastSeen }) => {
  updateUserAvatar(userId, isOnline);
});
```

**Payload:** `{ peerIds: string[] (≤500) }`

---

#### `presence:unsubscribe`

Stop watching specific peers.

```js
chat.emit("presence:unsubscribe", { peerIds: ["user456"] }, (res) => {});
```

---

#### `presence:unsubscribe_all`

Clear all presence subscriptions at once (e.g. when leaving the contacts screen).

```js
chat.emit("presence:unsubscribe_all", {}, (res) => {
  console.log(res.data.unsubscribedCount); // how many were cleared
});
```

---

#### `presence:list`

Get the list of currently watched peer IDs.

```js
chat.emit("presence:list", {}, (res) => {
  console.log(res.data.peerIds); // string[]
});
```

---

#### `call:initiate`

Start a 1-1 audio or video call.

```js
chat.emit(
  "call:initiate",
  {
    calleeId: "user456",
    callType: "VIDEO", // "AUDIO" | "VIDEO"
  },
  (res) => {
    if (res.success) {
      const { callId, rtcConfig } = res.data;
      // rtcConfig contains ICE servers — pass to RTCPeerConnection
    }
  }
);
```

**Payload:** `{ calleeId: string, callType?: "AUDIO" | "VIDEO" }`
**Broadcasts:** `call:incoming` to the callee.

---

#### `call:answer`

Accept an incoming call.

```js
chat.on("call:incoming", ({ callId, callerId, callType }) => {
  showIncomingCallUI(callerId, callType);

  // When user taps "Accept":
  chat.emit("call:answer", { callId }, (res) => {
    if (res.success) {
      startWebRTC(callId); // begin ICE exchange
    }
  });
});
```

**Payload:** `{ callId: string }`
**Broadcasts:** `call:answered` to the caller.

---

#### `call:decline`

Reject an incoming call.

```js
chat.emit("call:decline", { callId: "call123" }, (res) => {});
```

**Payload:** `{ callId: string }`
**Broadcasts:** `call:declined` to the caller.

---

#### `call:end`

End an active call (works for both caller and callee, and for cancelling before answer).

```js
chat.emit("call:end", { callId: "call123" }, (res) => {});
```

**Payload:** `{ callId: string }`
**Broadcasts:** `call:ended` with `{ callId, endedBy, durationSec }`.
**V1 note:** To cancel a ringing call, emit `call:end` — callee sees `call:ended { durationSec: 0 }`.

---

#### `call:ice`

Relay a WebRTC ICE candidate. **No ack** — fire-and-forget.

```js
peerConnection.onicecandidate = ({ candidate }) => {
  if (candidate) {
    chat.emit("call:ice", {
      callId: "call123",
      candidate,
    });
  }
};
```

**Payload:** `{ callId: string, candidate: RTCIceCandidateInit }`

---

#### `auth:refresh`

Refresh your access token without reconnecting the socket.

```js
chat.emit("auth:refresh", { refreshToken: "rt_..." }, (res) => {
  if (res.success) {
    const { accessToken, expiresIn } = res.data;
    storeToken(accessToken);
  }
});
```

**Payload:** `{ refreshToken: string }`
**Ack data:** `{ accessToken, expiresIn }`

---

#### `chat:catchup`

Reconnect gap-fill — fetch missed messages for multiple rooms at once. See §3.3 for details.

---

### 3.2 Server → Client

#### `message:new`

A new message was sent to a conversation room you have joined.

```js
chat.on("message:new", (msg) => {
  /*
  {
    // canonical fields
    id: "msg789",
    messageId: "msg789",       // alias for id
    roomId: "abc123",
    conversationId: "abc123",  // alias for roomId
    conversationType: "private",
    senderId: "user123",
    senderName: "John",
    senderAvatar: "https://cdn…/avatar.jpg",
    senderRole: "MEMBER",
    receiverId: "user456",     // private only
    contentType: "TEXT",       // UPPER-CASE always
    content: { text: "Hello!", files: [], urls: [] },
    contentText: "Hello!",     // V1 alias
    contentJson: "{}",         // V1 alias (JSON string)
    parentMessageId: null,     // non-null for replies
    quoteData: null,           // { messageId, senderId, contentType, text, … } for replies
    reactions: [],             // current reactions
    isDeleted: false,
    deletedType: null,
    editedAt: null,
    clientTs: 1718800000000,   // epoch ms
    serverTs: 1718800001234,   // epoch ms (authoritative)
    sentAt: 1718800001234,     // epoch ms alias
    sequenceNumber: 42,        // per-room monotonic cursor — use this for ordering
    isForwarded: false,
  }
  */
  appendMessageToConversation(msg);
  // Also mark delivered:
  chat.emit("message:delivered", {
    conversationId: msg.conversationId,
    upToMessageId: msg.messageId,
  });
});
```

**Room:** `conv:<conversationId>`
**Notes:** `contentType` is always **UPPER-CASE**. Sort by `sequenceNumber` (not `serverTs` or arrival time). System messages have `contentType: "SYSTEM"` — see §12.1 in `SOCKET_EVENTS.md`.

---

#### `message:edited`

A message was edited. Same canonical shape as `message:new`.

```js
chat.on("message:edited", (msg) => {
  // Replace the existing message bubble in the same position
  // msg has the same shape as message:new — use one mapper
  updateMessageInList(msg);
});
```

**Room:** `conv:<conversationId>`

---

#### `conv:updated`

Move a chat to the top of the inbox list (WhatsApp/Telegram-style bump).

```js
chat.on(
  "conv:updated",
  ({
    type,
    roomId,
    lastMessageId,
    lastMessage,
    lastMessageAt,
    senderId,
    unread,
  }) => {
    /*
  type: "PRIVATE" | "GROUP"
  roomId: "abc123"
  lastMessageId: "msg789"
  lastMessage: { contentType: "IMAGE", text: "📷 Photo" }
  lastMessageAt: 1718800001234  // epoch ms
  senderId: "user123"
  unread: true   // false if you are the sender
  */
    bumpConversationToTop(roomId, { lastMessage, lastMessageAt, unread });
  }
);
```

**Room:** `user:<userId>` (delivered to everyone in the conversation)
**Notes:** Delivered on `/chat` namespace only (NOT `/community`). Idempotent — safe to receive multiple times.

---

#### `message:read`

A participant marked messages as read.

```js
chat.on("message:read", ({ conversationId, readerId, upToMessageId }) => {
  // Show double-tick / read receipt for messages up to upToMessageId
  markAsRead(conversationId, readerId, upToMessageId);
});
```

**Room:** `conv:<conversationId>`

---

#### `message:delivered`

A participant's device received the message.

```js
chat.on(
  "message:delivered",
  ({ conversationId, recipientId, upToMessageId, messageIds }) => {
    showDeliveredTick(conversationId, recipientId, upToMessageId);
  }
);
```

**Room:** `conv:<conversationId>`
**Notes:** Private conversations only. Group/community delivery is inferred from membership.

---

#### `message:reaction`

A reaction was added or removed. Always contains the **complete** current reaction set.

```js
chat.on("message:reaction", ({ messageId, conversationId, reactions }) => {
  /*
  reactions: [
    {
      emoji: "👍",
      count: 3,
      users: [{ userId, displayName, avatar }],
    }
  ]
  */
  // Derive selfReacted client-side:
  const selfReacted = reactions.some((r) =>
    r.users.some((u) => u.userId === myUserId)
  );
  updateReactions(messageId, reactions, selfReacted);
});
```

**Room:** `conv:<conversationId>`
**Notes:** Always replace the full reaction set, never merge/patch.

---

#### `message:delete`

A message was deleted.

```js
chat.on(
  "message:delete",
  ({
    messageId,
    conversationId,
    type,
    deletedType,
    deletedBy,
    sequenceNumber,
  }) => {
    if (type === "forEveryone") {
      hideMessageForAll(messageId);
    } else if (type === "forMe" && deletedBy === myUserId) {
      hideMessageForMe(messageId);
    }
  }
);
```

**Room:** `conv:<conversationId>`
**Payload:** `{ messageId, conversationId, type: "forEveryone" | "forMe", deletedType, deletedBy, sequenceNumber }`

---

#### `typing:start` / `typing:stop`

A peer started or stopped typing.

```js
chat.on(
  "typing:start",
  ({ conversationId, userId, userDetails, timestamp, senderName }) => {
    /*
  userDetails: {
    userId: "user456",
    username: "johndoe",
    displayName: "John",
    avatarUrl: "https://cdn…/avatar.jpg" | null,
  }
  timestamp: 1718800000000  // epoch ms
  */
    showTypingIndicator(conversationId, userDetails);
    // Always set a 6s local timer to auto-hide in case typing:stop is missed
  }
);

chat.on("typing:stop", ({ conversationId, userId }) => {
  hideTypingIndicator(conversationId, userId);
});
```

**Room:** `conv:<conversationId>`
**Notes:** `userDetails` is resolved server-side once at connect. Server auto-emits `typing:stop` after 6 s if the client crashes.

---

#### `presence:status`

A watched peer came online or went offline.

```js
chat.on("presence:status", ({ userId, isOnline, lastActiveAt, lastSeen }) => {
  updateUserStatus(userId, isOnline, lastSeen);
});
```

**Room:** `user:<peerId>` (you're subscribed via `presence:subscribe`)

---

#### `read_sync`

Your own **other devices** cleared unread (multi-device sync).

```js
chat.on(
  "read_sync",
  ({
    conversationId,
    readerId,
    read_to_seq,
    unreadCount,
    conversationType,
  }) => {
    // readerId === myUserId (your other device read it)
    clearUnreadBadge(conversationId, unreadCount);
  }
);
```

**Room:** `user:<myUserId>`

---

#### `pin:updated`

A message was pinned or unpinned in a group chat.

```js
chat.on(
  "pin:updated",
  ({
    roomId,
    conversationId,
    messageId,
    action,
    pinnedBy,
    pinnedAt,
    pinnedCount,
  }) => {
    if (action === "pinned") {
      showPinnedBanner(messageId, pinnedBy);
    } else {
      hidePinnedBanner();
    }
  }
);
```

**Room:** `conv:<conversationId>`
**Payload:** `{ roomId, conversationId, messageId, action: "pinned" | "unpinned", pinnedBy | unpinnedBy, pinnedAt (epoch-ms), pinnedCount }`

---

#### `conv:archived` / `conv:unarchived`

A conversation was archived or restored on another device.

```js
chat.on("conv:archived", ({ roomId, type, archivedAt }) => {
  moveToArchivedList(roomId);
});

chat.on("conv:unarchived", ({ roomId, type }) => {
  restoreFromArchivedList(roomId);
});
```

**Room:** `user:<myUserId>`

---

#### `call:incoming`

Someone is calling you.

```js
chat.on("call:incoming", ({ callId, callerId, callType }) => {
  /*
  callType: "AUDIO" | "VIDEO"   <-- NOTE: field is callType, NOT type
  */
  showIncomingCallScreen(callId, callerId, callType);
});
```

**Room:** `user:<myUserId>`

---

#### `call:answered` / `call:declined` / `call:ended`

```js
chat.on("call:answered", ({ callId }) => {
  startRTCConnection(); // begin ICE exchange
});

chat.on("call:declined", ({ callId }) => {
  dismissCallUI();
});

chat.on("call:ended", ({ callId, endedBy, durationSec }) => {
  showCallSummary(durationSec);
});
```

**Room:** `call:<callId>`

---

#### `call:ice`

Receive an ICE candidate from the remote peer.

```js
chat.on("call:ice", ({ callId, candidate, from }) => {
  peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
});
```

**Room:** `call:<callId>`

---

#### `session:expired`

Your access token is expiring.

```js
chat.on("session:expired", ({ reason, expiresAt, gracePeriod, reconnect }) => {
  // Refresh within `gracePeriod` seconds
  refreshAndUpdateToken();
});
```

**Room:** Direct to socket (no room)

---

#### `chat:catchup:result`

Reconnect gap-fill response (one per room). See §3.3.

---

### 3.3 Reconnect Gap-Fill

When reconnecting after **more than 2 minutes**, re-join rooms and fetch missed messages:

```js
chat.on("connect", async () => {
  if (chat.recovered) {
    // Within 2 min — rooms restored, missed emits replayed automatically
    return;
  }

  // Beyond 2 min — rebuild everything
  for (const conv of openConversations) {
    await rejoin(conv.conversationId);
  }
  await resubscribePresence(watchedPeerIds);

  // Fetch missed messages for all rooms
  chat.emit(
    "chat:catchup",
    {
      rooms: openConversations.map((c) => ({
        roomId: c.conversationId,
        sinceSeq: c.lastSequenceNumber, // highest seq you already have; 0 = from start
        conversationType: c.type, // "private" | "group"
        limit: 100,
      })), // max 50 rooms per call
    },
    (res) => {
      console.log(res.success); // true
    }
  );
});

chat.on("chat:catchup:result", ({ roomId, events, hasMore, lastSeq }) => {
  events.forEach((e) => applyMissedEvent(e));
  if (hasMore) {
    // Paginate — request more with sinceSeq = lastSeq
    chat.emit("chat:catchup", {
      rooms: [{ roomId, sinceSeq: lastSeq }],
    });
  }
});
```

**`chat:catchup` payload:** `{ rooms: [{ roomId, sinceSeq?, conversationType?, limit? }]` — max 50 rooms.
**`chat:catchup:result` shape:** `{ roomId, events: CatchupEvent[], hasMore, lastSeq }`
**`CatchupEvent` fields:** `messageId, conversationId, senderId, contentType, contentText, contentJson, sentAt, sequenceNumber, isDeleted, deletedType, editedAt, systemEvent, systemData`

---

## 4. `/community` Namespace

Many-member community chat. Mirrors the `/chat` namespace API patterns.

> **Important:** `community:updated` (inbox list bump) is delivered on **this** namespace (`/community`), not `/chat`. Connect to both namespaces if you render both lists.

---

### 4.1 Client → Server

#### `community:join`

Join a community chat room.

```js
community.emit(
  "community:join",
  {
    communityId: "comm123",
    roomId: "room456",
  },
  (res) => {
    console.log(res.success); // true — idempotent
  }
);
```

**Payload:** `{ communityId: string, roomId: string }`

---

#### `community:leave`

Leave a community chat room.

```js
community.emit("community:leave", { communityId: "comm123" }, (res) => {});
```

**Payload:** `{ communityId: string }`

---

#### `community:message:send`

Post a message to a community.

```js
// Text message
community.emit(
  "community:message:send",
  {
    communityId: "comm123",
    roomId: "room456",
    clientMessageId: crypto.randomUUID(),
    message: "Hello community!", // "message" or "contentText" both work
    contentType: "TEXT",
  },
  (res) => {
    if (res.success) {
      const { messageId, roomId, sentAt } = res.data;
    }
  }
);

// Image message
community.emit(
  "community:message:send",
  {
    communityId: "comm123",
    roomId: "room456",
    clientMessageId: crypto.randomUUID(),
    contentType: "IMAGE",
    media: {
      files: [
        {
          objectKey: "uploads/…/image.jpg",
          name: "photo.jpg",
          size: 204800,
          mime: "image/jpeg",
          width: 1080,
          height: 720,
        },
      ],
    },
    // OR top-level files[] also accepted:
    // files: [{ objectKey: "…" }]
  },
  (res) => {
    /* ... */
  }
);

// Reply to a message
community.emit(
  "community:message:send",
  {
    communityId: "comm123",
    roomId: "room456",
    clientMessageId: crypto.randomUUID(),
    message: "Agreed!",
    contentType: "TEXT",
    parentMessageId: "msg789", // the message being replied to
  },
  (res) => {
    /* ... */
  }
);
```

**Payload:**

```ts
{
  communityId: string;
  roomId: string;
  clientMessageId: string;       // UUID, idempotency key
  message?: string;              // ≤4000 chars (alias: contentText)
  contentType: ContentType;
  media?: { files: FileAttachment[] };  // ≤30 files
  files?: FileAttachment[];      // alternative to media.files
  location?: { lat, lng, placeName?, placeAddress? };
  contact?: { name, phone, avatar?, userId? };
  sticker?: { id, url, packId };
  parentMessageId?: string;
}
```

**Ack data:** `{ messageId, roomId, sentAt (epoch-ms) }`

---

#### `community:messages:fetch`

Load paginated message history for a community room.

```js
community.emit(
  "community:messages:fetch",
  {
    roomId: "room456",
    limit: 30,
    cursor: "2024-06-19T12:00:00.000Z", // ISO-8601 UTC, must be in the past
  },
  (res) => {
    if (res.success) {
      const { messages, hasMore, cursor } = res.data;
    }
  }
);
```

**Payload:** `{ roomId: string, cursor?: string (ISO-8601-UTC), limit?: number (1–100, default 30) }`
**Notes:** PUBLIC communities allow non-member history access (Telegram-style). PRIVATE requires active membership.

---

#### `community:message:react`

Toggle a reaction in a community message.

```js
community.emit(
  "community:message:react",
  {
    messageId: "msg789",
    communityId: "comm123",
    emoji: "🔥",
  },
  (res) => {
    /* ... */
  }
);
```

**Payload:** `{ messageId: string, communityId: string, emoji: string }`

---

#### `community:message:reactions:get`

Get the full list of who reacted to a community message.

```js
community.emit(
  "community:message:reactions:get",
  {
    messageId: "msg789",
    communityId: "comm123",
  },
  (res) => {
    // res.data — [{ emoji, count, users: [{ userId, displayName, avatar }] }]
  }
);
```

---

#### `community:message:edit`

Edit your own community message (text only, within edit window).

```js
community.emit(
  "community:message:edit",
  {
    messageId: "msg789",
    communityId: "comm123",
    roomId: "room456",
    content: { text: "Updated text" },
  },
  (res) => {
    /* ... */
  }
);
```

**Payload:** `{ messageId, communityId, roomId, content: { text: string } }`

---

#### `community:message:delete`

Delete a community message.

```js
// Delete for everyone (sender / moderator / admin)
community.emit(
  "community:message:delete",
  {
    messageId: "msg789",
    communityId: "comm123",
    roomId: "room456",
    type: "forEveryone",
  },
  (res) => {
    /* ... */
  }
);
```

**Payload:** `{ messageId, communityId, roomId, type: "forEveryone" | "forMe" }`
**Notes:** `forEveryone` broadcasts `community:message:deleted`. `forMe` is local only.

---

#### `community:message:pin` / `community:message:unpin`

Pin or unpin a message (moderator/admin only).

```js
community.emit(
  "community:message:pin",
  {
    messageId: "msg789",
    communityId: "comm123",
    roomId: "room456",
  },
  (res) => {
    /* ... */
  }
);

community.emit(
  "community:message:unpin",
  {
    messageId: "msg789",
    communityId: "comm123",
    roomId: "room456",
  },
  (res) => {
    /* ... */
  }
);
```

---

#### `community:message:read`

Mark community messages as read up to a specific message.

```js
community.emit(
  "community:message:read",
  {
    communityId: "comm123",
    upToMessageId: "msg789",
  },
  (res) => {
    /* ... */
  }
);
```

**Payload:** `{ communityId: string, roomId?: string, upToMessageId: string }`
**Broadcasts:** `community:message:read` to the community room + `community:read_sync` to your other devices.

---

#### `community:message:forward`

Forward a community message to another community.

```js
community.emit(
  "community:message:forward",
  {
    messageId: "msg789",
    communityId: "comm123",
    targetCommunityId: "comm999",
    targetRoomId: "room888",
    clientMessageId: crypto.randomUUID(),
  },
  (res) => {
    /* ... */
  }
);
```

---

#### `community:message:delivered`

Signal that you received community messages (shows ✓✓ to sender).

```js
community.on("community:message:new", (msg) => {
  community.emit("community:message:delivered", {
    communityId: msg.communityId,
    upToMessageId: msg.messageId,
  });
});
```

**Payload:** `{ communityId: string, roomId?: string, upToMessageId: string }`

---

#### `typing:start` / `typing:stop` (community)

```js
// Community typing — fire-and-forget, no ack
community.emit("typing:start", {
  communityId: "comm123",
  roomId: "room456", // optional
  senderName: "John", // optional
});

community.emit("typing:stop", {
  communityId: "comm123",
});
```

---

#### `community:catchup`

Reconnect gap-fill for community rooms. Max 20 rooms per call.

```js
community.emit(
  "community:catchup",
  {
    rooms: [
      {
        roomId: "room456",
        sinceId: "msg700", // last message ID you have; OR use sinceTs
        // sinceTs: "2024-06-19T10:00:00.000Z",  // ISO-8601 alternative
        limit: 100,
      },
    ],
  },
  (res) => {
    /* ... */
  }
);

community.on(
  "community:catchup:result",
  ({ roomId, events, hasMore, lastId, nextTs }) => {
    events.forEach((e) => {
      // e.syncEventType: "new" | "edited" | "deleted" | "reacted"
      applyCommunityEvent(e);
    });
    if (hasMore) {
      community.emit("community:catchup", {
        rooms: [{ roomId, sinceId: lastId }],
      });
    }
  }
);
```

---

### 4.2 Server → Client

#### `community:message:new`

A new message arrived in a community you've joined.

```js
community.on("community:message:new", (msg) => {
  /*
  {
    messageId: "msg789",
    communityId: "comm123",
    roomId: "room456",
    senderId: "user123",
    senderName: "John",
    senderAvatar: "https://cdn…/avatar.jpg",
    message: "Hello!",          // message text
    contentType: "TEXT",        // UPPER-CASE always
    content: { text, files, urls, ... },
    parentMessageId: null,
    quoteData: null,
    reactions: [],
    clientMessageId: "...",
    serverTs: 1718800001234,    // epoch ms
    sentAt: 1718800001234,      // epoch ms alias
  }
  */
  appendCommunityMessage(msg);
  // Also signal delivery:
  community.emit("community:message:delivered", {
    communityId: msg.communityId,
    upToMessageId: msg.messageId,
  });
});
```

**Room:** `community:<communityId>`
**Notes:** For system messages, `contentType` is `"SYSTEM"` — see §4.3.

---

#### `community:updated`

Bump a community to the top of the community list.

```js
// NOTE: Listen on the /community namespace, NOT /chat
community.on(
  "community:updated",
  ({
    communityId,
    roomId,
    lastMessageId,
    lastMessage,
    lastMessageAt,
    senderId,
    unread,
  }) => {
    /*
  lastMessage: { contentType: "TEXT", text: "Hello!" }
  lastMessageAt: 1718800001234  // epoch ms
  unread: true  // false if you are the sender
  */
    bumpCommunityToTop(communityId, { lastMessage, lastMessageAt, unread });
  }
);
```

**Room:** `user:<userId>` (on `/community` namespace)

---

#### `community:message:reaction`

Reaction updated on a community message. Always the full current set.

```js
community.on(
  "community:message:reaction",
  ({ messageId, communityId, reactions }) => {
    // reactions: [{ emoji, count, users: [{ userId, displayName, avatar }] }]
    // Derive selfReacted client-side from reactions[].users[].userId === myUserId
    updateCommunityReactions(messageId, reactions);
  }
);
```

**Room:** `community:<communityId>`

---

#### `community:message:edited`

A community message was edited.

```js
community.on(
  "community:message:edited",
  ({
    messageId,
    communityId,
    roomId,
    senderId,
    message,
    contentType,
    editedAt,
  }) => {
    updateCommunityMessage(messageId, { message, contentType, editedAt });
  }
);
```

---

#### `community:message:deleted`

A community message was deleted for everyone.

```js
community.on(
  "community:message:deleted",
  ({ messageId, communityId, roomId, deleteType, deletedBy }) => {
    hideCommunityMessage(messageId); // deleteType is always "forEveryone" here
  }
);
```

---

#### `community:message:pinned`

A message was pinned. `pinnedIds` is the COMPLETE list — replace, don't merge.

```js
community.on(
  "community:message:pinned",
  ({
    messageId,
    communityId,
    roomId,
    pinnedIds,
    pinnedCount,
    pinnedAt,
    pinnedBy,
  }) => {
    setPinnedMessages(communityId, pinnedIds); // pinnedIds = authoritative full list
    showPinnedBanner(messageId, pinnedBy);
  }
);
```

---

#### `community:message:unpinned`

A message was unpinned.

```js
community.on(
  "community:message:unpinned",
  ({ messageId, communityId, roomId, pinnedIds, pinnedCount, unpinnedBy }) => {
    setPinnedMessages(communityId, pinnedIds); // replace the full list
  }
);
```

---

#### `community:message:read`

A member read community messages.

```js
community.on(
  "community:message:read",
  ({ communityId, readerId, upToMessageId, readAt }) => {
    // readAt is epoch-ms
    markCommunityRead(communityId, readerId, upToMessageId);
  }
);
```

**Room:** `community:<communityId>`

---

#### `community:read_sync`

Your other devices marked community messages as read.

```js
community.on(
  "community:read_sync",
  ({ communityId, upToMessageId, readAt }) => {
    clearCommunityUnreadBadge(communityId);
  }
);
```

**Room:** `user:<myUserId>`

---

#### `community:member:joined`

A member joined the community.

```js
community.on(
  "community:member:joined",
  ({ userId, username, displayName, avatarUrl, role, joinedAt }) => {
    /*
  role: "ADMIN" | "MODERATOR" | "MEMBER"
  joinedAt: epoch-ms number
  */
    addMemberToList(userId, { displayName, avatarUrl, role });
  }
);
```

**Room:** `community:<communityId>`
**Notes:** Emitted on all join paths: self-join (PUBLIC), invite-link redeem, and join-request approval.

---

#### `community:member:updated`

A member's profile changed (username, display name, avatar).

```js
community.on(
  "community:member:updated",
  ({ userId, username, displayName, avatarUrl, role, updatedAt }) => {
    updateMemberProfile(userId, { displayName, avatarUrl });
  }
);
```

**Room:** `community:<communityId>`

---

#### `typing:start` / `typing:stop` (community server→client)

```js
community.on(
  "typing:start",
  ({
    communityId,
    conversationId,
    userId,
    userDetails,
    timestamp,
    senderName,
  }) => {
    showCommunityTypingIndicator(communityId, userDetails);
  }
);

community.on("typing:stop", ({ communityId, userId }) => {
  hideCommunityTypingIndicator(communityId, userId);
});
```

**Room:** `community:<communityId>`

---

### 4.3 Community System Messages

System messages are delivered as `community:message:new` with `contentType: "SYSTEM"`.

```js
community.on("community:message:new", (msg) => {
  if (msg.contentType === "SYSTEM") {
    const { systemMessageType, systemMetadata } = msg;
    renderSystemMessage(systemMessageType, systemMetadata);
    return;
  }
  // regular message…
});
```

**`systemMessageType` values and their metadata:**

| `systemMessageType`        | Visibility   | Bumps list | `systemMetadata` fields                                     |
| -------------------------- | ------------ | ---------- | ----------------------------------------------------------- |
| `COMMUNITY_CREATED`        | All members  | Yes        | `actorUserId, actorName`                                    |
| `COMMUNITY_NAME_UPDATED`   | All members  | Yes        | `actorUserId, actorName, newName`                           |
| `COMMUNITY_AVATAR_UPDATED` | All members  | Yes        | `actorUserId, actorName`                                    |
| `COMMUNITY_UPDATED`        | All members  | Yes        | `actorUserId, actorName, changedFields[]`                   |
| `MEMBER_JOINED`            | All members  | Yes        | `actorUserId, actorName`                                    |
| `MEMBER_LEFT`              | All members  | Yes        | `actorUserId, actorName`                                    |
| `MEMBER_REMOVED`           | All members  | Yes        | `actorUserId, actorName, targetUserId, targetName`          |
| `MEMBER_BANNED`            | All members  | Yes        | `actorUserId, actorName, targetUserId, targetName`          |
| `MEMBER_UNBANNED`          | All members  | Yes        | `actorUserId, actorName, targetUserId, targetName`          |
| `MEMBER_MUTED`             | All members  | Yes        | `actorUserId, actorName, targetUserId, targetName`          |
| `MEMBER_UNMUTED`           | All members  | Yes        | `actorUserId, actorName, targetUserId, targetName`          |
| `ROLE_CHANGED`             | All members  | Yes        | `actorUserId, actorName, targetUserId, targetName, newRole` |
| `PINNED_MESSAGE`           | All members  | Yes        | `actorUserId, actorName, messageId`                         |
| `UNPINNED_MESSAGE`         | All members  | No         | `actorUserId, actorName, messageId`                         |
| `COMMUNITY_INVITE_CREATED` | All members  | No         | `actorUserId, actorName`                                    |
| `COMMUNITY_JOINED`         | **You only** | No         | `actorUserId` (= your userId)                               |
| `JOIN_REQUEST_APPROVED`    | **You only** | No         | `actorUserId, communityName`                                |
| `JOIN_REQUEST_REJECTED`    | **You only** | No         | `actorUserId, communityName`                                |

**Rendering rule:**

```js
function renderSystemMessage(type, meta) {
  // When actor is the current user, show "You" instead of actorName
  const actor = meta.actorUserId === myUserId ? "You" : meta.actorName;
  const target = meta.targetUserId === myUserId ? "you" : meta.targetName;

  switch (type) {
    case "MEMBER_JOINED":
      return `${actor} joined the community`;
    case "MEMBER_LEFT":
      return `${actor} left the community`;
    case "MEMBER_BANNED":
      return `${actor} banned ${target}`;
    case "ROLE_CHANGED":
      return `${actor} made ${target} a ${meta.newRole.toLowerCase()}`;
    case "COMMUNITY_JOINED":
      return "You joined this community"; // personal
    // etc.
  }
}
```

> **`COMMUNITY_JOINED`** is **personal** — published only to your own `user:<userId>` channel, never the room. Other members never see it.

---

## 5. `/notify` Namespace

In-app notification feed and unread badge counter.

---

### 5.1 Client → Server

#### `notifications:fetch`

Load paginated notifications.

```js
notify.emit(
  "notifications:fetch",
  {
    limit: 20,
    cursor: "notif_abc123", // omit for first page
  },
  (res) => {
    if (res.success) {
      const { notifications, nextCursor, hasMore, unreadCount } = res.data;
    }
  }
);
```

**Payload:** `{ cursor?: string, limit?: number (≤100) }`

---

#### `notifications:mark_read`

Mark specific notifications as read (or all if array is empty).

```js
// Mark specific notifications
notify.emit(
  "notifications:mark_read",
  {
    notificationIds: ["notif_abc", "notif_def"],
  },
  (res) => {
    console.log(res.data.markedCount);
  }
);

// Mark ALL as read
notify.emit("notifications:mark_read", { notificationIds: [] }, (res) => {});
```

**Payload:** `{ notificationIds: string[] }`
**Ack data:** `{ markedCount: number }`
**Side-effect:** broadcasts `notification:count_update` to all your connected devices.

---

#### `notifications:delete`

Soft-delete a notification.

```js
notify.emit(
  "notifications:delete",
  {
    notificationId: "notif_abc",
  },
  (res) => {
    if (res.success) {
      const { deleted, remainingUnread } = res.data;
      if (deleted) removeFromList("notif_abc");
    }
  }
);
```

**Payload:** `{ notificationId: string }`
**Ack data:** `{ deleted: boolean, remainingUnread: number }`
**Side-effect:** sends `notification:deleted` to your other devices.

---

### 5.2 Server → Client

#### `notification:count`

Sent once on connect with the current unread total.

```js
notify.on("notification:count", ({ count }) => {
  setBadgeCount(count);
});
```

---

#### `notification:count_update`

Unread count changed (new notification arrived OR you marked as read on another device).

```js
notify.on("notification:count_update", ({ count }) => {
  setBadgeCount(count); // always replace, never increment
});
```

**Room:** `user:<userId>` — received on **all** your connected devices simultaneously.

---

#### `notification:new`

A new notification was created.

```js
notify.on("notification:new", (notification) => {
  /*
  {
    notificationId: "notif_abc",  // canonical ID
    id: "notif_abc",              // deprecated alias — use notificationId ?? id
    type: "community.member_joined",  // discriminator — handle unknown types defensively
    title: "New member",
    body: "John joined your community",
    referenceId: "comm123",
    isRead: false,
    createdAt: "2024-06-19T12:00:00.000Z",
    data: { communityId: "comm123", ... }  // type-specific payload
  }
  */
  prependToNotificationFeed(notification);
  showPushBanner(notification.title, notification.body);
});
```

**Room:** `user:<userId>`

**Common `type` values:**

| `type`                            | Meaning                           |
| --------------------------------- | --------------------------------- |
| `friend.requested`                | Someone sent you a friend request |
| `friend.accepted`                 | Your friend request was accepted  |
| `community.member_joined`         | Someone joined your community     |
| `community.member_kicked`         | You were kicked from a community  |
| `community.member_banned`         | You were banned from a community  |
| `community.member_unbanned`       | Your ban was lifted               |
| `community.member_role_changed`   | Your role was changed             |
| `community.admin_transferred`     | Community admin was transferred   |
| `community.join_request_approved` | Your join request was approved    |
| `community.join_request_rejected` | Your join request was rejected    |
| `community.deleted`               | A community you're in was deleted |
| `community.report_actioned`       | A report you filed was actioned   |

> Always handle unknown `type` values gracefully — new types may be added without a breaking change.

---

#### `notification:deleted`

A notification was deleted on another device — remove it from your list.

```js
notify.on("notification:deleted", ({ notificationId }) => {
  removeFromNotificationList(notificationId);
});
```

---

#### `community:join_request:update`

Real-time update when your community join request is decided.

```js
notify.on(
  "community:join_request:update",
  ({
    communityId,
    requestId,
    status,
    communityName,
    decidedAt,
    navigation,
  }) => {
    /*
  status: "APPROVED" | "REJECTED" | "CANCELLED"
  decidedAt: ISO-8601 string
  navigation: { screen, params }   -- for deep-linking to the right screen
  */
    if (status === "APPROVED") {
      flipButtonState(communityId, "joined");
      // navigation.screen === "COMMUNITY_DETAILS" to take user there
    } else if (status === "REJECTED") {
      flipButtonState(communityId, "join");
    } else if (status === "CANCELLED") {
      flipButtonState(communityId, "join"); // you cancelled yourself
    }
  }
);
```

**Room:** `notify:<userId>` on `/notify` namespace
**Notes:** `APPROVED`/`REJECTED` also fire `notification:new`. `CANCELLED` is socket-only (no push — user initiated it).

---

#### `media:scan_result`

A media upload failed security scanning.

```js
notify.on("media:scan_result", ({ objectKey, status, reason, at }) => {
  // status: "QUARANTINED" | "INFECTED" | "ERROR"
  // at: epoch-ms
  showUploadError(objectKey, reason);
  removeOptimisticMessage(objectKey);
});
```

**Room:** `notify:<uploaderId>` on `/notify` namespace
**Notes:** Socket-only — no inbox row, no push. Always treat any status here as "upload blocked".

---

## 6. Key Message Shapes

### ContentType enum (UPPER-CASE everywhere)

```ts
type ContentType =
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
```

> Always UPPER-CASE. `contentType` is the single field name on every surface (socket + REST). The old `messageType` field **does not exist** in V2 — see §10.

### FileAttachment shape

```ts
interface FileAttachment {
  objectKey?: string; // from presigned upload — preferred
  url?: string; // external URL (e.g. Tenor GIF)
  name?: string;
  size?: number; // bytes
  mime?: string;
  width?: number;
  height?: number;
  durationMs?: number; // for AUDIO, VIDEO, VOICE
  blurhash?: string; // for IMAGE/VIDEO
  waveform?: number[]; // for VOICE
}
```

> File bytes **never** cross the socket. Upload first via `POST /api/v1/upload/sign`, then send the `objectKey`. See `docs/MEDIA_UPLOAD.md`.

### `lastMessage.text` preview (for `conv:updated` / `community:updated`)

| `contentType` | `lastMessage.text`                                |
| ------------- | ------------------------------------------------- |
| `TEXT`        | First ~200 chars of message body                  |
| `IMAGE`       | `📷 Photo`                                        |
| `VIDEO`       | `🎥 Video`                                        |
| `GIF`         | `🎞 GIF`                                          |
| `AUDIO`       | `🎵 Audio`                                        |
| `VOICE`       | `🎤 Voice message`                                |
| `DOCUMENT`    | `📎 {filename}` (→ `📎 Document` if name unknown) |
| `STICKER`     | `🌟 Sticker`                                      |
| `LOCATION`    | `📍 {placeName}` (→ `📍 Location`)                |
| `CONTACT`     | `👤 {contactName}` (→ `👤 Contact`)               |
| `SYSTEM`      | Rendered system-event sentence                    |

### Timestamp format

All timestamps on socket events are **Unix epoch milliseconds** (plain numbers), never ISO strings.
Exception: `community:member:updated.updatedAt` is ISO-8601 (legacy).

---

## 7. Common Patterns & Scenarios

### Sending a message (private chat)

```js
// 1. Connect and join the conversation
chat.emit("conv:join", { conversationId }, (res) => {});

// 2. Send a message with an idempotency key
const clientMessageId = crypto.randomUUID();
chat.emit(
  "message:send",
  {
    conversationId,
    clientMessageId,
    contentType: "TEXT",
    contentText: "Hey!",
    conversationType: "private",
    receiverId: peerId,
  },
  (res) => {
    if (res.success) {
      markMessageAsSent(clientMessageId, res.data.messageId);
    } else if (res.retryable) {
      scheduleRetry({ conversationId, clientMessageId, contentText: "Hey!" });
    } else {
      showError(res.message);
    }
  }
);

// 3. The peer receives:
chat.on("message:new", (msg) => {
  appendMessage(msg);
  // Signal delivery
  chat.emit("message:delivered", {
    conversationId: msg.conversationId,
    upToMessageId: msg.messageId,
  });
});
```

### Inbox list screen (no open conversation)

```js
// Connect to BOTH namespaces — the user never joins a specific conv/community room here
// just the auto-joined user:<id> room provides the bump events

// Private/Group inbox bumps (on /chat)
chat.on(
  "conv:updated",
  ({ roomId, type, lastMessage, lastMessageAt, unread }) => {
    bumpChatInboxItem(roomId, lastMessage, lastMessageAt, unread);
  }
);

// Community list bumps (on /community)
community.on(
  "community:updated",
  ({ communityId, lastMessage, lastMessageAt, unread }) => {
    bumpCommunityListItem(communityId, lastMessage, lastMessageAt, unread);
  }
);
```

### Reconnect handling (mobile)

```js
chat.on("connect", () => {
  if (chat.recovered) return; // Tier 1: auto-recovered

  // Tier 2: rebuild rooms and catch up
  Promise.all(
    openRooms.map(
      (room) =>
        new Promise((resolve) =>
          chat.emit("conv:join", { conversationId: room.id }, resolve)
        )
    )
  ).then(() => {
    // Catch up missed messages
    chat.emit("chat:catchup", {
      rooms: openRooms.map((r) => ({
        roomId: r.id,
        sinceSeq: r.lastSeq,
        conversationType: r.type,
        limit: 100,
      })),
    });
  });
  // Re-watch presence
  if (watchedPeers.length > 0) {
    chat.emit("presence:subscribe", { peerIds: watchedPeers });
  }
});
```

### Community join-request flow

```js
// User taps "Request to Join" → REST POST /api/v1/communities/:id/join-requests
// Then listen for the decision on /notify:

notify.on(
  "community:join_request:update",
  ({ communityId, status, navigation }) => {
    switch (status) {
      case "APPROVED":
        showToast("Join request approved!");
        // community:member:joined also broadcasts to the community room
        break;
      case "REJECTED":
        showToast("Join request declined");
        break;
      case "CANCELLED":
        // You cancelled via DELETE /api/v1/communities/:id/join-requests/mine
        break;
    }
    updateJoinButton(communityId, status);
  }
);
```

### WebRTC call (complete flow)

```js
// Caller side
chat.emit("call:initiate", { calleeId, callType: "VIDEO" }, (res) => {
  const { callId, rtcConfig } = res.data;
  const pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) chat.emit("call:ice", { callId, candidate });
  };

  chat.on("call:answered", () => {
    pc.createOffer().then((offer) => pc.setLocalDescription(offer));
  });
  chat.on("call:ice", ({ candidate }) => pc.addIceCandidate(candidate));
  chat.on("call:ended", ({ durationSec }) => {
    pc.close();
    showCallSummary(durationSec);
  });
});

// Callee side
chat.on("call:incoming", ({ callId, callerId, callType }) => {
  showIncomingCallUI();

  onAccept(() => {
    chat.emit("call:answer", { callId }, (res) => {
      // Start WebRTC
    });
    chat.on("call:ice", ({ candidate }) => pc.addIceCandidate(candidate));
  });

  onDecline(() => {
    chat.emit("call:decline", { callId });
  });
});
```

---

## 8. Rate Limits & Caps

### Per-event client throttles

| Event                     | Limit                                  | Notes                            |
| ------------------------- | -------------------------------------- | -------------------------------- |
| `typing:start`            | ≤1 per **3 s** per conversation        | While typing continuously        |
| `typing:stop`             | Once, debounced                        | When typing actually stops       |
| `presence:heartbeat`      | 1 per **30–60 s**                      | Never heartbeat in background    |
| `call:ice`                | Only as WebRTC produces candidates     | Don't batch                      |
| `message:send`            | ≤60/min (private), ≤30/min (community) | Server-enforced → `RATE_LIMITED` |
| `message:react`           | ≤10/min per conversation               | Server-enforced → `RATE_LIMITED` |
| `community:message:react` | ≤10/min per community room             | Server-enforced → `RATE_LIMITED` |

### Catchup room caps

| Namespace    | Max rooms per `catchup` call |
| ------------ | ---------------------------- |
| `/chat`      | **50**                       |
| `/community` | **20**                       |

Exceeding the cap rejects the entire call with `INVALID_PAYLOAD`.

### Other payload caps

| Field                          | Limit                      |
| ------------------------------ | -------------------------- |
| `contentText` / `message`      | 4,000 chars                |
| `files[]`                      | 30 attachments per message |
| `emoji`                        | 32 grapheme clusters       |
| `peerIds` (presence:subscribe) | 500                        |
| `notificationIds` (mark_read)  | 500                        |
| `urls[]` (link previews)       | 20                         |

---

## 9. Error Handling

### Error codes

| `error`           | `retryable` | Meaning                                                                 | What to do                                                              |
| ----------------- | ----------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `INVALID_PAYLOAD` | false       | Zod validation failed — bad field types, missing required, cap exceeded | Fix the payload; do NOT retry as-is                                     |
| `SERVICE_ERROR`   | true        | Downstream gRPC / service error                                         | Exponential backoff: 500ms → 1s → 2s, max 3 attempts                    |
| `RATE_LIMITED`    | true        | Server rate limit tripped                                               | Wait until `retryAfter` epoch-ms if provided, else 30s; then retry once |
| `FORBIDDEN`       | false       | Not a member / blocked / wrong role                                     | Surface to user; do not retry                                           |
| `NOT_FOUND`       | false       | Message / conversation / community missing                              | Surface to user; do not retry                                           |
| `CONFLICT`        | false       | Already applied / edit window expired                                   | Reconcile state; do not blind-retry                                     |

### Connection errors

```js
chat.on("connect_error", (err) => {
  if (err.message === "Authentication required") {
    // Refresh token and reconnect
  } else if (err.message === "Authentication failed") {
    // Logout
  }
});
```

### Retry algorithm

```js
async function emitWithRetry(event, payload, maxAttempts = 3) {
  let delay = 500;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await new Promise((r) => chat.emit(event, payload, r));
    if (res.success) return res;
    if (!res.retryable || attempt === maxAttempts) throw new Error(res.message);
    await sleep(delay);
    delay = Math.min(delay * 2, 30_000);
  }
}
```

---

## 10. V2 Breaking Changes

These fields were renamed in v2 — do NOT use the old names:

| Old field / value        | New field / value  | Where                             |
| ------------------------ | ------------------ | --------------------------------- |
| `messageType`            | `contentType`      | Every socket + REST message shape |
| call `type`              | `callType`         | `call:initiate`, `call:incoming`  |
| `notification:forwarded` | `notification:new` | `/notify` push event              |

---

## 11. Quick Index

### Client → Server

**`/chat`:** `conv:join` · `conv:leave` · `message:send` · `message:read` · `message:delivered` · `message:react` · `message:reactions:get` · `message:edit` · `message:forward` · `messages:fetch` · `chat:catchup` · `typing:start` · `typing:stop` · `presence:heartbeat` · `presence:subscribe` · `presence:unsubscribe` · `presence:unsubscribe_all` · `presence:list` · `call:initiate` · `call:answer` · `call:decline` · `call:end` · `call:ice` · `auth:refresh`

**`/community`:** `community:join` · `community:leave` · `community:message:send` · `community:messages:fetch` · `community:message:react` · `community:message:reactions:get` · `community:message:edit` · `community:message:delete` · `community:message:pin` · `community:message:unpin` · `community:message:read` · `community:message:forward` · `community:message:delivered` · `community:catchup` · `typing:start` · `typing:stop` · `auth:refresh`

**`/notify`:** `notifications:fetch` · `notifications:mark_read` · `notifications:delete`

### Server → Client

**`/chat`:** `message:new` · `message:edited` · `message:delete` · `message:reaction` · `message:read` · `message:delivered` · `conv:updated` · `chat:catchup:result` · `typing:start` · `typing:stop` · `presence:status` · `read_sync` · `pin:updated` · `conv:archived` · `conv:unarchived` · `call:incoming` · `call:answered` · `call:declined` · `call:ended` · `call:ice` · `session:expired`

**`/community`:** `community:message:new` · `community:message:edited` · `community:message:deleted` · `community:message:reaction` · `community:message:pinned` · `community:message:unpinned` · `community:message:read` · `community:read_sync` · `community:updated` · `community:catchup:result` · `community:member:joined` · `community:member:updated` · `typing:start` · `typing:stop` · `session:expired`

**`/notify`:** `notification:count` · `notification:count_update` · `notification:new` · `notification:deleted` · `community:join_request:update` · `media:scan_result`

---

_Last updated: 2026-06-19 — branch `rajesh-dev`_
