# Community System Messages — Changelog & Migration Guide

**Release Date:** 2026-06-16  
**Version:** Phase 1  
**Status:** Shipped

---

## Executive Summary

Community System Messages are **auto-generated, read-only lifecycle notifications** that appear in community chat timelines (e.g., "Alice created the community", "Bob promoted John to Moderator").

**For Frontend Teams:**

- ✅ **No new socket events** — reuse existing `community:message:new`
- ✅ **No breaking changes** — existing message handling continues working
- ✅ **Additive only** — system messages are a new `contentType: "SYSTEM"` variant
- ✅ **Fully documented** — complete payload examples + rendering guide included

---

## What Changed

### 1. NEW: System Message Type

**Added to:** `packages/constants/src/community/system-message.ts`

```typescript
export const CommunitySystemMessageType = {
  COMMUNITY_CREATED: "COMMUNITY_CREATED",
  COMMUNITY_UPDATED: "COMMUNITY_UPDATED",
  MEMBER_ROLE_CHANGED: "MEMBER_ROLE_CHANGED",
} as const;
```

**Why:** Centralized enum ensures consistent typing across all services (community-service, chat-service, FE).

**FE Usage:**

```typescript
import { CommunitySystemMessageType } from "@aimess/constants";

const isSystemCreated =
  msg.systemMessageType === CommunitySystemMessageType.COMMUNITY_CREATED;
```

---

### 2. NEW: Message Payload Extension

**Added to:** `packages/shared-types/src/chat.ts`

**New Fields in `MessageDto`:**

```typescript
// All optional, null for non-system messages
systemMessageType?: CommunitySystemMessageType | null;
systemMetadata?: SystemMessageMetadata | null;
```

**New Metadata Interfaces:**

```typescript
interface CommunityCreatedMetadata {
  communityName: string;
  creatorId: string;
  creatorName: string;
}

interface CommunityUpdatedMetadata {
  updaterId: string;
  updaterName: string;
  changedFields: string[]; // ["name", "avatar", etc.]
  newName?: string;
  newVisibility?: string;
}

interface MemberRoleChangedMetadata {
  actorId: string;
  actorName: string;
  targetUserId: string;
  targetName: string;
  oldRole: string;
  newRole: string;
}
```

**Why:** Structured metadata allows FE to render localized text without parsing plain English strings.

**FE Usage:**

```typescript
// ✅ CORRECT
const text = getSystemMessageText(msg.systemMessageType, msg.systemMetadata);

// ❌ WRONG — never parse content.text
const text = msg.content.text; // "Bob promoted John to Moderator" — English only
```

---

### 3. EXTENDED: Socket `community:message:new` Payload

**What Changed:**
Socket event payload now includes `systemMessageType` and `systemMetadata` when `contentType === "SYSTEM"`.

**Before (non-system):**

```json
{
  "id": "msg_abc",
  "contentType": "TEXT",
  "content": { "text": "Hello", "files": [] },
  "senderId": "user_xyz",
  "senderName": "Alice",
  "reactions": [],
  "parentMessageId": null
}
```

**After (system message):**

```json
{
  "id": "msg_system_001",
  "contentType": "SYSTEM",
  "content": { "text": "Alice created the community", "files": [] },
  "senderId": "user_abc",
  "senderName": "Alice",
  "reactions": [],
  "parentMessageId": null,
  "systemMessageType": "COMMUNITY_CREATED",
  "systemMetadata": {
    "communityName": "Tech Enthusiasts",
    "creatorId": "user_abc",
    "creatorName": "Alice"
  }
}
```

**Why:** Separating structured data (metadata) from plain-text fallback allows clients to render in any language and prevents mismatches between string parsing and actual meaning.

**FE Migration:**

```typescript
// Before: no system messages existed
socket.on("community:message:new", (msg) => {
  // All messages were normal text/image/video/etc.
  addToTimeline(msg);
});

// After: check contentType and render differently
socket.on("community:message:new", (msg) => {
  if (msg.contentType === "SYSTEM") {
    // Render as centered muted pill, no action buttons
    renderSystemMessage(msg);
  } else {
    // Existing behavior for normal messages
    renderNormalMessage(msg);
  }
});
```

---

### 4. EXTENDED: REST Message History APIs

**Endpoints affected:**

- `GET /api/v1/chat/community/{communityId}/messages` — message history
- `GET /api/v1/chat/community/{communityId}/sync` — incremental sync
- `GET /api/v1/chat/community/{communityId}/messages?around={messageId}` — jump-to-message

