# Community System Messages

**Status:** Implemented (Phase 1)  
**Last Updated:** 2026-06-16  
**Scope:** Backend + Socket Contract

---

## Overview

Community System Messages are **auto-generated lifecycle notifications** that appear in the community chat timeline when structural events occur (e.g., community created, member role changed). They flow through the existing `community:message:new` socket event and REST message APIs — no new transports were added.

**Key principle:** System messages are **read-only, immutable, and non-interactive**. They cannot be edited, deleted, reacted to, or replied to by any client.

---

## RabbitMQ Event Flow

System messages are created via an **async event-driven pipeline**:

```
┌─────────────────────────────┐
│  community-service          │
│  (community.service.ts)     │
│                             │
│  • create()                 │
│  • update()                 │
│  • updateMemberRole()       │
└──────────┬──────────────────┘
           │
           │ publishCommunitySystemMessageForChatSafe()
           │
           ▼
┌─────────────────────────────────────────┐
│  RabbitMQ Queue                         │
│  community.chat.sync.queue              │
│                                         │
│  Event: community.system_message        │
└──────────┬────────────────────────────┘
           │
           │ CommunityRoomSyncConsumer consumes
           │
           ▼
┌─────────────────────────────────────────┐
│  chat-service                           │
│  (CommunitySystemMessageService)        │
│                                         │
│  • Resolves user display names          │
│  • Persists GeneralRoomMessage          │
│  • Emits Redis pub/sub                  │
│  • Bumps community activity             │
└──────────┬────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│  Redis Pub/Sub                          │
│  community:<communityId>                │
│                                         │
│  Event: community:message:new           │
│  (delivered to api-gateway)             │
└──────────┬────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│  Frontend (via WebSocket)               │
│  Receives system message in timeline    │
└─────────────────────────────────────────┘
```

### Event: `community.system_message`

**Queue:** `community.chat.sync.queue` (durable, manual ACK)

**Routing Key:** `community.system_message` (direct send-to-queue, no exchange)

**Payload Format:**

```json
{
  "type": "community.system_message",
  "data": {
    "communityId": "comm_abc123",
    "systemMessageType": "COMMUNITY_CREATED",
    "metadata": {
      "communityName": "Tech Enthusiasts",
      "creatorId": "user_abc123",
      "creatorName": "Alice"
    },
    "triggeredByUserId": "user_abc123",
    "eventAt": "2026-06-16T12:30:45.123Z"
  }
}
```

**Consumer:** `CommunityRoomSyncConsumer` (chat-service)

**Handler Logic:**

```typescript
case "community.system_message": {
  const { systemMessageType, metadata, triggeredByUserId } = event.data;

  // Validate system message type
  if (!knownTypes.includes(systemMessageType)) {
    logger.warn(`Unknown system message type: ${systemMessageType}`);
    break;
  }

  // Delegate to service
  await this.communitySystemMessageService.post({
    communityId,
    systemMessageType,
    metadata,
    triggeredByUserId
  });

  logger.debug(`System message posted: ${systemMessageType}`);
  break;
}
```

**Delivery Guarantee:** At-least-once (manual ACK, DLQ on failure)

---

## Event Publish Triggers (community-service)

### Trigger 1: Community Creation

**Endpoint:** `POST /api/v1/communities`

**Code Path:**

```
community.service.ts:create()
  ├─ Validate category exists
  ├─ Create community row (DB)
  ├─ Create member rows (DB)
  ├─ Sync chat room (gRPC)
  ├─ publishCommunityCreatedForChatSafe() — async, room creation
  └─ publishCommunitySystemMessageForChatSafe() — async, system message
     │
     └─► RabbitMQ: community.chat.sync.queue
         {
           type: "community.system_message",
           data: {
             communityId: "comm_abc",
             systemMessageType: "COMMUNITY_CREATED",
             metadata: {
               communityName: "Tech Enthusiasts",
               creatorId: "user_xyz",
               creatorName: "Alice"
             },
             triggeredByUserId: "user_xyz",
             eventAt: "2026-06-16T12:30:45Z"
           }
         }
```

