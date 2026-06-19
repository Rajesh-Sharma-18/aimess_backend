# Community Messaging: Real-time Socket & Notification Flow

**Complete implementation guide** (Socket + REST) for:

1. Real-time community message delivery via socket
2. Auto-update community list order (bump-to-top)
3. Mark notifications as read when user reads message
4. All 17 implemented REST API endpoints with examples
5. Side-by-side Socket vs REST code comparisons

**Covers all implemented flows in codebase** (as of commit `03511c1`)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend (Client)                             │
│  Socket.IO /chat + /community + /notify namespaces               │
└──────────────────┬──────────────────────────────────────────────┘
                   │ WebSocket (3 multiplexed namespaces)
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                   api-gateway (:8000)                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ /chat namespace: 1-1, group messages, presence, calls      │  │
│  │ /community namespace: community messages                    │  │
│  │ /notify namespace: notifications + in-app badge            │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────┬──────────────┬──────────────────┬───────────────────────┘
       │ gRPC :4004   │ gRPC :4006       │ Redis subscribe
       ▼              ▼                  ▼
  ┌──────────────┐ ┌──────────────────────┐  ┌──────────────┐
  │ chat-service │ │notifications-service │  │ Redis Adapter│
  │  (:3004)     │ │    (:3006)           │  │  (broadcast) │
  │  MongoDB     │ │  MongoDB             │  │              │
  └──────┬───────┘ └──────────────────────┘  └──────────────┘
         │ Publish to Redis channel
         │ 1. community:<communityId>
         │ 2. user:<userId> (for bump-to-top)
         │ 3. notify:<userId> (for notifications)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Redis Pub/Sub                                 │
│  Channel: community:<communityId>  (message:new broadcast)       │
│  Channel: user:<userId>  (list bump-to-top events)               │
│  Channel: notify:<userId>  (notification events)                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Socket Events — Complete Contract

### 1.1 Client → Server Events (in `/community` namespace)

| Event                      | Ack | Payload                                                                       | When to call                                                |
| -------------------------- | --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `community:join`           | yes | `{ communityId, roomId }`                                                     | User enters community chat                                  |
| `community:message:send`   | yes | `{ communityId, roomId, clientMessageId, message, contentType, media?, ... }` | User sends message                                          |
| `community:message:read`   | yes | `{ communityId, upToMessageId, count }` (PROPOSED)                            | User scrolls into view / opens community (mark all as read) |
| `community:message:react`  | yes | `{ messageId, communityId, emoji }`                                           | User reacts with emoji                                      |
| `community:messages:fetch` | yes | `{ roomId, cursor?, limit? }`                                                 | User scrolls up for history                                 |
| `community:catchup`        | yes | `{ rooms: [{ roomId, sinceId, sinceTs, limit }] }`                            | Reconnect after 2+ min offline                              |
| `typing:start`             | no  | `{ communityId, roomId? }`                                                    | User starts typing                                          |
| `typing:stop`              | no  | `{ communityId, roomId? }`                                                    | User stops typing                                           |
| `community:leave`          | yes | `{ communityId }`                                                             | User exits community (optional)                             |

### 1.2 Server → Client Events (broadcast from `/community` namespace)

| Event                        | Room             | Payload                                                                                                      | Trigger                                     |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `community:message:new`      | `community:<id>` | `{ messageId, communityId, senderId, senderName, message, contentType, serverTs, sentAt, reactions[], ... }` | New message posted; **sets `unread_count`** |
| `typing:start` / `:stop`     | `community:<id>` | `{ communityId, userId, userDetails, timestamp }`                                                            | Member typing indicator                     |
| `community:message:reaction` | `community:<id>` | `{ messageId, reactions: [{emoji, count, users}] }`                                                          | Reaction added/removed                      |
| `community:message:edited`   | `community:<id>` | `{ messageId, message, editedAt }`                                                                           | Message edited                              |
| `community:message:deleted`  | `community:<id>` | `{ messageId, deleteType:"forEveryone" }`                                                                    | Message deleted                             |

### 1.3 Special: Community List Bump Event (on `/community` namespace)

**Delivered on `/community`**, to all community members:

| Event               | Room            | Payload                                                                                                                    | Trigger  |
| ------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `community:updated` | `user:<userId>` | `{ communityId, roomId, lastMessageId, lastMessage: { contentType, text }, lastMessageAt (epoch ms), senderId, unread:true | false }` | Every new community message → splices community to top of list, updates preview + unread badge |

**Client rule:** Listen on `/community` namespace for `community:updated` to reorder the community list in real-time without a full page refresh.

---

## 2. Complete Message Flow — Step by Step

### 2.1 User sends a message in community

