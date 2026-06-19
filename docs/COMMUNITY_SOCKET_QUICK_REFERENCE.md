# Community Chat — Socket Events Quick Reference

## Namespaces & Connections

```
/chat       → Presence, 1-1 & group messages (conv:updated list bumps)
/community  → Community messages, typing, reactions, community list bumps
/notify     → Notifications, unread badge
```

---

## Core Events for Your Three Requirements

### 1️⃣ GET NEW MESSAGES IN COMMUNITY

**Socket Event:** `community:message:new` (Server → Client)

```typescript
socket.on("community:message:new", (message) => {
  console.log(message);
  // {
  //   messageId: "msg_xyz",
  //   communityId: "comm_abc",
  //   senderId: "user_123",
  //   senderName: "John Doe",
  //   message: "Hello all! 👋",
  //   contentType: "TEXT",
  //   sentAt: 1718544000000,  // epoch ms
  //   reactions: [],
  //   clientMessageId: "...",
  // }

  // ACTION: Append to messages array, scroll to bottom
  messages.push(message);
  scrollToBottom();

  // UPDATE BADGE
  unreadCount++;
  updateBadge(unreadCount);
});
```

**How it gets triggered:**

```
User sends → community:message:send (emit)
  ↓
Gateway validates → calls chat-service gRPC
  ↓
chat-service persists to MongoDB
  ↓
Publishes to Redis: community:<communityId>
  ↓
Gateway re-emits to socket room: community:message:new
  ↓
All members in community receive it
```

---

### 2️⃣ UPDATE COMMUNITY LIST ORDER (BUMP TO TOP)

**Socket Event:** `community:updated` (Server → Client)  
**Namespace:** `/community` (NOT `/chat`)  
**Room:** `user:<userId>`

```typescript
// Listen on /community namespace!
const communitySocket = io(`${API_BASE}/community`, { auth: { token } });

communitySocket.on("community:updated", (update) => {
  console.log(update);
  // {
  //   communityId: "comm_abc",
  //   lastMessageId: "msg_xyz",
  //   lastMessage: { contentType: "TEXT", text: "Hello all! 👋" },
  //   lastMessageAt: 1718544000000,  // epoch ms
  //   senderId: "user_123",
  //   unread: true  // false if you're the sender
  // }

  // ACTION: Move community to top of list
  const idx = communities.findIndex((c) => c.id === update.communityId);
  if (idx !== -1) {
    const [community] = communities.splice(idx, 1);
    community.lastMessage = update.lastMessage;
    community.lastMessageAt = update.lastMessageAt;
    community.unreadCount = update.unread
      ? (community.unreadCount || 0) + 1
      : 0;
    communities.unshift(community); // Insert at top
  }

  // UPDATE BADGE
  if (update.unread) {
    communityListBadge++;
  }
});
```

**Fired on every community message** to all members (recipient list)

---

### 3️⃣ REMOVE NOTIFICATION WHEN USER READS MESSAGE

**Step 1: Emit socket event** when message enters viewport

```typescript
// Use Intersection Observer to detect when message is visible
function markMessageAsRead(communityId, upToMessageId) {
  communitySocket.emit(
    "community:message:read",
    {
      communityId,
      roomId: communityId,
      upToMessageId,
      count: 1,
    },
    (ack) => {
      if (ack.success) {
        console.log("Message marked read");
        // Notifications will be auto-cleared by backend
      }
    }
  );
}
```

**Step 2: Backend auto-clears notifications**

```
community:message:read emitted
  ↓
Gateway routes to chat-service gRPC
  ↓
chat-service marks message read in MongoDB
  ↓
Calls notifications-service to mark related notifs as read
  ↓
Publishes notification:count_update to notify:<userId>
  ↓
Frontend receives and updates badge
```

**Step 3: Listen for notification count update**

```typescript
notifySocket.on("notification:count_update", (data) => {
  console.log("Unread count:", data.count);
  // {count: 3}

  badgeCount = data.count;
  updateBadge(badgeCount); // Show 3 in notification badge
});
```

---

## Complete Socket Flow (Copy-paste)