**System Message Posted:** `COMMUNITY_CREATED`

---

### Trigger 2: Community Update

**Endpoint:** `PATCH /api/v1/communities/{communityId}`

**Code Path:**

```
community.service.ts:update()
  ├─ Load community (DB)
  ├─ Validate authorization (ADMIN only)
  ├─ Build changedFields array by comparing input vs current values
  │   ├─ name changed? → add "name"
  │   ├─ description changed? → add "description"
  │   ├─ avatarObjectKey changed? → add "avatar"
  │   ├─ coverObjectKey changed? → add "banner"
  │   ├─ type changed? → add "visibility"
  │   ├─ category changed? → add "category"
  │   ├─ handle changed? → add "handle"
  │   └─ settings changed? → add "settings"
  │
  ├─ updateCommunity(data) (DB)
  ├─ Invalidate cache
  │
  └─ if (changedFields.length > 0) publishCommunitySystemMessageForChatSafe()
     │
     └─► RabbitMQ: community.chat.sync.queue
         {
           type: "community.system_message",
           data: {
             communityId: "comm_abc",
             systemMessageType: "COMMUNITY_UPDATED",
             metadata: {
               updaterId: "user_admin",
               updaterName: "Admin",
               changedFields: ["avatar", "name"],
               newName: "New Community Name",
               newVisibility: "PRIVATE"
             },
             triggeredByUserId: "user_admin",
             eventAt: "2026-06-16T12:35:20Z"
           }
         }
```

**System Message Posted:** `COMMUNITY_UPDATED` (if any fields changed)

**Note:** No system message if all properties remain unchanged.

---

### Trigger 3: Member Role Change

**Endpoint:** `PATCH /api/v1/communities/{communityId}/members/{userId}/role`

**Code Path:**

```
community.service.ts:updateMemberRole()
  ├─ Load community (DB)
  ├─ Validate authorization (ADMIN only)
  ├─ Load target member (DB)
  ├─ Validate target is ACTIVE, not self, not ADMIN
  ├─ Idempotency check: if (target.role === role) return early (no event)
  │
  ├─ updateMemberRole(target, role) (DB)
  ├─ recordAudit(action: "MEMBER_PROMOTED" | "MEMBER_DEMOTED")
  ├─ publishCommunityMemberRoleChangedSafe() — notifications
  │
  └─ publishCommunitySystemMessageForChatSafe()
     │
     └─► RabbitMQ: community.chat.sync.queue
         {
           type: "community.system_message",
           data: {
             communityId: "comm_abc",
             systemMessageType: "MEMBER_ROLE_CHANGED",
             metadata: {
               actorId: "user_admin",
               actorName: "Admin",
               targetUserId: "user_john",
               targetName: "John",
               oldRole: "MEMBER",
               newRole: "MODERATOR"
             },
             triggeredByUserId: "user_admin",
             eventAt: "2026-06-16T12:40:15Z"
           }
         }
```

**System Message Posted:** `MEMBER_ROLE_CHANGED`

**Note:** Idempotent — if role is already set to the requested value, no event is published.

---

## Message Types

### 1. COMMUNITY_CREATED

**Backend Event:** Published by `community.service.ts:create()` after room provisioning

**Payload:**

```json
{
  "contentType": "SYSTEM",
  "systemMessageType": "COMMUNITY_CREATED",
  "systemMetadata": {
    "communityName": "Tech Enthusiasts",
    "creatorId": "user_abc123",
    "creatorName": "Alice"
  },
  "content": {
    "text": "Alice created the community"
  }
}
```

**Frontend Render:**

```
[Centered muted pill]
Alice created the community
```

---

### 2. COMMUNITY_UPDATED

**Trigger:** One or more community properties change (name, description, avatar, banner, visibility, settings, category, handle).

**Payload:**