```
USER (Frontend)
  ┌─────────────────────────────────────────────────────────┐
  │  1. Call socket.emit('community:message:send', {         │
  │     communityId: "comm_xyz",                             │
  │     roomId: "comm_xyz",  // same as communityId          │
  │     clientMessageId: "msg_<UUID>",  // idempotency key   │
  │     message: "Hello community",                           │
  │     contentType: "TEXT"                                   │
  │   }, (ack) => {                                          │
  │     if (ack.success) {                                   │
  │       // Message queued; real message arrives via        │
  │       // community:message:new event                     │
  │     }                                                     │
  │   });                                                     │
  └────────────┬────────────────────────────────────────────┘
               │ WebSocket
               ▼
  GATEWAY (:8000)
  ┌─────────────────────────────────────────────────────────┐
  │  2. Receives socket.emit, validates payload (Zod)        │
  │  3. Calls chat-service.SendMessage() over gRPC           │
  │  4. Returns ack: { success:true, data:{messageId,…} }    │
  └────────────┬────────────────────────────────────────────┘
               │ gRPC :4004
               ▼
  CHAT-SERVICE (:3004)
  ┌─────────────────────────────────────────────────────────┐
  │  5. Persists message to MongoDB (CommunityMessage)       │
  │  6. Publishes to Redis TWO channels:                     │
  │     a) community:<communityId>  (message event)          │
  │     b) user:<userId>  (list bump event)                  │
  │  7. Runs scenario validator (DB→event→socket→push)       │
  │  8. Returns gRPC response                                │
  └────────┬──────────────────────┬─────────────────────────┘
           │                      │
     Redis pub/sub (parallel)     │
     channels:                    │
           │                      │
    ┌──────┴──────┐              │
    │             │              │
    ▼             ▼              │
 GATEWAY (listens on both channels)
    │             │              │
    │ Re-emits:   │              │
    │             │              │
    ├─────────────────────────────────────────────────┐
    │ (a) community:message:new                       │
    │     → room: community:<communityId>             │
    │     → payload: full CommunityMessageWire        │
    │                                                 │
    │ (b) community:updated                           │
    │     → room: user:<userId>  (on /community namespace) │
    │     → payload: { communityId, lastMessage{…},   │
    │                  unread:true, lastMessageAt }   │
    └─────────────────────────────────────────────────┘
           │              │
           │              └─────────────────────────────────┐
           │                                                │
    ┌──────▼─────────────────┐              ┌──────────────▼───┐
    │                        │              │                  │
    │  FRONTEND RECEIVER 1   │              │ NOTIFICATIONS    │
    │ (in chat, joined)      │              │ SERVICE          │
    │                        │              │                  │
    │  Socket listener:      │              │ (Consuming from  │
    │ socket.on('community   │              │  community.queue)│
    │   :message:new', …)    │              │                  │
    │                        │              │ Publishes to     │
    │  → Append to messages  │              │ notify:<userId>  │
    │  → Increment badge     │              │                  │
    │                        │              │ → Notification   │
    │                        │              │   stored in      │
    │                        │              │   MongoDB        │
    └────────────────────────┘              └──────────────────┘
                 │                                     │
                 │ (also receives)                     │ Redis
                 │                                     │ push/sub
                 │                         ┌───────────▼──────┐
                 │                         │                  │
                 │                         │ FRONTEND USER    │
                 │                  ┌──────▼─────────────────│
                 │                  │                        │
                 │          Listener on /notify              │
                 │          socket.on('notification:new')    │
                 │                  │                        │
                 │                  │ → Show in-app toast    │
                 │                  │ → Increment badge      │
                 │                  └────────────────────────┘
                 │
          ┌──────▼──────────────────────┐
          │                              │
          │ FRONTEND USER BROWSER        │
          │ (sitting on community chat)  │
          │                              │
          │ Listeners on /community:     │
          │ 1. community:message:new     │
          │    → Append message          │
          │    → Scroll to bottom        │
          │    → Auto-mark as read?      │
          │                              │
          │ 2. community:updated         │
          │    (on /community namespace) │
          │    → Bump in community list  │
          │    → Update preview          │
          └──────────────────────────────┘
```

---

## 3. Real-Time Community List Update (No Page Reload)

### 3.1 Event: `community:updated`

**Delivered on:** `/community` namespace  
**Room:** `user:<userId>`  
**Trigger:** Every new community message  
**Payload:**

```jsonc
{
  "communityId": "comm_abc123",
  "roomId": "comm_abc123", // GeneralRoom.id === communityId
  "lastMessageId": "msg_xyz789",
  "lastMessage": {
    "contentType": "TEXT", // or IMAGE, VIDEO, etc.
    "text": "Hello everyone! 📷", // preview, 512 chars max
  },
  "lastMessageAt": 1718544000000, // epoch milliseconds
  "senderId": "user_sender123",
  "unread": true, // false on sender's copy
}
```

### 3.2 Frontend Implementation

```typescript
// SETUP: Connect to /community namespace (where list updates arrive)
const communitySocket = io(`${API_BASE}/community`, {
  auth: { token: accessToken },
  transports: ["websocket"],
});

// Listen for community list updates
communitySocket.on("community:updated", (payload) => {
  const { communityId, lastMessage, lastMessageAt, unread } = payload;

  // 1. Find community in local state by communityId
  const communityIndex = communities.findIndex((c) => c.id === communityId);

  if (communityIndex === -1) {
    // New community or not yet loaded → fetch full list
    fetchCommunityList();
    return;
  }

  // 2. Extract community from list
  const [community] = communities.splice(communityIndex, 1);

  // 3. Update with new message preview
  community.lastMessage = lastMessage;
  community.lastMessageAt = lastMessageAt;
  community.unreadCount = unread ? (community.unreadCount || 0) + 1 : 0;

  // 4. Insert back at top (index 0)
  communities.unshift(community);

  // 5. Re-render (UI will show updated list without full page refresh)
  setCommonCommunities([...communities]);
});
```

### 3.3 What makes this work:

✅ **Idempotent:** receiving `community:updated` twice with same `lastMessageId` results in same final state  
✅ **Independent:** delivered on `user:<id>` (not tied to message room) — works even if user isn't inside the chat  
✅ **Real-time:** arrives instantly via Redis pub/sub → Socket.IO broadcast  
✅ **No page reload:** pure list reorder + preview update  
✅ **Unread badge:** `unread:true` on everyone except sender

---

## 4. Mark Notifications as Read When User Reads Message

