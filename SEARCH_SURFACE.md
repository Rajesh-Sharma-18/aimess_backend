# SEARCH_SURFACE.md — discovery search as it exists today

Inventory taken 2026-09-08 against `claude/instagram-discovery-search-636027`
(backend) and `features/fix-the-unban-issue` (aimess_website). This file
describes the surface **before** the Instagram-structure work; see
`SEARCH_DECISIONS.md` for what changed and why.

---

## 1. HTTP surface

### 1.1 Unified fan-out — `GET /api/v1/search`

`apps/api-gateway/src/routes/v1/search.routes.ts`

| Query param | Type | Notes |
|---|---|---|
| `q` | string, 1–100, trimmed | Required. |
| `filter` | `all \| message \| community \| people \| group` | Selects which downstream legs run. |
| `cursor` | opaque, ≤2048 | A single leg's own cursor, or the base64url composite for `all`. |
| `limit` | int 1–50, default 20 | Per-leg quota is derived from this. |

Three downstream legs, called in parallel with the **caller's own bearer
token**, so every downstream permission gate still applies:

| Leg | Downstream call | Response shape it reads |
|---|---|---|
| `message` | `chat-service` `GET /api/chat/messages/search?q&limit&cursor` | `{ data, hasMore, nextCursor }` |
| `community` | `community-service` `GET /api/v1/communities/mine?q&filter=all&limit&cursor` | `{ data, pagination.nextCursor }` |
| `people` | `user-service` `GET /api/v1/users/search?q&limit&cursor` | `{ chat?, other, hasMore, nextCursor }` |

Notable existing behaviour:

- **Community leg is seeded with a sentinel cursor** (`ffffffffffffffffffffffff`,
  max ObjectId) so community-service starts on its `id desc` keyset rather than
  its offset path, whose `nextCursor` is always `null`.
- **`chat` is a bounded head**: user-service serves it on page 1 only and omits
  the key entirely on cursor pages, so a walk never re-sends it.
- **Quota per leg on `all`**: message `ceil(limit/2)`, community `ceil(limit/4)`,
  people `floor(limit/4)` — one busy category cannot starve the others.
- **No ranking anywhere.** Sections are emitted in fixed order
  (message, community, people). The route comments this explicitly: there is no
  relevance score on the platform, so a gateway-side sort would be an invented
  ranking rather than a better one.
- **Error mapping**: a downstream 401 → 401; 403 → 403 carrying the downstream
  code; a 400 on a cursor this route forwarded → `INVALID_CURSOR`; any other 4xx
  → `SEARCH_REQUEST_REJECTED` (non-retryable, deliberately not the 503).

### 1.2 People + groups — `GET /api/v1/users/search`

`apps/user-service/src/api/routes/user-search.routes.ts` →
`user-search.controller.ts` → `services/user-search.service.ts`

Two modes, decided by whether `q` is non-blank:

- **`q` blank → Recent only.** `{ recent: SearchResultItem[] }`, newest 10.
- **`q` present → `{ chat?, other, hasMore, nextCursor }`.**
  - `chat` (max 10, page 1 only): ACCEPTED friends matching `q`, ordered by
    private-room recency, **plus** groups the viewer is an ACTIVE member of.
  - `other` (paged, keyset on `firstName asc, userId asc`): everyone else that
    passes the `whoCanFindMe` gate, **plus** groups the viewer has left/been
    removed from but whose conversation they still hold.

Row types: `type: "USER"` (`SearchUserItem`) and `type: "GROUP"`
(`SearchGroupItem`) share one array.

Recent-search sub-routes on the same router:

| Route | Effect |
|---|---|
| `POST /api/v1/users/search/recent` | Upsert `{ targetType: USER \| GROUP, targetId }` |
| `DELETE /api/v1/users/search/recent` | Clear all |
| `DELETE /api/v1/users/search/recent/:targetId?targetType=` | Remove one |

A second, older recents surface also exists —
`GET/POST/DELETE /api/v1/users/recent-searches`
(`recent-searches.routes.ts`, `recent-search.service.ts`), keyed on
`searchedUserId` + a free-text `query`. **Users only.** The website does not
call it; it reads recents from `GET /users/search` with an empty `q`.

### 1.3 Communities — `GET /api/v1/communities/mine`

`apps/community-service/src/api/routes/community.routes.ts` →
`community.service.ts#discover` → `community.repository.ts#listDiscoverable`