```json
{
  "contentType": "SYSTEM",
  "systemMessageType": "COMMUNITY_UPDATED",
  "systemMetadata": {
    "updaterId": "user_xyz789",
    "updaterName": "Bob",
    "changedFields": ["avatar", "name"],
    "newName": "DevOps Hub",
    "newVisibility": "PRIVATE"
  },
  "content": {
    "text": "Bob updated the community (avatar, name)"
  }
}
```

**Frontend Logic:**

| `changedFields`      | Render As                                       |
| -------------------- | ----------------------------------------------- |
| `["avatar"]`         | `"Bob updated the community avatar"`            |
| `["name"]`           | `"Bob updated the community name"`              |
| `["description"]`    | `"Bob updated the community description"`       |
| `["banner"]`         | `"Bob updated the community banner"`            |
| `["visibility"]`     | `"Bob changed community visibility to PRIVATE"` |
| `["settings"]`       | `"Bob updated the community settings"`          |
| `["category"]`       | `"Bob updated the community category"`          |
| `["handle"]`         | `"Bob updated the community handle"`            |
| `["avatar", "name"]` | `"Bob updated the community profile"`           |
| Multiple fields      | `"Bob updated the community profile"`           |

---

### 3. MEMBER_ROLE_CHANGED

**Trigger:** A member's role is changed (MEMBER ↔ MODERATOR, MODERATOR ↔ ADMIN, etc.).

**Payload:**

```json
{
  "contentType": "SYSTEM",
  "systemMessageType": "MEMBER_ROLE_CHANGED",
  "systemMetadata": {
    "actorId": "user_admin999",
    "actorName": "Admin",
    "targetUserId": "user_john456",
    "targetName": "John",
    "oldRole": "MEMBER",
    "newRole": "MODERATOR"
  },
  "content": {
    "text": "Admin promoted John to Moderator"
  }
}
```

**Frontend Logic:**

| Transition         | Render As                                        |
| ------------------ | ------------------------------------------------ |
| MEMBER → MODERATOR | `"{actor} promoted {target} to Moderator"`       |
| MODERATOR → MEMBER | `"{actor} changed {target} to Member"`           |
| MODERATOR → ADMIN  | `"{actor} promoted {target} to Admin"`           |
| ADMIN → MEMBER     | `"{actor} changed {target} to Member"`           |
| Any other          | `"{actor} changed {target}'s role to {newRole}"` |

---

## Socket Contract

### Event: `community:message:new`

**No new socket events were created.** System messages use the existing `community:message:new` event.

**Message Shape (Extended):**

```typescript
interface CommunityMessage {
  // Identifiers
  id: string;
  messageId: string; // alias for id (V1 compat)
  communityId: string;
  roomId: string; // === communityId for community rooms

  // Sender
  senderId: string;
  senderName: string;
  senderAvatar: string; // presigned URL, resolve-on-read

  // Content
  contentType: "SYSTEM"; // UPPER-CASE canonical
  content: {
    text: string; // English fallback only
    files: [];
  };
  message: string; // alias for content.text (V1 compat)

  // System Message Fields (NEW)
  systemMessageType:
    | "COMMUNITY_CREATED"
    | "COMMUNITY_UPDATED"
    | "MEMBER_ROLE_CHANGED";
  systemMetadata: {
    // varies by systemMessageType — see Message Types section above
  };

  // Timestamps
  serverTs: number; // epoch-ms
  sentAt: number; // alias for serverTs (V1 compat)
  sequenceNumber: number; // monotonic per community

  // Standard fields (always empty for SYSTEM)
  parentMessageId: "";
  quoteData: null;
  reactions: [];
  editedAt: null;

  // Client metadata
  clientMessageId: "";
}
```

**Example Socket Emit:**

