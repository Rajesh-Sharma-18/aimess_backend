# AIMess — Frontend Community Chat Integration Guide

> **Audience:** Frontend and mobile developers integrating AIMess Community Chat.
>
> **Scope:** This document is generated directly from the backend codebase (gateway routing, microservice controllers, Zod validator schemas, Redis adapters, and the AsyncAPI spec). It covers Socket.IO namespaces, REST fallback routes, payload schemas, error structures, reconnection logic, and media upload flows.
>
> **Source Files Reference:**
>
> - Gateway Socket Namespaces: [community.ns.ts](file:///c:/Users/Windows/Documents/Rajesh/aimess_backend/apps/api-gateway/src/sockets/namespaces/community.ns.ts)
> - Chat Service Community Routes: [community.routes.ts](file:///c:/Users/Windows/Documents/Rajesh/aimess_backend/apps/chat-service/src/api/routes/community.routes.ts)
> - Community Service API Routes: [community.routes.ts](file:///c:/Users/Windows/Documents/Rajesh/aimess_backend/apps/community-service/src/api/routes/community.routes.ts)
> - AsyncAPI Specification: [asyncapi.yaml](file:///c:/Users/Windows/Documents/Rajesh/aimess_backend/apps/api-gateway/asyncapi/asyncapi.yaml)
> - Message Serializer: [chat-message.serializer.ts](file:///c:/Users/Windows/Documents/Rajesh/aimess_backend/apps/chat-service/src/lib/chat-message.serializer.ts)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Phase 1: Socket Event Audit](#2-phase-1-socket-event-audit)
3. [Phase 2: API Audit (REST)](#3-phase-2-api-audit-rest)
4. [Phase 3: Step-by-Step Community Chat Lifecycle](#4-phase-3-step-by-step-community-chat-lifecycle)
5. [Phase 4: Message Send Flow](#5-phase-4-message-send-flow)
6. [Phase 5: Reply Flow](#6-phase-5-reply-flow)
7. [Phase 6: Reaction Flow](#7-phase-6-reaction-flow)
8. [Phase 7: Edit Message Flow](#8-phase-7-edit-message-flow)
9. [Phase 8: Delete Message Flow](#9-phase-8-delete-message-flow)
10. [Phase 9: Read Receipt Flow](#10-phase-9-read-receipt-flow)
11. [Phase 10: Typing Indicator Flow](#11-phase-10-typing-indicator-flow)
12. [Phase 11: Media Flow (Upload & Reference)](#12-phase-11-media-flow-upload--reference)
13. [Phase 12: Reconnection & Message Sync Flow](#13-phase-12-reconnection--message-sync-flow)
14. [Phase 13: Error Handling & Payloads](#14-phase-13-error-handling--payloads)
15. [Phase 14: Contract Consistency Review & Mismatch Report](#15-phase-14-contract-consistency-review--mismatch-report)

---

## 1. Architecture Overview

AIMess utilizes a microservice architecture fronted by an **API Gateway**. The gateway acts as the reverse proxy for HTTP requests and terminates all real-time Socket.IO connections.

```
                       ┌─────────────────────────────────────────┐
                       │                Frontend                 │
                       └────┬───────────────────────────────┬────┘
                            │                               │
                            │ REST (JSON HTTP)              │ Socket.IO (namespaces)
                            │                               │
                            ▼                               ▼
                 ┌─────────────────────────────────────────────────────┐
                 │                     API Gateway                     │
                 └──────┬───────────────┬───────────────┬───────┬──────┘
                        │               │               │       │
                        │ gRPC          │ gRPC          │ gRPC  │ gRPC
                        ▼               ▼               ▼       ▼
               ┌───────────────┐┌───────────────┐┌─────────────┐┌─────────────┐
               │ community-srv ││   chat-srv    ││  media-srv  ││  other srvs │
               └───────────────┘└───────┬───────┘└─────────────┘└─────────────┘
                                        │ Redis Pub/Sub (Event Fan-out)
                                        ▼
                                ┌───────────────┐
                                │ Redis Cluster │
                                └───────────────┘
```

### Key Connectivity Details

- **REST Base Path:** `https://<gateway-host>/api/v1`
- **Socket.IO Base Path:** `wss://<gateway-host>/socket.io/` (namespaces: `/chat`, `/community`, `/notify`)
- **Community Connection:** Handled over the `/community` socket namespace.
- **Inbox and List Bumps:** Community activity list bumps (`community:updated` event) are delivered on the `/chat` namespace to the user's personal room (`user:<userId>`). Thus, clients must connect to both namespaces to receive complete UI updates.
- **Object-Key Media Model:** Media bytes are never transferred through sockets or the API Gateway. The frontend requests a presigned upload URL (`POST /api/v1/media/upload-url`), uploads raw bytes directly to storage using `PUT`, and references the item using its `objectKey`. Presigned read URLs are dynamically resolved when reading chat history or receiving socket broadcasts ("resolve-on-read").

---

## 2. Phase 1: Socket Event Audit

The following table lists every real-time event under the Socket.IO `/community` namespace (and user list bumps on `/chat`).

| Event Name                       | Direction       | Purpose                                | Payload DTO / Schema            | Response / Ack DTO                                                                              |
| :------------------------------- | :-------------- | :------------------------------------- | :------------------------------ | :---------------------------------------------------------------------------------------------- |
| `community:join`                 | Client → Server | Joins Socket room for a community      | `CommunityJoinPayload`          | `AckEnvelope` (Empty success)                                                                   |
| `community:leave`                | Client → Server | Leaves Socket room for a community     | `CommunityRef`                  | `AckEnvelope` (Empty success)                                                                   |
| `community:message:send`         | Client → Server | Sends a message into a community       | `CommunityMessageSendPayload`   | `AckEnvelope` with `CommunityMessageSendResult`                                                 |
| `community:messages:fetch`       | Client → Server | Socket-based message history query     | `CommunityMessagesFetchPayload` | `AckEnvelope` with `{ messages: CommunityMessageDto[], nextCursor?: string, hasMore: boolean }` |
| `community:message:react`        | Client → Server | Toggles reaction on a message          | `CommunityMessageReactPayload`  | `AckEnvelope` with `CommunityMessageReactionPayload`                                            |
| `community:catchup`              | Client → Server | Gap-fill sync after reconnection       | `CommunityCatchupPayload`       | `AckEnvelope` with `{ rooms: CatchupRoomStatus[] }`                                             |
| `community:message:edit`         | Client → Server | Edits an owned message (text-only)     | `CommunityMessageEditPayload`   | `AckEnvelope` with `CommunityMessageEditedPayload`                                              |
| `community:message:delete`       | Client → Server | Deletes a message (forEveryone/forMe)  | `CommunityMessageDeletePayload` | `AckEnvelope` with `CommunityMessageDeletedPayload`                                             |
| `community:message:pin`          | Client → Server | Pins a message (mod/admin only)        | `CommunityMessagePinPayload`    | `AckEnvelope` with `CommunityMessagePinnedPayload`                                              |
| `community:message:unpin`        | Client → Server | Unpins a message (mod/admin only)      | `CommunityMessageUnpinPayload`  | `AckEnvelope` with `CommunityMessageUnpinnedPayload`                                            |
| `typing:start`                   | Client → Server | Indicates typing start (no ack)        | `CommunityTypingRequest`        | None (Fire-and-forget)                                                                          |
| `typing:stop`                    | Client → Server | Indicates typing stop (no ack)         | `CommunityTypingRequest`        | None (Fire-and-forget)                                                                          |
| `community.member.kick`          | Client → Server | Kicks a member (mod/admin only)        | `KickMemberSchema`              | `AckEnvelope` (Empty success)                                                                   |
| `community.member.ban`           | Client → Server | Bans a member (mod/admin only)         | `BanMemberSchema`               | `AckEnvelope` (Empty success)                                                                   |
| `community.member.unban`         | Client → Server | Unbans a member (mod/admin only)       | `UnbanMemberSchema`             | `AckEnvelope` (Empty success)                                                                   |
| `community.admin.transfer`       | Client → Server | Transfers ownership (owner only)       | `TransferAdminSchema`           | `AckEnvelope` (Empty success)                                                                   |
| `community.member.role_change`   | Client → Server | Changes role of a member (admin/mod)   | `ChangeMemberRoleSchema`        | `AckEnvelope` (Empty success)                                                                   |
| `community.report.create`        | Client → Server | Reports message/community content      | `CreateReportSchema`            | `AckEnvelope` (Empty success)                                                                   |
| `community.delete`               | Client → Server | Hard-deletes community (admin only)    | `DeleteCommunitySchema`         | `AckEnvelope` (Empty success)                                                                   |
| **`community:message:new`**      | Server → Client | Broadcast of a new room message        | None                            | `CommunityMessageNewPayload`                                                                    |
| **`community:message:edited`**   | Server → Client | Broadcast of edited text content       | None                            | `CommunityMessageEditedPayload`                                                                 |
| **`community:message:deleted`**  | Server → Client | Broadcast of deleted tombstone         | None                            | `CommunityMessageDeletedPayload`                                                                |
| **`community:message:reaction`** | Server → Client | Broadcast of reaction list refresh     | None                            | `CommunityMessageReactionPayload`                                                               |
| **`community:message:pinned`**   | Server → Client | Broadcast of pinned list changes       | None                            | `CommunityMessagePinnedPayload`                                                                 |
| **`community:message:unpinned`** | Server → Client | Broadcast of unpinned list changes     | None                            | `CommunityMessageUnpinnedPayload`                                                               |
| **`community:catchup:result`**   | Server → Client | Missed events for a single room        | None                            | `CommunityCatchupResultPayload`                                                                 |
| **`community.deleted`**          | Server → Client | Broadcast that community was deleted   | None                            | `{ communityId: string, deletedBy: string }`                                                    |
| **`typing:start`**               | Server → Client | Broadcast that a member is typing      | None                            | `TypingBroadcastPayload`                                                                        |
| **`typing:stop`**                | Server → Client | Broadcast that a member stopped typing | None                            | `TypingBroadcastPayload`                                                                        |
| **`community:member:joined`**    | Server → Client | Broadcast that a user joined (stubbed) | None                            | `CommunityMemberDTO` (V2 reserved)                                                              |
| **`community:updated`**          | Server → Client | Inbox list item bump (on `/chat`)      | None                            | `CommunityUpdatedPayload`                                                                       |

---

## 3. Phase 2: API Audit (REST)

Protected endpoints require a valid access token in the `Authorization: Bearer <JWT>` header.

### 3.1 Community Profile & Management APIs

Mounted under `/api/v1/communities/*` (routed to `community-service`):

| Endpoint                                            | Method   | Purpose                             | Request DTO / Params          | Response DTO                                                   |
| :-------------------------------------------------- | :------- | :---------------------------------- | :---------------------------- | :------------------------------------------------------------- |
| `/communities`                                      | `POST`   | Creates a new community             | `createCommunitySchema`       | `CommunityResponseData`                                        |
| `/communities/:id`                                  | `GET`    | Fetches community profile info      | None                          | `CommunityResponseData`                                        |
| `/communities/:id`                                  | `PATCH`  | Updates community details           | `updateCommunitySchema`       | `CommunityResponseData`                                        |
| `/communities/:id`                                  | `DELETE` | Hard-deletes community (admin only) | None                          | `{ success: true, message: string }`                           |
| `/communities/categories`                           | `GET`    | Lists available categories          | None                          | `{ success: true, data: Category[] }`                          |
| `/communities/name-available`                       | `GET`    | Verifies name is not taken          | `nameAvailableQuerySchema`    | `{ success: true, data: { available: boolean } }`              |
| `/communities/handle-available`                     | `GET`    | Verifies handle is not taken        | `handleAvailableQuerySchema`  | `{ success: true, data: { available: boolean } }`              |
| `/communities/mine`                                 | `GET`    | Lists user's joined communities     | `myCommunitiesQuerySchema`    | `{ success: true, data: Community[], pagination: Pagination }` |
| `/communities/discover`                             | `GET`    | Searches/browses public rooms       | `discoverQuerySchema`         | `{ success: true, data: Community[] }`                         |
| `/communities/:id/members`                          | `GET`    | Lists community member details      | `listMembersQuerySchema`      | `{ success: true, data: Member[] }`                            |
| `/communities/:id/members`                          | `POST`   | Invites/adds members in bulk        | `addMembersSchema`            | `{ success: true, message: string }`                           |
| `/communities/:id/leave`                            | `POST`   | Voluntarily leaves the community    | `leaveReasonSchema`           | `{ success: true, message: string }`                           |
| `/communities/:id/like`                             | `POST`   | Likes a community                   | None                          | `{ success: true, message: string }`                           |
| `/communities/:id/like`                             | `DELETE` | Removes a community like            | None                          | `{ success: true, message: string }`                           |
| `/communities/:id/join`                             | `POST`   | Joins a public/open community       | None                          | `{ success: true, joined: boolean }`                           |
| `/communities/:id/join-requests`                    | `POST`   | Requests to join private community  | `createJoinRequestSchema`     | `{ success: true, data: JoinRequest }`                         |
| `/communities/:id/join-requests`                    | `GET`    | Lists requests (mod/admin only)     | `listJoinRequestsQuerySchema` | `{ success: true, data: JoinRequest[] }`                       |
| `/communities/:id/join-requests/:requestId/approve` | `POST`   | Approves a join request (mod+)      | None                          | `{ success: true }`                                            |
| `/communities/:id/join-requests/:requestId/reject`  | `POST`   | Rejects a join request (mod+)       | None                          | `{ success: true }`                                            |
| `/communities/:id/invites`                          | `POST`   | Sends direct member invite (mod+)   | `createInviteSchema`          | `{ success: true, data: Invite }`                              |
| `/communities/:id/invites`                          | `GET`    | Lists pending invites (mod+)        | `listInvitesQuerySchema`      | `{ success: true, data: Invite[] }`                            |
| `/communities/:id/invite-links`                     | `POST`   | Generates a join invite link        | `createInviteLinkSchema`      | `{ success: true, data: InviteLink }`                          |
| `/communities/:id/invite-links`                     | `GET`    | Lists active invite links           | `listInviteLinksQuerySchema`  | `{ success: true, data: InviteLink[] }`                        |
| `/communities/:id/invite-links/:linkId`             | `DELETE` | Revokes a join invite link          | None                          | `{ success: true }`                                            |
| `/communities/invite-links/:code/redeem`            | `POST`   | Redeems invite link to join         | None                          | `{ success: true, data: { communityId: string } }`             |
| `/communities/:id/mute`                             | `GET`    | Fetches user mute setting           | None                          | `{ success: true, data: MuteSetting }`                         |
| `/communities/:id/mute`                             | `PUT`    | Mutes community notifications       | `setMuteSchema`               | `{ success: true, data: MuteSetting }`                         |
| `/communities/:id/mute`                             | `DELETE` | Unmutes community notifications     | None                          | `{ success: true }`                                            |
| `/communities/:id/notification-preferences`         | `GET`    | Fetches notification settings       | None                          | `{ success: true, data: NotificationPrefs }`                   |
| `/communities/:id/notification-preferences`         | `PUT`    | Saves notification settings         | `setNotificationPrefsSchema`  | `{ success: true, data: NotificationPrefs }`                   |
| `/communities/:id/members/:userId/role`             | `PUT`    | Assigns roles (admin only)          | `updateMemberRoleSchema`      | `{ success: true }`                                            |
| `/communities/:id/members/:userId`                  | `DELETE` | Kicks a member (mod+)               | `moderationReasonSchema`      | `{ success: true }`                                            |
| `/communities/:id/members/:userId/ban`              | `POST`   | Bans a member (mod+)                | `moderationReasonSchema`      | `{ success: true }`                                            |
| `/communities/:id/members/:userId/ban`              | `DELETE` | Unbans a member (mod+)              | None                          | `{ success: true }`                                            |
| `/communities/:id/members/:userId/mute`             | `POST`   | Mutes member chat permissions       | `setMemberMuteSchema`         | `{ success: true }`                                            |
| `/communities/:id/members/:userId/mute`             | `DELETE` | Unmutes member chat permissions     | None                          | `{ success: true }`                                            |
| `/communities/:id/members/:userId/warn`             | `POST`   | Logs formal warning to member       | `warnMemberSchema`            | `{ success: true }`                                            |
| `/communities/:id/members/:userId/warnings`         | `GET`    | Lists member warnings               | `warningsQuerySchema`         | `{ success: true, data: Warning[] }`                           |
| `/communities/:id/reports`                          | `POST`   | Reports community violations        | `createReportSchema`          | `{ success: true, data: Report }`                              |
| `/communities/:id/reports`                          | `GET`    | Lists reports (mod/admin only)      | `listReportsQuerySchema`      | `{ success: true, data: Report[] }`                            |
| `/communities/:id/reports/:reportId/review`         | `POST`   | Flags report under-review (mod+)    | `reportResolutionSchema`      | `{ success: true }`                                            |
| `/communities/:id/reports/:reportId/action`         | `POST`   | Resolves report with action (mod+)  | `reportResolutionSchema`      | `{ success: true }`                                            |
| `/communities/:id/reports/:reportId/dismiss`        | `POST`   | Dismisses false report (mod+)       | `reportResolutionSchema`      | `{ success: true }`                                            |
| `/communities/:id/reports/:reportId/withdraw`       | `POST`   | Creator withdraws open report       | None                          | `{ success: true }`                                            |
| `/communities/:id/reports/:reportId`                | `DELETE` | Permanently deletes log (mod+)      | None                          | `{ success: true }`                                            |

### 3.2 Community Chat & Messaging APIs

Mounted under `/api/v1/chat/community/*` (routed to `chat-service`):

| Endpoint                                        | Method   | Purpose                               | Request DTO / Query                | Response DTO                                               |
| :---------------------------------------------- | :------- | :------------------------------------ | :--------------------------------- | :--------------------------------------------------------- |
| `/chat/community/rooms`                         | `GET`    | Lists chat rooms caller is in         | None                               | `{ success: true, data: GeneralRoom[] }`                   |
| `/chat/community/rooms/:roomId/messages`        | `GET`    | Message history (backward pagination) | `communityTimelineQuerySchema`     | `PaginatedResponse<CommunityMessageDto>`                   |
| `/chat/community/rooms/:roomId/messages`        | `POST`   | REST Fallback: Send message           | `sendCommunityMessageBodySchema`   | `{ success: true, data: CommunityMessageSendResult }`      |
| `/chat/community/rooms/:roomId/sync`            | `GET`    | Mutation catchup (forward page)       | `communitySyncQuerySchema`         | `PaginatedResponse<CommunityCatchupEventDto>`              |
| `/chat/community/messages/:messageId`           | `PATCH`  | REST Fallback: Edit own text message  | `editCommunityMessageSchema`       | `{ success: true, data: CommunityMessageEditedPayload }`   |
| `/chat/community/messages/:messageId`           | `DELETE` | REST Fallback: Delete message         | None                               | `{ success: true, data: CommunityMessageDeletedPayload }`  |
| `/chat/community/messages/:messageId/react`     | `POST`   | REST Fallback: Toggle reaction        | `reactCommunityMessageBodySchema`  | `{ success: true, data: CommunityMessageReactionPayload }` |
| `/chat/community/rooms/:roomId/pins`            | `GET`    | Lists pinned messages in room         | None                               | `{ success: true, data: PinnedMessage[] }`                 |
| `/chat/community/rooms/:roomId/pins`            | `POST`   | REST Fallback: Pin message            | `pinCommunityMessageSchema`        | `{ success: true, data: CommunityMessagePinnedPayload }`   |
| `/chat/community/rooms/:roomId/pins/:messageId` | `DELETE` | REST Fallback: Unpin message          | `unpinCommunityMessageQuerySchema` | `{ success: true, data: CommunityMessageUnpinnedPayload }` |
| `/chat/community/rooms/:roomId/read`            | `POST`   | Marks community room read (coarse)    | `markCommunityReadBodySchema`      | `{ success: true, message: string }`                       |

### 3.3 Central Media APIs

Mounted under `/api/v1/media/*` (routed to `media-service`):

| Endpoint                    | Method   | Purpose                        | Request Body         | Response Body                        |
| :-------------------------- | :------- | :----------------------------- | :------------------- | :----------------------------------- |
| `/media/upload-url`         | `POST`   | Get presigned upload URL & key | `UploadUrlRequest`   | `UploadUrlResponse`                  |
| `/media/download-url`       | `POST`   | Re-sign GET URL for key        | `DownloadUrlRequest` | `DownloadUrlResponse`                |
| `/media/uploads/:objectKey` | `DELETE` | Clean up / cancel file upload  | None                 | `{ success: true, message: string }` |

---

## 4. Phase 3: Step-by-Step Community Chat Lifecycle

Below is the execution flow from discovery to active chat.

```
  Frontend                     Gateway / Services               Socket Gateway
     │                                 │                               │
     │ 1. GET /communities/discover    │                               │
     ├────────────────────────────────>│                               │
     │ <── Community[]                 │                               │
     │                                 │                               │
     │ 2. POST /communities/:id/join   │                               │
     ├────────────────────────────────>│                               │
     │ <── { success: true }           │                               │
     │                                 │                               │
     │ 3. Connect socket namespace "/community"                        │
     ├────────────────────────────────────────────────────────────────>│
     │ <── Handshake OK ("connect" event)                              │
     │                                 │                               │
     │ 4. Emit: community:join { communityId, roomId }                 │
     ├────────────────────────────────────────────────────────────────>│
     │ <── Ack: SOCKET_COMMUNITY_JOINED                                │
     │                                 │                               │
     │ 5. GET .../community/rooms/:roomId/messages                     │
     ├────────────────────────────────>│                               │
     │ <── Paginated messages          │                               │
     │                                 │                               │
     │ 6. (Active chat state: listen to room events)                   │
     │    [community:message:new, typing:start, react, edit, delete...]│
```

### STEP 1: Discover and Search Communities

Find public communities to join.

- **API:** `GET /api/v1/communities/discover`
- **Query Params:**
  - `q`: Search query string (optional, min 1)
  - `categoryId`: Category identifier (optional)
- **Response Payload (`200 OK`):**

```json
{
  "success": true,
  "data": [
    {
      "id": "6843e1a2b5c3d4e5f6a7b8c9",
      "name": "Design Guild",
      "handle": "design-guild",
      "description": "A place for design professionals.",
      "avatarUrl": "https://cdn.aimess.com/community/avatar/logo.png",
      "memberCount": 142,
      "isPublic": true,
      "categoryId": "cat_123"
    }
  ]
}
```

### STEP 2: Join the Community

Submit membership to gain access.

- **API:** `POST /api/v1/communities/:id/join`
- **Response Payload (`200 OK`):**

```json
{
  "success": true,
  "message": "Successfully joined community",
  "joined": true
}
```

> [!NOTE]
> For private communities, this API triggers a request and returns `joined: false`. The user must wait for a moderator to approve. Alternatively, clients can request a join request log via `POST /api/v1/communities/:id/join-requests`.

### STEP 3: Connect to the Socket.IO Namespaces

Establish Socket.IO connections.

1. Connect to `/community` namespace (handles message sending, typing indicators, pins, edits, deletes).
2. Connect to `/chat` namespace (receives `community:updated` list bumps).

- **Handshake Config:**

```js
const token = "eyJhbGciOiJIUzI1Ni..."; // JWT

const communitySocket = io(
  "wss://aimess.api.vasundharasolutions.com/community",
  {
    path: "/socket.io/",
    auth: { token },
    transports: ["websocket"],
  }
);

const chatSocket = io("wss://aimess.api.vasundharasolutions.com/chat", {
  path: "/socket.io/",
  auth: { token },
  transports: ["websocket"],
});
```

### STEP 4: Join the Socket Room

Once connected, notify the server to join the specific community namespace room. Sockets that do not emit this will not receive room broadcasts.

- **Emit event:** `community:join`
- **Payload:**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9"
}
```

- **Ack Callback Response:**

```json
{
  "success": true,
  "message": "Successfully joined community socket room"
}
```

### STEP 5: Fetch Messages (Chat History)

Fetch the timeline before rendering real-time events.

- **API:** `GET /api/v1/chat/community/rooms/:roomId/messages`
- **Query Params:**
  - `limit`: Page count (optional, default `30`, max `100`)
  - `before_ts`: ISO 8601 UTC string (optional, pages backward)
- **Response Payload (`200 OK`):**

```json
{
  "success": true,
  "message": "Messages fetched successfully",
  "data": {
    "data": [
      {
        "id": "683abc123def456789012345",
        "messageId": "683abc123def456789012345",
        "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
        "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
        "senderId": "user_abc123",
        "senderName": "Alice",
        "senderAvatar": "https://cdn.aimess.com/avatars/alice.jpg",
        "contentType": "TEXT",
        "content": {
          "text": "Hello world! 👋"
        },
        "reactions": [],
        "parentMessageId": "",
        "serverTs": 1749465231234,
        "sentAt": 1749465231234
      }
    ],
    "pagination": {
      "limit": 30,
      "nextCursor": "2025-06-15T11:45:00.000Z",
      "hasMore": true
    }
  }
}
```

### STEP 6: Close Session (Graceful Exit)

Emit leave events when closing a chat thread.

- **Emit event:** `community:leave`
- **Payload:**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9"
}
```

---

## 5. Message Send Flow

Sends a message into the community thread. Sockets require the handshake to have passed auth; the server injects the authoritative `senderId` and user details.

### 5.1 Socket Flow (Preferred)

- **Emit event:** `community:message:send`
- **Payload DTO (`CommunityMessageSendPayload`):**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440010",
  "contentType": "TEXT",
  "message": "Good morning team!"
}
```

- **Success Ack callback:**

```json
{
  "success": true,
  "message": "Message sent successfully",
  "data": {
    "messageId": "683abc123def456789012345",
    "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
    "sentAt": 1749465231234,
    "alreadySent": false
  }
}
```

> [!TIP]
> The `clientMessageId` is an idempotency key. If a send fails due to network loss, re-emitting the same payload with the same `clientMessageId` triggers idempotency checks. The server will safely ignore the write and return `alreadySent: true` instead of creating duplicates.

- **Broadcast push (`community:message:new` event) emitted to the room:**

```json
{
  "id": "683abc123def456789012345",
  "messageId": "683abc123def456789012345",
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "senderId": "user_abc123",
  "senderName": "Alice",
  "senderAvatar": "https://cdn.aimess.com/avatars/alice.jpg",
  "contentType": "TEXT",
  "content": {
    "text": "Good morning team!",
    "files": []
  },
  "message": "Good morning team!",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440010",
  "reactions": [],
  "serverTs": 1749465231234,
  "sentAt": 1749465231234
}
```

### 5.2 REST Fallback API

Use this if the Socket connection is offline or restricted.

- **API:** `POST /api/v1/chat/community/rooms/:roomId/messages`
- **Request DTO (`sendCommunityMessageBodySchema`):**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "message": "Good morning team!",
  "messageType": "text",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440010"
}
```

> [!WARNING]
> **Contract Mismatch (REST request vs Socket emit):**
> Notice that the REST body uses **`messageType`** (lower-case value expected, e.g. `"text"`, `"image"`) instead of **`contentType`** (UPPER-CASE value expected, e.g. `"TEXT"`, `"IMAGE"`). Sockets expect `contentType`. Ensure your serializers map these correctly depending on the channel.

- **Response Payload (`200 OK`):**

```json
{
  "success": true,
  "data": {
    "messageId": "683abc123def456789012345",
    "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
    "sentAt": 1749465231234
  }
}
```

### 5.3 Error Cases

- **Invalid Body (`400 Bad Request` or `INVALID_PAYLOAD` socket error):** Body fails Zod gate. Message is omitted, content type is unsupported, or text exceeds 4000 characters.
- **Forbidden Member (`FORBIDDEN`):** User is not a member of this community, or has been muted/banned.
- **Rate Limited (`RATE_LIMITED`):** Senders are throttled to **30 messages / min**. Wait for the back-off window before retrying.

---

## 6. Reply Flow

Replies reference a parent message. The parent details are snapshotted in `quoteData` to ensure replies can still render even if the parent message gets deleted.

```
       [ Parent Message ] <─── (messageId: "683abc123def456789012345")
              ▲
              │ parentMessageId / repliedToId
              │
       [ Reply Message  ] ─── (quoteData contains snapshot of parent text/sender)
```

### 6.1 Socket Flow

- **Emit event:** `community:message:send`
- **Payload:**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440013",
  "contentType": "TEXT",
  "message": "Thanks for clarifying!",
  "parentMessageId": "683abc123def456789012345"
}
```

- **Success Broadcast (`community:message:new` event):**

```json
{
  "id": "683abc123def456789012399",
  "messageId": "683abc123def456789012399",
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "senderId": "user_def456",
  "senderName": "Bob",
  "contentType": "TEXT",
  "content": {
    "text": "Thanks for clarifying!"
  },
  "parentMessageId": "683abc123def456789012345",
  "quoteData": {
    "messageId": "683abc123def456789012345",
    "senderId": "user_abc123",
    "senderName": "Alice",
    "messageType": "TEXT",
    "preview": "Good morning team!",
    "isDeleted": false
  },
  "serverTs": 1749465245000,
  "sentAt": 1749465245000
}
```

### 6.2 REST Fallback API

- **API:** `POST /api/v1/chat/community/rooms/:roomId/messages`
- **Request DTO:**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "message": "Thanks for clarifying!",
  "messageType": "text",
  "parentMessageId": "683abc123def456789012345"
}
```

---

## 7. Reaction Flow

Reactions add or remove an emoji. Re-sending the same emoji toggles it off (deletes the reaction).

### 7.1 Socket Flow

- **Emit event:** `community:message:react`
- **Payload DTO (`CommunityMessageReactPayload`):**

```json
{
  "messageId": "683abc123def456789012345",
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "emoji": "👍"
}
```

- **Success Ack response data:**

```json
{
  "success": true,
  "message": "Reaction updated successfully",
  "data": {
    "messageId": "683abc123def456789012345",
    "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
    "reactions": [
      {
        "emoji": "👍",
        "count": 1,
        "users": [
          {
            "userId": "user_abc123",
            "displayName": "Alice",
            "avatar": "https://cdn.aimess.com/avatars/alice.jpg"
          }
        ]
      }
    ]
  }
}
```

- **Broadcast push (`community:message:reaction` event) emitted to the room:**

```json
{
  "messageId": "683abc123def456789012345",
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "reactions": [
    {
      "emoji": "👍",
      "count": 1,
      "users": [
        {
          "userId": "user_abc123",
          "displayName": "Alice",
          "avatar": "https://cdn.aimess.com/avatars/alice.jpg"
        }
      ]
    }
  ]
}
```

> [!IMPORTANT]
> **Broadcast Rule:** Reaction broadcasts carry the **complete, updated reaction group list** for the message. The frontend must replace its local reaction list for the message entirely with this new payload rather than performing delta merges.

### 7.2 REST Fallback API

- **API:** `POST /api/v1/chat/community/messages/:messageId/react`
- **Request DTO (`reactCommunityMessageBodySchema`):**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "emoji": "👍"
}
```

- **Response Payload (`200 OK`):**
  Matches the socket reaction broadcast structure (complete state).

### 7.3 Rate Limits

Reactions are capped at **10 requests / min** per room. Exceeding this returns a `RATE_LIMITED` error code.

---

## 8. Edit Message Flow

Allows updating the text content of a message.

- **Enforced Validation Rules:**
  - Only text-only messages are editable.
  - Only the original sender may edit their message.
  - Enforced edit window: **15 minutes** from generation.

### 8.1 Socket Flow

- **Emit event:** `community:message:edit`
- **Payload DTO (`CommunityMessageEditPayload`):**

```json
{
  "messageId": "683abc123def456789012345",
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "content": {
    "text": "Good morning team! (edited text)"
  }
}
```

- **Success Broadcast (`community:message:edited` event):**

```json
{
  "messageId": "683abc123def456789012345",
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "senderId": "user_abc123",
  "message": "Good morning team! (edited text)",
  "contentType": "TEXT",
  "editedAt": 1749465999000
}
```

### 8.2 REST Fallback API

- **API:** `PATCH /api/v1/chat/community/messages/:messageId`
- **Request DTO:**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "content": {
    "text": "Good morning team! (edited text)"
  }
}
```

- **Response Payload:** Same as socket broadcast.

---

## 9. Delete Message Flow

Removes a message. Supports two delete paradigms:

1. `forEveryone` — Soft-deletes the message for all room participants. Original body is scrubbed and replaced with a tombstone. Allowed for the message sender, community moderators, and administrators.
2. `forMe` — Locally hides the message for the caller only. No socket broadcast is fanned out.

### 9.1 Socket Flow

- **Emit event:** `community:message:delete`
- **Payload DTO (`CommunityMessageDeletePayload`):**

```json
{
  "messageId": "683abc123def456789012345",
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "type": "forEveryone"
}
```

- **Success Broadcast (`community:message:deleted` event):**

```json
{
  "messageId": "683abc123def456789012345",
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "deleteType": "forEveryone",
  "deletedBy": "user_abc123"
}
```

> [!IMPORTANT]
> **Tombstone Behavior:** On receiving `community:message:deleted` for `forEveryone`, the client application must remove the message body, scrub any media files, hide attachments, and render a placeholder bubble: _"This message was deleted."_

### 9.2 REST Fallback API

- **API:** `DELETE /api/v1/chat/community/messages/:messageId`
- **Query Params:**
  - `type`: `"forEveryone"` or `"forMe"` (optional, default `"forMe"`)
- **Response Payload (`200 OK`):**
  Same as socket broadcast (forEveryone case).

---

## 10. Read Receipt Flow

Marks a room read.
Unlike private chats which have high-resolution read events (`message:read`), community read receipts are coarse. They advance the user's read pointer in the DB but **do not broadcast read indicators** to other peers to prevent broadcast storms.

### 10.1 Coarse Read API

- **API:** `POST /api/v1/chat/community/rooms/:roomId/read`
- **Request DTO (`markCommunityReadBodySchema`):**

```json
{
  "upToMessageId": "683abc123def456789012345"
}
```

- **Response Payload (`200 OK`):**

```json
{
  "success": true,
  "message": "Community room marked read"
}
```

---

## 11. Typing Indicator Flow

Real-time typing alerts. Since this is high-frequency, events are fire-and-forget (no socket callback is sent, no retry mechanism).

```
   Typing Senders                                                Receivers
     │                                                             │
     │ 1. Emit typing:start { communityId }                        │
     ├───────────────────────────────────┐                         │
     │                                   ▼                         │
     │                            [Gateway Timer]                  │
     │                            Start 6s expiry                  │
     │                                   │                         │
     │                                   ├────────────────────────>│
     │                                   │ Broadcast typing:start  │
     │                                   │                         │
     │ 2. Emit typing:stop { communityId }                         │
     ├───────────────────────────────────┐                         │
     │                                   ▼                         │
     │                            Clear 6s timer                   │
     │                                   ├────────────────────────>│
     │                                   │ Broadcast typing:stop   │
```

### 11.1 Client Emit Details

Emitted every 3 to 5 seconds while actively typing.

- **Events:** `typing:start` and `typing:stop`
- **Payload DTO (`CommunityTypingRequest`):**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9"
}
```

### 11.2 Server Broadcast details

- **Broadcast Events:** `typing:start` and `typing:stop` on room `community:<communityId>`.
- **Payload (`TypingBroadcastPayload`):**

```json
{
  "conversationId": "6843e1a2b5c3d4e5f6a7b8c9",
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "userDetails": {
    "userId": "user_abc123",
    "username": "alice",
    "displayName": "Alice",
    "avatarUrl": "https://cdn.aimess.com/avatars/alice.jpg"
  },
  "timestamp": 1749465610000
}
```

> [!IMPORTANT]
> **Typing Expiry Invariant:**
> To prevent "stuck" typing states (due to crashes or network dropouts), the gateway holds a **6-second countdown** per connection. If no fresh `typing:start` is received within 6 seconds, the server will automatically broadcast a `typing:stop` event. On transport disconnect, all timers are flushed and stops are broadcast. Receivers should also implement a matching 6-second local cleanup timer.

---

## 12. Media Flow (Upload & Reference)

AIMess operates on an **object-key model**. Sockets and HTTP gateways never carry file bytes. All media types follow the exact same flow.

### 12.1 End-to-End Media Sequence

```
  Frontend                         Gateway / media-srv                MinIO Storage
     │                                     │                                │
     │ 1. POST /media/upload-url           │                                │
     ├────────────────────────────────────>│                                │
     │ <── { uploadUrl, objectKey, headers }                                │
     │                                     │                                │
     │ 2. PUT to uploadUrl with headers    │                                │
     ├─────────────────────────────────────┼───────────────────────────────>│
     │ <── HTTP 200 OK                     │                                │
     │                                     │                                │
     │ 3. Send message with objectKey      │                                │
     ├────────────────────────────────────>│                                │
     │                                     │ (resolves key to signed URL)   │
     │ <── Broadcast community:message:new │                                │
```

### 12.2 Detailed Steps

#### Step 1: Request presigned upload credentials

- **API:** `POST /api/v1/media/upload-url`
- **Request Payload:**

```json
{
  "category": "COMMUNITY_CHAT_ATTACHMENT",
  "contentType": "image/jpeg",
  "contentLength": 204800
}
```

- **Response Payload (`200 OK`):**

```json
{
  "success": true,
  "data": {
    "uploadUrl": "https://minio.vasundharasolutions.com/community-chat-uploads/6843e1/img_001.jpg?X-Amz-Signature=...",
    "objectKey": "community-chat-uploads/6843e1a2b5c3d4e5f6a7b8c9/img_001.jpg",
    "uploadExpiresIn": 900,
    "maxBytes": 104857600,
    "headers": {
      "Content-Type": "image/jpeg"
    },
    "media": {
      "downloadUrl": "https://minio.vasundharasolutions.com/community-chat-uploads/6843e1/img_001.jpg?X-Amz-Expires=3600&...",
      "downloadUrlExpiresIn": 3600
    }
  }
}
```

#### Step 2: Upload file bytes directly to storage

Perform a raw PUT request to the `uploadUrl`.

- **Headers:** Send **only** the returned headers object (i.e. `"Content-Type": "image/jpeg"`). Do **not** send the `Authorization` header here (causes signature mismatches).
- **Body:** Raw file bytes.

#### Step 3: Reference the objectKey in the message payload

Send the message containing the file meta-structure.

- **Socket event:** `community:message:send`
- **Payload:**

```json
{
  "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "contentType": "IMAGE",
  "message": "Check our roadmap!",
  "media": {
    "files": [
      {
        "objectKey": "community-chat-uploads/6843e1a2b5c3d4e5f6a7b8c9/img_001.jpg",
        "name": "roadmap.jpg",
        "size": 204800,
        "mime": "image/jpeg",
        "width": 1920,
        "height": 1080,
        "blurhash": "LKO2?U%2Tw=w]~RBVZRi};RPxuwH"
      }
    ]
  }
}
```

#### Step 4: Render resolved URLs (Receiver side)

Peers receive the broadcast containing a fresh, authenticated read URL (`url` key inside the `files` array). Render this `url` directly.

```json
{
  "contentType": "IMAGE",
  "content": {
    "text": "Check our roadmap!",
    "files": [
      {
        "objectKey": "community-chat-uploads/6843e1a2b5c3d4e5f6a7b8c9/img_001.jpg",
        "url": "https://minio.vasundharasolutions.com/community-chat-uploads/6843e1/img_001.jpg?X-Amz-Expires=3600...",
        "name": "roadmap.jpg",
        "size": 204800,
        "mime": "image/jpeg",
        "width": 1920,
        "height": 1080,
        "blurhash": "LKO2?U%2Tw=w]~RBVZRi};RPxuwH"
      }
    ]
  }
}
```

> [!CAUTION]
> **Presigned URL Expiry:** Presigned download URLs expire in **3600 seconds** (1 hour). If a user leaves the app open for a long period, rendering an old cached URL will result in an HTTP `403 Forbidden` from MinIO/S3. The frontend must fetch fresh message history or hit the download URL API `POST /api/v1/media/download-url` with the `objectKey` to acquire a fresh signature.

### 12.3 Message Types and Per-Type Metadata requirements

Ensure the correct metadata properties are populated on send:

- **TEXT:** Plain message body.
- **IMAGE:** `width`, `height`, `blurhash` (for instant placeholder).
- **VIDEO:** `width`, `height`, `durationMs`, `blurhash` (poster).
- **AUDIO:** `durationMs`.
- **VOICE:** `durationMs`, `waveform` (amplitude array, max 2048).
- **DOCUMENT:** `name`, `size`, `mime` (file chip preview).
- **STICKER:** `packId`, `stickerId`, `objectKey` inside the `sticker` node.
- **LOCATION:** `lat`, `lng`, `placeName`, `placeAddress` inside the `location` node.
- **CONTACT:** `name`, `phone`, `avatar`, `userId` inside the `contact` node.

---

## 13. Reconnection & Message Sync Flow

On Socket disconnect, the Socket.IO client automatically attempts reconnection.

### 13.1 State Recovery

- **Default state recovery:** The server retains rooms and events for **2 minutes** (`connectionStateRecovery`). If reconnection completes within this window, missed events are automatically delivered on the socket connection.
- **Manual Gap-Fill:** If the disconnection lasts longer than 2 minutes, the client must trigger the catchup sync.

### 13.2 Gap-fill Catchup Sync

Clients request missed messages across multiple room identifiers in a single batch. Up to **10 rooms** can be batched per socket request.

- **Emit Event:** `community:catchup`
- **Payload DTO (`CommunityCatchupPayload`):**
  Supports two mutually exclusive cursor strategies:

1. `sinceId` mode: Query using the last known message ID (MongoDB ObjectId). Returns new messages in chronological order.
2. `sinceTs` mode: Query using the highest `updatedAt` epoch-ms timestamp. Returns all mutations (new messages, text edits, deletes, and reactions) that occurred. **This is highly recommended when resuming from background.**

- **Example Payload (sinceTs Mode):**

```json
{
  "rooms": [
    {
      "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
      "sinceTs": 1749465000000,
      "limit": 100
    }
  ]
}
```

- **Aggregated Ack response:**

```json
{
  "success": true,
  "message": "Catchup sync completed",
  "data": {
    "rooms": [
      {
        "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
        "hasMore": false,
        "lastId": "683abc123def456789000004",
        "nextTs": 1749465210000,
        "authorized": true
      }
    ]
  }
}
```

- **Event Push (`community:catchup:result` event) pushed to socket:**
  The server pushes one event per room containing the missed mutations list:

```json
{
  "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
  "events": [
    {
      "messageId": "683abc123def456789000003",
      "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
      "senderId": "user_abc123",
      "senderName": "Alice",
      "message": "Updated text after edit",
      "contentType": "TEXT",
      "sentAt": 1749465050000,
      "isDeleted": false,
      "editedAt": 1749465200000,
      "syncEventType": "edited",
      "reactions": []
    },
    {
      "messageId": "683abc123def456789000004",
      "roomId": "6843e1a2b5c3d4e5f6a7b8c9",
      "senderId": "user_def456",
      "senderName": "Bob",
      "message": "",
      "contentType": "TEXT",
      "sentAt": 1749465060000,
      "isDeleted": true,
      "deletedType": "forEveryone",
      "editedAt": 0,
      "syncEventType": "deleted",
      "reactions": []
    }
  ],
  "hasMore": false,
  "lastId": "683abc123def456789000004",
  "nextTs": 1749465210000
}
```

### 13.3 Sync Fallback API

If sockets are entirely disconnected, clients can fetch catching-up mutations via REST:

- **API:** `GET /api/v1/chat/community/rooms/:roomId/sync`
- **Query Params:**
  - `since_ts`: Epoch-ms cursor (required)
  - `limit`: Page limit (optional, max 100)

---

## 14. Phase 13: Error Handling & Payloads

AIMess provides a standardized, unified error payload for all Socket acks and REST responses.

### 14.1 Standardized Error DTO (`AckEnvelope` with success = false)

```json
{
  "success": false,
  "error": "INVALID_PAYLOAD | SERVICE_ERROR | FORBIDDEN | NOT_FOUND | RATE_LIMITED | CONFLICT",
  "retryable": true,
  "message": "Something went wrong, please try again."
}
```

### 14.2 Error Classification Table

| Error Code        | Reason                                                                                                | Retryable? | Expected Frontend Action                                                                     |
| :---------------- | :---------------------------------------------------------------------------------------------------- | :--------- | :------------------------------------------------------------------------------------------- |
| `INVALID_PAYLOAD` | Zod validation failed at the gateway. Body values are malformed or missing.                           | ❌ No      | Do not retry. Fix the request structure or validate inputs client-side.                      |
| `FORBIDDEN`       | Caller is not a community member, is muted, banned, or lacks required roles (e.g. moderator actions). | ❌ No      | Stop operations. Redirect user or display authorization error.                               |
| `NOT_FOUND`       | The target community, chat room, or message ID does not exist in the database.                        | ❌ No      | Remove the target locally. Refresh the current view.                                         |
| `CONFLICT`        | The edit window has closed (> 15 min), or the entity state rejects the update.                        | ❌ No      | Notify the user the action is no longer valid.                                               |
| `SERVICE_ERROR`   | Downstream gRPC service error, DB timeout, or internal exception.                                     | ✅ Yes     | Retry using exponential backoff (e.g., 500ms -> 1s -> 2s) with jitter.                       |
| `RATE_LIMITED`    | Rate limits exceeded (30 messages/min or 10 reactions/min).                                           | ✅ Yes     | Wait for the window to clear. (If `retryAfter` timestamp is present, block until that time). |

---

## 15. Phase 14: Contract Consistency Review & Mismatch Report

Comparing the implementation and the OpenAPI/AsyncAPI specification reveals several inconsistencies that frontend developers must code around:

### Mismatch 1: REST Message Type vs Socket Content Type

- **Finding:** When sending a message via HTTP (`POST /api/v1/chat/community/rooms/:roomId/messages`), the validation schema ([community.validator.ts:L69](file:///c:/Users/Windows/Documents/Rajesh/aimess_backend/apps/chat-service/src/api/validators/community.validator.ts#L69)) requires **`messageType`** (case-insensitive, normalized to lower-case). However, when sending via Socket (`community:message:send` / [community.ns.ts:L53](file:///c:/Users/Windows/Documents/Rajesh/aimess_backend/apps/api-gateway/src/sockets/namespaces/community.ns.ts#L53)) or when receiving message broadcasts, the schema specifies **`contentType`** (UPPER-CASE).
- **Workaround:** Frontend mappers must normalize inputs. Map to `messageType` for REST sends and `contentType` for Socket emits.

### Mismatch 2: Thread Reply References

- **Finding:** The private/group messaging socket uses **`repliedToId`** for quote indicators. The community namespace socket uses **`parentMessageId`** for the exact same purpose.
- **Workaround:** Ensure client mappers output the correct identifier key based on whether the chat room is a 1-1 thread vs a community room.

### Mismatch 3: Community Cover Image Read-Only Gaps

- **Finding:** The `CommunityData` details response exposes `coverUrl` and `cover` (`MediaObject`). However, neither the creation DTO (`CreateCommunityRequest`) nor the update DTO (`UpdateCommunityRequest`) in the community validation layer accepts a `coverObjectKey`.
- **Workaround:** Treating cover images as read-only. There is currently no REST endpoint to set or modify the community cover.

### Mismatch 4: Undocumented REST Cancel Endpoint

- **Finding:** The media cancel route `DELETE /api/v1/media/uploads/:objectKey` is implemented in `media-service` but is completely missing from Swagger/OpenAPI specifications.
- **Workaround:** Implement HTTP calls using standard route patterns described in this guide.

### Mismatch 5: Timestamp Types

- **Finding:** In OpenAPI definitions, `createdAt` and `editedAt` are documented as ISO-8601 strings. However, on the socket wire and during serialization, `serverTs`, `sentAt`, and `editedAt` are formatted as epoch-ms integers.
- **Workaround:** Frontend parsers should treat timestamps dynamically. Use `Number(timestamp)` or parse defensively to handle either formatting.