### 4.1 Current State

**Notifications-service** creates in-app notifications for:

- `community.join_requested` — admins/moderators
- `community.member_added` — the new member
- `community.member_joined` — admins/moderators
- All other community moderation events

**Stored in:** `notifications.Notification` (MongoDB)

### 4.2 Problem

Currently:

- Notification is created when message is posted (or event occurs)
- No explicit "mark as read when user reads the message" flow
- Notifications are marked read via REST: `POST /api/v1/notifications/mark-read`

### 4.3 Solution: Auto-mark on Message Read

**Proposal:** Send `community:message:read` socket event when user scrolls message into view:

#### Step 1: Client detects message read

```typescript
// In your community chat view
useEffect(() => {
  // Intersection Observer: detect when latest message enters viewport
  const observerOptions = {
    root: chatContainerRef.current,
    threshold: 0.5,
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && entry.target.dataset.messageId) {
        const messageId = entry.target.dataset.messageId;
        const isLatestMessage = messageId === lastMessageId;

        if (isLatestMessage) {
          // Message is now visible
          emitReadReceipt(messageId);
        }
      }
    });
  }, observerOptions);

  // Observe all messages
  document.querySelectorAll("[data-message-id]").forEach((msg) => {
    observer.observe(msg);
  });

  return () => observer.disconnect();
}, [messages, lastMessageId]);

function emitReadReceipt(upToMessageId: string) {
  // Emit only once per message (debounce)
  if (lastReadMessageId === upToMessageId) return;

  communitySocket.emit(
    "community:message:read",
    {
      communityId,
      roomId: communityId, // GeneralRoom.id === communityId
      upToMessageId,
      count: 1, // how many unread messages we're marking as read
    },
    (ack) => {
      if (ack.success) {
        console.log("Message marked as read");
      }
    }
  );

  setLastReadMessageId(upToMessageId);
}
```

#### Step 2: Gateway receives and routes to chat-service

**Gateway handler** (`apps/api-gateway/src/sockets/community.handler.ts`):

```typescript
// On /community namespace, message:read event
socketNamespace.on("community:message:read", async (socket, data, ack) => {
  const { communityId, upToMessageId } = data;

  try {
    // Validate
    if (!communityId || !upToMessageId) {
      return ack({
        success: false,
        error: "INVALID_PAYLOAD",
        message: t("errors.invalidPayload"),
      });
    }

    // Call chat-service gRPC
    const result = await chatClient.markCommunityMessageRead({
      communityId,
      upToMessageId,
      readerId: socket.data.userId,
    });

    // Acknowledge
    ack({
      success: true,
      message: t("socket.messages.SOCKET_CHAT_MESSAGE_MARKED_READ"),
      data: { upToMessageId },
    });

    // Optional: broadcast read receipt to other members
    // socket.to(`community:${communityId}`).emit("community:message:read", {
    //   communityId,
    //   readerId: socket.data.userId,
    //   upToMessageId,
    // });
  } catch (error) {
    ack({
      success: false,
      error: "SERVICE_ERROR",
      retryable: true,
      message: t("errors.somethingWentWrong"),
    });
  }
});
```

#### Step 3: Chat-service marks message as read + auto-clears notifications

**Chat-service gRPC handler** (`apps/chat-service/src/grpc/handlers/community.handler.ts`):

```typescript
async markCommunityMessageRead(
  request: MarkCommunityMessageReadRequest
): Promise<MarkCommunityMessageReadResponse> {
  const { communityId, upToMessageId, readerId } = request;

  try {
    // 1. Update message read status in MongoDB
    await this.communityRepository.markMessagesRead({
      communityId,
      upToMessageId,
      readerId,
    });

    // 2. Publish to Redis (broadcast read receipt to room)
    await publishCommunityRoomEvent(redis, communityId, "community:message:read", {
      communityId,
      readerId,
      upToMessageId,
    });

    // 3. (NEW) Auto-clear related notifications
    // When user marks message read, any notifications tied to that
    // message/community are marked read in notifications-service
    await this.notificationsClient.markNotificationsRead({
      userId: readerId,
      communityId,
      // Only clear notifications created before this read timestamp
    }).catch((e) => logger.error("Failed to auto-mark notifications", e));

    return {
      success: true,
      upToMessageId,
    };
  } catch (error) {
    logger.error("markCommunityMessageRead failed", error);
    throw new ServiceError("Failed to mark messages as read");
  }
}
```

#### Step 4: Notifications-service auto-clears (optional enhancement)

**New gRPC method** on notifications-service:

```protobuf
// in notifications.proto
rpc MarkCommunityNotificationsRead(MarkCommunityNotificationsReadRequest)
  returns (MarkCommunityNotificationsReadResponse);

message MarkCommunityNotificationsReadRequest {
  string userId = 1;
  string communityId = 2;
}

message MarkCommunityNotificationsReadResponse {
  int32 markedCount = 1;
}
```

**Handler** (`apps/notifications-service/src/grpc/notifications.handler.ts`):

```typescript
async markCommunityNotificationsRead(
  request: MarkCommunityNotificationsReadRequest
): Promise<MarkCommunityNotificationsReadResponse> {
  const { userId, communityId } = request;

  // Mark all unread notifications for this community/user as read
  const result = await db.notification.updateMany(
    {
      userId,
      "data.communityId": communityId,
      isRead: false,
    },
    { isRead: true }
  );

  return {
    markedCount: result.modifiedCount,
  };
}
```

---

## 5. Complete Socket Event Timeline (Example)