Mode is inferred from params: any of `q` / `categoryId` / `filter` switches it
into **search mode** (`includeJoined: true`); no params at all lists the
caller's joined communities on a `lastActivityAt` cursor.

Search-mode visibility (`listDiscoverable`):

```
deletedAt unset
AND ( type = PUBLIC  OR  id IN <caller's ACTIVE + non-dismissed BANNED memberships> )
AND ( status != CLOSED  OR  id IN <same member set> )
AND <text filter>
```

Ordering is `id desc` (ObjectId is time-ordered → newest first). Offset paging
by `page`, or an `id < cursor` keyset when `cursor` is supplied; the keyset path
skips the `count` query and reports `total: -1`.

`GET /api/v1/communities/discover` is a deprecated alias: PUBLIC only, excluding
every community the caller already relates to (ACTIVE + PENDING + BANNED).

`GET /api/v1/communities/by-handle/:handle` is the deep-link resolver and is
**PUBLIC-only by design** — a private community's handle resolves 404, never
"exists but private". `/by-handle/:handle/card` is the only unauthenticated
community route (OG unfurl, PUBLIC only).

### 1.4 Groups

Groups have **no HTTP search route of their own.** They are reached only through
user-service, which calls chat-service over gRPC:

| gRPC (from `user-service/src/grpc/messaging.client.ts`) | Backing repo method |
|---|---|
| `listActiveGroups(viewerId, q, limit)` | `group-room.repository#searchInRoomIds` over ACTIVE memberships |
| `listOtherGroups(viewerId, q, excludeIds, limit)` | same, over left/removed rooms the conversation is still held for |
| `getGroupsByIds(viewerId, ids)` | `findManyByRoomIds` |

`searchInRoomIds` carries an explicit contract note: *"There is deliberately no
'every other group' variant: group existence must never imply group
visibility, so the id set is always derived from the viewer's relationship to
the group."*

### 1.5 Messages

`chat-service` `GET /api/chat/messages/search` — body search over rooms the
caller is in. `$regex`-backed, no score. Out of scope for discovery: E2EE room
bodies are never searched server-side.

---

## 2. Matching rules

One shared tokenizer, `packages/utils/src/search-tokenize.ts`:

- `tokenizeSearchQuery` — trim, split on whitespace runs.
- `normalizeForSearch` — lowercase → NFD → `đ`→`d` → strip combining marks →
  **strip every non-letter/non-digit** → NFC. So `@`, `_`, `.`, `-`, spaces all
  vanish: `"@Smiley_Creatures"` → `"smileycreatures"`.
- `tokenizeAndNormalize` — `{raw, normalized}` pairs, punctuation-only tokens
  dropped.

Three per-entity filter builders, all the same AND-of-OR shape (every token must
match some field; different tokens may match different fields):

| Builder | Fields |
|---|---|
| `user-service/src/lib/user-search.util.ts#buildUserSearchFilter` | `normalizedUsername`, `normalizedFirstName`, `normalizedLastName`, `normalizedFullName`, and raw `username`/`firstName`/`lastName` (`contains`, insensitive) |
| `community-service/src/lib/community-search.util.ts#buildCommunitySearchFilter` | `normalizedName`, `normalizedHandle`, raw `name`/`handle` |
| `chat-service/src/lib/group-search.util.ts#buildGroupSearchFilter` | `normalizedName`, raw `name` — groups have no handle |

**Every field is `contains`. Nothing is `equals` or "starts with", and nothing is
weighted.** `@handle` therefore already matches — via the normalized shadow, not
the raw clause — but a handle-exact hit has no priority over a name-substring
hit, and is ordered only by the page's keyset (`firstName asc` for people,
`id desc` for communities, `lastMessageAt desc` for groups).

---

## 3. Privacy gates in force