**What Changed:**
All three endpoints now include `systemMessageType` and `systemMetadata` in response payloads when message `contentType === "SYSTEM"`.

**Before:**

```json
{
  "messages": [
    {
      "id": "msg_001",
      "contentType": "TEXT",
      "message": "Welcome!",
      "senderName": "Alice"
    }
  ]
}
```

**After:**

```json
{
  "messages": [
    {
      "id": "msg_system_001",
      "contentType": "SYSTEM",
      "message": "Alice created the community",
      "senderName": "Alice",
      "systemMessageType": "COMMUNITY_CREATED",
      "systemMetadata": {
        "communityName": "Tech Enthusiasts",
        "creatorId": "user_abc",
        "creatorName": "Alice"
      }
    },
    {
      "id": "msg_001",
      "contentType": "TEXT",
      "message": "Welcome!",
      "senderName": "Bob"
    }
  ]
}
```

**FE Migration:**

```typescript
// REST history fetch
const response = await fetch(`/api/v1/chat/community/${communityId}/messages`);
const { messages } = await response.json();

messages.forEach((msg) => {
  if (msg.contentType === "SYSTEM") {
    // New: handle system message
    displaySystemMessage(msg.systemMessageType, msg.systemMetadata);
  } else {
    // Existing: handle normal message
    displayNormalMessage(msg);
  }
});
```

---

### 5. EXTENDED: gRPC Community Message APIs

**RPCs affected:**

- `getCommunityMessages` — message history fetch
- `communityCatchup` — reconnection catch-up

**What Changed:**
gRPC responses now include `systemMessageType` and `systemMetadata` in message objects.

**Before:**

```protobuf
// Response message field
{
  messageId: "msg_001",
  message: "Hello",
  contentType: "TEXT"
}
```

**After:**

```protobuf
// Response message field with system message
{
  messageId: "msg_system_001",
  message: "Alice created the community",
  contentType: "SYSTEM",
  systemMessageType: "COMMUNITY_CREATED",
  systemMetadata: {
    // JSON object
  }
}
```

**FE Migration (if using gRPC client):**

```typescript
// Same as REST — check contentType and handle accordingly
const messages = await chatClient.getCommunityMessages({...});
messages.forEach(msg => {
  if (msg.contentType === 'SYSTEM') {
    renderSystemMessage(msg);
  } else {
    renderNormalMessage(msg);
  }
});
```

---

### 6. EXTENDED: AsyncAPI Socket Schema

**What Changed:**
`asyncapi.yaml` now documents system messages in the `community:message:new` schema with 3 named examples.

**Before:**

```yaml
examples:
  - name: community_normal_text
    payload:
      contentType: TEXT
      message: "Hello world"
```

**After:**

```yaml
examples:
  - name: community_normal_text
    payload:
      contentType: TEXT
      message: "Hello world"

  - name: community_system_created
    payload:
      contentType: SYSTEM
      systemMessageType: COMMUNITY_CREATED
      systemMetadata:
        communityName: "Tech Enthusiasts"
        creatorId: "user_abc"
        creatorName: "Alice"

  - name: community_system_updated
    payload:
      contentType: SYSTEM
      systemMessageType: COMMUNITY_UPDATED
      systemMetadata:
        updaterId: "user_xyz"
        updaterName: "Bob"
        changedFields: ["avatar"]

  - name: community_system_role_changed
    payload:
      contentType: SYSTEM
      systemMessageType: MEMBER_ROLE_CHANGED
      systemMetadata:
        actorId: "user_admin"
        actorName: "Admin"
        targetUserId: "user_john"
        targetName: "John"
        oldRole: "MEMBER"
        newRole: "MODERATOR"
```

**Why:** Clear examples help FE teams understand expected payloads during implementation.

---

### 7. EXTENDED: OpenAPI Schemas

**What Changed:**
`ChatCommunityMessage` schema now includes `systemMessageType` and `systemMetadata` fields as optional nullable properties.

**Before:**

```yaml
ChatCommunityMessage:
  type: object
  properties:
    id: { type: string }
    contentType: { type: string, enum: [TEXT, IMAGE, VIDEO, ...] }
    message: { type: string }
    reactions: { type: array }
```

**After:**

