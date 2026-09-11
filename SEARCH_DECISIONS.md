# SEARCH_DECISIONS.md — discovery search

Locked decisions for the Instagram-structure discovery search. Read
`SEARCH_SURFACE.md` first for what the surface looked like before this work.

Scope reminder: this is **discovery** — people, communities, groups. Message-body
search is a separate leg that is untouched, and E2EE room bodies are never
searched server-side.

---

## 1. Query normalization

| Rule | Value | Where |
|---|---|---|
| Strip leading `@` | Yes — falls out of `normalizeForSearch`, which strips every non-letter/non-digit | `packages/utils/src/search-tokenize.ts` |
| Case | Insensitive, both on the normalized shadow and the raw `contains` fallback | same |
| Whitespace | Trimmed, split on runs; tokens AND-ed, each free to match any field | same |
| Diacritics | Folded (NFD → drop marks → NFC); Vietnamese `đ` mapped by hand | same |
| Handle charset | Unchanged — existing AIMESS account rules. No new alphabet was invented. | `user-service/src/lib/username.util.ts` |

`@Smiley_Creatures`, `Smiley_Creatures`, `smiley creatures` and `smileycreatures`
all normalize to `smileycreatures` and hit the same row. This already held before
this work; it is recorded here because it is now a tested guarantee.

## 2. Minimum query length and debounce

**Minimum length: 1. Debounce: `SIDEBAR_SEARCH_DEBOUNCE_MS` (client).**

Deliberately *not* the plan's "1 for `@exact`, else 2". The plan's reason for a
minimum was "avoid dump-all", and the dump-all it guards against cannot happen
here: an empty/blank `q` takes a different branch entirely (Recents), and a
1-character `q` is still a filtered query bounded by `limit` ≤ 50 and by the
session-scoped `searchRateLimiter`. Adding a second gate that the client would
have to special-case for `@x` buys nothing and gives two places to disagree about
what a valid query is.

The gateway keeps `q: z.string().trim().min(1).max(100)`.

## 3. Ranking

**Handle-first, with an exact-handle head.** Implemented in two parts because a
single-part fix cannot work:

1. **Exact-handle head — people only.** One extra indexed equality lookup on
   `normalizedUsername`, run alongside the page query, whose hit is hoisted to
   the front of page 1. It exists because the page order is a *keyset*
   (`firstName asc, userId asc`): an exact `@cat` among 200 handles containing
   "cat" otherwise sits at whatever page its owner's first name falls on, and no
   amount of sorting a page can fix a row that is not in it. The head is
   emitted on page 1 only, and its id is subtracted from the keyset on **every**
   page so the walk cannot serve it a second time.

   **Communities get no head query.** A community handle is long and near-unique,
   so an exact match is essentially never buried behind a page of substring
   matches the way a short username can be — the tiering below is enough. The
   note in `community-search.util.ts` says what to add if a short-handle
   collision ever proves otherwise.
2. **In-page tiering** (people and communities). Within a returned page, rows are
   stably ordered handle-exact → handle-prefix → handle-contains → name-only.
   The keyset boundary is read from the **unsorted** page in both services, so
   reordering what the reader sees never moves where the next page starts.

Resulting order, top tab: exact handle → friends → handle prefix → everything
else, with groups and communities in their own sections.

**Known ceiling** (marked `ponytail:` in code): tiering is *within* a page. A
handle-prefix match on page 3 does not overtake a name-only match on page 1.
Fixing that properly needs a stored rank key or a search index, which this
product does not have — the exact-handle head covers the case that actually
matters.