```javascript
{
  event: "community:message:new",
  data: {
    id: "msg_abc123",
    messageId: "msg_abc123",
    communityId: "comm_xyz789",
    roomId: "comm_xyz789",
    contentType: "SYSTEM",
    systemMessageType: "MEMBER_ROLE_CHANGED",
    systemMetadata: {
      actorId: "user_admin999",
      actorName: "Admin",
      targetUserId: "user_john456",
      targetName: "John",
      oldRole: "MEMBER",
      newRole: "MODERATOR"
    },
    content: { text: "Admin promoted John to Moderator", files: [] },
    message: "Admin promoted John to Moderator",
    senderId: "user_admin999",
    senderName: "Admin",
    senderAvatar: "https://minio.internal/avatars/user_admin999_abc.webp?X-Amz-Expires=3600&...",
    serverTs: 1750000000000,
    sentAt: 1750000000000,
    sequenceNumber: 42,
    parentMessageId: "",
    quoteData: null,
    reactions: [],
    editedAt: null,
    clientMessageId: ""
  }
}
```

---

## REST API Contract

### GET `/api/v1/chat/community/{communityId}/messages`

System messages appear in the response with the same fields as the socket emit.

**Query Parameters:**

- `before_ts` — ISO 8601 timestamp (fetch older messages)
- `after_ts` — ISO 8601 timestamp (fetch newer messages)
- `around` — messageId (fetch window around a message)
- `limit` — number of messages (default 50, max 100)

**Response:**

```json
{
  "messages": [
    {
      "id": "msg_system_001",
      "contentType": "SYSTEM",
      "systemMessageType": "COMMUNITY_CREATED",
      "systemMetadata": { ... },
      "content": { "text": "Alice created the community", "files": [] },
      "senderId": "user_abc123",
      "senderName": "Alice",
      "serverTs": 1750000000000,
      "sequenceNumber": 1,
      ...
    },
    {
      "id": "msg_user_002",
      "contentType": "TEXT",
      "content": { "text": "Welcome to the community!", "files": [] },
      "senderId": "user_xyz789",
      "senderName": "Bob",
      "serverTs": 1750000001000,
      "sequenceNumber": 2,
      ...
    }
  ],
  "hasMore": false,
  "nextCursor": "2026-06-16T12:30:00Z"
}
```

### GET `/api/v1/chat/community/{communityId}/sync`

Incremental sync by `updatedAt` timestamp. Returns all mutations (new, edited, deleted, reacted).

**Query Parameters:**

- `after_ts` — ISO 8601 timestamp (fetch mutations since this time)
- `limit` — number of events (default 50, max 100)

**Response:**

```json
{
  "messages": [
    {
      "id": "msg_system_001",
      "contentType": "SYSTEM",
      "systemMessageType": "COMMUNITY_CREATED",
      "systemMetadata": { ... },
      "syncEventType": "new",
      "createdAt": 1750000000000,
      "updatedAt": 1750000000000,
      ...
    }
  ],
  "nextCursor": "2026-06-16T12:30:00Z"
}
```

---

## Frontend Implementation Guide

### Rendering

**DO:**

```typescript
function renderCommunityMessage(msg: CommunityMessage) {
  if (msg.contentType === 'SYSTEM') {
    return (
      <SystemMessageBubble>
        <MutedText>
          {getSystemMessageText(msg.systemMessageType, msg.systemMetadata)}
        </MutedText>
        {/* Centered, gray pill style */}
        {/* NO action buttons */}
      </SystemMessageBubble>
    );
  }

  return <NormalMessageBubble msg={msg} />;
}

function getSystemMessageText(type: string, meta: any): string {
  switch (type) {
    case 'COMMUNITY_CREATED':
      return `${meta.creatorName} created the community`;
    case 'COMMUNITY_UPDATED': {
      const fields = meta.changedFields as string[];
      if (fields.length === 1) {
        const label = {
          avatar: 'avatar',
          name: 'name',
          description: 'description',
          banner: 'banner',
          visibility: 'visibility',
          settings: 'settings',
          category: 'category',
          handle: 'handle'
        }[fields[0]] || fields[0];
        return `${meta.updaterName} updated the community ${label}`;
      }
      return `${meta.updaterName} updated the community profile`;
    }
    case 'MEMBER_ROLE_CHANGED': {
      const action =
        meta.newRole === 'MODERATOR' ? 'promoted' :
        meta.oldRole === 'MODERATOR' ? 'demoted' : 'changed';
      return `${meta.actorName} ${action} ${meta.targetName} to ${meta.newRole}`;
    }
    default:
      return 'Community was updated';
  }
}
```