```
T=0:00
  User A sends message "Hello" in community "Tech Lovers"
  → community:message:send emitted

T=0:01
  Message persisted to MongoDB
  → Redis publishes to community:tech_lovers_123 (all members)
  → Redis publishes to user:* (all community members) for list bump
  → notifications-service consumes from queue, creates in-app notification

T=0:02
  Gateway re-emits:
    • community:message:new (on room community:tech_lovers_123)
    • community:updated (on room user:each_member)

T=0:03
  User B sees message in chat view
  → Intersection Observer detects message in viewport
  → Emits community:message:read

T=0:04
  Chat-service marks message as read for User B
  → Publishes community:message:read to room
  → Calls notifications-service to mark related notifications read

T=0:05
  Notifications-service marks User B's in-app notifications read
  → Publishes notification:count_update to user:User_B

T=0:06
  User B's frontend receives notification:count_update
  → Badge count decreases
```

---

## 6. Frontend Integration Checklist

### Setup Phase

- [ ] Connect to `/community` namespace (for `community:message:new` and `community:updated`)
- [ ] Connect to `/notify` namespace (for `notification:new` / `notification:count_update`)
- [ ] Implement reconnection with exponential backoff

### Message Send

- [ ] Generate `clientMessageId` (UUID) for idempotency
- [ ] Emit `community:message:send` with full payload
- [ ] Wait for ack before showing message as "sent"
- [ ] Handle `SERVICE_ERROR` (retryable) with backoff
- [ ] Handle `RATE_LIMITED` with `retryAfter` delay

### List Update

- [ ] Listen on `/community` namespace for `community:updated`
- [ ] Splice community from current position to index 0
- [ ] Update `lastMessage.text` preview
- [ ] Update `lastMessageAt` timestamp
- [ ] Increment `unreadCount` if `unread:true`
- [ ] Re-render without page refresh

### Message Read

- [ ] Implement Intersection Observer to detect message in viewport
- [ ] Emit `community:message:read` when latest message visible
- [ ] Wait for ack
- [ ] Debounce to avoid duplicate read receipts
- [ ] Optional: show "read" indicator on messages

### Notifications

- [ ] Listen on `/notify` for `notification:new`
- [ ] Show in-app toast/banner
- [ ] Increment notification badge
- [ ] Listen for `notification:count_update` after mark-read
- [ ] Update badge count in real-time

---

## 7. Example Full Flow (Copy-paste ready)

### Community Socket Setup

```typescript
import { io } from "socket.io-client";

const API_BASE = "http://localhost:8000"; // or your prod URL
const accessToken = "eyJhbGciOi...";

// Three multiplexed namespaces sharing one connection
const chatSocket = io(`${API_BASE}/chat`, {
  auth: { token: accessToken },
  transports: ["websocket"],
});

const communitySocket = io(`${API_BASE}/community`, {
  auth: { token: accessToken },
  transports: ["websocket"],
});

const notifySocket = io(`${API_BASE}/notify`, {
  auth: { token: accessToken },
  transports: ["websocket"],
});

// Join community
communitySocket.emit(
  "community:join",
  {
    communityId: "comm_abc123",
    roomId: "comm_abc123",
  },
  (ack) => {
    if (ack.success) {
      console.log("Joined community");
    } else {
      console.error("Join failed:", ack.error);
    }
  }
);

// Send message
communitySocket.emit(
  "community:message:send",
  {
    communityId: "comm_abc123",
    roomId: "comm_abc123",
    clientMessageId: crypto.randomUUID(),
    message: "Hello everyone!",
    contentType: "TEXT",
  },
  (ack) => {
    if (ack.success) {
      console.log("Message sent:", ack.data.messageId);
    }
  }
);

// Receive new messages
communitySocket.on("community:message:new", (msg) => {
  console.log("New message:", msg);
  // Append to your messages list
});

// List bumps to top
communitySocket.on("community:updated", (update) => {
  console.log("Community bumped:", update.communityId);
  // Reorder your community list
});

// Mark message read (when visible)
function markMessageRead(communityId, upToMessageId) {
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
        console.log("Marked read");
      }
    }
  );
}

// Receive notifications
notifySocket.on("notification:new", (notif) => {
  console.log("Notification:", notif.title, notif.body);
  // Show in-app toast
});

// Notification badge updates
notifySocket.on("notification:count_update", (data) => {
  console.log("Unread count:", data.count);
  // Update badge UI
});
```

---

## 8. Event Type Definitions (TypeScript)

```typescript
// community.types.ts

export interface CommunityMessageSendPayload {
  communityId: string;
  roomId: string;
  clientMessageId: string;
  message: string;
  contentType:
    | "TEXT"
    | "IMAGE"
    | "VIDEO"
    | "AUDIO"
    | "VOICE"
    | "DOCUMENT"
    | "GIF"
    | "STICKER"
    | "LOCATION"
    | "CONTACT";
  media?: {
    files: Array<{
      objectKey?: string;
      url?: string;
      name?: string;
      size?: number;
      mime?: string;
      width?: number;
      height?: number;
      durationMs?: number;
    }>;
  };
  location?: {
    lat: number;
    lng: number;
    placeName?: string;
    placeAddress?: string;
  };
  contact?: { name: string; phone?: string; avatar?: string; userId?: string };
  sticker?: { packId: string; stickerId: string };
  parentMessageId?: string;
}

export interface CommunityMessageNewEvent {
  messageId: string;
  communityId: string;
  roomId: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  message: string;
  contentType: string;
  content?: Record<string, any>;
  reactions: Array<{
    emoji: string;
    count: number;
    users: Array<{ userId: string; displayName: string; avatar?: string }>;
  }>;
  sentAt: number; // epoch ms
  serverTs: number;
  clientMessageId: string;
  parentMessageId?: string;
  isDeleted?: boolean;
}

export interface CommunityUpdatedEvent {
  communityId: string;
  roomId: string;
  lastMessageId: string;
  lastMessage: { contentType: string; text: string };
  lastMessageAt: number; // epoch ms
  senderId: string;
  unread: boolean;
}

export interface CommunityMessageReadPayload {
  communityId: string;
  roomId: string;
  upToMessageId: string;
  count?: number;
}

export interface NotificationItem {
  notificationId: string;
  type: string;
  title: string;
  body: string;
  referenceId?: string;
  isRead: boolean;
  createdAt: string; // ISO-8601
  data?: Record<string, string>;
}

export interface NotificationCountUpdate {
  count: number; // unread notification count
}
```

