# AIMess Media Upload & Download — Frontend Developer Guide

> **Migration note:** The old per-service endpoints (`/community/upload/url`, `/users/uploads/url`, etc.) have been removed. **All media — for every category — goes through one unified API at `/api/v1/media`.**

---

## Table of Contents

1. [Quick-Start Checklist](#1-quick-start-checklist)
2. [Architecture Overview](#2-architecture-overview)
3. [Categories — What to Use When](#3-categories--what-to-use-when)
4. [Allowed File Types & Size Caps](#4-allowed-file-types--size-caps)
5. [Step-by-Step Upload Flow](#5-step-by-step-upload-flow)
6. [Step-by-Step Download Flow](#6-step-by-step-download-flow)
7. [Scan Status Polling](#7-scan-status-polling)
8. [Cancelling an Upload](#8-cancelling-an-upload)
9. [Attaching Media to a Chat Message](#9-attaching-media-to-a-chat-message)
10. [API Reference](#10-api-reference)
11. [Error Codes](#11-error-codes)
12. [End-to-End Code Examples](#12-end-to-end-code-examples)
13. [FAQ](#13-faq)

---

## 1. Quick-Start Checklist

Upload any file in 3 calls:

```
POST  /api/v1/media/upload-url   →  get presigned PUT URL + objectKey
PUT   <uploadUrl>                 →  PUT the raw file directly to MinIO (no auth header)
POST  /api/v1/media/confirm       →  trigger scan; receive scanStatus
```

Then to get a usable URL:

```
POST  /api/v1/media/download-url  →  get a fresh presigned GET URL
```

All endpoints require `Authorization: Bearer <accessToken>` **except** the MinIO PUT (it's a presigned URL that contains credentials in the query string).

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Your App                                                           │
│                                                                     │
│  1. POST /api/v1/media/upload-url  ─────────────────────────────►  │
│     ← { uploadUrl, objectKey, headers, media }                      │
│                                                                     │
│  2. PUT  <uploadUrl>  (with Content-Type header)  ──────────────►  │
│     ← 200 OK from MinIO (no body)                                   │
│                                                                     │
│  3. POST /api/v1/media/confirm  ────────────────────────────────►  │
│     ← { objectKey, scanStatus, fileSize }                           │
│       scanStatus: "CLEAN" | "PENDING" | "INFECTED" | "ERROR"       │
│                                                                     │
│  If scanStatus === "PENDING":                                        │
│  4. GET /api/v1/media/scan-status?objectKey=…&category=…  ──────►  │
│     ← { objectKey, scanStatus }   (poll until CLEAN/INFECTED)       │
│                                                                     │
│  5. POST /api/v1/media/download-url  ───────────────────────────►  │
│     ← { downloadUrl, downloadUrlExpiresIn, media }                  │
│                                                                     │
│     Send the objectKey in your message payload (not the URL).       │
└─────────────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- **Never persist a presigned URL.** They expire (≈7 days download / 1 hour upload). Persist `objectKey` and call `/download-url` to re-resolve.
- **File ownership comes from your JWT token.** There is no parameter to override it.
- **`resourceId` is required for all chat attachments** — without it downloads cannot be access-controlled. Pass the `roomId` / `groupId` / `communityId`.

---

## 3. Categories — What to Use When

| `category`                  | Use for                                      | Max size         | File types      |
| --------------------------- | -------------------------------------------- | ---------------- | --------------- |
| `USER_AVATAR`               | User profile picture                         | 5 MB             | JPEG, PNG, WebP |
| `COMMUNITY_AVATAR`          | Community profile picture                    | 5 MB             | JPEG, PNG, WebP |
| `COMMUNITY_COVER`           | Community cover/banner image                 | 5 MB             | JPEG, PNG, WebP |
| `GROUP_AVATAR`              | Group profile picture                        | 5 MB             | JPEG, PNG, WebP |
| `CHAT_ATTACHMENT`           | File attachment in a **private (1-on-1) DM** | 100 MB ceiling\* | Full media set  |
| `GROUP_CHAT_ATTACHMENT`     | File attachment in a **group chat**          | 100 MB ceiling\* | Full media set  |
| `COMMUNITY_CHAT_ATTACHMENT` | File attachment in a **community room**      | 100 MB ceiling\* | Full media set  |

> \*Per-MIME caps are stricter than the category ceiling — see §4.

**The old `community/upload/url` endpoint mapped to `COMMUNITY_CHAT_ATTACHMENT`. Replace every call to it with `POST /api/v1/media/upload-url` and `category: "COMMUNITY_CHAT_ATTACHMENT"`.**

---

## 4. Allowed File Types & Size Caps

### 4.1 Avatars & Covers (`USER_AVATAR`, `COMMUNITY_AVATAR`, `COMMUNITY_COVER`, `GROUP_AVATAR`)

| MIME type    | Max size |
| ------------ | -------- |
| `image/jpeg` | 5 MB     |
| `image/png`  | 5 MB     |
| `image/webp` | 5 MB     |

Any other MIME returns `415 UPLOAD_UNSUPPORTED_CONTENT_TYPE`.

### 4.2 Chat Attachments (`CHAT_ATTACHMENT`, `GROUP_CHAT_ATTACHMENT`, `COMMUNITY_CHAT_ATTACHMENT`)

#### Images

| MIME         | Max size |
| ------------ | -------- |
| `image/jpeg` | 25 MB    |
| `image/png`  | 25 MB    |
| `image/webp` | 25 MB    |
| `image/gif`  | 30 MB    |

#### Video

| MIME                     | Max size |
| ------------------------ | -------- |
| `video/mp4`              | 100 MB   |
| `video/quicktime` (MOV)  | 100 MB   |
| `video/x-matroska` (MKV) | 100 MB   |
| `video/webm`             | 100 MB   |
| `video/x-msvideo` (AVI)  | 100 MB   |
| `video/x-m4v`            | 100 MB   |

#### Audio / Voice Notes

| MIME                              | Max size |
| --------------------------------- | -------- |
| `audio/mpeg` (MP3)                | 100 MB   |
| `audio/ogg` (OGG/Opus)            | 100 MB   |
| `audio/wav`                       | 100 MB   |
| `audio/mp4` / `audio/x-m4a` (M4A) | 100 MB   |
| `audio/aac`                       | 100 MB   |
| `audio/flac`                      | 100 MB   |

#### Documents

| MIME                                                                               | Max size |
| ---------------------------------------------------------------------------------- | -------- |
| `application/pdf`                                                                  | 50 MB    |
| `application/msword` (DOC)                                                         | 50 MB    |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX)   | 50 MB    |
| `application/vnd.ms-excel` (XLS)                                                   | 50 MB    |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (XLSX)         | 50 MB    |
| `application/vnd.ms-powerpoint` (PPT)                                              | 100 MB   |
| `application/vnd.openxmlformats-officedocument.presentationml.presentation` (PPTX) | 100 MB   |
| `text/plain` (TXT)                                                                 | 10 MB    |
| `text/csv` (CSV)                                                                   | 25 MB    |
| `application/json`                                                                 | 10 MB    |
| `application/xml` / `text/xml`                                                     | 10 MB    |

#### Archives

| MIME                           | Max size |
| ------------------------------ | -------- |
| `application/zip`              | 100 MB   |
| `application/x-zip-compressed` | 100 MB   |

> **Note on Content-Disposition:** Images, video, and audio are served **inline** (browser can render). Documents and archives are served as **forced downloads** (`Content-Disposition: attachment`). Plan your UI accordingly.

---

## 5. Step-by-Step Upload Flow

### Step 1 — Request a presigned upload URL

```
POST /api/v1/media/upload-url
Authorization: Bearer <accessToken>
Content-Type: application/json
```

**Request body:**

| Field           | Type   | Required             | Description                                     |
| --------------- | ------ | -------------------- | ----------------------------------------------- |
| `category`      | string | ✅                   | One of the 7 categories (§3)                    |
| `contentType`   | string | ✅                   | MIME type of the file (e.g. `image/jpeg`)       |
| `contentLength` | number | ✅                   | File size in bytes (integer > 0)                |
| `resourceId`    | string | ⚠️ Required for chat | The room/group/community ID the file belongs to |

**Example (community chat attachment):**

```json
{
  "category": "COMMUNITY_CHAT_ATTACHMENT",
  "contentType": "image/jpeg",
  "contentLength": 204800,
  "resourceId": "community-uuid-here"
}
```

**Example (user avatar):**

```json
{
  "category": "USER_AVATAR",
  "contentType": "image/png",
  "contentLength": 51200
}
```

> Avatars and covers are public — `resourceId` is optional and ignored.

**Success response `200 OK`:**

```json
{
  "success": true,
  "data": {
    "uploadUrl": "https://minio.example.com/bucket/community-chat-uploads/user-uuid/file-uuid.jpg?X-Amz-...",
    "objectKey": "community-chat-uploads/user-uuid/file-uuid.jpg",
    "uploadExpiresIn": 3600,
    "maxBytes": 26214400,
    "headers": {
      "Content-Type": "image/jpeg"
    },
    "media": {
      "fileId": "file-uuid",
      "objectKey": "community-chat-uploads/user-uuid/file-uuid.jpg",
      "fileName": null,
      "contentType": "image/jpeg",
      "size": 204800,
      "downloadUrl": "https://minio.example.com/...",
      "downloadUrlExpiresIn": 604800,
      "uploadUrl": "https://minio.example.com/...",
      "uploadUrlExpiresIn": 3600
    }
  }
}
```

**Store `objectKey` permanently.** The URLs expire; the key does not.

---

### Step 2 — PUT the file directly to MinIO

```
PUT <uploadUrl>
Content-Type: <same MIME you declared in step 1>

<raw file bytes>
```

**Important:**

- Set `Content-Type` to **exactly** the MIME you declared in step 1 (e.g. `image/jpeg`)
- Do **not** send `Authorization` — the presigned URL already contains credentials
- Do **not** encode the file as multipart/form-data or base64 — send raw bytes
- Expect `200 OK` with an **empty body** on success

**Axios example:**

```js
await axios.put(uploadUrl, file, {
  headers: { "Content-Type": contentType },
  // no Authorization header here!
});
```

**Fetch example:**

```js
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": contentType },
  body: file, // File | Blob | ArrayBuffer
});
```

---

### Step 3 — Confirm the upload (triggers scan)

```
POST /api/v1/media/confirm
Authorization: Bearer <accessToken>
Content-Type: application/json
```

**Request body:**

| Field         | Type   | Required | Description             |
| ------------- | ------ | -------- | ----------------------- |
| `objectKey`   | string | ✅       | Returned from step 1    |
| `category`    | string | ✅       | Same category as step 1 |
| `contentType` | string | ✅       | Same MIME as step 1     |

```json
{
  "objectKey": "community-chat-uploads/user-uuid/file-uuid.jpg",
  "category": "COMMUNITY_CHAT_ATTACHMENT",
  "contentType": "image/jpeg"
}
```

**Success response `200 OK`:**

```json
{
  "success": true,
  "data": {
    "objectKey": "community-chat-uploads/user-uuid/file-uuid.jpg",
    "scanStatus": "CLEAN",
    "fileSize": 204800
  }
}
```

**`scanStatus` values:**

| Value         | Meaning                                               | Action                          |
| ------------- | ----------------------------------------------------- | ------------------------------- |
| `CLEAN`       | File passed all checks. Ready to use.                 | Proceed to send message         |
| `PENDING`     | AV scan enqueued. File not yet downloadable.          | Poll `/scan-status` (§7)        |
| `INFECTED`    | Magic-byte check failed or virus found. File deleted. | Show error, discard `objectKey` |
| `QUARANTINED` | Structural threat (ZIP bomb etc.). File deleted.      | Show error, discard `objectKey` |
| `ERROR`       | Scan infrastructure failure. File not confirmed.      | Retry `/confirm`                |
| `SKIPPED`     | Dev environment — no AV. File is downloadable.        | Proceed                         |

---

## 6. Step-by-Step Download Flow

Presigned download URLs expire (~7 days). **Always fetch a fresh URL before displaying or downloading a file** — never store the URL in your DB or localStorage permanently.

```
POST /api/v1/media/download-url
Authorization: Bearer <accessToken>
Content-Type: application/json
```

**Request body:**

| Field       | Type   | Required | Description                          |
| ----------- | ------ | -------- | ------------------------------------ |
| `objectKey` | string | ✅       | The key you stored                   |
| `category`  | string | ✅       | Category the file was uploaded under |

```json
{
  "objectKey": "community-chat-uploads/user-uuid/file-uuid.jpg",
  "category": "COMMUNITY_CHAT_ATTACHMENT"
}
```

**Success response `200 OK`:**

```json
{
  "success": true,
  "data": {
    "downloadUrl": "https://minio.example.com/...?X-Amz-Expires=604800&...",
    "downloadUrlExpiresIn": 604800,
    "media": {
      "fileId": "file-uuid",
      "objectKey": "community-chat-uploads/user-uuid/file-uuid.jpg",
      "fileName": null,
      "contentType": "image/jpeg",
      "size": 204800,
      "downloadUrl": "https://minio.example.com/...",
      "downloadUrlExpiresIn": 604800,
      "uploadUrl": null,
      "uploadUrlExpiresIn": null
    }
  }
}
```

**Authorization rules by category:**

| Category                    | Who can download                                                     |
| --------------------------- | -------------------------------------------------------------------- |
| `USER_AVATAR`               | Any authenticated user                                               |
| `COMMUNITY_AVATAR`          | Any authenticated user                                               |
| `COMMUNITY_COVER`           | Any authenticated user                                               |
| `GROUP_AVATAR`              | Any authenticated user                                               |
| `CHAT_ATTACHMENT`           | Only the two participants of that private DM (`resourceId` = roomId) |
| `GROUP_CHAT_ATTACHMENT`     | Only members of that group (`resourceId` = groupId)                  |
| `COMMUNITY_CHAT_ATTACHMENT` | Only members of that community (`resourceId` = communityId)          |

Violating these rules returns `403 MEDIA_ACCESS_FORBIDDEN`.

---

## 7. Scan Status Polling

Only needed when `/confirm` returns `scanStatus: "PENDING"`.

```
GET /api/v1/media/scan-status?objectKey=<key>&category=<category>
Authorization: Bearer <accessToken>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "objectKey": "community-chat-uploads/user-uuid/file-uuid.jpg",
    "scanStatus": "CLEAN"
  }
}
```

**Recommended polling strategy:**

```js
async function waitForScan(objectKey, category) {
  const MAX_ATTEMPTS = 20;
  const DELAY_MS = 2000; // 2 s between polls → up to ~40 s total

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const { data } = await api.get("/media/scan-status", {
      params: { objectKey, category },
    });
    const { scanStatus } = data.data;

    if (scanStatus === "CLEAN" || scanStatus === "SKIPPED") return "ok";
    if (scanStatus === "INFECTED" || scanStatus === "QUARANTINED")
      return "rejected";
    if (scanStatus === "ERROR") throw new Error("Scan failed — please retry");

    await sleep(DELAY_MS);
  }
  throw new Error("Scan timed out");
}
```

---

## 8. Cancelling an Upload

If the user cancels mid-way, clean up the object:

```
DELETE /api/v1/media/uploads/<objectKey>?category=<category>
Authorization: Bearer <accessToken>
```

> `objectKey` must be **URL-encoded** if it contains slashes (it always does). Use `encodeURIComponent`.

**Example:**

```
DELETE /api/v1/media/uploads/community-chat-uploads%2Fuser-uuid%2Ffile-uuid.jpg?category=COMMUNITY_CHAT_ATTACHMENT
```

**Response `200 OK`:**

```json
{ "success": true, "data": null, "message": "Upload cancelled" }
```

You can only delete objects you own (matched by your JWT userId embedded in the key). Returns `403` otherwise.

---

## 9. Attaching Media to a Chat Message

After upload + confirm → CLEAN, include the file in your message body as an `AttachmentDto`:

```ts
interface AttachmentDto {
  objectKey?: string; // ← store this permanently
  url: string; // ← presigned download URL (from media.downloadUrl)
  name: string; // original filename shown in UI
  size: number; // bytes
  mime: string; // MIME type
  width?: number; // for images
  height?: number; // for images
  durationMs?: number; // for audio/video
  blurhash?: string; // for images (optional, compute client-side)
  waveform?: number[]; // for audio (optional, compute client-side)
}
```

The `contentType` field on the message must match the kind of file:

| File type                                | `contentType` value |
| ---------------------------------------- | ------------------- |
| `image/*` (except GIF)                   | `"IMAGE"`           |
| `image/gif`                              | `"GIF"`             |
| `video/*`                                | `"VIDEO"`           |
| `audio/*` (recorded voice)               | `"VOICE"`           |
| `audio/*` (music/file)                   | `"AUDIO"`           |
| `application/pdf`, office, archive, etc. | `"DOCUMENT"`        |

**Community chat send example:**

```json
{
  "message": "",
  "contentType": "IMAGE",
  "files": [
    {
      "objectKey": "community-chat-uploads/user-uuid/file-uuid.jpg",
      "url": "https://minio.example.com/...presigned...",
      "name": "photo.jpg",
      "size": 204800,
      "mime": "image/jpeg",
      "width": 1920,
      "height": 1080
    }
  ]
}
```

**What the server returns in socket `community:message:new` / REST response:**

```json
{
  "content": {
    "text": "",
    "files": [
      {
        "objectKey": "community-chat-uploads/user-uuid/file-uuid.jpg",
        "url": "https://minio.example.com/...fresh-presigned-url...",
        "name": "photo.jpg",
        "size": 204800,
        "mime": "image/jpeg"
      }
    ]
  },
  "contentType": "IMAGE"
}
```

The server **re-resolves** the `url` on every read — the URL in the response is always fresh. Your client should not cache the URL across sessions.

---

## 10. API Reference

All paths are prefixed with `/api/v1`.

### POST `/media/upload-url`

Get a presigned PUT URL for direct-to-storage upload.

**Auth:** Bearer token required  
**Rate-limited:** Yes

| Body field      | Type    | Required | Notes                                       |
| --------------- | ------- | -------- | ------------------------------------------- |
| `category`      | enum    | ✅       | See §3                                      |
| `contentType`   | string  | ✅       | MIME type (e.g. `video/mp4`)                |
| `contentLength` | integer | ✅       | Bytes, must be > 0                          |
| `resourceId`    | string  | ⚠️       | Required for `*_CHAT_ATTACHMENT` categories |

**Response:** `{ uploadUrl, objectKey, uploadExpiresIn, maxBytes, headers, media }`

---

### POST `/media/confirm`

Trigger magic-byte validation and AV scan after PUT.

**Auth:** Bearer token required  
**Rate-limited:** Yes

| Body field    | Type   | Required |
| ------------- | ------ | -------- |
| `objectKey`   | string | ✅       |
| `category`    | enum   | ✅       |
| `contentType` | string | ✅       |

**Response:** `{ objectKey, scanStatus, fileSize? }`

---

### POST `/media/download-url`

Get a fresh presigned GET URL for a stored object.

**Auth:** Bearer token required  
**Rate-limited:** Yes

| Body field  | Type   | Required |
| ----------- | ------ | -------- |
| `objectKey` | string | ✅       |
| `category`  | enum   | ✅       |

**Response:** `{ downloadUrl, downloadUrlExpiresIn, media }`

---

### GET `/media/scan-status`

Poll async AV scan result.

**Auth:** Bearer token required  
**Query params:** `objectKey`, `category`

**Response:** `{ objectKey, scanStatus }`

---

### DELETE `/media/uploads/:objectKey`

Cancel in-progress upload and delete from storage.

**Auth:** Bearer token required  
**Route param:** `objectKey` — URL-encode it (`encodeURIComponent`)  
**Query param:** `category`

**Response:** `{ success: true, data: null }`

---

## 11. Error Codes

All errors follow `{ success: false, error: { code, message } }`.

| HTTP | Code                              | Meaning                                          |
| ---- | --------------------------------- | ------------------------------------------------ |
| 400  | `MEDIA_REQUEST_INVALID`           | Missing/invalid field in request body            |
| 400  | `MEDIA_UNKNOWN_CATEGORY`          | `category` value not recognized                  |
| 400  | `UPLOAD_FILE_TOO_LARGE`           | `contentLength` exceeds per-MIME or category cap |
| 400  | `UPLOAD_FILE_EMPTY`               | `contentLength` is 0                             |
| 403  | `MEDIA_CONFIRM_FORBIDDEN`         | You don't own this `objectKey`                   |
| 403  | `MEDIA_CANCEL_FORBIDDEN`          | You don't own this `objectKey`                   |
| 403  | `MEDIA_ACCESS_FORBIDDEN`          | You're not a member of the resource              |
| 415  | `UPLOAD_UNSUPPORTED_CONTENT_TYPE` | MIME not in the allowed list for the category    |
| 404  | `MEDIA_OBJECT_NOT_FOUND`          | `objectKey` doesn't exist in storage             |
| 401  | —                                 | Missing/expired access token                     |

---

## 12. End-to-End Code Examples

### 12.1 Upload a community chat image (React + Axios)

```ts
import axios from "axios";

const api = axios.create({
  baseURL: "https://api.aimess.example.com/api/v1",
  headers: { Authorization: `Bearer ${accessToken}` },
});

async function uploadCommunityImage(
  file: File,
  communityId: string
): Promise<{ objectKey: string; url: string }> {
  // ── Step 1: get presigned upload URL ──────────────────────────────
  const { data: step1 } = await api.post("/media/upload-url", {
    category: "COMMUNITY_CHAT_ATTACHMENT",
    contentType: file.type,
    contentLength: file.size,
    resourceId: communityId,
  });

  const { uploadUrl, objectKey, headers } = step1.data;

  // ── Step 2: PUT file directly to MinIO (no auth header) ───────────
  await axios.put(uploadUrl, file, {
    headers: { "Content-Type": headers["Content-Type"] },
  });

  // ── Step 3: confirm (triggers scan) ───────────────────────────────
  const { data: step3 } = await api.post("/media/confirm", {
    objectKey,
    category: "COMMUNITY_CHAT_ATTACHMENT",
    contentType: file.type,
  });

  let { scanStatus } = step3.data;

  // ── Step 4: poll if PENDING ────────────────────────────────────────
  if (scanStatus === "PENDING") {
    scanStatus = await pollScanStatus(objectKey, "COMMUNITY_CHAT_ATTACHMENT");
  }

  if (scanStatus !== "CLEAN" && scanStatus !== "SKIPPED") {
    throw new Error(`File rejected: ${scanStatus}`);
  }

  // ── Step 5: get a download URL (for immediate preview) ────────────
  const { data: step5 } = await api.post("/media/download-url", {
    objectKey,
    category: "COMMUNITY_CHAT_ATTACHMENT",
  });

  return { objectKey, url: step5.data.downloadUrl };
}

async function pollScanStatus(
  objectKey: string,
  category: string
): Promise<string> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await api.get("/media/scan-status", {
      params: { objectKey, category },
    });
    const { scanStatus } = data.data;
    if (scanStatus !== "PENDING") return scanStatus;
  }
  throw new Error("Scan timed out after 40 s");
}
```

---

### 12.2 Upload a user avatar

```ts
async function uploadUserAvatar(file: File): Promise<string> {
  // Step 1
  const { data: s1 } = await api.post("/media/upload-url", {
    category: "USER_AVATAR",
    contentType: file.type, // must be image/jpeg | image/png | image/webp
    contentLength: file.size,
    // No resourceId needed for avatars
  });

  // Step 2 — PUT
  await axios.put(s1.data.uploadUrl, file, {
    headers: { "Content-Type": s1.data.headers["Content-Type"] },
  });

  // Step 3 — confirm (avatars don't AV-scan in most envs, expect CLEAN/SKIPPED)
  const { data: s3 } = await api.post("/media/confirm", {
    objectKey: s1.data.objectKey,
    category: "USER_AVATAR",
    contentType: file.type,
  });

  // Avatars return CLEAN or SKIPPED immediately (no async scan)
  return s1.data.objectKey; // store this in your user profile
}
```

---

### 12.3 Render a stored image (resolve on read)

```ts
// ⚠ Never store the URL. Always re-fetch before display.
async function getImageUrl(objectKey: string, category: string): Promise<string> {
  const { data } = await api.post('/media/download-url', { objectKey, category });
  return data.data.downloadUrl;
}

// In React:
function CommunityImage({ objectKey }: { objectKey: string }) {
  const [url, setUrl] = React.useState('');

  React.useEffect(() => {
    getImageUrl(objectKey, 'COMMUNITY_CHAT_ATTACHMENT').then(setUrl);
  }, [objectKey]);

  return <img src={url} />;
}
```

---

### 12.4 Cancel an upload on user abort

```ts
async function cancelUpload(objectKey: string, category: string) {
  await api.delete(`/media/uploads/${encodeURIComponent(objectKey)}`, {
    params: { category },
  });
}
```

---

## 13. FAQ

**Q: Where did `POST /community/upload/url` go?**  
A: Removed. Use `POST /api/v1/media/upload-url` with `category: "COMMUNITY_CHAT_ATTACHMENT"` and `resourceId: <communityId>`. Same 3-step flow.

**Q: Do I need to call `/confirm` for avatars?**  
A: Yes. Confirm is always required before the file is usable. For avatars in dev the scan returns `SKIPPED` immediately, so no polling is needed.

**Q: Can I skip `/confirm` entirely?**  
A: No. An unconfirmed file is never downloadable. The download-url endpoint will auto-confirm on first call (reads the file from MinIO), but this adds latency and bypasses the magic-byte check — always call `/confirm` explicitly after the PUT.

**Q: What `contentType` should I send in my message when uploading voice notes?**  
A: Use `"VOICE"` for recorded voice notes (any `audio/*` MIME you recorded). Use `"AUDIO"` for music or audio files the user is sharing. Both use the same upload category.

**Q: The download URL I stored is returning 403. Why?**  
A: Presigned URLs embed an expiry. After 7 days they stop working. Call `/download-url` to get a fresh one — store `objectKey`, not the URL.

**Q: My image displays fine but my PDF opens as garbage. Why?**  
A: Documents are forced to `Content-Disposition: attachment` (downloaded, not rendered inline). This is intentional security behaviour — don't try to display PDFs inline from the presigned URL. Open a download prompt instead.

**Q: How do I show a progress bar during the upload?**  
A: The PUT to MinIO is a standard HTTP request — use `onUploadProgress` (Axios) or `XMLHttpRequest` with a `progress` event listener. The gateway and media-service don't see this traffic; it goes directly from the client to MinIO.

**Q: I'm getting `415 UPLOAD_UNSUPPORTED_CONTENT_TYPE`. What's wrong?**  
A: Either the MIME you passed in `contentType` isn't in the allowed list for that category (check §4), or the filename extension doesn't match the MIME (e.g. a file named `photo.jpg` with MIME `image/png` will fail). Fix both to match.

**Q: What is `resourceId` and can I omit it?**  
A: `resourceId` binds the file to its access-controlled context (the room/group/community). For chat attachment categories, omitting it means `POST /media/download-url` will fall back to legacy owner-only access — only the uploader can download it. Other members can't, which will cause blank attachments in their chat. Always pass it for chat uploads.