| Gate | Where | Effect on search |
|---|---|---|
| `whoCanFindMe` | `user-service/src/lib/privacy-scope.ts#discoverableWhere`, applied by `buildDiscoveryWhere` | Filters people out of `other` entirely. Widened by `alwaysVisibleIds` for peers the viewer already has a private room with — the row is in their inbox anyway, and hiding it here made the two doors disagree. |
| `whoCanViewProfile` | `visibleIdentity` | Gates profile **content** (bio/cover/counts), **not** the row. Name + avatar are never viewer-scoped. |
| `whoCanSeeOnlineStatus` | `visibleIsOnline` | Denied viewer sees `isOnline: false`. |
| `whoCanSendFriendRequests` | `canSendFriendRequest` | Decides `canSendRequest` on the row; the raw scope is never exposed. |
| Blocks | `splitBlocks` | One-way. A user the **viewer** blocked stays in the viewer's results carrying `isBlockedByMe`. A user who blocked the **viewer** is subtracted (`hiddenIds`) **unless** the pair already has a private room, in which case the row survives flagged `isBlockedByPeer` with every action off and presence forced false. |
| Community visibility | `listDiscoverable` | PUBLIC, or a community the caller is an ACTIVE/BANNED member of. A PRIVATE community the caller is not in is invisible — consistent with `/by-handle` 404ing it. |
| Group visibility | `searchInRoomIds` | Only rooms derived from the caller's own memberships. There is no global group index. |
| `ProfileStatus` / `deletedAt` | `discoverableWhere` | Banned and deleted profiles never surface. |

---

## 4. Rate limiting

`apps/api-gateway/src/middleware/rate-limit.ts` →
`searchRateLimiter` = `{ rule: "search", windowMs: 60_000, max: env.SEARCH_RATE_LIMIT_MAX, scope: "session" }`.

**It is mounted.** `routes/v1/index.ts` applies it to `/users/search`,
`/users/discovery`, `/communities/search`, `/chat/search` and `/search`. The
AIM-39 "configured but imported by nothing" state was fixed before this work; a
follow-up (commit `a7b514fe`) gave each limiter its own Redis counter key, which
is what stopped search traffic from draining the `auth.sensitive` bucket.

---

## 5. Website surface

`aimess_website`, `features/fix-the-unban-issue` (search work is uncommitted at
time of writing).

| File | Role |
|---|---|
| `src/controller/search/search.api.ts` | `globalSearch()`; the `SearchItem` union (`message` / `community` / `person` / `group`) |
| `src/controller/search/useGlobalSearch.ts` | One `useInfiniteQuery` per `(term, tab)`; debounce `SIDEBAR_SEARCH_DEBOUNCE_MS`; `retry: false`; `placeholderData` bridges term changes but **not** tab changes |
| `src/constants/searchScope.ts` | `SEARCH_SCOPE_TABS` — Top / Message / Community / People / Group; `SEARCH_PREVIEW_ROWS = 3` |
| `src/component/chat/sidebar/useSidebarSearchSections.ts` | The one place the unified response is read; builds Friends → Other People → Community → Groups → Messages |
| `src/component/chat/sidebar/SidebarSearchResults.tsx` | Section renderer, scroll-driven `loadMore`, empty state, keyword highlight |
| `src/component/chat/sidebar/ChatListItem.tsx` | Row: avatar, name, `lastMessage.text` **or** `subtitle`, member-count chip |
| `src/component/message/hooks/useFriendSearch.ts` | Recents (empty query) + friend-request actions; recents read `GET /users/search` with no `q` |
| `src/component/message/MessageSidebar.tsx`, `src/component/community/CommunitySidebar.tsx` | The two mounts; both share the tab via `useSearchScope()` |

Row layout today:

- **Person** — title = display name (or username), `lastMessage.text = "@handle"`.
- **Community** — title = name, `lastMessage.text` = last-activity preview
  (via `toChatListEntry`, shared with the joined list).
- **Group** — title = name, member-count chip, no subtitle.

Empty query renders `MessageFriendResults` from `useFriendSearch.recent`.

---

## 6. Gaps found

1. **The gateway has no `group` leg.** Its `filter` enum is
   `all | message | community | people`, so the website's Group tab 400s. Groups
   *do* come back inside the `people` leg, but `peoplePage()` stamps every row
   `type: "person"` regardless of `row.type`, so the website's
   `item.person.type === "USER"` guard drops them and they render nowhere. The
   same bug makes `filter=people` return groups mislabelled as people.
2. **No handle-first ranking.** Every field is an unweighted `contains`, and
   ordering is the page keyset. A handle-exact match can land on page 7.
3. **Community rows carry no `@handle` in search.** The row renderer is shared
   with the joined list, which correctly wants the activity preview.
4. **`GROUP` recents are stored but never rendered.** `useFriendSearch.recent`
   filters `isUser`, so a recorded group target is dropped client-side.
5. **No `COMMUNITY` recent target type.** `RecentSearchTargetType` is
   `USER | GROUP` on a Postgres enum, so adding one needs a migration plus a
   cross-service name resolve in user-service.