**DON'T:**

```typescript
// ❌ WRONG — parse content.text for display
const text = msg.content.text;  // "Alice created the community"
// This is English-only fallback for accessibility, not for rendering

// ❌ WRONG — try to edit/delete/react
socket.emit('community:message:react', {
  messageId: msg.id,
  emoji: '👍'
});
// Server returns: 400 CHAT_SYSTEM_MESSAGE_IMMUTABLE

// ❌ WRONG — try to reply
<ReplyButton messageId={msg.id} />
// Disabled flag should check: contentType === 'SYSTEM'
```

### Interaction Guards

```typescript
// Hide action buttons for system messages
function MessageActions(props: { msg: CommunityMessage }) {
  if (props.msg.contentType === 'SYSTEM') {
    return null;  // No edit, delete, react, forward, pin buttons
  }

  return (
    <>
      <EditButton disabled={!canEdit(props.msg)} />
      <DeleteButton disabled={!canDelete(props.msg)} />
      <ReactButton disabled={!canReact(props.msg)} />
      <ReplyButton disabled={!canReply(props.msg)} />
      <ForwardButton disabled={!canForward(props.msg)} />
      <PinButton disabled={!canPin(props.msg)} />
    </>
  );
}
```

### Socket Subscription

```typescript
// Listen for system messages (same event as normal messages)
socket.on("community:message:new", (msg: CommunityMessage) => {
  if (msg.contentType === "SYSTEM") {
    console.log("System event:", {
      type: msg.systemMessageType,
      metadata: msg.systemMetadata,
      preview: msg.content.text,
    });
  }

  // Add to message timeline (treat same as normal messages)
  addMessageToTimeline(msg);
});
```

---

## Testing

### Quick Manual Test

1. **Create a community:**

   ```bash
   curl -X POST http://localhost:8000/api/v1/communities \
     -H "Authorization: Bearer $JWT" \
     -d '{"name":"Test","type":"PUBLIC","categoryId":"cat_123"}'
   ```

   → `COMMUNITY_CREATED` system message auto-posted

2. **Subscribe to socket:**

   ```javascript
   socket.on("community:message:new", (msg) => {
     if (msg.contentType === "SYSTEM") {
       console.log("🔔", msg.systemMessageType, msg.systemMetadata);
     }
   });
   ```

3. **Update community name:**

   ```bash
   curl -X PATCH http://localhost:8000/api/v1/communities/{communityId} \
     -H "Authorization: Bearer $JWT" \
     -d '{"name":"New Name"}'
   ```

   → Socket emits `COMMUNITY_UPDATED` with `changedFields: ["name"]`

4. **Change member role:**

   ```bash
   curl -X PATCH http://localhost:8000/api/v1/communities/{communityId}/members/{userId}/role \
     -H "Authorization: Bearer $JWT" \
     -d '{"role":"MODERATOR"}'
   ```

   → Socket emits `MEMBER_ROLE_CHANGED` with role transition

5. **Fetch message history:**

   ```bash
   curl http://localhost:8000/api/v1/chat/community/{communityId}/messages \
     -H "Authorization: Bearer $JWT"
   ```

   → System messages appear with `systemMessageType` and `systemMetadata`

6. **Try to react (should fail):**
   ```bash
   curl -X POST http://localhost:8000/api/v1/chat/messages/{systemMessageId}/react \
     -H "Authorization: Bearer $JWT" \
     -d '{"emoji":"👍"}'
   ```
   → Response: `400 CHAT_SYSTEM_MESSAGE_IMMUTABLE`