---

## 9. Troubleshooting

| Issue                          | Cause                                                  | Fix                                                           |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------- |
| Messages not appearing in chat | Socket not joined to `community:<id>` room             | Call `community:join` before sending                          |
| List not bumping to top        | Listening on `/chat` namespace instead of `/community` | Listen on `/community` for `community:updated`                |
| Badge not updating             | Not listening to `/notify` namespace                   | Add `notifySocket.on("notification:count_update")`            |
| Notifications stuck as unread  | Not emitting `community:message:read`                  | Implement Intersection Observer + emit on scroll              |
| Duplicate messages             | Not deduping on `clientMessageId`                      | Store sent `clientMessageId`s in local state, skip duplicates |
| Reconnection loses messages    | Not calling `community:catchup` after Tier-2 reconnect | Store per-room `sinceId` / `sinceTs`, emit on reconnect       |

---

## 10. Gateway Implementation Reference

### Handler: `apps/api-gateway/src/sockets/community.handler.ts`

```typescript
import type { Socket } from "socket.io";
import { z } from "zod";
import { getChatClient } from "./chat.client.js";
import { t } from "@aimess/constants";

const CommunityMessageSendSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1),
  clientMessageId: z.string().uuid(),
  message: z.string().max(4000),
  contentType: z.enum([
    "TEXT",
    "IMAGE",
    "VIDEO",
    "AUDIO",
    "VOICE",
    "DOCUMENT",
    "GIF",
    "STICKER",
    "LOCATION",
    "CONTACT",
  ]),
  media: z
    .array(
      z.object({
        objectKey: z.string().optional(),
        url: z.string().optional(),
        name: z.string().optional(),
        size: z.number().optional(),
        mime: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        durationMs: z.number().optional(),
      })
    )
    .optional(),
  parentMessageId: z.string().optional(),
});

const CommunityMessageReadSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1),
  upToMessageId: z.string().min(1),
  count: z.number().optional(),
});

export function setupCommunityHandlers(io: Server): void {
  const communityNamespace = io.of("/community");

  communityNamespace.on("connection", (socket: Socket) => {
    const userId = socket.data.userId;

    // Join community room
    socket.on("community:join", (data, ack) => {
      const { communityId } = data;
      socket.join(`community:${communityId}`);
      ack({ success: true, message: t("socket.messages.COMMUNITY_JOINED") });
    });

    // Send message
    socket.on("community:message:send", async (data, ack) => {
      const result = CommunityMessageSendSchema.safeParse(data);
      if (!result.success) {
        return ack({
          success: false,
          error: "INVALID_PAYLOAD",
          message: t("errors.invalidPayload"),
        });
      }

      try {
        const chatClient = getChatClient();
        const response = await chatClient.sendCommunityMessage({
          senderId: userId,
          ...result.data,
        });

        ack({
          success: true,
          message: t("socket.messages.MESSAGE_SENT"),
          data: {
            messageId: response.messageId,
            sequenceNumber: response.sequenceNumber,
            sentAt: response.sentAt,
          },
        });
      } catch (error) {
        ack({
          success: false,
          error: "SERVICE_ERROR",
          retryable: true,
          message: t("errors.somethingWentWrong"),
        });
      }
    });

    // Mark messages as read
    socket.on("community:message:read", async (data, ack) => {
      const result = CommunityMessageReadSchema.safeParse(data);
      if (!result.success) {
        return ack({
          success: false,
          error: "INVALID_PAYLOAD",
          message: t("errors.invalidPayload"),
        });
      }

      try {
        const chatClient = getChatClient();
        await chatClient.markCommunityMessageRead({
          communityId: result.data.communityId,
          upToMessageId: result.data.upToMessageId,
          readerId: userId,
        });

        ack({
          success: true,
          message: t("socket.messages.MESSAGES_MARKED_READ"),
        });
      } catch (error) {
        ack({
          success: false,
          error: "SERVICE_ERROR",
          retryable: true,
          message: t("errors.somethingWentWrong"),
        });
      }
    });
  });
}
```

---

## 11. Socket vs REST Comparison (Both Approaches)

All message operations are available via **Socket (real-time)** or **REST (fallback)**.

