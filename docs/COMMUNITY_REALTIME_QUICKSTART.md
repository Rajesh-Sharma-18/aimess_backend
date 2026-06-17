# Community Real-Time — Frontend Quickstart

> **Purpose:** Fix the "messages don't update without a page reload" problem.  
> **Audience:** Frontend developers (React / React Native / any framework).  
> **Source of truth for full event catalog:** [`SOCKET_EVENTS.md`](SOCKET_EVENTS.md)  
> **Source of truth for REST routes:** [`COMMUNITIES_API.md`](COMMUNITIES_API.md)

---

## Why Messages Aren't Updating

The backend publishes events to Redis the moment a message is saved to the DB.
The gateway re-emits them to a Socket.IO room. If the client is not in that room,
nothing arrives — regardless of how long you wait. Reloading works because a REST
call fetches the latest state; the socket never fired.

**The three root causes of "not updating":**

| #   | Symptom                                                    | Root Cause                                                                    |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | No message events at all                                   | `community:join` was never emitted — client is not in the socket room         |
| 2   | Messages arrive but the community list doesn't move to top | Listening for `community:updated` on `/community` — it arrives on **`/chat`** |
| 3   | Works on first load, breaks on navigation                  | Room re-join not called after socket reconnect                                |

---

## The Architecture in One Diagram

```
 You (sender)
      │
      │  POST /api/v1/chat/community/{roomId}/send
      │  — OR —
      │  socket.emit("community:message:send", {...})
      ▼
 chat-service  ──── saves to MongoDB
      │
      │  redis.publish("community:{communityId}", { event, data })
      ▼
 Redis pub/sub
      │
      │  gateway psubscribes "community:*"
      ▼
 api-gateway /community namespace
      │
      │  io.to("community:{communityId}").emit(event, data)
      ▼
 Every socket in room "community:{communityId}"  ←── You and all receivers
```

```
 (separately, for the community list):

 chat-service  ──── redis.publish("user:{memberId}", { event: "community:updated", data })
      │                    for EVERY active member
      ▼
 api-gateway /chat namespace   ←── NOTE: /chat, not /community
      │
      │  io.to("user:{memberId}").emit("community:updated", data)
      ▼
 Receiver's /chat socket  →  move community to top of list, update preview
```

---

## Step 1 — Open All Three Namespaces

You need both `/community` (for messages) and `/chat` (for list bumps). Open them
once when the app starts, before any component mounts.

```ts
// lib/socket.ts
import { io, type Socket } from "socket.io-client";

const URL = process.env.NEXT_PUBLIC_GATEWAY_URL!; // e.g. http://localhost:8000

let _sockets: { community: Socket; chat: Socket; notify: Socket } | null = null;

export function initSockets(getToken: () => string | null) {
  if (_sockets) return _sockets;

  const opts = {
    path: "/socket.io/",
    transports: ["websocket", "polling"] as const,
    autoConnect: false,
    // Passing auth as a function means every reconnect picks up the latest token.
    auth: (cb: (o: { token: string | null }) => void) =>
      cb({ token: getToken() }),
  };

  _sockets = {
    community: io(`${URL}/community`, opts),
    chat: io(`${URL}/chat`, opts),
    notify: io(`${URL}/notify`, opts),
  };

  _sockets.community.connect();
  _sockets.chat.connect();
  _sockets.notify.connect();

  return _sockets;
}

export const getSockets = () => {
  if (!_sockets) throw new Error("Call initSockets first");
  return _sockets;
};
```

---

## Step 2 — Join the Community Room

**This is the most commonly missed step.** The socket is not automatically
subscribed to a community's events. You must emit `community:join` every time the
user opens a community's chat screen — and again after a full reconnect.

```ts
// hooks/useCommunityChat.ts
import { useEffect } from "react";
import { getSockets } from "@/lib/socket";

export function useCommunityChat(communityId: string) {
  useEffect(() => {
    const { community } = getSockets();

    // Join the room — this is what makes events arrive
    community.emit(
      "community:join",
      { communityId },
      (ack: { success: boolean; message: string }) => {
        if (!ack.success) {
          console.error("Failed to join community room:", ack.message);
        }
      }
    );

    // Leave the room when navigating away (free up server resources)
    return () => {
      community.emit("community:leave", { communityId }, () => {});
    };
  }, [communityId]);
}
```

Call this hook in the community chat screen component:

```tsx
function CommunityChatScreen({ communityId }: { communityId: string }) {
  useCommunityChat(communityId); // ← this is all it takes to start receiving

  return <ChatUI communityId={communityId} />;
}
```

---

## Step 3 — Listen for New Messages

Register listeners **once**, in a top-level provider or layout component, not
inside the chat screen. This way they survive navigation.

