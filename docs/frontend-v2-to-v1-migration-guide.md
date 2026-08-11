# Frontend Migration Guide — `/api/v2` is gone, everything is on `/api/v1`

**Audience:** Web, Android, iOS
**Backend branch:** `refactor/v1-to-v2-migration`
**Backend audit:** [`docs/v2-to-v1-consolidation-audit.md`](./v2-to-v1-consolidation-audit.md)
**Supersedes:** `docs/CLIENT_V2_MIGRATION_RULEBOOK.md` (deleted — its core instruction, "timestamp pagination is gone, delete `before_ts`", is no longer true)

---

## Overview

### Why

`/api/v2` was never a second version of the API. It was a **parallel pagination-contract variant of 12 endpoints**, against ~276 on `/api/v1`. Keeping it meant two URLs, two envelopes, and two client code paths for the same 12 capabilities, permanently — and it split the client contract with no end state.

Every V2 capability has been folded into its `/api/v1` endpoint. `/api/v2` no longer exists: the gateway does not mount it, and requests to it now **404**.

### What this means for you

- **If you only ever called `/api/v1`:** nothing changed. Not one V1 request, parameter, or response field behaves differently. Skip to [Added fields](#added-fields-v1-gained-these-all-optional) and [Response Changes](#response-changes) to see what you gained for free.
- **If you called any `/api/v2` endpoint:** you must change those calls. There are at most 12 of them. Most are a path swap; four also need a response-reader change.

### Summary of changes

|                                                      | Count            |
| ---------------------------------------------------- | ---------------- |
| V1 endpoints removed                                 | **0**            |
| V1 requests whose behavior changed                   | **0**            |
| V2 endpoints removed                                 | 12 (all of them) |
| V2 endpoints that need only a base-URL/path change   | 8                |
| V2 endpoints that also need a response-reader change | 4                |

---

## Removed APIs

Every one of these now returns 404.

| #   | Removed V2 endpoint                                    |
| --- | ------------------------------------------------------ |
| 1   | `GET /api/v2/communities/mine`                         |
| 2   | `GET /api/v2/chat/inbox`                               |
| 3   | `GET /api/v2/chat/private/rooms/{roomId}/messages`     |
| 4   | `GET /api/v2/chat/private/rooms/{roomId}/changes`      |
| 5   | `POST /api/v2/chat/private/messages/{messageId}/react` |
| 6   | `GET /api/v2/chat/group/rooms/{roomId}/messages`       |
| 7   | `GET /api/v2/chat/group/rooms/{roomId}/changes`        |
| 8   | `DELETE /api/v2/chat/group/messages/{messageId}`       |
| 9   | `POST /api/v2/chat/group/messages/{messageId}/react`   |
| 10  | `GET /api/v2/chat/community/rooms/{roomId}/messages`   |
| 11  | `GET /api/v2/chat/community/rooms/{roomId}/changes`    |
| 12  | `GET /api/v2/chat/community/rooms/{roomId}/sync`       |

---

## Replacement APIs

| Old API (V2)                                     | New API (V1)                                     | Notes                                                                                   |
| ------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `GET /api/v2/communities/mine`                   | `GET /api/v1/communities/mine`                   | Same `cursor` param, same response. **Path swap only.**                                 |
| `GET /api/v2/chat/inbox`                         | `GET /api/v1/chat/inbox`                         | Same `before_cursor`/`after_cursor`. **Envelope differs — see below.**                  |
| `GET /api/v2/chat/private/rooms/{id}/messages`   | `GET /api/v1/chat/private/rooms/{id}/messages`   | Same `before_seq`/`after_seq`/`around`. **Envelope differs.**                           |
| `GET /api/v2/chat/private/rooms/{id}/changes`    | `GET /api/v1/chat/private/rooms/{id}/changes`    | Identical request and response. **Path swap only.**                                     |
| `POST /api/v2/chat/private/messages/{id}/react`  | `POST /api/v1/chat/private/messages/{id}/react`  | Identical. **Path swap only.**                                                          |
| `GET /api/v2/chat/group/rooms/{id}/messages`     | `GET /api/v1/chat/groups/{id}/messages`          | ⚠️ **Path shape changes** — plural `groups`, no `/rooms` segment. **Envelope differs.** |
| `GET /api/v2/chat/group/rooms/{id}/changes`      | `GET /api/v1/chat/groups/{id}/changes`           | ⚠️ **Path shape changes** (as above). Response identical.                               |
| `DELETE /api/v2/chat/group/messages/{id}`        | `DELETE /api/v1/chat/groups/messages/{id}`       | Identical apart from the prefix.                                                        |
| `POST /api/v2/chat/group/messages/{id}/react`    | `POST /api/v1/chat/groups/messages/{id}/react`   | Identical apart from the prefix.                                                        |
| `GET /api/v2/chat/community/rooms/{id}/messages` | `GET /api/v1/chat/community/rooms/{id}/messages` | Same `before_seq`/`after_seq`/`around`. **Envelope differs.**                           |
| `GET /api/v2/chat/community/rooms/{id}/changes`  | `GET /api/v1/chat/community/rooms/{id}/changes`  | Identical request and response. **Path swap only.**                                     |
| `GET /api/v2/chat/community/rooms/{id}/sync`     | `GET /api/v1/chat/community/rooms/{id}/sync`     | Was already an exact duplicate of the V1 route. **Path swap only.**                     |

### The one path-shape trap

V2 chat used the singular `group` with a `/rooms/` segment. V1 uses the plural `groups` with the room id directly. Do not just replace `v2` with `v1` on group URLs:

```text
WRONG   /api/v1/chat/group/rooms/grp_abc/messages     → 404
RIGHT   /api/v1/chat/groups/grp_abc/messages
```

The same applies to `/changes`. The `react` and `delete` group routes keep their `messages/{messageId}` tail and only change the prefix:

```text
/api/v1/chat/groups/messages/{messageId}/react
/api/v1/chat/groups/messages/{messageId}
```

---

## Request Changes

**No V2 request parameter was renamed, removed, or given different semantics.** Everything V2 accepted, V1 now accepts, spelled identically:

| Endpoint                                  | Params carried over from V2 unchanged        |
| ----------------------------------------- | -------------------------------------------- |
| `GET /communities/mine`                   | `cursor`                                     |
| `GET /chat/inbox`                         | `before_cursor`, `after_cursor`              |
| `GET /chat/private/rooms/{id}/messages`   | `before_seq`, `after_seq`, `around`, `limit` |
| `GET /chat/groups/{id}/messages`          | `before_seq`, `after_seq`, `around`, `limit` |
| `GET /chat/community/rooms/{id}/messages` | `before_seq`, `after_seq`, `around`, `limit` |
| `GET …/changes` (all three room kinds)    | `since_revision`, `limit`                    |
| `POST …/react`                            | body `{ emoji }`                             |
| `DELETE /chat/groups/messages/{id}`       | `type=forMe\|forEveryone`                    |

### Added fields (V1 gained these; all optional)

| Endpoint                                  | Added                           | Meaning                                                                                                                        |
| ----------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /communities/mine`                   | `cursor`                        | Opaque compound `(lastActivityAt, id)` keyset, **exclusive**. Preferred over `before_ts`/`after_ts`. Wins if both are sent.    |
| `GET /chat/inbox`                         | `before_cursor`, `after_cursor` | Opaque compound `(lastMessageAt, roomId)` keyset, **exclusive**. Preferred over `before_ts`/`after_ts`. Wins if both are sent. |
| `GET /chat/community/rooms/{id}/messages` | `before_seq`, `after_seq`       | Gap-safe monotonic `sequenceNumber` keyset. Opt-in; outranks `before_ts`/`after_ts`.                                           |

### Removed fields

None.

### Renamed fields

None.

### Validation changes

- V1 schemas are **not** `.strict()`. Unknown query params are silently stripped, exactly as before. (V2's private/group timeline WAS strict and 400'd on unknown params — that stricter behavior is gone.)
- `before_ts` + `after_ts` together still → 400. `before_cursor` + `after_cursor` together → 400. `before_seq` + `after_seq` together → 400.
- **One behavior worth knowing:** because unknown params are stripped rather than rejected, a typo'd cursor param silently returns the newest page. If you see pagination looping, check your param spelling first.

### Pagination precedence (per endpoint, highest first)

```text
/chat/{private,groups,community}/…/messages
  around  →  before_seq | after_seq  →  after_ts (community only: incremental sync)  →  before_ts | none

/chat/inbox
  before_cursor | after_cursor  →  before_ts | after_ts  →  none

/communities/mine
  cursor  →  before_ts | after_ts  →  q/categoryId (search mode)  →  search-mode default page
```

---

## Response Changes

### For V1-only clients: one new field, nothing removed

| Endpoint                                  | New field                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /chat/private/rooms/{id}/messages`   | `pinnedMessage` — the room's current active pin summary, or `null`. Every page.         |
| `GET /chat/groups/{id}/messages`          | `pinnedMessage` — same. Every page.                                                     |
| `GET /chat/community/rooms/{id}/messages` | Message objects now also carry `senderId`, `isDeleted`, and `content.text` (see below). |

### Community message field aliases — additive, nothing removed

Community messages historically used the DB's own column names on the wire, while private and group used different names for the same concepts. V2 normalized them by **deleting** the community names. V1 instead **adds** the canonical names and **keeps** the old ones, so one client model parses all three room kinds and no existing reader breaks:

| Legacy community field (still present) | Canonical field (now also present) |
| -------------------------------------- | ---------------------------------- |
| `sentBy`                               | `senderId`                         |
| `deletedForAll`                        | `isDeleted`                        |
| `message`                              | `content.text`                     |

If you migrated a community reader to the canonical names for V2, it keeps working. If you never did, it keeps working. Prefer the canonical names in new code.

### For clients coming off V2: the envelope is the real change

This is the only substantive break. V2 introduced a different envelope for four endpoints; V1 keeps the envelope every existing V1 client already parses.

**V2 timeline envelope (gone):**

```json
{
  "items": [
    /* messages */
  ],
  "page": {
    "limit": 40,
    "hasMoreOlder": true,
    "hasMoreNewer": false,
    "olderSeq": 41,
    "newerSeq": null
  },
  "roomRevision": 261,
  "pinnedMessage": null
}
```

**V1 timeline envelope (use this):**

```json
{
  "data": [
    /* messages */
  ],
  "pagination": {
    "totalData": 812,
    "totalPage": 28,
    "currentPage": 1,
    "limit": 30,
    "nextCursor": "41",
    "hasMore": true
  },
  "hasMore": true,
  "nextCursor": "41",
  "hasMoreOlder": true,
  "hasMoreNewer": false,
  "olderCursor": "41",
  "newerCursor": null,
  "roomRevision": 261,
  "pinnedMessage": null
}
```

Field-by-field:

| V2                       | V1                                                             |
| ------------------------ | -------------------------------------------------------------- |
| `items`                  | `data`                                                         |
| `page.limit`             | `pagination.limit`                                             |
| `page.hasMoreOlder`      | `hasMoreOlder` (also `hasMore` / `pagination.hasMore`)         |
| `page.hasMoreNewer`      | `hasMoreNewer`                                                 |
| `page.olderSeq` (number) | `olderCursor` (string) — also `nextCursor`                     |
| `page.newerSeq` (number) | `newerCursor` (string)                                         |
| —                        | `pagination.totalData` / `totalPage` / `currentPage` (V1 only) |

`roomRevision` and `pinnedMessage` sit at the same top level in both.

**V2 inbox envelope (gone):** `{ items, page: { limit, hasMore, nextCursor }, totalCount }`
**V1 inbox envelope (use this):** `{ data, pagination: { totalData, totalPage, currentPage, limit, nextCursor, hasMore }, hasMore, nextCursor }` — `totalCount` becomes `pagination.totalData`.

**Cursor values are strings on V1.** V2 handed back `olderSeq`/`newerSeq` as numbers; V1's `olderCursor`/`newerCursor`/`nextCursor` are strings (or `null`). Parse before comparing numerically. Continue to echo opaque tokens (`"<ms>_<id>"`, `"<ms>_<roomId>"`) back **verbatim** — never parse those to a number, or you drop the tiebreaker and start skipping same-millisecond rows.

### Behavioural changes

| Area                                       | Change                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/chat/private` + `/chat/groups` timelines | Now return `pinnedMessage` on every page. Purely additive; you can drop a separate pin fetch on room open.                                                                                                                                                                                             |
| `/chat/private/…/messages`                 | Now supports `before_ts`/`after_ts` again (V2 rejected them). Additive — `before_seq`/`after_seq` are unchanged and still preferred.                                                                                                                                                                   |
| `/chat/community/…/messages`               | Now supports `before_seq`/`after_seq` (V1 previously did not). Existing `before_ts`/`after_ts`/`around` callers unaffected.                                                                                                                                                                            |
| `/chat/inbox` with `*_cursor`              | Boundaries are EXCLUSIVE — pages no longer share a boundary row on a `lastMessageAt` tie, so you can drop the de-dupe-by-`roomId` workaround. With `*_ts` the old inclusive behavior is unchanged, so keep de-duping there.                                                                            |
| `/communities/mine` with `cursor`          | Same: EXCLUSIVE boundaries, de-dupe-by-`id` no longer needed. With `*_ts`, unchanged.                                                                                                                                                                                                                  |
| `/communities/mine` mode inference         | ⚠️ Unlike V2, calling `/communities/mine` with **no params at all** returns the **search-mode** page, not the joined newest page. To get the joined list's first page, send `cursor` — or a `limit` plus your first `cursor` — explicitly. This matches long-standing V1 behavior and was not changed. |

---

## Socket Changes

**None.** Socket.IO was never versioned — the `/chat`, `/community`, `/notify`, and `/stream` namespaces have no `v1`/`v2` split and were not touched by this migration.

- New events: none
- Removed events: none
- Payload changes: none

The `/changes` REST feed still pairs with the same `community:catchup` / reconnect flow you use today.

---

## Breaking Changes

For clients that called `/api/v2`:

1. **All 12 `/api/v2` URLs now 404.** Repoint them per the [Replacement APIs](#replacement-apis) table.
2. **Group paths change shape**, not just prefix: `chat/group/rooms/{id}/…` → `chat/groups/{id}/…`.
3. **Four endpoints return the V1 envelope**, not the V2 one: `data` instead of `items`, `pagination`/top-level continuation instead of `page`. Affects `/chat/inbox` and the private, group, and community message timelines.
4. **Cursor values are strings**, not numbers, in the V1 continuation fields.
5. **`/communities/mine` with no params returns search mode**, not the joined list.

For clients that only called `/api/v1`:

> No breaking API changes. Nothing to do. `pinnedMessage` on the private and group timelines, the canonical community field aliases, the `cursor`/`*_cursor`/`*_seq` params, and the `/changes`, `react`, and path-param group-delete routes are all additive and optional.

---

## Migration Checklist

- [ ] **Update REST endpoints** — replace every `/api/v2/...` URL using the [Replacement APIs](#replacement-apis) table. Grep your codebase for `api/v2` and for any derived "v2 prefix" config value; there should be zero hits when you are done.
- [ ] **Delete any second base URL.** A single `/api/v1` prefix is now the whole API. (Web: `apiV2Prefix` has been removed from `app.config.ts`.)
- [ ] **Fix the group paths specifically** — `chat/group/rooms/{id}` → `chat/groups/{id}`. This one will not be caught by a blind `v2`→`v1` replace.
- [ ] **Update DTOs / response readers** for the four envelope changes: `items`→`data`, `page.*`→`pagination.*` + top-level `hasMoreOlder`/`hasMoreNewer`/`olderCursor`/`newerCursor`, `totalCount`→`pagination.totalData`.
- [ ] **Parse cursors as strings.** Keep echoing opaque `"<ms>_<id>"` tokens verbatim; never `Number()` them.
- [ ] **Verify pagination** end to end on: private timeline, group timeline, community timeline, inbox, communities list. Scroll to the very top of a room and confirm no duplicate and no missing message at page boundaries.
- [ ] **Verify authentication** — unchanged (same `Authorization: Bearer <access token>`, same 401/403 codes), but re-run a signed-in smoke test since every URL moved.
- [ ] **Verify uploads** — unchanged (`/api/v1/media/*` was never versioned differently), but confirm chat attachments still send after the path edits.
- [ ] **Verify notifications** — unchanged. Push, in-app feed, and badge counts do not touch any migrated endpoint.
- [ ] **Verify error handling** — unchanged response shape (`{ success: false, message, ... }`) and unchanged status codes. Confirm your 404 handler is not now swallowing a missed `/api/v2` URL and hiding it as an empty state.
- [ ] **Verify socket behavior** — no changes expected; confirm reconnect catch-up still drains via `/changes` after the path swap.
- [ ] **Confirm zero `api/v2` references remain** before shipping.

---

## Reference — the consolidated V1 surface for these 12 capabilities

```text
GET    /api/v1/communities/mine?cursor=<ms>_<communityId>&limit=20
GET    /api/v1/chat/inbox?before_cursor=<ms>_<roomId>&limit=20

GET    /api/v1/chat/private/rooms/{roomId}/messages?before_seq=<n>&limit=30
GET    /api/v1/chat/private/rooms/{roomId}/changes?since_revision=<n>&limit=100
POST   /api/v1/chat/private/messages/{messageId}/react          { "emoji": "👍" }

GET    /api/v1/chat/groups/{roomId}/messages?before_seq=<n>&limit=30
GET    /api/v1/chat/groups/{roomId}/changes?since_revision=<n>&limit=100
POST   /api/v1/chat/groups/messages/{messageId}/react           { "emoji": "👍" }
DELETE /api/v1/chat/groups/messages/{messageId}?type=forEveryone

GET    /api/v1/chat/community/rooms/{roomId}/messages?before_seq=<n>&limit=30
GET    /api/v1/chat/community/rooms/{roomId}/changes?since_revision=<n>&limit=100
GET    /api/v1/chat/community/rooms/{roomId}/sync?since_ts=<ms>&limit=50
```

Swagger: `GET /docs/v1` on the gateway (`/docs` redirects there). `/docs/v2` is gone; `/docs/versions` now lists a single version.