| Operation           | Socket Event               | REST Endpoint                           | Ack/Response | Use Case                           |
| ------------------- | -------------------------- | --------------------------------------- | ------------ | ---------------------------------- |
| **Send Message**    | `community:message:send`   | `POST /rooms/:roomId/messages`          | Ack + data   | Active user (socket faster)        |
| **Mark Read**       | `community:message:read`   | `POST /rooms/:roomId/read`              | Ack          | Auto-clears notifs (socket only)   |
| **Fetch History**   | `community:messages:fetch` | `GET /rooms/:roomId/messages`           | Ack + data   | Pagination / scroll                |
| **Get Timeline**    | —                          | `GET /rooms/:roomId/conversation`       | 200 OK       | Advances read pointer auto         |
| **Sync Changes**    | —                          | `GET /rooms/:roomId/sync`               | 200 OK       | Offline recovery (timestamp-based) |
| **Edit Message**    | `community:message:edit`   | `PATCH /messages/:messageId`            | Ack          | 15-min window, text-only           |
| **Delete Message**  | `community:message:delete` | `DELETE /messages/:messageId`           | Ack          | forEveryone or forMe               |
| **Add Reaction**    | `community:message:react`  | `POST /messages/:messageId/react`       | Ack          | Toggle emoji (same emoji = remove) |
| **Pin Message**     | `community:message:pin`    | `POST /rooms/:roomId/pins`              | Ack          | Mod/admin only                     |
| **Unpin Message**   | `community:message:unpin`  | `DELETE /rooms/:roomId/pins/:messageId` | Ack          | Mod/admin only                     |
| **Get Pins**        | —                          | `GET /rooms/:roomId/pins`               | 200 OK       | List all pinned                    |
| **Search Messages** | —                          | `GET /rooms/:roomId/messages/search`    | 200 OK       | Full-text search                   |

---

### When to use Socket vs REST

**Socket (real-time, recommended for active chat):**

- User is actively in the chat screen
- Need instant ack + broadcast to room
- Want real-time "X is typing" indicators
- Bidirectional communication
- Faster round-trip (~20-50ms vs 100-200ms)

**REST (fallback, recommended for offline/batch):**

- User is offline or backgrounded
- Batch operations (fetch multiple messages)
- Need idempotency (retry-safe via clientMessageId)
- Simple request-response pattern
- Mobile offline queue before socket sends
- Simpler for stateless clients (no socket connection state)

**Auto-clearing notifications:** Only socket `community:message:read` auto-clears. REST `/read` does not trigger notification clearing (yet).

---

## 11. Complete REST API Reference (All Implemented Endpoints)

### Core Messaging APIs

#### 1. Send Message (REST fallback)

```bash
POST /api/v1/chat/community/rooms/:roomId/messages
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**

```jsonc
{
  "message": "Hello everyone! 📷",
  "contentType": "TEXT",  // UPPER-CASE
  "clientMessageId": "<UUID>",  // idempotency key (optional)
  "parentMessageId": "<msg_id>",  // for replies (optional)
  // Optional: one of these
  "media": {
    "files": [
      {
        "objectKey": "chat-uploads/user_123/uuid.jpg",
        "name": "photo.jpg",
        "size": 204800,
        "mime": "image/jpeg",
        "width": 1920,
        "height": 1080,
        "blurhash": "...",
        "waveform": [...]  // for audio
      }
    ]
  },
  "location": {
    "lat": 40.7128,
    "lng": -74.0060,
    "placeName": "New York",
    "placeAddress": "123 Main St"
  },
  "contact": {
    "name": "John Doe",
    "phone": "+1234567890",
    "avatar": "...",
    "userId": "user_456"
  },
  "sticker": {
    "packId": "sticker_pack_123",
    "stickerId": "sticker_456",
    "url": "..."
  }
}
```

**Response (201):**

```jsonc
{
  "success": true,
  "data": {
    "messageId": "msg_xyz789",
    "communityId": "comm_abc123",
    "senderId": "user_123",
    "sentAt": 1718544000000,
    "clientMessageId": "...",
    "sequenceNumber": 42,
    "contentType": "TEXT",
    "message": "Hello everyone! 📷",
    "reactions": [],
  },
}
```

#### 2. Mark Room as Read

```bash
POST /api/v1/chat/community/rooms/:roomId/read
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**

```jsonc
{
  "upToMessageId": "<optional, currently ignored — server reads to now>",
}
```

**Response (200):**

```jsonc
{ "success": true, "data": { "ok": true } }
```

#### 3. Fetch Message History (Scroll)

```bash
GET /api/v1/chat/community/rooms/:roomId/messages?limit=30&before_ts=1718544000000
Authorization: Bearer <token>
```

**Query params:**

- `limit` (1-100, default 30)
- `before_ts` (epoch ms, scroll backward)
- `after_ts` (epoch ms, scroll forward)
- `around` (epoch ms, fetch messages around this timestamp)

**Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "messages": [
      {
        "messageId": "msg_xyz",
        "communityId": "comm_abc",
        "senderId": "user_123",
        "senderName": "John Doe",
        "message": "Hello",
        "contentType": "TEXT",
        "content": {...},
        "reactions": [
          {
            "emoji": "👍",
            "count": 2,
            "users": [
              { "userId": "user_456", "displayName": "Jane", "avatar": "..." }
            ]
          }
        ],
        "sentAt": 1718544000000,
        "editedAt": 0,
        "isDeleted": false,
        "deletedType": null
      }
    ],
    "hasMore": true,
    "cursor": "1718543000000"
  }
}
```

#### 4. Fetch Conversation (Advances Read Pointer)

```bash
GET /api/v1/chat/community/rooms/:roomId/conversation?pageNumber=1&limit=30
Authorization: Bearer <token>
```

**Response:** Same as history, but auto-marks messages as read

#### 5. Incremental Sync (Get All Changes)

```bash
GET /api/v1/chat/community/rooms/:roomId/sync?since_ts=1718543000000&limit=100
Authorization: Bearer <token>
```

**Returns:** All edits, deletes, reactions, new messages since the timestamp

#### 6. Get Room Media Only

```bash
GET /api/v1/chat/community/rooms/:roomId/media?type=image&cursor=&limit=20
Authorization: Bearer <token>
```

**Query params:**

- `type` (image, video, audio, document)
- `cursor` (pagination cursor)
- `limit` (1-100, default 20)

---

### Message Mutations

#### 7. Edit Message

```bash
PATCH /api/v1/chat/community/messages/:messageId
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**