---

## Implementation Notes

### Backend Architecture

**community-service (Event Publisher)**

- **File:** `src/services/community.service.ts`
- **Call Sites:**
  - `create()` (line ~902) → publishes on community creation
  - `update()` (line ~1074) → publishes on community property change
  - `updateMemberRole()` (line ~1396) → publishes on role transition
- **Publisher Function:** `publishCommunitySystemMessageForChatSafe()` from `src/messaging/publish-community-chat.ts`

**chat-service (Event Consumer & Message Creator)**

- **Consumer:** `CommunityRoomSyncConsumer` in `src/events/community-room-sync.consumer.ts`
  - Listens on queue: `community.chat.sync.queue`
  - Handler: `case "community.system_message"` (line ~221)
  - Validates `systemMessageType` against known enum values
  - Delegates to `CommunitySystemMessageService`

- **Service:** `CommunitySystemMessageService` in `src/services/community-system-message.service.ts`
  - `post()` method: core logic for creating system messages
  - Resolves display names via `UserSnapshotService`
  - Calls `GeneralRoomMessageRepository.createSystemMessage()`
  - Publishes Redis event: `community:<communityId>`
  - Calls `publishCommunityActivitySafe()` to bump inbox

- **Repository:** `createSystemMessage()` in `src/repositories/general-room-message.repository.ts`
  - Persists `GeneralRoomMessage` row with `messageType: "SYSTEM"`
  - Sets `systemMessageType` and `systemMetadata` fields

- **Immutability Guards:** `src/services/community-message.service.ts`
  - `editMessage()` (line 882) → blocks SYSTEM via `!== "TEXT"`
  - `deleteForMe()` (line 985) → throws `CHAT_SYSTEM_MESSAGE_IMMUTABLE`
  - `deleteForAll()` (line 1004) → throws `CHAT_SYSTEM_MESSAGE_IMMUTABLE`
  - `reactToMessage()` (line 909) → throws `CHAT_SYSTEM_MESSAGE_IMMUTABLE`
  - `pinMessage()` (line 1058) → throws `CHAT_SYSTEM_MESSAGE_IMMUTABLE`
  - `unpinMessage()` (line 1108) → throws `CHAT_SYSTEM_MESSAGE_IMMUTABLE`

### Database Schema

**Table:** `general_room_messages` (MongoDB)

**New Fields:**

- `systemMessageType: String?` — one of the 3 enum values (or null)
- `systemMetadata: Json?` — structured payload (or null)

**New Index:**

```
[roomId, systemMessageType, createdAt DESC]
```

Used for efficient queries filtering by type.

### Backward Compatibility

- **Existing clients:** Unaffected. Non-SYSTEM messages have null/undefined values for the new fields.
- **V1 aliases:** System messages include `messageId`, `conversationId`, `sentAt`, `contentText` aliases for legacy clients.
- **Read-only:** System messages cannot mutate, so no breaking changes to edit/delete/react contracts.

---

## Known Limitations

1. **No system message for community deletion** — Deleted communities have their chat room deactivated but no explicit system message is posted (chat-service processes the deactivation async).
2. **No system message for bulk member operations** — Adding/removing multiple members via `PATCH /members` generates individual `community.member.synced` events but not individual system messages.
3. **No system message for community settings changes** — Generic "updated" covers it but no granular metadata per setting key.

These are design trade-offs; system messages focus on the top 3 high-visibility events.

---

## References

- [`docs/SOCKET_EVENTS.md`](SOCKET_EVENTS.md) — Full socket event catalog
- [`docs/COMMUNITY_CHAT_INTEGRATION_GUIDE.md`](COMMUNITY_CHAT_INTEGRATION_GUIDE.md) — Complete FE integration guide
- `packages/constants/src/community/system-message.ts` — Enum definition
- `packages/shared-types/src/chat.ts` — TypeScript interfaces