```yaml
ChatCommunityMessage:
  type: object
  properties:
    id: { type: string }
    contentType: { type: string, enum: [TEXT, IMAGE, VIDEO, ..., SYSTEM] }
    message: { type: string }
    reactions: { type: array }
    systemMessageType:
      type: string
      nullable: true
      enum: [COMMUNITY_CREATED, COMMUNITY_UPDATED, MEMBER_ROLE_CHANGED]
      description: "Present when contentType is SYSTEM"
    systemMetadata:
      type: object
      nullable: true
      additionalProperties: true
      description: "Shape varies by systemMessageType"
```

**FE Usage:**

```typescript
// TypeScript client generated from OpenAPI
import { ChatCommunityMessage } from '@aimess/api-client';

const msg: ChatCommunityMessage = {
  id: "msg_123",
  contentType: "SYSTEM",
  systemMessageType: "COMMUNITY_CREATED",
  systemMetadata: { ... }
};
```

---

## What Was NOT Removed

### ✅ Backward Compatible: V1 Aliases Preserved

System messages include V1 aliases for backward compatibility:

```json
{
  // New fields
  "systemMessageType": "COMMUNITY_CREATED",
  "systemMetadata": { ... },

  // V1 aliases (still present)
  "messageId": "msg_123",        // alias for id
  "conversationId": "comm_456",  // alias for communityId
  "contentText": "...",          // alias for content.text
  "sentAt": 1750000000000        // alias for serverTs
}
```

**Why:** Existing V1 clients that don't know about system messages can still read the message using familiar field names.

**FE Migration:**

```typescript
// Old V1 code still works
const msgId = msg.messageId; // Still works
const text = msg.contentText; // Still works

// New code uses canonical names
const msgId = msg.id; // Preferred
const text = msg.content.text; // Preferred
```

---

### ✅ Backward Compatible: Normal Messages Unchanged

Non-system messages (`contentType: TEXT`, `IMAGE`, etc.) are **completely unchanged**:

```json
{
  "id": "msg_001",
  "contentType": "TEXT",
  "message": "Hello!",
  "senderId": "user_xyz",
  "senderName": "Bob",
  "reactions": [],
  "parentMessageId": null
  // systemMessageType and systemMetadata are absent/null
}
```

**FE Migration:**

```typescript
// Existing code for normal messages requires NO changes
if (msg.contentType === "TEXT") {
  displayText(msg.message);
} else if (msg.contentType === "IMAGE") {
  displayImage(msg.attachments[0]);
}

// Just add a new case for SYSTEM
if (msg.contentType === "SYSTEM") {
  displaySystemMessage(msg.systemMessageType, msg.systemMetadata);
}
```

---

## What CANNOT Be Done (New Guards)

### ❌ System Messages Are Immutable

Attempting to mutate system messages returns `400 CHAT_SYSTEM_MESSAGE_IMMUTABLE`.

**Operations that now fail for system messages:**

| Operation        | Endpoint                              | Error Code                                 | Fix                                      |
| ---------------- | ------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| Edit             | `PATCH /messages/{id}`                | `CHAT_SYSTEM_MESSAGE_IMMUTABLE`            | Hide edit button for SYSTEM messages     |
| Delete (for me)  | `DELETE /messages/{id}?type=forMe`    | `CHAT_SYSTEM_MESSAGE_IMMUTABLE`            | Hide delete button for SYSTEM messages   |
| Delete (for all) | `DELETE /messages/{id}?type=forAll`   | `CHAT_SYSTEM_MESSAGE_IMMUTABLE`            | Hide delete button for SYSTEM messages   |
| React            | `POST /messages/{id}/react`           | `CHAT_SYSTEM_MESSAGE_IMMUTABLE`            | Hide reaction button for SYSTEM messages |
| Pin              | `POST /community/{id}/pins`           | `CHAT_SYSTEM_MESSAGE_IMMUTABLE`            | Hide pin button for SYSTEM messages      |
| Unpin            | `DELETE /community/{id}/pins/{msgId}` | `CHAT_SYSTEM_MESSAGE_IMMUTABLE`            | Hide unpin button for SYSTEM messages    |
| Reply            | `POST /messages/{id}/reply`           | `CHAT_SYSTEM_MESSAGE_IMMUTABLE` (implicit) | Hide reply button for SYSTEM messages    |
| Forward          | `POST /messages/{id}/forward`         | `CHAT_SYSTEM_MESSAGE_IMMUTABLE` (implicit) | Hide forward button for SYSTEM messages  |

**Why:** System messages are **lifecycle notifications**, not user-generated chat. They cannot be modified once created.