```typescript
import { io } from "socket.io-client";

const API = "http://localhost:8000";
const TOKEN = "your_jwt_token";

// 1. SETUP: Three namespaces
const chatSocket = io(`${API}/chat`, {
  auth: { token: TOKEN },
  transports: ["websocket"],
});
const communitySocket = io(`${API}/community`, {
  auth: { token: TOKEN },
  transports: ["websocket"],
});
const notifySocket = io(`${API}/notify`, {
  auth: { token: TOKEN },
  transports: ["websocket"],
});

// 2. JOIN COMMUNITY
communitySocket.emit(
  "community:join",
  {
    communityId: "comm_abc123",
    roomId: "comm_abc123",
  },
  (ack) => console.log("Joined:", ack.success)
);

// 3. LISTEN FOR NEW MESSAGES (Requirement #1)
communitySocket.on("community:message:new", (msg) => {
  messages.push(msg);
  unreadCount++;
  render();
});

// 4. LISTEN FOR LIST BUMPS (Requirement #2)
communitySocket.on("community:updated", (update) => {
  const idx = communities.findIndex((c) => c.id === update.communityId);
  if (idx !== -1) {
    const [comm] = communities.splice(idx, 1);
    comm.lastMessage = update.lastMessage;
    communities.unshift(comm);
  }
  render();
});

// 5. LISTEN FOR NOTIFICATION UPDATES (Requirement #3)
notifySocket.on("notification:count_update", (data) => {
  notificationBadge = data.count;
  render();
});

// 6. SEND MESSAGE
function sendMessage(text) {
  communitySocket.emit(
    "community:message:send",
    {
      communityId: "comm_abc123",
      roomId: "comm_abc123",
      clientMessageId: crypto.randomUUID(),
      message: text,
      contentType: "TEXT",
    },
    (ack) => {
      if (ack.success) {
        console.log("✅ Sent:", ack.data.messageId);
      }
    }
  );
}

// 7. MARK MESSAGE READ (on scroll into view)
function onMessageVisible(messageId, communityId) {
  communitySocket.emit(
    "community:message:read",
    {
      communityId,
      roomId: communityId,
      upToMessageId: messageId,
      count: 1,
    },
    (ack) => {
      if (ack.success) {
        console.log("✅ Marked read, notifications cleared");
      }
    }
  );
}
```

---

## Event Contract Summary

| Event                       | Direction       | Room             | Namespace    | Purpose             |
| --------------------------- | --------------- | ---------------- | ------------ | ------------------- |
| `community:message:send`    | Client → Server | —                | `/community` | Send a message      |
| `community:message:new`     | Server → Client | `community:<id>` | `/community` | New message arrives |
| `community:message:read`    | Client → Server | —                | `/community` | Mark message read   |
| `community:updated`         | Server → Client | `user:<id>`      | `/community` | Bump list to top    |
| `notification:count_update` | Server → Client | `user:<id>`      | `/notify`    | Badge updated       |
| `notification:new`          | Server → Client | `user:<id>`      | `/notify`    | New notification    |
| `typing:start` / `:stop`    | Bidirectional   | `community:<id>` | `/community` | Typing indicator    |
| `community:message:react`   | Client → Server | —                | `/community` | Add emoji reaction  |

---

## Ack Response Format

Every `emit` with a callback gets:

```typescript
// SUCCESS
{
  success: true,
  message: "Message sent successfully",
  data: { messageId, sentAt, sequenceNumber }
}

// ERROR
{
  success: false,
  error: "SERVICE_ERROR" | "INVALID_PAYLOAD" | "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMITED",
  retryable: true | false,
  message: "Human-readable error message"
}
```

---

## State to Track (Client-side)

```typescript
const communityState = {
  // Messages
  messages: [], // Array of message objects
  lastReadMessageId: null, // For marking as read
  unreadCount: 0, // Messages unread in this community

  // Community list
  communities: [], // Array of communities
  communityListUnread: 0, // Total unread across all communities

  // Notifications
  notificationCount: 0, // Unread notifications badge
  notifications: [], // Array of notification objects

  // Socket
  chatSocketConnected: false,
  communitySocketConnected: false,
  notifySocketConnected: false,
};
```

---

## Error Handling

```typescript
communitySocket.emit("community:message:send", payload, (ack) => {
  if (!ack.success) {
    if (ack.error === "RATE_LIMITED") {
      // Back off, show "too many messages" message
      setTimeout(() => retry(), ack.retryAfter || 30000);
    } else if (ack.retryable) {
      // Transient error, retry with backoff
      exponentialBackoffRetry(payload);
    } else {
      // Non-retryable (INVALID_PAYLOAD, FORBIDDEN, NOT_FOUND)
      showError(ack.message);
    }
  }
});
```

---

## Implementation Checklist

- [ ] Setup 3 socket namespaces (/chat, /community, /notify)
- [ ] Join community on enter (emit `community:join`)
- [ ] Listen for `community:message:new` → append + increment badge
- [ ] Listen for `community:updated` (on /community) → splice to top
- [ ] Listen for `notification:count_update` → update badge
- [ ] Implement Intersection Observer for message visibility
- [ ] Emit `community:message:read` when message visible
- [ ] Generate `clientMessageId` (UUID) for idempotency
- [ ] Emit `community:message:send` with full payload
- [ ] Handle all error codes with proper retry logic
- [ ] Persist per-room read cursors (for reconnect)
- [ ] Implement `community:catchup` after 2+ min disconnect

---

## Files to Read

1. `docs/SOCKET_EVENTS.md` — Complete socket contract (§5 = community)
2. `docs/COMMUNITY_CHAT_INTEGRATION_GUIDE.md` — Phase-by-phase frontend guide
3. `docs/COMMUNITY_MESSAGING_REALTIME_FLOW.md` — This flow (you are here)
4. `apps/api-gateway/src/sockets/community.handler.ts` — Gateway implementation
5. `apps/chat-service/src/grpc/handlers/community.handler.ts` — Backend logic