```ts
// providers/SocketProvider.tsx
import { useEffect } from "react";
import { getSockets } from "@/lib/socket";

export function SocketProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const { community, chat } = getSockets();

    // ── /community namespace ──────────────────────────────────────────────

    // New message (fires for every member currently in the room)
    community.on("community:message:new", (msg) => {
      // Deduplicate: if you sent this message optimistically, your own
      // optimistic bubble has clientMessageId set — skip the echo.
      if (isMyOptimisticBubble(msg.clientMessageId)) {
        confirmOptimisticMessage(msg.clientMessageId, msg);
        return;
      }
      appendMessageToRoom(msg.roomId, msg);
    });

    community.on("community:message:edited", (data) => {
      updateMessage(data.messageId, { message: data.message, editedAt: data.editedAt });
    });

    community.on("community:message:deleted", (data) => {
      tombstoneMessage(data.messageId);
    });

    community.on("community:message:reaction", (data) => {
      // Server sends the COMPLETE current set — replace, don't merge.
      replaceReactions(data.messageId, data.reactions);
    });

    community.on("community:message:pinned", (data) => {
      // Server sends the COMPLETE pinnedIds list — replace, don't merge.
      replacePinnedMessages(data.communityId, data.pinnedIds);
    });

    community.on("community:message:unpinned", (data) => {
      replacePinnedMessages(data.communityId, data.pinnedIds);
    });

    // ── /chat namespace — list-bump ───────────────────────────────────────
    // CRITICAL: community:updated arrives on /chat, NOT /community.
    // If you listen on the wrong namespace, the community list never moves.

    chat.on("community:updated", (update) => {
      // Move this community to the top of the list and update the preview.
      reorderCommunityInList(update.communityId, {
        lastMessage: update.lastMessage,
        lastMessageAt: update.lastMessageAt,
        unread: update.unread,   // false when you are the sender
      });
    });

    return () => {
      community.off("community:message:new");
      community.off("community:message:edited");
      community.off("community:message:deleted");
      community.off("community:message:reaction");
      community.off("community:message:pinned");
      community.off("community:message:unpinned");
      chat.off("community:updated");
    };
  }, []);

  return <>{children}</>;
}
```

---

## Step 4 — Send a Message with Optimistic UI

Send via socket for lowest latency. Use a stable `clientMessageId` (UUID) as your
idempotency key so retries don't create duplicates.

```ts
import { v4 as uuid } from "uuid";
import { getSockets } from "@/lib/socket";

async function sendMessage(communityId: string, roomId: string, text: string) {
  const clientMessageId = uuid();

  // 1. Show the bubble immediately (optimistic)
  addOptimisticBubble({ clientMessageId, text, status: "sending" });

  // 2. Send via socket
  const { community } = getSockets();
  community.emit(
    "community:message:send",
    {
      communityId,
      roomId,
      clientMessageId,
      message: text,
      contentType: "TEXT", // always UPPER-CASE
    },
    (ack) => {
      if (ack.success) {
        // community:message:new will arrive and confirm the bubble.
        // If you're also in the same room, deduplicate by clientMessageId (Step 3).
        markBubbleSent(clientMessageId, ack.data);
      } else {
        markBubbleFailed(clientMessageId, ack.message);
      }
    }
  );
}
```

---

## Step 5 — Handle Reconnection

Socket.IO has two recovery tiers. Handle both or messages will be missed after
any network hiccup.

```ts
import { getSockets } from "@/lib/socket";

// Call this from your SocketProvider after initSockets()
export function setupReconnectHandlers(
  openRooms: string[],
  currentUserId: string
) {
  const { community, chat } = getSockets();

  community.on("connect", async () => {
    if (community.recovered) {
      // Tier 1: reconnected within 2 min — rooms restored, events replayed.
      // Do nothing.
      return;
    }

    // Tier 2: fresh connection — must re-join every open room.
    for (const communityId of openRooms) {
      community.emit("community:join", { communityId }, () => {});
    }

    // Gap-fill: fetch messages missed while offline.
    // sinceId = the last message id you received for each room (persist this).
    community.emit(
      "community:catchup",
      {
        rooms: openRooms.map((id) => ({
          roomId: id,
          sinceId: getLastMessageId(id), // from your local storage / state
          limit: 100,
        })),
      },
      () => {}
    );
  });

  // Catchup results arrive one per room
  community.on("community:catchup:result", (result) => {
    for (const event of result.events) {
      switch (event.syncEventType) {
        case "new":
          appendMessageToRoom(result.roomId, event);
          break;
        case "edited":
          updateMessage(event.messageId, event);
          break;
        case "deleted":
          tombstoneMessage(event.messageId);
          break;
        case "reacted":
          replaceReactions(event.messageId, event.reactions);
          break;
      }
    }
    if (result.hasMore) {
      // Paginate: re-emit with sinceId = result.lastId
      community.emit(
        "community:catchup",
        {
          rooms: [
            { roomId: result.roomId, sinceId: result.lastId, limit: 100 },
          ],
        },
        () => {}
      );
    }
    // Persist the cursor for next reconnect
    setLastMessageId(result.roomId, result.lastId);
  });

  // On auth error: refresh the token then reconnect
  community.on("connect_error", (err) => {
    if (err.message.includes("Authentication")) {
      refreshToken().then((token) => {
        community.auth = { token };
        community.connect();
      });
    }
  });
}
```

