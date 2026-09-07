# User Search — Frontend Integration Guide

Base path: `/api/v1/users/search` (proxied through api-gateway → user-service).
All endpoints require `Authorization: Bearer <accessToken>`.

> **This endpoint is no longer the way to search for people.** Global search is
> now one unified API — `GET /api/v1/search?q=&filter=people&cursor=&limit=` —
> which calls this one for you and pages it properly. See
> [GLOBAL_SEARCH_MOBILE_GUIDE.md](./GLOBAL_SEARCH_MOBILE_GUIDE.md).
> What is still yours to call directly is the **recent-searches** subsystem in
> §1 and §3-5 below, plus the no-`q` form of §2 that backs the "Recent" list on
> an empty search box.

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
| `page`  | integer | `1`     | Offset paging for the `other` section only. Prefer `cursor`.                                                                          |
| `cursor`| string  | —       | Opaque keyset cursor over `other`, echoed back as `nextCursor`. On a cursor page `chat` is **omitted** — it is a bounded head, served on page 1 only. |
| `limit` | integer | `10`    | Max **50**. Caps the `chat` and `other` sections. (Was capped at 10, which made `limit=20` a 400 rather than a clamp.)                 |

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
      /* up to 10 items, newest first */
    ],
    "chat": [
      /* up to `limit` items, default 10 */
    ],
    "other": [
      /* up to `limit` items, default 10, paged via `cursor` (or legacy `page`) */
    ],
    "hasMore": false,
    "nextCursor": null
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
  "roomId": "room_abc123",
  "isFriend": true,
  "relationshipStatus": "FRIEND",
  "friendshipId": "fr_abc123"
}
```

- `roomId` is `null` when no private room exists with this user yet — treat
  the "message" action for that item as "start a new conversation" rather
  than "open room `roomId`".
- `isFriend` is the explicit friendship indicator — `true` only for an
  **ACCEPTED** friendship, **independent of `roomId`**. A friend you've never
  messaged lands in `other` with `roomId: null` **and** `isFriend: true`.
  Never infer friendship from `roomId`.
- `relationshipStatus` (`FRIEND` | `PENDING_IN` | `PENDING_OUT` | `NONE`) is
  the richer form; `PENDING_IN` = they requested you, `PENDING_OUT` = you
  requested them. `friendshipId` is the row id for accept/cancel/unfriend
  actions (`null` when `NONE`). Group items carry none of these fields.

Distinguish the three states the FE cares about from any `USER` item:

| State         | `isFriend` | `roomId` |                               |
| ------------- | ---------- | -------- | ----------------------------- |
| Existing chat | either     | non-null | private conversation exists   |
| Friend        | `true`     | any      | friends regardless of a room  |
| Stranger      | `false`    | `null`   | not a friend, no conversation |

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

**`chat`/`other` is a conversation split, not a friendship split.** It reflects
only whether a private room exists, not whether the two users are friends. To
render friendship state (badge, "Add friend" button, pending request), read
`isFriend` / `relationshipStatus` on each item — not which section it came from.

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
| `400`  | Invalid `q`/`page`/`limit` (e.g. `limit` > 50) |
| `401`  | Missing/expired/invalid access token           |