**Display-name matching: kept, ranked below handle.** Not removed. Dropping it
would regress every existing "search my friend by their name" flow, and the plan
explicitly allows it as a secondary key. Scenario 4 ("display name without handle
match is *not required* to hit") is satisfied either way; here it does hit, and
it sorts last.

## 4. People

- **Primary key: handle.** Secondary: first/last/full name, tiered below.
- **Never searched: email, phone.** No code path reads either; there is nothing
  to remove and nothing to add.
- **Blocked** — unchanged, and deliberately asymmetric:
  - The viewer blocked them → row stays, flagged `isBlockedByMe`, so the client
    can offer *Unblock* instead of an action the API would reject.
  - They blocked the viewer → row is subtracted, **unless** the pair already has
    a private room. That carve-out predates this work and stays: the pair is in
    the viewer's inbox anyway, and hiding it here is what made search and the
    chat list open different screens for the same person.
- **Self**: hidden. `viewerId` is in `excludeUserIds`. Consistent, no "You" row.
- **`whoCanFindMe`: semantics unchanged.** A user who has hidden themselves stays
  hidden *including from an exact-handle query*. This is the plan's "if that
  setting already means 'not in search'" branch: on AIMESS it does — it is the
  discovery gate, not a profile-content gate — so honouring it on exact handle is
  the correct read, not a silent narrowing. The one existing widening
  (`alwaysVisibleIds`, for peers you already have a conversation with) is
  untouched.

## 5. Communities

- **Primary key: handle/slug** — the `@catloversonly` in `/community/@catloversonly`.
  Name stays as a secondary key, tiered below handle.
- **`/community/@handle` routing is untouched.** No change to
  `GET /communities/by-handle/:handle` or `/by-handle/:handle/card`.
- **Private communities: NOT findable by non-members. This is a deliberate
  deviation from the plan's default.**

  The plan's default was "private community findable by handle, IG-style". Three
  reasons not to take it:

  1. `/communities/by-handle/:handle` already 404s a private community *by
     design*, and its docstring says so. Making search answer where the
     deep-link resolver refuses puts two doors of the same product on opposite
     sides of one privacy boundary — the exact failure mode this codebase has
     been bitten by repeatedly.
  2. The community row is not an IG-style stub. `toDiscoverItem` serializes
     `lastActivityPreview`, `lastActivityUsername` and `lastActivityType`. A
     "findable" private community would leak recent message previews to
     non-members, which is a content leak, not an existence oracle.
  3. Nothing in the product asked for it. Widening a shipped privacy boundary is
     not a search-ranking change.

  **To flip it** if the product does want IG semantics: in
  `community.repository.ts#listDiscoverable`, add
  `{ handle: { equals: <raw q>, mode: "insensitive" } }` to `visibilityOr`, and
  null out the `lastActivity*` fields in `toDiscoverItem` for rows where
  `isJoined === false && type !== PUBLIC`. Both halves are required; the first
  alone is the leak.

- Joining stays gated exactly as before. A visible row is not permission.

## 6. Groups

- **Primary (and only) key: name.** Groups have no handle field, and none was
  invented. The row never renders a fake `@`.
- **Members only.** Enforced server-side in
  `chat-service/src/repositories/group-room.repository.ts#searchInRoomIds`, which
  only ever queries an explicit `roomIds` set derived from the caller's own
  memberships. There is no global group index and no code path that could
  produce one. This is not a client-side subtraction.
- **Left/removed groups**: a group the caller left but whose conversation they
  still hold appears with `isActiveMember: false`. It is still *their* row — it
  is in their inbox. A group they were never in is absent, full stop.

## 7. Recent searches

- **Kept as-is: `USER | GROUP`**, stored as `{ targetType, targetId }` on
  `RecentUserSearch`, newest 20 stored, newest 10 rendered.
- **Empty query renders Recents only** — never a directory. The branch is in
  `user-search.controller.ts`: blank `q` calls `searchRecent()`, and no search
  logic runs.
- **`COMMUNITY` recents: deferred, not skipped.** `RecentSearchTargetType` is a
  **Postgres** enum, so a third value needs a real migration, and user-service
  would then need a community-name resolve over gRPC to render the row. Both are
  fine to do — they are just not search behaviour, and doing them here would put
  a schema migration inside a ranking change. `user-service/src/grpc/community.client.ts`
  already exists, so the follow-up is: enum value + migration + a
  `getCommunitiesByIds` batch call in `searchRecent`.
- Recents are recorded on **tap**, not on keystroke, and only for rows the user
  actually opened.

## 8. Rate limiting

`searchRateLimiter` is already mounted on `/users/search`, `/users/discovery`,
`/communities/search`, `/chat/search` and `/search`
(`api-gateway/src/routes/v1/index.ts`). Nothing to add. It is session-scoped,
60s window, `env.SEARCH_RATE_LIMIT_MAX`, and since commit `a7b514fe` it has its
own Redis counter rather than sharing one with `auth.sensitive`.

The unified `/search` fan-out is throttled at least as hard as the endpoints it
calls, because one caller request becomes up to three downstream ones.

## 9. Result contract

The gateway's `SearchItem` union gains a fourth member. Groups now arrive as
their own row type instead of being stamped `type: "person"`:

```ts
type SearchItem =
  | { type: "message";   id: string; message:   {...} }
  | { type: "community"; id: string; community: {...} }
  | { type: "person";    id: string; bucket: "chat" | "other"; person: {...} }
  | { type: "group";     id: string; group:     {...} }   // NEW
```

`filter` gains `"group"`. `people` and `group` share the one user-service leg —
the response already carries both kinds — and the gateway partitions the rows.
No new downstream endpoint, no new gRPC call.

`filter=group` returns a **single page** (`nextCursor: null`). Groups are a
bounded head in user-service's response and are dropped on cursor pages, so
paging a group-only filter would walk people looking for groups that can never
appear.

## 10. UI

- One box, tabs **Top | Message | Community | People | Group**, debounced.
- Empty query → Recents. Never a user dump.
- Row subtitles:
  - person → `@handle`
  - community → `@handle` (search rows only; the joined list keeps its activity
    preview, which is what that list is for)
  - group → `Group · N members`, never a fake `@`
- Tap routes are the existing ones: `PATHS.MESSAGE_DETAIL`,
  `PATHS.COMMUNITY_OPEN(handle, id)`, profile card. Membership and join rules
  unchanged.
- Empty state: "no results" copy, never a blank panel.

## 11. Explicitly out of scope

- Global search of all groups by name.
- Email or phone search.
- Server-side search of E2EE message bodies.
- Any change to join, friend-request or block rules.
- Any change to `/community/@handle` routing.

---

## 12. Scenario matrix

Rows 1–26 of the plan. **Verified by** says what actually checked it — an
automated test that fails if the behaviour regresses, or a read of the code path
with no runtime check behind it. Nothing here was exercised against a running
stack: this worktree has no database, no gRPC peers and no services up, so every
"code" row is an argument, not a measurement.

Test paths are relative to the backend repo unless marked `web:`.

### People

| # | Scenario | Result | Verified by |
|---|---|---|---|
| 1 | `Smiley_Creatures` / `smiley_creatures` / `@Smiley_Creatures` → that user | PASS | test — `apps/user-service/tests/users/user-search.test.ts`, "resolves %s to the same exact-handle row" (all three spellings normalize to one indexed lookup) |
| 2 | Friend appears under Friends/Top | PASS | code — `chat` bucket is `findUsersInList(friendIds)`; section order asserted in `web: __tests__/component/chat/sidebarSearchSections.spec.tsx` |
| 3 | Non-friend appears under People if privacy allows | PASS | test — `apps/user-service/tests/users/room-peer-discovery-carve-out.test.ts` (the `whoCanFindMe` gate and its one carve-out) |
| 4 | Display name without handle match not *required* to hit; if it hits, ranks below handle | PASS (it hits, ranked last) | test — `user-search.test.ts`, "orders a page handle-exact, prefix, then name-only" |
| 5 | Email/phone query: no user dump | PASS | code — `buildUserSearchFilter` has exactly seven fields (username/first/last/full + their shadows); neither email nor phone is on `UserProfile`'s searchable set at all. `john@example.com` normalizes to `johnexamplecom` and matches nothing |
| 6 | Blocked user absent | PASS | test — `apps/user-service/tests/users/blocked-pair-discovery-parity.test.ts`. Asymmetric by design: the viewer's own block keeps the row (flagged), a peer's block removes it unless a conversation exists |
| 7 | Self: hidden, consistently | PASS | test — `user-search.test.ts`, "never lets an exact handle bypass the self or block rules". `viewerId` is in `excludeUserIds` and the exact head re-checks it |

### Community

| # | Scenario | Result | Verified by |
|---|---|---|---|
| 8 | `@catloversonly` / `catloversonly` → Cat lovers Only | PASS | test — `apps/community-service/tests/lib/community-search.util.test.ts` + `tests/communities/list-discoverable-search.test.ts`; the `@` is stripped by `normalizeForSearch` before the shadow match |
| 9 | Private community row visible to a non-member, join still gated | **NOT IMPLEMENTED — deliberate** | see §5. Private communities stay invisible to non-members, matching `/by-handle` which 404s them. The flip is documented there; it needs the `lastActivity*` fields nulled at the same time or it leaks message previews |
| 10 | Handle prefix `cat` → ranked prefix hits | PASS | test — `packages/utils/tests/search-tokenize.test.ts`, `rankByHandle` tiers; applied to communities in `community.service.ts#discover` |
| 11 | Community display-name-only match is secondary; handle is the required path | PASS | code — `buildCommunitySearchFilter` matches both, `rankCommunitiesByHandle` puts every handle tier above name-only |

### Group

| # | Scenario | Result | Verified by |
|---|---|---|---|
| 12 | `Testing Vasundhara` → that group if I am a member | PASS | test — `apps/chat-service/tests/grpc/search-user-groups-visibility.test.ts` |
| 13 | Partial `Vasundhara` → name contains | PASS | code — `buildGroupSearchFilter` is `contains` on `normalizedName` and raw `name` |
| 14 | Group I am **not** in is absent even on an exact name match | PASS | test — same visibility suite. Structural: `searchInRoomIds` only ever queries an explicit `roomIds` set derived from the caller's memberships, and chat-service has no "all groups" variant to call by mistake |
| 15 | No `@handle` needed, and none invented | PASS | code — `GroupRoom` has no handle column; the web row renders `name` + "Group · N members" (`web: useSidebarSearchSections.ts`, asserted in the sections spec) |

### Chrome

| # | Scenario | Result | Verified by |
|---|---|---|---|
| 16 | Empty query → recents only | PASS | code — `user-search.controller.ts` branches on `q.trim()`; a blank query never reaches any search path |
| 17 | Tabs filter kinds | PASS | test — `apps/api-gateway/tests/search/global-search.test.ts`, "filter=people … drops the groups" and "filter=group serves groups from the people leg" |
| 18 | Tap a recent → same result | PASS | code, **no automated test**. Recents now render GROUP rows too (they were stored and dropped client-side); a group tap opens the conversation, a person tap opens the profile card |
| 19 | Clear recent | PASS | code, **no automated test**. `clearRecent` now dismisses every kind, not only the users — the group rows used to linger until the refetch and then blink away |
| 20 | Debounce; no request on a junk character | PARTIAL — debounce yes, min-length 2 deliberately not adopted | see §2. Min length stays 1; an empty query is a different branch, so there is no dump to guard against |
| 21 | Empty-state copy, not a blank panel | PASS | code — `web: SidebarSearchResults.tsx` renders the not-found art + copy when every section is empty |
| 22 | Community + people + group together in Top, no duplicates | PASS | test — gateway "filter=all …" asserts `["message","community","person","group"]`; the exact-handle head is removed from the keyset on every page, so it cannot come back later in the walk |

### Regression

| # | Scenario | Result | Verified by |
|---|---|---|---|
| 23 | Opening a chat from a result still works | PASS | code — tap routes are untouched (`PATHS.MESSAGE_DETAIL`, `PATHS.COMMUNITY_OPEN`, profile card) |
| 24 | Join community / open group permissions unchanged | PASS | code — no join, membership or friendship path was edited. The community visibility `where` is byte-identical; only the in-page order of the rows it returns changed |
| 25 | In-chat message search unchanged | PASS | code — the message leg's URL, envelope and cursor are untouched; `chat-service` was not modified at all |
| 26 | E2EE rooms: no server-side search of ciphertext bodies | PASS | code — discovery reads `UserProfile`, `Community` and `GroupRoom` metadata only. No new path reads message content |

### Suite state after the change

| Suite | Before | After |
|---|---|---|
| `apps/api-gateway` | 651 | 652 (3 assertions updated to the new row contract, 1 test added) |
| `apps/user-service` | 374 | 381 (7 added) |
| `apps/community-service` | 982 | 982 |
| `packages` | 128 | 134 (6 added) |
| `aimess_website` | 114 | 117 (3 added) |

Two `packages/grpc-utils` files report "must contain at least one test" — they
are `assert`-based self-checks that the repo's own config excludes and only the
path workaround below picks up. Unrelated to this change.

**Running the suites from this worktree:** the checkout lives under a `.claude/`
path segment, and the leading `\.` makes Jest's generated `testMatch` glob
escape-sequence its own rootDir, so zero files match. Override it:

```bash
node ../../node_modules/jest/bin/jest.js --rootDir . --testMatch="**/tests/**/*.test.ts"
```

run from the service directory. Outside a `.claude` path the normal
`pnpm test` works unchanged.
