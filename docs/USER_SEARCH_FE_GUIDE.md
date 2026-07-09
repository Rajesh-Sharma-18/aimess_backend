# User Search — Frontend Integration Guide

Base path: `/api/v1/users/search` (proxied through api-gateway → user-service).
All endpoints require `Authorization: Bearer <accessToken>`.

---

## 1. `POST /api/v1/users/search/recent`

Records that the caller just viewed a User or Group. Call this when the user
taps into a profile or a group from search results (or from anywhere else in
the app you want reflected in "Recent").

### Request

```json
{
  "targetType": "USER",
  "targetId": "660e8400-e29b-41d4-a716-446655440001"
}
```

| Field        | Type                  | Notes                                                                  |
| ------------ | --------------------- | ---------------------------------------------------------------------- |
| `targetType` | `"USER"` \| `"GROUP"` | required                                                               |
| `targetId`   | string, 1–64 chars    | `USER` → the target's `userId` (UUID). `GROUP` → the group's `roomId`. |

Do **not** send a `roomId` — it is intentionally not part of this contract.
`roomId` is always resolved dynamically when the list is read back (a room
may not exist yet at record time, or membership can change later).

### Behavior

- Upsert key is `(caller, targetType, targetId)`. Viewing the same target
  again just bumps its `lastViewedAt` — no duplicate entries.
- The list is capped at 20 entries per user; the oldest are pruned
  automatically once the cap is exceeded.

### Response

```json
{ "success": true, "message": "Recently viewed item saved.", "data": null }
```

`201 Created`. `400` on validation failure. `401` if unauthenticated.

---

## 2. `GET /api/v1/users/search`

### Query parameters

| Param   | Type    | Default | Notes                                                                                                                                 |
| ------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `q`     | string  | —       | Optional. Matched against username, firstName, lastName, and full name (Users), and name (Groups). Applied to **all three** sections. |
| `page`  | integer | `1`     | Paginates the `other` section only.                                                                                                   |
| `limit` | integer | `10`    | Max 10. Caps the `chat` and `other` sections.                                                                                         |

If `q` is omitted, the endpoint returns: `recent` (latest viewed), `chat`
(most recently active), `other` (a suggested set) — i.e. a sensible
"empty state" screen.

### Response shape

```json
{
  "success": true,
  "message": "Users retrieved successfully.",
  "data": {
    "recent": [
      /* up to 4 items */
    ],
    "chat": [
      /* up to `limit` items, default 10 */
    ],
    "other": [
      /* up to `limit` items, default 10, paginated via `page` */
    ]
  }
}
```

Every item is one of two shapes, discriminated by `type`:

**User item**

```json
{
  "type": "USER",
  "userId": "660e8400-e29b-41d4-a716-446655440001",
  "username": "janedoe",
  "firstName": "Jane",
  "lastName": "Doe",
  "fullName": "Jane Doe",
  "avatarUrl": "https://.../avatars/...",
  "avatarUrlExpiresIn": 3600,
  "avatar": { "url": "...", "expiresIn": 3600 },
  "isOnline": false,
  "roomId": "room_abc123"
}
```

- `roomId` is `null` when no private room exists with this user yet — treat
  the "message" action for that item as "start a new conversation" rather
  than "open room `roomId`".
- `avatarUrl`/`avatarUrlExpiresIn` are the legacy flat fields; `avatar` is
  the nested `MediaObject` — use whichever your client already standardizes
  on, both are populated identically.

**Group item**

```json
{
  "type": "GROUP",
  "roomId": "room_group456",
  "name": "Weekend Hikers",
  "avatar": "",
  "description": "",
  "memberCount": 12,
  "isActiveMember": true
}
```

- `roomId` here is also the group's stable identifier — always present
  (a Group result never has a null roomId).
- `isActiveMember` tells you whether tapping should open the group chat
  directly (`true`) or show a "join" affordance (`false`).

### Section semantics

| Section  | Contents                                                                                                                                                                                               | Cap            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `recent` | Latest recently-viewed Users/Groups (from step 1 above), newest-viewed first. `roomId` re-resolved live on every call — a group that was disbanded, or that you left, silently drops out of this list. | 4              |
| `chat`   | Private Users you already have a room with (any prior interaction) + Groups you actively belong to.                                                                                                    | 10             |
| `other`  | Private Users you have **no** room with + Groups you are **not** an active member of. Never duplicates anything already shown in `recent` or `chat`.                                                   | 10 (paginated) |

Blocked users (either direction) never appear in any section.

### Suggested FE flow

1. On opening the search screen with an empty query, call
   `GET /api/v1/users/search` (no `q`) and render `recent` / `chat` / `other`
   as three labeled sections (e.g. "Recent", "Chats", "Suggested" or
   "People you may know").
2. As the user types, debounce and re-call with `q` — re-render the same
   three sections; `other` becomes true search results rather than
   suggestions.
3. When the user taps a result:
   - Fire-and-forget `POST /api/v1/users/search/recent` with the tapped
     item's `type`/`id` so it surfaces in `recent` next time.
   - If it's a `USER` item with a non-null `roomId`, navigate straight into
     that room. If `roomId` is `null`, navigate into a "new conversation"
     flow (a room is created on first send, via the existing chat APIs).
   - If it's a `GROUP` item with `isActiveMember: true`, open the group
     chat by its `roomId`. If `false`, show the group's join/preview screen.
4. For infinite scroll on `other`, increment `page` (1-indexed) with the
   same `limit`; `recent` and `chat` are not paginated — always re-fetch
   page 1 for those two sections.

### Errors

| Status | When                                           |
| ------ | ---------------------------------------------- |
| `400`  | Invalid `q`/`page`/`limit` (e.g. `limit` > 10) |
| `401`  | Missing/expired/invalid access token           |