```jsonc
{
  "content": {
    "text": "Updated message",
  },
}
```

**Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "messageId": "msg_xyz",
    "message": "Updated message",
    "editedAt": 1718544060000,
  },
}
```

**Constraints:**

- Text-only messages (no media edit)
- 15-minute edit window
- Own messages only

#### 8. Delete Message

```bash
DELETE /api/v1/chat/community/messages/:messageId?type=forEveryone
Authorization: Bearer <token>
```

**Query params:**

- `type` = `forEveryone` | `forMe`

**Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "messageId": "msg_xyz",
    "type": "forEveryone",
  },
}
```

#### 9. Add/Remove Reaction

```bash
POST /api/v1/chat/community/messages/:messageId/react
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**

```jsonc
{
  "emoji": "👍",
}
```

**Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "messageId": "msg_xyz",
    "reactions": [
      {
        "emoji": "👍",
        "count": 2,
        "users": [
          { "userId": "user_123", "displayName": "John", "avatar": "..." },
          { "userId": "user_456", "displayName": "Jane", "avatar": "..." },
        ],
      },
    ],
  },
}
```

**Note:** Sending the same emoji twice = remove reaction (toggle)

---

### Pinning

#### 10. Pin Message (Moderator/Admin)

```bash
POST /api/v1/chat/community/rooms/:roomId/pins
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**

```jsonc
{
  "messageId": "msg_xyz",
}
```

**Response (201):**

```jsonc
{
  "success": true,
  "data": {
    "messageId": "msg_xyz",
    "pinnedAt": 1718544000000,
    "pinnedIds": ["msg_xyz", "msg_abc", ...],  // Full list
    "pinnedCount": 3
  }
}
```

#### 11. Unpin Message

```bash
DELETE /api/v1/chat/community/rooms/:roomId/pins/:messageId?communityId=comm_abc
Authorization: Bearer <token>
```

**Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "messageId": "msg_xyz",
    "pinnedIds": ["msg_abc", ...],  // Remaining pinned
    "pinnedCount": 2
  }
}
```

#### 12. Get Pinned Messages

```bash
GET /api/v1/chat/community/rooms/:roomId/pins?cursor=&limit=20
Authorization: Bearer <token>
```

**Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "pins": [
      { "messageId": "msg_xyz", "message": "...", "pinnedAt": 1718544000000, ... }
    ],
    "hasMore": false,
    "cursor": null
  }
}
```

---

### Search & Discovery

#### 13. Search Messages

```bash
GET /api/v1/chat/community/rooms/:roomId/messages/search?q=keyword&limit=20&page=1
Authorization: Bearer <token>
```

**Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "results": [
      { "messageId": "...", "message": "...", "sentAt": ..., ... }
    ],
    "total": 5,
    "page": 1,
    "pageSize": 20
  }
}
```

#### 14. Get Rooms

```bash
GET /api/v1/chat/community/rooms
```

**Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "rooms": [
      {
        "roomId": "comm_abc123",
        "name": "General Discussion",
        "description": "...",
        "hasUnread": true, // per authenticated user
        "lastMessage": "...",
        "lastMessageAt": 1718544000000,
        "memberCount": 42,
      },
    ],
  },
}
```

#### 15. Search Rooms

```bash
GET /api/v1/chat/community/rooms/search?query=JavaScript&page=1&limit=10
```

**Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "results": [
      {
        "roomId": "comm_xyz",
        "name": "JavaScript Beginners",
        "description": "...",
        "memberCount": 156,
      },
    ],
    "total": 3,
    "page": 1,
  },
}
```

#### 16. Join Room

```bash
POST /api/v1/chat/community/rooms/:roomId/join
Authorization: Bearer <token>
```

**Response (200):**

```jsonc
{
  "success": true,
  "data": { "roomId": "comm_abc", "joined": true },
}
```

#### 17. Leave Room

```bash
POST /api/v1/chat/community/rooms/:roomId/leave
Authorization: Bearer <token>
```

**Response (200):**

```jsonc
{
  "success": true,
  "data": { "roomId": "comm_abc", "left": true },
}
```

---

## 12. Socket vs REST Code Examples (Side by Side)

### A. Send a Message

**Socket (Real-time):**

```typescript
communitySocket.emit(
  "community:message:send",
  {
    communityId: "comm_abc123",
    roomId: "comm_abc123",
    clientMessageId: crypto.randomUUID(), // idempotency
    message: "Hello everyone!",
    contentType: "TEXT",
  },
  (ack) => {
    if (ack.success) {
      console.log("✅ Message sent:", ack.data.messageId);
      // Append to UI immediately OR wait for community:message:new
    } else if (ack.retryable) {
      // Retry with backoff
      setTimeout(() => resend(), 1000);
    } else {
      // Non-retryable: show error to user
      showError(ack.message);
    }
  }
);
```

**REST (Fallback):**

```typescript
const response = await fetch(
  "/api/v1/chat/community/rooms/comm_abc123/messages",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Hello everyone!",
      contentType: "TEXT",
      clientMessageId: crypto.randomUUID(),
    }),
  }
);

if (response.ok) {
  const { data } = await response.json();
  console.log("✅ Message sent:", data.messageId);
  // Poll for community:message:new or refetch messages
} else if (response.status === 429) {
  // Rate limited
  setTimeout(() => retry(), 30000);
} else if (response.status === 500) {
  // Retryable server error
  setTimeout(() => retry(), 1000);
}
```