---

## Complete Event Reference

### Events you **receive** on `/community` namespace

| Event                        | Trigger                         | Key Fields                                                                                                                                                               |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `community:message:new`      | Any member sends a message      | `id`, `communityId`, `roomId`, `senderId`, `senderName`, `senderAvatar`, `contentType`, `content.text`, `content.files`, `clientMessageId`, `sequenceNumber`, `serverTs` |
| `community:message:edited`   | Sender edits their message      | `messageId`, `communityId`, `roomId`, `message`, `contentType`, `editedAt`                                                                                               |
| `community:message:deleted`  | Message deleted for everyone    | `messageId`, `communityId`, `roomId`, `deleteType` (`"forEveryone"`), `deletedBy`                                                                                        |
| `community:message:reaction` | Any member reacts / un-reacts   | `messageId`, `communityId`, `reactions[]` — **full set, replace don't merge**                                                                                            |
| `community:message:pinned`   | Mod pins a message              | `messageId`, `communityId`, `pinnedIds[]` — **full list**                                                                                                                |
| `community:message:unpinned` | Mod unpins a message            | `messageId`, `communityId`, `pinnedIds[]` — **remaining list**                                                                                                           |
| `community:member:joined`    | A member was approved / joined  | `userId`, `displayName`, `avatarUrl`, `role`, `joinedAt`                                                                                                                 |
| `community:catchup:result`   | Response to `community:catchup` | `roomId`, `events[]`, `hasMore`, `lastId`                                                                                                                                |
| `typing:start`               | Member starts typing            | `communityId`, `userId`, `userDetails.displayName`, `userDetails.avatarUrl`                                                                                              |
| `typing:stop`                | Member stops typing             | same as `typing:start`                                                                                                                                                   |

### Events you **receive** on `/chat` namespace

| Event               | Trigger                            | Key Fields                                                                                        |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `community:updated` | Any message sent to this community | `communityId`, `roomId`, `lastMessage.text`, `lastMessage.contentType`, `lastMessageAt`, `unread` |

### Events you **receive** on `/notify` namespace

| Event                           | Trigger                                    | Key Fields                                                                                        |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `community:join_request:update` | Your join request was approved or rejected | `communityId`, `requestId`, `status` (`"APPROVED"` \| `"REJECTED"`), `communityName`, `decidedAt` |
| `notification:new`              | Any in-app notification                    | `notificationId`, `type`, `title`, `body`, `referenceId`, `isRead`                                |
| `notification:count_update`     | Unread badge changed                       | `count` — replace your badge total                                                                |

### Events you **emit** on `/community` namespace

| Event                      | When to emit                            | Payload                                                          |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `community:join`           | When user opens a community chat screen | `{ communityId }`                                                |
| `community:leave`          | When user navigates away                | `{ communityId }`                                                |
| `community:message:send`   | User taps Send                          | `{ communityId, roomId, clientMessageId, message, contentType }` |
| `community:message:react`  | User taps a reaction emoji              | `{ messageId, communityId, emoji }` (same emoji twice = remove)  |
| `community:message:edit`   | User edits own message                  | `{ messageId, communityId, roomId, content: { text } }`          |
| `community:message:delete` | User deletes own message                | `{ messageId, communityId, roomId, type: "forEveryone" }`        |
| `community:message:pin`    | Mod pins a message                      | `{ messageId, communityId, roomId }`                             |
| `community:message:unpin`  | Mod unpins a message                    | `{ messageId, communityId, roomId }`                             |
| `community:catchup`        | After reconnect, gap-fill               | `{ rooms: [{ roomId, sinceId, limit }] }`                        |
| `typing:start`             | User is typing (≤ 1 per 3 s)            | `{ communityId }`                                                |
| `typing:stop`              | User stopped typing                     | `{ communityId }`                                                |

---

## Ack Envelope

Every emitted event that accepts an ack callback uses the same response shape:

```ts
type Ack<T = undefined> =
  | { success: true; message: string; data?: T }
  | {
      success: false;
      message: string;
      error: AckErrorCode;
      retryable: boolean;
      retryAfter?: number;
    };

type AckErrorCode =
  | "INVALID_PAYLOAD" // fix the payload — do NOT retry
  | "SERVICE_ERROR" // retry with backoff (500ms → 1s → 2s, max 3)
  | "RATE_LIMITED" // wait retryAfter ms (or 30s), then one retry
  | "FORBIDDEN" // user is not authorized — surface to user, do NOT retry
  | "NOT_FOUND" // resource doesn't exist — do NOT retry
  | "CONFLICT"; // duplicate or state mismatch — do NOT retry
```

Always branch on `ack.error`, never on `ack.message` (the message string is
localized and may change between releases).

---

## System Messages (contentType: "SYSTEM")

Community lifecycle events arrive as regular `community:message:new` but with
`contentType: "SYSTEM"`. Render them as centered activity labels, not chat
bubbles. They cannot be reacted to, edited, deleted, replied to, or forwarded —
hide all action buttons when `contentType === "SYSTEM"`.

```ts
const FIELD_LABEL: Record<string, string> = {
  avatar: "community photo",
  name: "community title",
  description: "community description",
  visibility: "community visibility",
  handle: "community link",
  category: "community category",
  rules: "community rules",
  banner: "community banner",
};

function roleRank(r: string) {
  return r === "ADMIN" ? 2 : r === "MODERATOR" ? 1 : 0;
}

export function renderSystemMessage(
  msg: { systemMessageType: string; systemMetadata: any },
  currentUserId: string
): string {
  const m = msg.systemMetadata;
  if (!m) return "Community was updated";

  const actor =
    m.actorUserId === currentUserId ? "You" : m.actorName || "Someone";

  switch (msg.systemMessageType) {
    case "COMMUNITY_CREATED":
      return `${actor} created the community`;

    case "COMMUNITY_UPDATED": {
      const field = Array.isArray(m.changedFields) ? m.changedFields[0] : "";
      const label = FIELD_LABEL[field] ?? `community ${field}`;
      return `${actor} changed the ${label}`;
    }

    case "MEMBER_ROLE_CHANGED": {
      const target =
        m.targetUserId === currentUserId ? "you" : m.targetName || "a member";
      const verb =
        roleRank(m.newRole) > roleRank(m.oldRole) ? "promoted" : "demoted";
      const role = m.newRole.charAt(0) + m.newRole.slice(1).toLowerCase();
      return `${actor} ${verb} ${target} to ${role}`;
    }

    default:
      return m.actorName
        ? `${actor} updated the community`
        : "Community was updated";
  }
}
```

---

## Rate Limits

| Action                    | Cap               | What happens on breach                |
| ------------------------- | ----------------- | ------------------------------------- |
| `community:message:send`  | 30 / min          | `RATE_LIMITED` ack, `retryable: true` |
| `community:message:react` | 10 / min per room | `RATE_LIMITED` ack                    |
| `typing:start`            | ≤ 1 per 3 s       | Server silently drops extras          |
| Typing auto-expiry        | 6 s server-side   | Client must also expire after 6 s     |

---

## Mobile Notes

- **Background:** call `community:leave` for each open room and stop heartbeats.
  New messages arrive via FCM/APNs push while backgrounded — use them as a wake
  signal only, then REST/catchup on foreground.
- **Foregrounding:** reconnect → re-join rooms → `community:catchup` with last
  known `messageId` cursor.
- **Token refresh:** call `refreshToken()` before reconnecting. Set
  `socket.auth = { token }` then `socket.connect()`.

---

## Debugging Checklist

If messages still aren't arriving after following this guide:

```
[ ] Socket is connected?          console.log(community.connected) → true
[ ] Joined the room?              Did community:join ack return success: true?
[ ] Correct namespace?            community:message:new must be on /community socket
[ ] community:updated namespace?  Must be on /chat socket, NOT /community
[ ] Token valid?                  connect_error fires with "Authentication failed"?
[ ] Community has a chat room?    GET /api/v1/communities/{id} → chatEnabled: true
[ ] Member is active?             role !== null (banned/pending members can't receive)
```

---

## References

- [`SOCKET_EVENTS.md`](SOCKET_EVENTS.md) — canonical event catalog (authoritative)
- [`COMMUNITY_CHAT_INTEGRATION_GUIDE.md`](COMMUNITY_CHAT_INTEGRATION_GUIDE.md) — full phase-by-phase guide
- [`SOCKET_FRONTEND_GUIDE.md`](SOCKET_FRONTEND_GUIDE.md) — Next.js + Redux integration patterns
- [`COMMUNITIES_API.md`](COMMUNITIES_API.md) — REST API reference
- [`MEDIA_UPLOAD.md`](MEDIA_UPLOAD.md) — how to upload files before sending them