**FE Implementation:**

```typescript
function MessageActions(props: { msg: CommunityMessage }) {
  // System messages: no action buttons
  if (msg.contentType === 'SYSTEM') {
    return null;
  }

  // Normal messages: all buttons available (subject to permissions)
  return (
    <>
      <EditButton disabled={!canEdit(msg)} />
      <DeleteButton disabled={!canDelete(msg)} />
      <ReactButton disabled={!canReact(msg)} />
      <ReplyButton disabled={!canReply(msg)} />
      <ForwardButton disabled={!canForward(msg)} />
      <PinButton disabled={!canPin(msg)} />
    </>
  );
}

// Test: attempt to react to system message
async function testSystemMessageImmutability() {
  const response = await fetch(`/api/v1/messages/msg_system_001/react`, {
    method: 'POST',
    body: JSON.stringify({ emoji: '👍' }),
    headers: { 'Authorization': `Bearer ${token}` }
  });

  // Response: 400 Bad Request
  // Body: { error: "CHAT_SYSTEM_MESSAGE_IMMUTABLE", code: "CHAT_SYSTEM_MESSAGE_IMMUTABLE" }
}
```

---

## FE Implementation Checklist

### Step 1: Update Message Type Guards

```typescript
// ✅ DO: Check contentType for rendering logic
if (msg.contentType === "SYSTEM") {
  // Render system message
  renderSystemMessage(msg);
} else {
  // Render normal message
  renderNormalMessage(msg);
}

// ❌ DON'T: Assume all messages are normal
if (!msg.attachments?.length) {
  // This assumption breaks for SYSTEM messages
}
```

### Step 2: Add System Message Renderer

```typescript
import { CommunitySystemMessageType } from '@aimess/constants';

function renderSystemMessage(msg: CommunityMessage) {
  const text = getSystemMessageText(msg.systemMessageType, msg.systemMetadata);

  return (
    <div className="system-message-pill">
      <span className="muted-text">{text}</span>
    </div>
  );
}

function getSystemMessageText(
  type: CommunitySystemMessageType | null | undefined,
  metadata: any
): string {
  if (!type) return 'Community was updated';

  switch (type) {
    case CommunitySystemMessageType.COMMUNITY_CREATED:
      return `${metadata.creatorName} created the community`;

    case CommunitySystemMessageType.COMMUNITY_UPDATED: {
      const fields = metadata.changedFields as string[];
      if (fields.length === 1) {
        return `${metadata.updaterName} updated the community ${fields[0]}`;
      }
      return `${metadata.updaterName} updated the community profile`;
    }

    case CommunitySystemMessageType.MEMBER_ROLE_CHANGED: {
      const action =
        metadata.newRole === 'MODERATOR' ? 'promoted' :
        metadata.oldRole === 'MODERATOR' ? 'demoted' : 'changed';
      return `${metadata.actorName} ${action} ${metadata.targetName} to ${metadata.newRole}`;
    }

    default:
      return 'Community was updated';
  }
}
```

### Step 3: Hide Action Buttons for System Messages

```typescript
function MessageActionButtons(props: { msg: CommunityMessage }) {
  // System messages have no action buttons
  if (props.msg.contentType === 'SYSTEM') {
    return null;
  }

  return (
    <div className="message-actions">
      <EditButton msg={props.msg} />
      <DeleteButton msg={props.msg} />
      <ReactButton msg={props.msg} />
      <ReplyButton msg={props.msg} />
      <ForwardButton msg={props.msg} />
      <PinButton msg={props.msg} />
    </div>
  );
}
```

### Step 4: Update Message Timeline Component

```typescript
function MessageTimeline(props: { messages: CommunityMessage[] }) {
  return (
    <div className="timeline">
      {props.messages.map(msg => (
        <div key={msg.id}>
          {msg.contentType === 'SYSTEM' ? (
            <SystemMessageBubble msg={msg} />
          ) : (
            <NormalMessageBubble msg={msg} />
          )}
        </div>
      ))}
    </div>
  );
}
```

### Step 5: Socket Event Listener

```typescript
// Socket listener — already receiving system messages
socket.on("community:message:new", (msg: CommunityMessage) => {
  // Add to timeline (handles both SYSTEM and normal)
  addMessageToTimeline(msg);
});

// REST history fetch — already receiving system messages
async function fetchCommunityHistory(communityId: string) {
  const response = await fetch(
    `/api/v1/chat/community/${communityId}/messages`
  );
  const { messages } = await response.json();

  messages.forEach((msg) => {
    // Check contentType and render accordingly
    addMessageToTimeline(msg);
  });
}
```

