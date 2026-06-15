# Media Flow — Frontend vs Backend Responsibilities

> **Quick Reference:** Frontend calls API X → Backend responds with Y → Frontend does Z
>
> This document defines the exact split of work between Frontend and Backend for handling media in chat, avatars, and community features.

---

## Table of Contents

1. [Upload Flow](#upload-flow)
2. [Send Flow (Socket.IO)](#send-flow-socketio)
3. [Receive Flow (Socket.IO)](#receive-flow-socketio)
4. [REST History Flow](#rest-history-flow)
5. [Avatar & Profile Flow](#avatar--profile-flow)
6. [Community Avatar/Cover Flow](#community-avatarcover-flow)
7. [Error Cases](#error-cases)
8. [Summary Table](#summary-table)

---

## UPLOAD FLOW

### Step 1: Get Presigned Upload URL

#### Frontend Calls:

```
POST /api/v1/media/upload-url

Body:
{
  "category": "CHAT_ATTACHMENT",        // for private chat
  "contentType": "image/jpeg",
  "contentLength": 512000
}

Headers:
Authorization: Bearer <accessToken>
```

**Categories:**

- `CHAT_ATTACHMENT` — private chat files
- `GROUP_CHAT_ATTACHMENT` — group chat files
- `COMMUNITY_CHAT_ATTACHMENT` — community room files
- `USER_AVATAR` — user profile avatar
- `COMMUNITY_AVATAR` — community avatar
- `COMMUNITY_COVER` — community cover image
- `GROUP_AVATAR` — group room avatar

#### Backend Responds:

```json
{
  "success": true,
  "data": {
    "objectKey": "chat-uploads/9f3a/xyz789.jpg",
    "uploadUrl": "https://minio.aimess.app/aimess-chat/chat-uploads/9f3a/xyz789.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Signature=...&X-Amz-Expires=900",
    "uploadExpiresIn": 900,
    "headers": {
      "Content-Type": "image/jpeg"
    },
    "media": {
      "objectKey": "chat-uploads/9f3a/xyz789.jpg",
      "uploadUrl": "https://minio.../...",
      "downloadUrl": "https://minio.aimess.app/aimess-chat/chat-uploads/9f3a/xyz789.jpg?X-Amz-...GET",
      "downloadUrlExpiresIn": 3600
    }
  }
}
```

#### Frontend Does:

- ✅ Save `objectKey` for sending the message later
- ✅ Extract `uploadUrl` and `headers` for the PUT step
- ✅ **OPTIONAL:** Display `media.downloadUrl` as instant preview after PUT succeeds (UX enhancement)
- ✅ **NEVER** modify or guess the `objectKey` — this is a server-generated, user-scoped identifier
- ✅ Handle error if `success: false` (show error toast, don't proceed)

**Rate Limit:** 30 requests per minute per user

---

### Step 2: Upload File Bytes to MinIO

#### Frontend Calls:

```
PUT <uploadUrl from Step 1>

Headers:
Content-Type: image/jpeg

Body:
<raw file bytes>
```

#### Backend (MinIO) Responds:

```
200 OK
```

#### Frontend Does:

- ✅ Match the `Content-Type` header from Step 1 response
- ✅ **ONLY proceed to message:send if you get 200 OK**
- ✅ Handle failures:
  - If timeout/network error: retry the PUT (same URL if still valid)
  - If `uploadUrl` expired: go back to Step 1, request a new URL, then PUT again
  - Retry up to 3 times with exponential backoff
  - If all retries fail: show "Upload failed" and let user retry
- ✅ Show progress indicator to user (optional but recommended)

**Timeout:** uploadUrl valid for ~5 minutes (900 seconds)

---

## SEND FLOW (Socket.IO)

### Private Chat

#### Frontend Emits:

```typescript
socket.emit(
  "message:send",
  {
    conversationId: "prv_7c1e",
    conversationType: "private",
    clientMessageId: "5e2b-uuid", // unique per message, use for idempotency
    contentType: "IMAGE", // UPPER-CASE always
    contentText: "", // optional caption
    files: [
      {
        objectKey: "chat-uploads/9f3a/xyz789.jpg",
        name: "vacation.jpg",
        mime: "image/jpeg",
        size: 512000,
        width: 1080,
        height: 720,
        blurhash: "LEHV6nWB2yk8",
      },
    ],
  },
  (ack) => {
    // ack callback — see below
  }
);
```

**Validation Rules (FE should enforce):**

- `contentType` MUST be UPPER-CASE
- `contentText` ≤ 4000 characters
- `files[]` count ≤ 30
- Each file name ≤ 255 characters
- `objectKey` from upload response (don't modify)

#### Backend Does:

- ✅ Validates payload schema
- ✅ Validates `contentType` is UPPER-CASE
- ✅ Validates `objectKey` length ≤ 500 chars
- ✅ Validates `files[]` count ≤ 30
- ✅ Validates `contentText` ≤ 4000 chars
- ✅ Validates metadata (width, height, blurhash presence)
- ✅ **Resolves `objectKey` → presigned download URL** (server-side, before broadcast)
- ✅ Stores message in DB with **raw `objectKey`** (not the URL)
- ✅ Broadcasts `message:new` event to all participants in the conversation
- ✅ Calls **ack callback** with result

#### Backend Calls Ack Callback:

```json
{
  "success": true,
  "data": {
    "messageId": "msg_88",
    "sequenceNumber": 42,
    "sentAt": 1718200000000
  }
}
```

OR (on error):

```json
{
  "success": false,
  "message": "FILE_TOO_LARGE",
  "retryable": false
}
```

#### Frontend Does (when ack arrives):

- ✅ If `success: true`:
  - Replace temp bubble's `clientMessageId` with real `messageId`
  - Remove sending spinner
  - Mark message as "sent"
- ✅ If `success: false` AND `retryable: true`:
  - Show "Retrying..." indicator
  - Auto-retry with **same `clientMessageId`** (idempotent)
  - Retry up to 5 times
  - If still fails: show error "Failed to send" with manual retry button
- ✅ If `success: false` AND `retryable: false`:
  - Show error message to user
  - Provide "Discard" or "Try again" button
  - **DO NOT auto-retry**

---

### Community / Group Chat

#### Frontend Emits:

```typescript
socket.emit(
  "community:message:send",
  {
    communityId: "comm_5g2h",
    roomId: "room_7k9m",
    clientMessageId: "5e2b-uuid",
    contentType: "IMAGE",
    message: "Check this out!", // caption (optional)
    media: {
      files: [
        {
          objectKey: "chat-uploads/9f3a/xyz789.jpg",
          name: "vacation.jpg",
          mime: "image/jpeg",
          size: 512000,
          width: 1440,
          height: 960,
          blurhash: "LEHV6nWB2yk8",
        },
      ],
    },
  },
  (ack) => {
    // ack callback
  }
);
```

**Key Differences:**

- Event: `community:message:send` (not `message:send`)
- Files nested under: `media: { files: [...] }`
- Text field: `message` (not `contentText`)
- Requires: `communityId` and `roomId`

#### Backend Does:

- ✅ Same validations as private chat
- ✅ Validates nested `media.files[]`
- ✅ Resolves media URLs before broadcast
- ✅ Stores in `GeneralRoomMessage` or `GroupMessage` table
- ✅ Calls ack callback

#### Frontend Does:

- ✅ Same ack handling as private chat

---

## RECEIVE FLOW (Socket.IO)

### Private Chat Message

#### Backend Broadcasts:

```typescript
socket.on("message:new", (msg) => {
  // msg object:
  {
    "messageId": "msg_88",
    "conversationId": "prv_7c1e",
    "contentType": "IMAGE",
    "senderId": "9f3a",
    "senderName": "Alice",
    "senderAvatar": "https://minio.aimess.app/aimess-avatars/avatars/9f3a/av.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&...",  // ← FULL URL
    "content": {
      "text": "Beautiful day!",
      "files": [{
        "objectKey": "chat-uploads/9f3a/xyz789.jpg",
        "url": "https://minio.aimess.app/aimess-chat/chat-uploads/9f3a/xyz789.jpg?X-Amz-...GET",  // ← FULL URL
        "name": "vacation.jpg",
        "mime": "image/jpeg",
        "width": 1080,
        "height": 720,
        "blurhash": "LEHV6nWB2yk8"
      }]
    },
    "clientMessageId": "5e2b-uuid",
    "sequenceNumber": 42,
    "serverTs": 1718200000000
  }
})
```

#### Frontend Does:

- ✅ Extract `senderAvatar` → `"https://..."` (full, presigned URL)
- ✅ Extract `content.files[0].url` → `"https://..."` (full, presigned URL)
- ✅ **Render directly:** `<img src={msg.senderAvatar} />`
- ✅ **Render directly:** `<img src={msg.content.files[0].url} />`
- ✅ **DO NOT build or modify URLs** — use as-is
- ✅ **DO NOT call `download-url` endpoint** — URLs are already resolved
- ✅ If matching a temp bubble by `clientMessageId`: reconcile and remove spinner
- ✅ Cache bytes locally by `objectKey` if needed (for offline); **never cache the URL** (expires ~1h)

---

### Community / Group Chat Message

#### Backend Broadcasts:

```typescript
socket.on("community:message:new", (msg) => {
  // Same shape as private chat, with communityId & roomId added
  {
    "messageId": "msg_xyz",
    "roomId": "room_7k9m",
    "communityId": "comm_5g2h",
    "contentType": "IMAGE",
    "senderId": "9f3a",
    "senderAvatar": "https://minio.../aimess-avatars/avatars/9f3a/av.webp?X-Amz-...",
    "content": {
      "text": "Check this out!",
      "files": [{
        "url": "https://minio.../aimess-chat/chat-uploads/9f3a/xyz789.jpg?X-Amz-...",
        ...
      }]
    },
    ...
  }
})
```

#### Frontend Does:

- ✅ Same as private chat — render URLs directly

---

### Message Reactions

#### Backend Broadcasts:

```typescript
socket.on("message:reaction", {
  messageId: "msg_88",
  conversationId: "prv_7c1e",
  reactions: [
    {
      emoji: "👍",
      count: 2,
      users: [
        {
          userId: "7k9m",
          displayName: "Bob",
          avatar:
            "https://minio.../aimess-avatars/avatars/7k9m/av.webp?X-Amz-...", // ← FULL URL
        },
        {
          userId: "2m5p",
          displayName: "Carol",
          avatar:
            "https://minio.../aimess-avatars/avatars/2m5p/av.webp?X-Amz-...",
        },
      ],
    },
  ],
});
```

#### Frontend Does:

- ✅ Extract each user's `avatar` → full URL
- ✅ Render: `<img src={avatar} />`
- ✅ Group by emoji and display reaction bubbles

---

## REST HISTORY FLOW

### Private Chat History

#### Frontend Calls:

```
GET /api/v1/conversations/prv_7c1e/messages?limit=50&cursor=<timestamp>

Headers:
Authorization: Bearer <accessToken>
```

**Query Parameters:**

- `limit` (optional, default 50, max 100): number of messages to fetch
- `cursor` (optional): ISO 8601 timestamp for pagination

#### Backend Responds:

```json
{
  "success": true,
  "data": [
    {
      "messageId": "msg_88",
      "conversationId": "prv_7c1e",
      "contentType": "IMAGE",
      "senderId": "9f3a",
      "senderName": "Alice",
      "senderAvatar": "https://minio.../aimess-avatars/avatars/9f3a/av.webp?X-Amz-...",
      "content": {
        "text": "",
        "files": [
          {
            "objectKey": "chat-uploads/9f3a/xyz789.jpg",
            "url": "https://minio.../aimess-chat/chat-uploads/9f3a/xyz789.jpg?X-Amz-...",
            "name": "vacation.jpg",
            "mime": "image/jpeg",
            "width": 1080,
            "height": 720,
            "blurhash": "LEHV6nWB2yk8"
          }
        ]
      },
      "sequenceNumber": 42,
      "serverTs": 1718200000000
    }
  ],
  "pagination": {
    "hasNext": true,
    "nextCursor": "2026-06-12T15:30:00Z"
  }
}
```

#### Frontend Does:

- ✅ For each message in `data[]`:
  - Extract `senderAvatar` → full URL, render directly
  - Extract `content.files[i].url` → full URL, render directly
- ✅ Handle pagination:
  - If `pagination.hasNext: true`, fetch next page using `nextCursor`
  - Keep loading until `hasNext: false`
- ✅ Display messages in reverse chronological order (newest last)

---

### Community / Group Chat History

#### Frontend Calls:

```
GET /api/v1/communities/comm_5g2h/rooms/room_7k9m/messages?limit=50&cursor=<iso-timestamp>

Headers:
Authorization: Bearer <accessToken>
```

#### Backend Responds:

```json
{
  "success": true,
  "data": [
    {
      "messageId": "msg_xyz",
      "roomId": "room_7k9m",
      "communityId": "comm_5g2h",
      "senderAvatar": "https://...",
      "content": {
        "files": [{
          "url": "https://...",
          ...
        }]
      },
      ...
    }
  ],
  "pagination": { ... }
}
```

#### Frontend Does:

- ✅ Same as private chat — render URLs directly

---

## AVATAR & PROFILE FLOW

### Get User Profile

#### Frontend Calls:

```
GET /api/v1/profiles/9f3a

Headers:
Authorization: Bearer <accessToken>
```

#### Backend Responds:

```json
{
  "success": true,
  "data": {
    "userId": "9f3a",
    "username": "alice",
    "displayName": "Alice Wonder",
    "avatar": "https://minio.../aimess-avatars/avatars/9f3a/av.webp?X-Amz-...",
    "email": "alice@example.com",
    "bio": "Designer & builder",
    "status": "online",
    ...
  }
}
```

#### Frontend Does:

- ✅ Extract `avatar` → full URL
- ✅ Render: `<img src={avatar} />`

---

### Update User Avatar

#### Step 1: Get Upload URL

```
POST /api/v1/media/upload-url
{
  "category": "USER_AVATAR",
  "contentType": "image/webp",
  "contentLength": 102400
}
```

Backend responds with `objectKey` and `uploadUrl` (see [Upload Flow](#step-1-get-presigned-upload-url))

#### Step 2: Upload File

```
PUT <uploadUrl>
<raw file bytes>
```

Backend responds: `200 OK`

#### Step 3: Update Profile with New Avatar

```
PATCH /api/v1/profiles/me

Body:
{
  "avatarObjectKey": "avatars/9f3a/xyz.webp"
}

Headers:
Authorization: Bearer <accessToken>
```

#### Backend Responds:

```json
{
  "success": true,
  "data": {
    "userId": "9f3a",
    "avatar": "https://minio.../aimess-avatars/avatars/9f3a/xyz.webp?X-Amz-...",
    ...
  }
}
```

#### Frontend Does:

- ✅ After Step 1: Extract `objectKey` and `uploadUrl`
- ✅ After Step 2: PUT file to `uploadUrl`
- ✅ After Step 3: Extract new `avatar` URL
- ✅ Update profile display with new avatar
- ✅ Broadcast avatar change to all active sockets (they'll receive new profile)

---

## COMMUNITY AVATAR/COVER FLOW

### Get Community Detail

#### Frontend Calls:

```
GET /api/v1/communities/comm_5g2h

Headers:
Authorization: Bearer <accessToken>
```

#### Backend Responds:

```json
{
  "success": true,
  "data": {
    "communityId": "comm_5g2h",
    "name": "Tech Enthusiasts",
    "description": "A place for tech lovers",
    "avatar": "https://minio.../aimess-community/community/avatar/comm_5g2h/xyz.jpg?X-Amz-...",
    "cover": "https://minio.../aimess-community/community/cover/comm_5g2h/xyz.jpg?X-Amz-...",
    "memberCount": 1024,
    "type": "PUBLIC",
    ...
  }
}
```

#### Frontend Does:

- ✅ Extract `avatar` and `cover` → both full URLs
- ✅ Render: `<img src={avatar} />` and `<img src={cover} />`

---

### Update Community Avatar/Cover

#### Step 1: Get Upload URL

```
POST /api/v1/media/upload-url
{
  "category": "COMMUNITY_AVATAR",      // or "COMMUNITY_COVER"
  "contentType": "image/jpeg",
  "contentLength": 307200
}
```

Backend responds with `objectKey` and `uploadUrl`

#### Step 2: Upload File

```
PUT <uploadUrl>
<raw file bytes>
```

Backend responds: `200 OK`

#### Step 3: Update Community

```
PATCH /api/v1/communities/comm_5g2h

Body:
{
  "avatarObjectKey": "community/avatar/comm_5g2h/xyz.jpg"
}
// OR
{
  "coverObjectKey": "community/cover/comm_5g2h/xyz.jpg"
}

Headers:
Authorization: Bearer <accessToken>
```

#### Backend Responds:

```json
{
  "success": true,
  "data": {
    "communityId": "comm_5g2h",
    "avatar": "https://minio.../aimess-community/community/avatar/comm_5g2h/xyz.jpg?X-Amz-...",
    "cover": "https://minio.../aimess-community/community/cover/comm_5g2h/xyz.jpg?X-Amz-...",
    ...
  }
}
```

#### Frontend Does:

- ✅ After Step 1: Extract `objectKey`
- ✅ After Step 2: Upload file
- ✅ After Step 3: Extract new `avatar`/`cover` URLs
- ✅ Update UI with new images
- ✅ Broadcast to all community members (socket event)

---

## ERROR CASES

### Upload URL Request Fails

#### Frontend Calls:

```
POST /api/v1/media/upload-url { ... }
```

#### Backend Responds:

```json
{
  "success": false,
  "message": "INVALID_MIME_TYPE"
}
```

**Possible error codes:**

- `INVALID_MIME_TYPE` — file type not in allowed list
- `RATE_LIMITED` — too many requests (30/min limit)
- `FILE_TOO_LARGE` — size exceeds maximum
- `CATEGORY_NOT_FOUND` — invalid category enum
- `UNAUTHORIZED` — not authenticated
- `FORBIDDEN` — user permissions issue

#### Frontend Does:

- ✅ Show error toast to user: "File type not supported" / "Too many uploads, try again later" / etc.
- ✅ **DO NOT proceed to PUT step**
- ✅ Let user pick a different file or retry after delay

---

### PUT to MinIO Fails

#### Frontend Calls:

```
PUT uploadUrl
<raw bytes>
```

#### Backend (MinIO) Responds:

```
403 Forbidden  // or 400 Bad Request, 500 Internal Server Error, timeout
```

#### Frontend Does:

- ✅ Retry PUT 2-3 times with exponential backoff (500ms → 1s → 2s)
- ✅ If still fails: show error "Upload failed"
- ✅ Offer user options:
  - Retry upload (go back to Step 1 if URL expired)
  - Pick a different file
  - Cancel
- ✅ If `uploadUrl` is close to expiring (< 1 min): go back to Step 1 before next retry
- ✅ Show upload progress indicator (optional but recommended)

---

### Message Send Fails (Non-Retryable)

#### Frontend Emits:

```typescript
socket.emit("message:send", { ... }, (ack) => {
  // ack callback
})
```

#### Backend Calls Ack:

```json
{
  "success": false,
  "message": "FILE_TOO_LARGE",
  "retryable": false
}
```

**Non-retryable error codes:**

- `FILE_TOO_LARGE` — exceeds per-type size limit
- `INVALID_CONTENT_TYPE` — contentType not UPPER-CASE
- `FORBIDDEN` — user not member of conversation/community
- `INVALID_OBJECT_KEY` — key format invalid or doesn't belong to sender
- `MESSAGE_TEXT_TOO_LONG` — text > 4000 chars

#### Frontend Does:

- ✅ Show error in message bubble: "File size exceeds limit" / "You're not a member" / etc.
- ✅ Provide "Delete" or "Try again" button
- ✅ **DO NOT auto-retry**
- ✅ User can discard message or manually retry

---

### Message Send Fails (Retryable)

#### Backend Calls Ack:

```json
{
  "success": false,
  "message": "SERVICE_UNAVAILABLE",
  "retryable": true
}
```

**Retryable error codes:**

- `SERVICE_UNAVAILABLE` — backend temporarily down
- `RATE_LIMITED` — user rate limit exceeded
- `TIMEOUT` — server timeout
- `TRANSIENT_ERROR` — temporary network/DB issue

#### Frontend Does:

- ✅ Show "Retrying..." spinner in message bubble
- ✅ **Automatically re-emit** with **SAME `clientMessageId`** (idempotent)
- ✅ Retry up to 5 times with exponential backoff
- ✅ After 5 failures: show error "Failed to send"
- ✅ Provide manual retry button if user wants to try again

---

### Socket Disconnect During Send

#### Scenario:

Socket disconnects while waiting for ack callback

#### Frontend Does:

- ✅ On reconnect, check if message was posted:
  - Fetch recent history and look for matching `clientMessageId`
  - If found: reconcile bubble with real `messageId` (message was sent)
  - If not found: mark as "failed to send" and allow user to retry
- ✅ Never send the same `clientMessageId` twice unless intentional retry

---

## METADATA COMPUTATION (Frontend Responsibility)

### Image Metadata

```typescript
const file = input.files[0];
const img = new Image();
img.onload = () => {
  const width = img.naturalWidth;
  const height = img.naturalHeight;

  // Compute blurhash (use blurhash library)
  import { encode } from "blurhash";
  const canvas = document.createElement("canvas");
  // ... render img to canvas and extract pixel data
  const blurhash = encode(pixels, 4, 3); // 4x3 components
};
```

### Video Metadata

```typescript
const video = document.createElement("video");
video.src = URL.createObjectURL(file);
video.onloadedmetadata = () => {
  const durationMs = video.duration * 1000;
  const width = video.videoWidth;
  const height = video.videoHeight;
};
```

### Audio / Voice Note Metadata

```typescript
const audioContext = new AudioContext();
const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
const waveform = extractWaveform(audioBuffer); // array of ~50-100 floats [0, 1]
const durationMs = audioBuffer.duration * 1000;
```

### Send with Metadata

```typescript
socket.emit("message:send", {
  contentType: "IMAGE",
  files: [
    {
      objectKey: "chat-uploads/...",
      name: "photo.jpg",
      mime: "image/jpeg",
      size: 512000,
      width: 1080, // ← from image.naturalWidth
      height: 720, // ← from image.naturalHeight
      blurhash: "LEHV6nWB2yk8", // ← computed
      waveform: [], // ← for audio only
      durationMs: 0, // ← for audio/video
    },
  ],
});
```

#### Backend Does:

- ✅ Echoes metadata back on `message:new` / history
- ✅ Uses metadata for instant preview rendering (FE renders blurhash + dimensions before download)

#### Frontend Does:

- ✅ Use `blurhash` to render a blurred placeholder while image is downloading
- ✅ Use `width` / `height` to size the placeholder correctly
- ✅ Use `waveform` to paint voice note amplitude bars
- ✅ Use `durationMs` to show video/audio length

---

## SUMMARY TABLE

| Flow                              | Frontend Calls                                        | Backend Responds                                     | Frontend Does                          |
| --------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| **Get Upload URL**                | `POST /api/v1/media/upload-url`                       | `{ objectKey, uploadUrl, downloadUrl }`              | Save keys, prepare file for PUT        |
| **Upload Bytes**                  | `PUT uploadUrl`                                       | `200 OK`                                             | Proceed to message:send; show progress |
| **Send Message (private)**        | `socket.emit("message:send", {...})`                  | ack callback                                         | Handle success/error; reconcile IDs    |
| **Send Message (community)**      | `socket.emit("community:message:send", {...})`        | ack callback                                         | Handle success/error; reconcile IDs    |
| **Receive Message**               | `socket.on("message:new", msg)`                       | full URLs in `senderAvatar` + `content.files[i].url` | Render URLs directly; no conversion    |
| **Get History**                   | `GET /api/v1/conversations/:id/messages`              | array of messages with full URLs                     | Render URLs; handle pagination         |
| **Get Profile**                   | `GET /api/v1/profiles/:id`                            | `{ avatar: "https://..." }`                          | Render avatar directly                 |
| **Update Avatar**                 | `POST /upload-url` → `PUT` → `PATCH /profiles/me`     | new avatar URL                                       | Update UI; broadcast to sockets        |
| **Get Community**                 | `GET /api/v1/communities/:id`                         | `{ avatar, cover: "https://..." }`                   | Render directly                        |
| **Update Community Avatar/Cover** | `POST /upload-url` → `PUT` → `PATCH /communities/:id` | new avatar/cover URL                                 | Update UI; broadcast to sockets        |
| **Error on Upload**               | `POST /upload-url`                                    | `{ success: false, message }`                        | Show error toast; don't PUT            |
| **Error on Send (non-retryable)** | `socket.emit("message:send", ...)`                    | ack with `retryable: false`                          | Show error; don't auto-retry           |
| **Error on Send (retryable)**     | `socket.emit("message:send", ...)`                    | ack with `retryable: true`                           | Auto-retry with same clientMessageId   |
| **Socket Disconnect**             | On reconnect, fetch history                           | `GET /api/v1/conversations/:id/messages`             | Check if message was posted; reconcile |

---

## KEY RULES

### ✅ DO

- ✅ Always use UPPER-CASE `contentType` (`IMAGE`, `VIDEO`, `AUDIO`, `DOCUMENT`)
- ✅ Render media URLs directly: `<img src={url} />`
- ✅ Compute metadata (blurhash, width, height, waveform) **on the frontend**
- ✅ Send only `objectKey` in messages; never send the presigned URL
- ✅ Use `clientMessageId` for idempotency; reuse on retry
- ✅ Handle ack callback for send results
- ✅ Retry PUT on network failure (exponential backoff)
- ✅ Retry message:send if ack.retryable=true (same clientMessageId)
- ✅ Reconcile optimistic bubbles with real messageId on ack
- ✅ Cache bytes locally by `objectKey` (not by URL)
- ✅ Re-fetch history on reconnect for fresh URLs

### ❌ DON'T

- ❌ Never modify or guess the `objectKey` — it's server-generated
- ❌ Never build or construct URLs from keys
- ❌ Never call `download-url` endpoint for regular messages
- ❌ Never use `contentType` in lower case (use `IMAGE`, not `image`)
- ❌ Never persist presigned URLs — they expire (~1 hour)
- ❌ Never send file bytes over the socket
- ❌ Never send raw keys in the UI (only full URLs)
- ❌ Never auto-retry if `retryable: false`
- ❌ Never reuse an expired `uploadUrl`; request a new one

---

## Appendix: Rate Limits

| Endpoint                                  | Limit        | Window            |
| ----------------------------------------- | ------------ | ----------------- |
| `POST /api/v1/media/upload-url`           | 30 requests  | 1 minute per user |
| `POST /api/v1/media/download-url`         | 120 requests | 1 minute per user |
| `DELETE /api/v1/media/uploads/:objectKey` | 30 requests  | 1 minute per user |
| `socket.emit("message:send")`             | 50 messages  | 1 minute per user |
| `socket.emit("community:message:send")`   | 50 messages  | 1 minute per user |

---

## Appendix: Error Codes

### Upload URL Errors

- `INVALID_MIME_TYPE` — file type not allowed
- `RATE_LIMITED` — too many requests
- `FILE_TOO_LARGE` — exceeds max size
- `CATEGORY_NOT_FOUND` — invalid category
- `UNAUTHORIZED` — not authenticated

### Send Message Errors

- **Non-retryable:**
  - `FILE_TOO_LARGE` — exceeds per-type limit
  - `INVALID_CONTENT_TYPE` — not UPPER-CASE
  - `FORBIDDEN` — not member of conversation
  - `INVALID_OBJECT_KEY` — key format/ownership invalid
  - `MESSAGE_TEXT_TOO_LONG` — text > 4000 chars

- **Retryable:**
  - `SERVICE_UNAVAILABLE` — backend temporarily down
  - `RATE_LIMITED` — user rate limit
  - `TIMEOUT` — server timeout
  - `TRANSIENT_ERROR` — temporary issue

---

## Appendix: Allowed MIME Types

**Images:**

- `image/jpeg`
- `image/png`
- `image/webp`
- `image/gif`

**Video:**

- `video/mp4`
- `video/quicktime`

**Audio:**

- `audio/mpeg`
- `audio/ogg`
- `audio/wav`

**Documents:**

- `application/pdf`
- `application/msword`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx)

---

## See Also

- [MEDIA_UPLOAD.md](MEDIA_UPLOAD.md) — Media upload protocol details
- [SOCKET_EVENTS.md](SOCKET_EVENTS.md) — Complete Socket.IO event reference
- [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md) — Backend implementation notes
