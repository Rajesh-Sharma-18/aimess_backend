# Communities API Reference

> Frontend integration guide for the AIMess **Communities** feature.
> Audience: React / web & mobile client developers.
> Sources: `community-service` (management) and `chat-service` (community chat), exposed through the API Gateway.

---

## Table of contents

1. [Conventions](#1-conventions)
   - [Base URLs](#11-base-urls)
   - [Authentication](#12-authentication)
   - [Response envelope](#13-response-envelope)
   - [Errors & status codes](#14-errors--status-codes)
   - [ID formats](#15-id-formats)
   - [Roles](#16-roles)
   - [Pagination](#17-pagination)
2. [Shared data types](#2-shared-data-types)
3. [Community management API](#3-community-management-api)
   - [Create & read](#31-create--read)
   - [Discovery & my communities](#32-discovery--my-communities)
   - [Categories](#33-categories)
   - [Membership](#34-membership)
   - [Member moderation](#35-member-moderation-mute--warn)
   - [Join requests](#36-join-requests)
   - [Invites](#37-invites)
   - [Invite links](#38-invite-links)
   - [Reports](#39-reports)
   - [Mute settings](#310-mute-settings)
   - [Notification preferences](#311-notification-preferences)
   - [Likes / favorites](#312-likes--favorites)
   - [Uploads](#313-uploads)
4. [Community chat API](#4-community-chat-api)
5. [Real-time Socket.IO contract](#5-real-time-socketio-contract)
6. [React integration notes](#6-react-integration-notes)

---

## 1. Conventions

### 1.1 Base URLs

Everything goes through the API Gateway. Replace `{{BASE}}` with the gateway origin (e.g. `https://api.aimess.app`).

| Concern                                                                  | Prefix                        | Backed by         |
| ------------------------------------------------------------------------ | ----------------------------- | ----------------- |
| Community management (CRUD, members, invites, reports, mute, categories) | `{{BASE}}/api/v1/communities` | community-service |
| Community **chat** (rooms, messages, pins, sync)                         | `{{BASE}}/api/chat/community` | chat-service      |

### 1.2 Authentication

Every endpoint requires a valid access token:

```http
Authorization: Bearer <accessToken>
```

The authenticated user id is read from the token server-side — you never send your own user id in a body or query.

### 1.3 Response envelope

Every REST response uses one envelope:

```jsonc
{
  "success": true,
  "message": "Community created", // human-readable, localized via Accept-Language
  "data": {
    /* endpoint-specific payload, or null */
  },
}
```

The sections below describe the **`data`** payload only.

### 1.4 Errors & status codes

```jsonc
{
  "success": false,
  "message": "Community ID is invalid",
  "data": null,
}
```

| Code                    | Meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `200 OK`                | Success                                                            |
| `201 Created`           | Resource created                                                   |
| `400 Bad Request`       | Validation failed (Zod)                                            |
| `401 Unauthorized`      | Missing / invalid token                                            |
| `403 Forbidden`         | Insufficient role                                                  |
| `404 Not Found`         | Resource missing                                                   |
| `409 Conflict`          | e.g. handle/name taken, already a member                           |
| `429 Too Many Requests` | Rate limit (community chat send/edit/react/delete: **30 req/min**) |

### 1.5 ID formats

| Field                                                                                             | Format                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `communityId`, `roomId`, `messageId`, `categoryId`, `reportId`, `inviteId`, `linkId`, `requestId` | MongoDB ObjectId — 24 lowercase hex chars: `^[a-f0-9]{24}$` |
| `userId`                                                                                          | UUID v4 (from auth-service)                                 |
| invite link `code`                                                                                | 4–64 chars of `[A-Za-z0-9_-]`                               |

### 1.6 Roles

`ADMIN` (owner) > `MODERATOR` > `MEMBER`. Each endpoint lists its minimum role. **Self** = any authenticated user acting on their own membership/data.

### 1.7 Pagination

Two patterns. Each endpoint says which it uses.

**Offset pagination** — query `page` (default `1`) + `limit` (default `20`, max `50`). Response wraps the list:

```jsonc
{
  "data": [
    /* items */
  ],
  "hasMore": true,
  "nextCursor": null,
  "pagination": {
    "totalData": 137,
    "totalPage": 7,
    "currentPage": 1,
    "limit": 20,
    "nextCursor": null,
    "hasMore": true,
  },
}
```

> Note: a few admin/list endpoints return a simpler block `{ page, limit, total, totalPages, hasNext, hasPrev }` — noted inline where used.

**Cursor pagination** — timestamp cursors `before_ts` / `after_ts` (epoch ms, mutually exclusive). Response includes `nextCursor` (feed back as the next cursor) and `hasMore`.

---

## 2. Shared data types

These TypeScript shapes are reused across many endpoints. Copy them into your client types.

```ts
// Presigned media descriptor attached to avatars/covers/attachments.
interface MediaObject {
  fileId: string | null;
  objectKey: string | null;
  fileName: string | null;
  contentType: string | null;
  size: number | null;
  downloadUrl: string | null;
  downloadUrlExpiresIn: number | null;
  uploadUrl: string | null;
  uploadUrlExpiresIn: number | null;
  uploadHeaders?: Record<string, string>;
}

type CommunityType = "PUBLIC" | "PRIVATE";
type CommunityMemberRole = "ADMIN" | "MODERATOR" | "MEMBER";
type CommunityMemberStatus = "ACTIVE" | "PENDING" | "BANNED" | "LEFT";
type CommunityModerationStatus = "ACTIVE" | "SUSPENDED";
type JoinRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
type InviteStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED";
type ReportStatus =
  | "OPEN"
  | "REVIEWED"
  | "ACTIONED"
  | "DISMISSED"
  | "WITHDRAWN";

// Denormalized "last activity" line shown on community cards.
interface CommunityLastActivity {
  type:
    | "message"
    | "join"
    | "removal"
    | "reaction"
    | "edited"
    | "deleted"
    | "pinned"
    | "unpinned"
    | "created";
  userId: string | null;
  username: string | null;
  preview: string;
  dateTime: number; // epoch ms
}

// Full community object — returned by create / get / patch.
interface CommunityData {
  id: string;
  name: string;
  handle: string;
  description: string | null;
  type: CommunityType;
  category: { id: string; name: string };
  creatorId: string;
  adminId: string;
  memberCount: number;
  memberLimit: number;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  avatar: MediaObject;
  coverUrl: string | null;
  coverUrlExpiresIn: number | null;
  cover: MediaObject;
  role: CommunityMemberRole | null; // caller's role, null if not a member
  isJoined: boolean;
  /**
   * Present when the caller has a PENDING join request for this community.
   * null when the caller is already a member, never requested, or the request
   * was approved/rejected/cancelled.
   * Frontend: show "Requested" + cancel button when this is non-null.
   */
  joinRequestId: string | null;
  joinRequestStatus: "PENDING" | null;
  isMuted: boolean;
  muteUntil: string | null; // ISO-8601, null if not/indefinitely muted
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  isLive: boolean;
  moderationStatus: CommunityModerationStatus;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  lastActivity: CommunityLastActivity;
}

// Compact row for the caller's joined-communities list.
interface CommunityListItem {
  id: string;
  name: string;
  handle: string;
  type: CommunityType;
  memberCount: number;
  memberLimit: number;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  avatar: MediaObject;
  role: CommunityMemberRole;
  isJoined: boolean;
  lastActivityAt: number; // epoch ms
  unreadMessageCount: number;
  lastActivity: CommunityLastActivity;
  isMuted: boolean;
  muteUntil: string | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  isLive: boolean;
}

// Public/browse card (no role; caller not necessarily a member).
interface CommunityDiscoverItem {
  id: string;
  name: string;
  handle: string;
  description: string | null;
  type: CommunityType;
  category: { id: string; name: string };
  memberCount: number;
  memberLimit: number;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  avatar: MediaObject;
  createdAt: number; // epoch ms
  unreadMessageCount?: number; // only in /mine search mode
  lastActivity?: CommunityLastActivity;
  isJoined: boolean;
  isMuted: boolean;
  muteUntil: string | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  isLive: boolean;
}

interface CommunityMemberData {
  userId: string;
  role: CommunityMemberRole;
  status: CommunityMemberStatus;
  joinedAt: string;
  snapshotUsername: string;
  snapshotDisplayName: string;
  snapshotAvatarUrl: string | null;
  snapshotAvatarUrlExpiresIn: number | null;
  snapshotAvatar: MediaObject;
  bannedAt: string | null;
  bannedBy: string | null;
  banReason: string | null;
}
```

The DTOs for join requests, invites, reports, mute, warnings, invite links and audit logs are documented inline in their sections below.

---

## 3. Community management API

Base: `{{BASE}}/api/v1/communities`

### 3.1 Create & read

#### `POST /` — Create community

**Role:** any authenticated user (becomes `ADMIN`).

Request body:

```jsonc
{
  "name": "Hanoi Foodies", // 3–50 chars
  "handle": "hanoi_foodies", // 3–32 chars, [a-z0-9_], auto-normalized
  "type": "PUBLIC", // "PUBLIC" | "PRIVATE"
  "categoryId": "64f0a1b2c3d4e5f600112233",
  "description": "Best food spots", // optional, ≤500 chars
  "avatarObjectKey": "uploads/...", // optional, from upload-URL flow
  "memberIds": ["<uuid>", "<uuid>"], // optional, ≤500 seed members
}
```

**`201`** → `data`: [`CommunityData`](#2-shared-data-types).

#### `GET /:id` — Get one community

**Role:** member (or anyone for PUBLIC). **`200`** → `data`: `CommunityData`.

#### `PATCH /:id` — Update community

**Role:** ADMIN / MODERATOR. Body: any subset of the create fields (at least one required); `description` and `avatarObjectKey` may be `null` to clear. **`200`** → `data`: `CommunityData`.

#### `DELETE /:id` — Delete community

**Role:** ADMIN. **`200`** → `data: null`.

#### `GET /name-available?name=...` — Check name availability

#### `GET /handle-available?handle=...` — Check handle availability

**`200`** → `data`:

```jsonc
{ "name": "Hanoi Foodies", "available": true } // or { "handle": "...", "available": false }
```

---

### 3.2 Discovery & my communities

#### `GET /mine` — Unified list (joined OR search)

One endpoint, two modes inferred from params. **At least one of `before_ts`, `after_ts`, `q`, `categoryId` is required.**

**Joined mode** (cursor) — pass a timestamp cursor:

| Param       | Type     | Notes                                                             |
| ----------- | -------- | ----------------------------------------------------------------- |
| `before_ts` | epoch ms | your communities with `lastActivityAt <= before_ts`, newest-first |
| `after_ts`  | epoch ms | `lastActivityAt >= after_ts`, oldest-first                        |
| `limit`     | int      | default 20, max 50                                                |

`200` → `data`: cursor-paginated list of [`CommunityListItem`](#2-shared-data-types):

```jsonc
{
  "data": [
    /* CommunityListItem[] */
  ],
  "pagination": {
    "totalData": 0,
    "totalPage": 1,
    "currentPage": 1,
    "limit": 20,
    "nextCursor": "1718000000000",
    "hasMore": true,
  },
  "hasMore": true,
  "nextCursor": "1718000000000", // feed back as the next before_ts
}
```

**Search mode** (offset) — pass `q` and/or `categoryId` (no timestamp):

| Param           | Type     | Notes                                                                        |
| --------------- | -------- | ---------------------------------------------------------------------------- |
| `q`             | string   | 1–100 chars                                                                  |
| `categoryId`    | ObjectId | filter by category                                                           |
| `filter`        | enum     | `all` (default) \| `live` \| `upcoming` (live/upcoming reserved for streams) |
| `page`, `limit` | int      | offset pagination                                                            |

`200` → `data`: offset-paginated list of [`CommunityDiscoverItem`](#2-shared-data-types) (with `unreadMessageCount` and `lastActivity` populated). Pagination wins if both modes' params are sent.

#### `GET /discover` — Public browse _(deprecated — prefer `/mine`)_

Same query as search mode but **excludes** communities you've already joined. Query: `q?`, `categoryId?`, `filter`, `page`, `limit`. `200` → offset-paginated `CommunityDiscoverItem[]`.

---

### 3.3 Categories

DTO:

```ts
interface CommunityCategoryData {
  id: string;
  name: string;
  slug: string;
}
interface AdminCategoryData {
  id: string;
  name: string;
  slug: string;
  visible: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
}
```

#### `GET /categories` — List active categories (public)

No params. `200` → `data`: `{ "categories": CommunityCategoryData[] }`.

#### `GET /categories/admin` — Admin list

**Role:** admin. Query: `search?`, `status` (`visible`|`hidden`|`all`, default `all`), `page`, `limit`. `200` → `data`:

```jsonc
{
  "categories": [
    /* AdminCategoryData[] */
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0,
    "hasNext": false,
    "hasPrev": false,
  },
}
```

#### `POST /categories` — Create _(admin)_

Body: `{ "name": "Food" }` (2–80 chars). `201` → `AdminCategoryData`.

#### `PATCH /categories/:categoryId` — Update _(admin)_

Body: `{ "name"?: string, "visible"?: boolean }` (at least one). `200` → `AdminCategoryData`.

#### `DELETE /categories/:categoryId` — Delete _(admin)_

`200` → `data: null`.

---

### 3.4 Membership

#### `POST /:id/join` — Join (PUBLIC)

No body. Creates a join request. `201` → `CommunityJoinRequestData` (see [3.6](#36-join-requests)).

#### `POST /:id/leave` — Leave

Body (all optional):

```jsonc
{ "reason": "TOO_MANY_NOTIFICATIONS", "reasonText": "..." }
```

`reason` enum: `TOO_MANY_NOTIFICATIONS`, `NOT_RELEVANT`, `COMMUNITY_INACTIVE`, `TOO_MANY_MESSAGES`, `PRIVACY_CONCERN`, `JOINED_BY_MISTAKE`, `TAKING_A_BREAK`, `OTHER`. `reasonText` (≤500) is **required when** `reason = "OTHER"`. `200` → updated `CommunityMemberData`.

#### `POST /leave/bulk` — Leave many

Body: `{ "communityIds": ["<oid>", ...] }` (1–50). `200` → result summary.

#### `POST /:id/members` — Add members

**Role:** ADMIN / MODERATOR. Body: `{ "userIds": ["<uuid>", ...] }` (1–100). `201` → `data`:

```jsonc
{
  "added": [
    /* CommunityMemberData[] */
  ],
  "skipped": [{ "userId": "<uuid>", "reason": "ALREADY_MEMBER" }], // ALREADY_MEMBER | BANNED | NOT_FRIEND
}
```

#### `GET /:id/members` — List members

Query: `page`, `limit`, `status?` (`ACTIVE`|`PENDING`|`BANNED`|`LEFT`). `200` → offset-paginated `CommunityMemberData[]`.

#### `PUT /:id/members/:userId/role` — Change role

**Role:** ADMIN. Body: `{ "role": "MODERATOR" | "MEMBER" }`. `200` → `CommunityMemberData`.

#### `DELETE /:id/members/:userId` — Kick

**Role:** ADMIN / MODERATOR. Body: `{ "reason"?: string }` (≤500). `200` → `CommunityMemberData`.

#### `POST /:id/members/:userId/ban` — Ban

**Role:** ADMIN / MODERATOR. Body: `{ "reason"?: string }`. `200` → `CommunityMemberData`.

#### `DELETE /:id/members/:userId/ban` — Unban

`200` → `CommunityMemberData`.

#### `POST /:id/transfer-admin` — Transfer ownership

**Role:** ADMIN. Body: `{ "userId": "<uuid>" }`. `200` → `CommunityData`.

#### `GET /:id/audit-logs` — Moderation log

**Role:** ADMIN / MODERATOR. Query: `page`, `limit`. `200` → offset-paginated rows:

```ts
interface CommunityAuditLogData {
  id: string;
  communityId: string;
  actorId: string;
  action: string; // e.g. MEMBER_BANNED, JOIN_REQUEST_APPROVED, INVITE_LINK_CREATED, ...
  targetUserId: string | null;
  reason: string | null;
  metadata: unknown;
  createdAt: string;
}
```

---

### 3.5 Member moderation (mute / warn)

DTOs:

```ts
interface CommunityMutedMemberData {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  avatar: MediaObject;
  mutedBy: string;
  reason: string | null;
  mutedAt: string;
  mutedUntil: string | null;
}
interface CommunityMemberWarningData {
  warningId: string;
  userId: string;
  warnedBy: string;
  note: string;
  createdAt: string;
}
```

#### `GET /:id/muted-members` — List muted _(MODERATOR+)_

Query: `page`, `limit`. `200` → offset-paginated `CommunityMutedMemberData[]`.

#### `POST /:id/members/:userId/mute` — Mute member _(MODERATOR+)_

Body: `{ "durationMinutes"?: number, "reason"?: string }` — `durationMinutes` 1–525600 (365 d); `null`/omit = indefinite. `200` → `CommunityMutedMemberData`.

#### `DELETE /:id/members/:userId/mute` — Unmute _(MODERATOR+)_

`200` → `data: null`.

#### `POST /:id/members/:userId/warn` — Warn _(MODERATOR+)_

Body: `{ "note": "..." }` (1–1000 chars, required). `201` → `CommunityMemberWarningData`.

#### `GET /:id/members/:userId/warnings` — List warnings _(MODERATOR+)_

Query: `page`, `limit`. `200` → offset-paginated `CommunityMemberWarningData[]`.

---

### 3.6 Join requests

DTOs:

```ts
interface CommunityJoinRequestData {
  requestId: string;
  communityId: string;
  userId: string;
  status: JoinRequestStatus;
  message: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
// Moderator list rows add `user: { userId, username, displayName, avatarUrl, avatarUrlExpiresIn, avatar }`
// "Mine" list rows add `community: { id, name, handle, type, memberCount, memberLimit, avatarUrl, ... }`
```

#### `POST /:id/join-requests` — Request to join

Body: `{ "message"?: string }` (≤500). `201` → `CommunityJoinRequestData`.

#### `GET /:id/join-requests` — List _(MODERATOR+)_

Query: `page`, `limit`, `status?`. `200` → offset-paginated rows enriched with `user`.

#### `GET /join-requests/mine` — My requests

Query: `page`, `limit`, `status?`. `200` → rows enriched with `community`.

#### `POST /:id/join-requests/:requestId/approve` — Approve _(MODERATOR+)_

#### `POST /:id/join-requests/:requestId/reject` — Reject _(MODERATOR+)_

No body. `200` → `CommunityJoinRequestData`.

#### `DELETE /:id/join-requests/mine` — Cancel my own pending request

No body. Cancels the authenticated caller's **PENDING** request for the given
community. Returns `400 COMMUNITY_JOIN_REQUEST_NOT_PENDING` if the request was
already approved or rejected.

`200` → `CommunityJoinRequestData` (status: `"CANCELLED"`).

> Use this instead of `/:requestId` when you only have the `communityId` (e.g.
> from `GET /communities/:id`'s new `joinRequestId` field). The server resolves
> the request from the caller's token — no `requestId` needed.

#### `DELETE /:id/join-requests/:requestId` — Cancel by request ID (self)

`200` → `CommunityJoinRequestData`.

---

### 3.7 Invites

DTO:

```ts
interface CommunityInviteData {
  inviteId: string;
  communityId: string;
  inviterId: string;
  inviteeId: string;
  status: InviteStatus;
  createdAt: string;
  updatedAt: string;
}
// Moderator list adds `invitee: {...}`; "mine" list adds `community: {...}`.
```

#### `POST /:id/invites` — Invite a user _(MODERATOR+)_

Body: `{ "inviteeId": "<uuid>" }`. `201` → `CommunityInviteData`.

#### `GET /:id/invites` — List _(MODERATOR+)_

Query: `page`, `limit`, `status?`. `200` → rows enriched with `invitee`.

#### `GET /invites/mine` — My received invites

Query: `page`, `limit`, `status?`. `200` → rows enriched with `community`.

#### `POST /invites/:inviteId/accept` — Accept

#### `POST /invites/:inviteId/decline` — Decline

No body. `200` → `CommunityInviteData`.

---

### 3.8 Invite links

DTO:

```ts
interface CommunityInviteLinkData {
  linkId: string;
  code: string;
  url: string;
  communityId: string;
  createdBy: string;
  maxUses: number | null;
  usedCount: number;
  autoApprove: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  isActive: boolean; // computed: not revoked, not expired, not exhausted
}
```

#### `POST /:id/invite-links` — Create _(MODERATOR+)_

Body (all optional): `{ "maxUses"?: 1–1000, "expiresInMinutes"?: 1–525600, "autoApprove"?: boolean }`. `201` → `CommunityInviteLinkData`.

#### `GET /:id/invite-links` — List

Query: `page`, `limit`, `status?` (`active`|`expired`|`revoked`). `200` → offset-paginated links.

#### `DELETE /:id/invite-links/:linkId` — Revoke

`200` → `CommunityInviteLinkData`.

#### `POST /invite-links/:code/redeem` — Redeem a code

Path `code`. Joins / requests-to-join via the link. `200` → result.

#### `POST /:id/invite-links/bulk-send` — DM a link to users _(MODERATOR+)_

Body: `{ "userIds": ["<oid>", ...] /* 1–50 */, "linkId"?: "<oid>" }`. When `linkId` is omitted the service reuses the first active link or creates one. `200` → fan-out result.

---

### 3.9 Reports

DTO:

```ts
interface CommunityReportData {
  reportId: string;
  communityId: string;
  reporterId: string;
  targetUserId: string | null;
  reason: string;
  status: ReportStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}
// Moderator list adds `reporter: {...}` and `target: {...} | null`; "mine" list adds `community: {...}`.
```

#### `POST /:id/reports` — Create report

Body: `{ "targetUserId"?: "<uuid>", "reason": "..." }` (`reason` 3–1000 chars). `201` → `CommunityReportData`.

#### `GET /:id/reports` — List _(MODERATOR+)_

Query: `page`, `limit`, `status?`. `200` → rows enriched with `reporter`/`target`.

#### `GET /reports/mine` — My filed reports

Query: `page`, `limit`, `status?`. `200` → rows enriched with `community`.

#### `POST /:id/reports/:reportId/review` — Mark reviewed _(MODERATOR+)_

#### `POST /:id/reports/:reportId/action` — Action _(MODERATOR+)_

#### `POST /:id/reports/:reportId/dismiss` — Dismiss _(MODERATOR+)_

Body: `{ "resolution"?: string }` (≤1000). `200` → `CommunityReportData`.

#### `POST /:id/reports/:reportId/withdraw` — Withdraw (reporter, OPEN only)

No body. `200` → `CommunityReportData`.

#### `DELETE /:id/reports/:reportId` — Hard delete _(MODERATOR+)_

`200` → `data: null`.

---

### 3.10 Mute settings

Per-community mute, **for yourself** (distinct from moderation mute in 3.5).

DTO:

```ts
interface CommunityMuteData {
  communityId: string;
  mutedUntil: string | null; // null = indefinite
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

#### `GET /:id/mute` — Get my mute state → `CommunityMuteData`

#### `PUT /:id/mute` — Set mute

Body: `{ "durationMinutes"?: number }` (1–525600; null/omit = indefinite). `200` → `CommunityMuteData`.

#### `DELETE /:id/mute` — Clear mute → `data: null`

#### `POST /mute/bulk` — Bulk mute / unmute

Body:

```jsonc
{ "action": "mute", "communityIds": ["<oid>", ...], "durationMinutes": 60 }
// action: "mute" | "unmute"; communityIds 1–50; durationMinutes optional
```

`200` → result summary.

#### `POST /read/bulk` — Bulk mark read

Body: `{ "communityIds": ["<oid>", ...] }` (1–50). `200` → result summary.

---

### 3.11 Notification preferences

DTO:

```ts
interface CommunityNotificationPreferenceData {
  communityId: string;
  mutedUntil: string | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  isMuted: boolean; // derived: true when all three toggles are off
  createdAt: string | null;
  updatedAt: string | null;
}
```

#### `GET /:id/notification-preferences` — Get → `CommunityNotificationPreferenceData`

#### `PUT /:id/notification-preferences` — Set

Body (at least one field): `{ "streamEnabled"?: boolean, "chatEnabled"?: boolean, "announcementEnabled"?: boolean }`. `200` → `CommunityNotificationPreferenceData`.

---

### 3.12 Likes / favorites

DTO: `interface CommunityFavoriteData { favoriteId: string; communityId: string; createdAt: string }`

#### `POST /:id/like` — Like → `201` `CommunityFavoriteData`

#### `DELETE /:id/like` — Unlike → `200` `data: null`

#### `GET /liked` — List liked

Cursor query: `cursor?`, `limit` (default 20). `200` → `{ items: (CommunityDiscoverItem & { likedAt: string })[], nextCursor, hasMore }`.

---

### 3.13 Uploads

#### `POST /uploads/url` — Presigned upload URL

Use to upload a community avatar, then pass the returned object key as `avatarObjectKey` on create/update. Body follows the upload-URL schema (file name, mime, size). `200` → `{ uploadUrl, objectKey, ... }` (a `MediaObject`-style payload).

---

## 4. Community chat API

Base: `{{BASE}}/api/chat/community`. `:roomId` is a community's chat room (each community has at least a general room).

**Message DTO** (the "wire" shape returned by every timeline/sync/search endpoint — note `messageType` is serialized as **`contentType`**):

```ts
interface CommunityMessage {
  id: string;
  roomId: string;
  sentBy: string; // sender userId
  senderName: string | null;
  senderAvatar: string | null;
  message: string | null; // text body
  contentType: string; // TEXT | IMAGE | VIDEO | VOICE | AUDIO | DOCUMENT | GIF | LOCATION | CONTACT | STICKER | CUSTOM
  attachments: unknown[]; // media files
  reactions: Record<
    string,
    Array<{ userId: string; userName: string; avatar: string }>
  >;
  parentMessageId: string | null; // reply target
  quoteData: object | null; // reply snapshot
  clientMessageId: string | null; // idempotency key echoed back
  deletedForAll: boolean;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### 4.1 Rooms

| Method & path               | Description                  | Returns        |
| --------------------------- | ---------------------------- | -------------- |
| `GET /rooms`                | My community rooms           | room list      |
| `GET /rooms/search?query=`  | Search rooms (`query` 1–100) | matching rooms |
| `POST /rooms/:roomId/join`  | Join room (no body)          | membership     |
| `POST /rooms/:roomId/leave` | Leave room (no body)         | membership     |

### 4.2 Messages

#### `GET /rooms/:roomId/messages` — Timeline

Query (all optional; `before_ts`/`after_ts` mutually exclusive):

| Param       | Meaning                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `before_ts` | epoch ms — history/scroll: `createdAt <= before_ts`, newest-first, live messages only                                  |
| `after_ts`  | epoch ms — incremental sync: ALL mutations (new/edited/reacted/tombstones) where `updatedAt >= after_ts`, oldest-first |
| `around`    | messageId — jump-to-message window                                                                                     |
| `limit`     | 1–100, default 30                                                                                                      |

`200` → paginated envelope (`before_ts`/`around` use the full `pagination` block; `after_ts` returns `{ data, hasMore, nextCursor }`). `data` is `CommunityMessage[]`; feed `nextCursor` back as the next `before_ts`/`after_ts`.

#### `GET /rooms/:roomId/sync?since_ts=<ms>&limit=<n>` — Incremental sync

Query: `since_ts` (epoch ms, **required**), `limit` (1–200, default 50). Returns every mutation since the cursor, oldest-first. Store the highest `updatedAt` seen and feed it back. `200` → `{ data: CommunityMessage[], ... }`.

#### `GET /rooms/:roomId/conversation` — Offset paged

Query: `pageNumber` (≥1, default 1), `limit` (1–100, default 30), `timestamp?` (epoch ms `createdAt <` boundary). `200` → page of `CommunityMessage[]`.

#### `GET /rooms/:roomId/messages/search?q=...` — Search in room

Query: `q?` (≤100), `cursor?`, `limit?` (1–100). `200` → matches.

#### `GET /rooms/:roomId/media` — Shared media / docs

Query: `type?` (`IMAGE`|`VIDEO`|`GIF`|`VOICE`|`DOCUMENT`|`STICKER`), `cursor?`, `limit` (1–100, default 30). `200` → media items.

#### `PATCH /messages/:messageId` — Edit _(own, text-only, ≤15 min; 30/min)_

Body: `{ "communityId": "<id>", "content": { "text": "new text" } }` (text 1–4000). `200` → updated `CommunityMessage`.

#### `DELETE /messages/:messageId` — Delete _(30/min)_

`200` → tombstone / result.

#### `POST /messages/:messageId/react` — React _(30/min)_

Body: `{ "communityId": "<id>", "emoji": "👍" }` (emoji 1–10). `200` → updated reactions.

### 4.3 Pins

| Method & path                                                                 | Role       | Notes                                  |
| ----------------------------------------------------------------------------- | ---------- | -------------------------------------- |
| `POST /rooms/:roomId/pins` (or `POST /rooms/:roomId/messages/:messageId/pin`) | MODERATOR+ | Body `{ "communityId"?: "<id>" }`      |
| `DELETE /rooms/:roomId/pins/:messageId`                                       | MODERATOR+ | Query `communityId` required           |
| `DELETE /rooms/:roomId/messages/:messageId/pin`                               | MODERATOR+ | Body `{ "messageId", "communityId"? }` |
| `GET /rooms/:roomId/pins`                                                     | member     | List pinned messages                   |

---

## 5. Real-time Socket.IO contract

Connect to the **`/community`** namespace with your access token (same auth as REST). On connect you auto-join your personal room `user:<userId>`. To receive a community's broadcasts you must emit `community:join` first.

### 5.1 Client → server

Each event takes a payload and an optional ack callback `(res) => {}`. Ack shape: `{ ok: true, data }` or `{ ok: false, code }`.

| Event                      | Payload                                                 | Purpose                                                                 |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `community:join`           | `{ communityId, roomId }`                               | Join the room to receive broadcasts                                     |
| `community:leave`          | `{ communityId }`                                       | Leave the room                                                          |
| `community:message:send`   | see below                                               | Send a message                                                          |
| `community:messages:fetch` | `{ roomId, cursor?, limit? }`                           | Page (cursor = ISO datetime, not future; limit ≤100, default 30)        |
| `community:message:react`  | `{ messageId, communityId, emoji }`                     | Toggle a reaction (emoji ≤32)                                           |
| `community:message:edit`   | `{ messageId, communityId, roomId, content: { text } }` | Edit (text 1–4000)                                                      |
| `community:message:delete` | `{ messageId, communityId, roomId, type }`              | `type`: `"forEveryone"` \| `"forMe"`                                    |
| `community:message:pin`    | `{ messageId, communityId, roomId }`                    | Pin (MODERATOR+)                                                        |
| `community:message:unpin`  | `{ messageId, communityId, roomId }`                    | Unpin (MODERATOR+)                                                      |
| `community:catchup`        | `{ rooms: [{ roomId, sinceId?, sinceTs?, limit? }] }`   | Reconnect gap-fill, 1–20 rooms (`sinceTs` epoch ms wins over `sinceId`) |

`community:message:send` payload:

```jsonc
{
  "communityId": "<id>",
  "roomId": "<id>",
  "clientMessageId": "uuid-for-idempotency", // optional but recommended
  "message": "Hello", // ≤4000
  "contentType": "TEXT", // uppercased; TEXT | IMAGE | VIDEO | VOICE | AUDIO | DOCUMENT | GIF | LOCATION | CONTACT | STICKER | CUSTOM
  "parentMessageId": "<id>", // optional, reply
  "media": {
    "files": [
      // ≤30 files
      {
        "url": "https://...",
        "objectKey": "uploads/...",
        "name": "pic.jpg",
        "size": 12345,
        "mime": "image/jpeg",
        "width": 800,
        "height": 600,
        "durationMs": 0,
        "blurhash": "...",
        "waveform": [
          /* ≤2048 numbers */
        ],
      },
    ],
  },
  "location": {
    "lat": 21.0,
    "lng": 105.8,
    "placeName": "...",
    "placeAddress": "...",
  },
  "contact": {
    "name": "Jane",
    "phone": "+84...",
    "avatar": "...",
    "userId": "...",
  },
  "sticker": {
    "objectKey": "...",
    "url": "https://...",
    "packId": "...",
    "stickerId": "...",
  },
}
```

Send only the sub-object matching `contentType`.

### 5.2 Server → client

Backend services publish to the Redis channel `community:<communityId>`; the gateway fans them out to everyone in that room. Listen for:

| Event                                                     | Meaning                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `community:message:new`                                   | A new message arrived (payload = `CommunityMessage`)                    |
| `community:message:edited`                                | A message was edited                                                    |
| `community:message:deleted`                               | Tombstone                                                               |
| `community:message:reacted`                               | Reaction changed                                                        |
| `community:message:pinned` / `community:message:unpinned` | Pin state changed                                                       |
| `community:member:joined`                                 | A member joined                                                         |
| `community:updated`                                       | Community/room bumped — re-sort your list                               |
| `community:catchup:result`                                | Per-room gap-fill: `{ roomId, events: [...], hasMore, lastId, nextTs }` |

---

## 6. React integration notes

- **One fetch helper.** Prepend `/api/v1/communities` or `/api/chat/community`, attach the bearer token, and unwrap `response.data` from the `{ success, message, data }` envelope.
- **Lists with TanStack Query.** Use `useInfiniteQuery`. For cursor endpoints, `getNextPageParam` returns `nextCursor` (feed as the next `before_ts`). For offset endpoints, increment `page` while `pagination.hasMore` is true.
- **Chat = socket + REST.** Keep the `/community` namespace as the live source; use the REST `messages` / `sync` endpoints to backfill history and reconcile after reconnect (`after_ts` / `since_ts`).
- **Idempotency.** Always send `clientMessageId` on `community:message:send` so retries don't duplicate — it's echoed back on the message.
- **Optimistic UI.** Render the message immediately keyed by `clientMessageId`, then reconcile when the send ack (or `community:message:new`) returns the server `id`.
- **Presigned URLs expire.** `avatarUrl` / `downloadUrl` come with `*ExpiresIn` (seconds); refetch the resource if a URL has aged out rather than caching it indefinitely.
- **Mirror validation client-side** (name 3–50, handle `[a-z0-9_]` 3–32, text ≤4000, emoji ≤10, etc.) to avoid round-trip `400`s.