---

### B. Mark Message as Read

**Socket (Real-time, auto-clears notifications):**

```typescript
communitySocket.emit(
  "community:message:read",
  {
    communityId: "comm_abc123",
    roomId: "comm_abc123",
    upToMessageId: lastVisibleMessageId,
    count: 1,
  },
  (ack) => {
    if (ack.success) {
      console.log("✅ Marked read + notifications cleared");
      // notification:count_update will arrive separately
    }
  }
);
```

**REST (Fallback, does NOT auto-clear notifications yet):**

```typescript
const response = await fetch("/api/v1/chat/community/rooms/comm_abc123/read", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    upToMessageId: lastVisibleMessageId, // currently ignored
  }),
});

// Marks messages read, but notifications NOT auto-cleared
// Call `/api/v1/notifications/mark-read` separately if needed
```

---

### C. Edit Message

**Socket:**

```typescript
communitySocket.emit(
  "community:message:edit",
  {
    messageId: "msg_xyz",
    communityId: "comm_abc123",
    roomId: "comm_abc123",
    content: { text: "Updated message" },
  },
  (ack) => {
    if (ack.success) {
      console.log("✅ Edited");
      // Wait for community:message:edited broadcast
    }
  }
);
```

**REST:**

```typescript
const response = await fetch("/api/v1/chat/community/messages/msg_xyz", {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content: { text: "Updated message" },
  }),
});

if (response.ok) {
  const { data } = await response.json();
  console.log("✅ Edited at:", data.editedAt);
}
```

---

### D. Add Reaction

**Socket:**

```typescript
communitySocket.emit(
  "community:message:react",
  {
    messageId: "msg_xyz",
    communityId: "comm_abc123",
    emoji: "👍", // send same emoji again to remove
  },
  (ack) => {
    if (ack.success) {
      // Full reaction set in ack.data
      console.log("✅ Reactions:", ack.data.reactions);
    }
  }
);
```

**REST:**

```typescript
const response = await fetch("/api/v1/chat/community/messages/msg_xyz/react", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ emoji: "👍" }),
});

if (response.ok) {
  const { data } = await response.json();
  console.log("✅ Reactions:", data.reactions);
}
```

---

### E. Delete Message

**Socket:**

```typescript
communitySocket.emit(
  "community:message:delete",
  {
    messageId: "msg_xyz",
    communityId: "comm_abc123",
    roomId: "comm_abc123",
    type: "forEveryone", // or "forMe"
  },
  (ack) => {
    if (ack.success) {
      console.log("✅ Deleted");
      // Wait for community:message:deleted broadcast
    }
  }
);
```

**REST:**

```typescript
const response = await fetch(
  "/api/v1/chat/community/messages/msg_xyz?type=forEveryone",
  {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }
);

if (response.ok) {
  console.log("✅ Deleted");
}
```

---

### F. Fetch Message History

**Socket:**

```typescript
communitySocket.emit(
  "community:messages:fetch",
  {
    roomId: "comm_abc123",
    cursor: "2026-06-18T10:30:00Z", // ISO 8601 (optional)
    limit: 30,
  },
  (ack) => {
    if (ack.success) {
      console.log("✅ Fetched:", ack.data.messages.length, "messages");
      // Parse and append to UI
    }
  }
);
```

**REST (without advancing read pointer):**

```typescript
const response = await fetch(
  "/api/v1/chat/community/rooms/comm_abc123/messages?limit=30",
  {
    headers: { Authorization: `Bearer ${token}` },
  }
);

if (response.ok) {
  const { data } = await response.json();
  console.log("✅ Fetched:", data.messages.length, "messages");
}
```

**REST (with auto-advance read pointer):**

```typescript
const response = await fetch(
  "/api/v1/chat/community/rooms/comm_abc123/conversation?pageNumber=1&limit=30",
  {
    headers: { Authorization: `Bearer ${token}` },
  }
);

if (response.ok) {
  const { data } = await response.json();
  console.log("✅ Fetched + auto-marked read");
}
```

---

### Rate Limiting & Error Codes

**Rate Limits (per user):**

- Send/react/edit/delete/pin/unpin: **30 requests per 60 seconds**
- Breach → `429 Too Many Requests`

**HTTP Error Codes:**
| Code | Error | Retryable |
|------|-------|-----------|
| 400 | INVALID_PAYLOAD | No |
| 401 | UNAUTHORIZED | No |
| 403 | FORBIDDEN (no permission) | No |
| 404 | NOT_FOUND | No |
| 409 | CONFLICT (already applied) | No |
| 429 | RATE_LIMITED | Yes (after delay) |
| 500 | SERVICE_ERROR | Yes (with backoff) |

---

## Summary

✅ **Socket Events:** `/chat` + `/community` + `/notify` namespaces  
✅ **Message Delivery:** `community:message:new` → appends to chat  
✅ **List Reorder:** `community:updated` (on `/community`) → splice to top, no reload  
✅ **Notifications:** Auto-cleared when user reads message via `community:message:read`  
✅ **Badge Updates:** `notification:count_update` syncs across all devices  
✅ **REST APIs:** 17 endpoints (send, fetch, edit, delete, react, pin, search)  
✅ **Socket Fallback:** All mutations available via REST (send, edit, delete, react)

All events are **idempotent**, **retryable** (where applicable), and **localized** to user's language preference.