---

## Testing Payloads

### Test 1: COMMUNITY_CREATED

**Trigger:** Create a community via `POST /api/v1/communities`

**Expected Socket Emit:**

```json
{
  "event": "community:message:new",
  "data": {
    "id": "msg_system_001",
    "contentType": "SYSTEM",
    "systemMessageType": "COMMUNITY_CREATED",
    "systemMetadata": {
      "communityName": "Tech Team",
      "creatorId": "user_abc123",
      "creatorName": "Alice"
    },
    "content": {
      "text": "Alice created the community",
      "files": []
    },
    "message": "Alice created the community",
    "senderId": "user_abc123",
    "senderName": "Alice",
    "reactions": [],
    "parentMessageId": "",
    "quoteData": null,
    "serverTs": 1750000000000
  }
}
```

**Expected REST Response (from history):**

```json
{
  "messages": [
    {
      "id": "msg_system_001",
      "contentType": "SYSTEM",
      "systemMessageType": "COMMUNITY_CREATED",
      "systemMetadata": {
        "communityName": "Tech Team",
        "creatorId": "user_abc123",
        "creatorName": "Alice"
      },
      "message": "Alice created the community",
      "senderId": "user_abc123",
      "senderName": "Alice"
    }
  ]
}
```

---

### Test 2: COMMUNITY_UPDATED

**Trigger:** Update community name via `PATCH /api/v1/communities/{id}`

**Expected Socket Emit:**

```json
{
  "event": "community:message:new",
  "data": {
    "id": "msg_system_002",
    "contentType": "SYSTEM",
    "systemMessageType": "COMMUNITY_UPDATED",
    "systemMetadata": {
      "updaterId": "user_xyz789",
      "updaterName": "Bob",
      "changedFields": ["name"],
      "newName": "DevOps Hub"
    },
    "content": {
      "text": "Bob updated the community name",
      "files": []
    },
    "message": "Bob updated the community name"
  }
}
```

---

### Test 3: MEMBER_ROLE_CHANGED

**Trigger:** Promote member via `PATCH /api/v1/communities/{id}/members/{userId}/role`

**Expected Socket Emit:**

```json
{
  "event": "community:message:new",
  "data": {
    "id": "msg_system_003",
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
      "text": "Admin promoted John to MODERATOR",
      "files": []
    },
    "message": "Admin promoted John to MODERATOR"
  }
}
```

---

### Test 4: Immutability Guard

**Trigger:** Try to react to system message

```bash
curl -X POST http://localhost:8000/api/v1/messages/msg_system_001/react \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"emoji":"👍"}'
```

**Expected Response:**

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "CHAT_SYSTEM_MESSAGE_IMMUTABLE"
}
```

---

## Rollback Plan

If system messages need to be disabled:

1. **Backend:** Remove `publishCommunitySystemMessageForChatSafe()` calls from `community.service.ts` (3 call sites)
2. **Consumer:** Disable `case "community.system_message"` in `CommunityRoomSyncConsumer`
3. **Frontend:** No changes needed — system messages will simply stop appearing

**No database migration needed** — the schema fields remain (nullable, unused).

---

## FAQ

**Q: Will old messages break?**  
A: No. Existing `TEXT`, `IMAGE`, `VIDEO` messages are unchanged. System messages are purely additive.

**Q: Can I ignore system messages in my FE code?**  
A: Technically yes, but they'll appear in the chat history silently. We recommend rendering them as read-only system pills.

**Q: What if a user's name changes after a system message is created?**  
A: The system message stores the name snapshot at creation time (`creatorName`, `updaterName`, `actorName`, `targetName`). Historical accuracy is preserved.

**Q: Why can't system messages be edited?**  
A: They're immutable lifecycle records, not user-generated chat. Editing would break the audit trail.

**Q: Are system messages searchable?**  
A: Currently, no. They flow through the normal chat pipeline but are not indexed by search. This is a Phase 2 feature.

---

## Support

- **Full Spec:** `docs/COMMUNITY_SYSTEM_MESSAGES.md`
- **Implementation Notes:** `docs/IMPLEMENTATION-NOTES.md`
- **Socket Contract:** `docs/SOCKET_EVENTS.md`
- **Backend Tests:** `apps/chat-service/tests/` (Jest suite)
