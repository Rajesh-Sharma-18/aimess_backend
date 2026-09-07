# Unified Global Search — Android & iOS Integration Guide

Everything a mobile client needs to implement global search: one endpoint, the
four filter tabs, cursor pagination, every row shape, every error code, and the
runbook for opening a searched message inside the right conversation.

Self-contained — you do not need any other document to build this.

Base URL: `{API_HOST}/api/v1` · Auth: `Authorization: Bearer <accessToken>` on every call.

**Timestamps are epoch milliseconds everywhere EXCEPT `message.createdAt`, which is an
ISO-8601 string.** That one field is pre-stringified by the backend before the
serializer runs. Parse it as ISO, not as a number. See §9.1.

---

# PART 1 — THE RUNBOOK

## 1.1 The whole feature in one page

There is **one** endpoint. The tab the user taps is a query parameter, not a
different API.

```
GET /api/v1/search?q=google&filter=all&limit=20
GET /api/v1/search?q=google&filter=message&limit=20
GET /api/v1/search?q=google&filter=community&limit=20
GET /api/v1/search?q=google&filter=people&limit=20
```

Page 2 of any of them is the same URL plus the `nextCursor` the previous page
returned:

```
GET /api/v1/search?q=google&filter=message&limit=20&cursor=1782133107521_507f1f77bcf86cd799439011
```

```
USER TYPES "google"
        │
        ▼
   debounce 400 ms          ← do NOT send g / go / goo / goog / google
        │
        ▼
GET /search?q=google&filter=<active tab>&limit=20
        │
        ▼
  { data: [ …mixed rows… ], nextCursor, hasMore }
        │
        ├─ render rows in arrival order (see §4 — do NOT re-sort)
        │
        ▼
USER SCROLLS TO BOTTOM
        │
        ▼
   hasMore == true ?  ──no──►  stop. never call again for this page set.
        │ yes
        ▼
same URL + &cursor=<nextCursor>   ← ONE in flight at a time
        │
        ▼
  APPEND to the list. Never replace it.
```

## 1.2 Rules that will bite you if you skip them

1. **Debounce 400 ms.** The web client uses exactly 400 ms. The gateway allows
   60 search requests per minute per session on top of a 100/min global
   backstop; a request per keystroke will 429 a fast typist.
2. **The cursor is opaque. Echo it back byte for byte.** Do not parse it, split
   it, base64-decode it, coerce it to a number, or store it as anything but a
   string. There are four different codecs behind it (§5.4) and they are not
   interchangeable — feeding one endpoint's cursor to another is a 400.
3. **Changing `q` or `filter` starts a NEW result set.** Drop the old rows,
   drop the old cursor, fetch page 1. Never carry a cursor across a tab switch.
4. **One next-page request in flight at a time.** Guard it in the load-more
   function itself, not at the call site.
5. **A stale response must never overwrite a newer one.** Tag every request
   with the `(q, filter)` it was issued for and discard a response whose tag no
   longer matches the current input. If `google` resolves after `github`, drop
   it.
6. **`hasMore == false` means stop.** So does `nextCursor == null`. So does a
   `nextCursor` identical to the one you just sent — treat that as the end, not
   as a page to fetch again.
7. **A short first page still needs a top-up.** If the returned rows do not
   fill the viewport, no scroll event will ever fire, so page 2 will never be
   requested. After each page lands, if the content is shorter than the list
   and `hasMore` is true, request the next page yourself.
8. **A failed next page must not blank the list.** Keep the rows already on
   screen and show an inline retry at the bottom. Only a failed *first* page
   earns a full-screen error state. And stop auto-retrying after a failure, or
   a short list plus a persistently failing page 2 becomes an infinite request
   loop.

## 1.3 Opening a message result

This is the part that is easy to get subtly wrong.

```
USER TAPS A MESSAGE ROW
        │
        │  the row already carries everything you need:
        │  { conversationType, roomId, messageId }
        ▼
OPEN THE CONVERSATION for (conversationType, roomId)
        │   PRIVATE   → roomId is "prv_…"   → private chat screen
        │   GROUP     → roomId is "grp_…"   → group chat screen
        │   COMMUNITY → roomId IS the community id → community chat screen
        ▼
IS messageId ALREADY IN THE LOADED WINDOW?
        │
        ├─ yes ─► scroll to it, highlight, done.
        │
        └─ no  ─► LOAD THE WINDOW AROUND IT FIRST:
                  GET <timeline>?around=<messageId>&limit=30
                  (§6.2 — one call per conversation type)
                        │
                        ▼
                  render that window, scroll to the row, highlight
```

**Do not** navigate to the conversation and hope the message is already loaded.
A search hit is frequently thousands of messages back; the newest page will not
contain it.

**Do not** discard the forward cursor from the `around` response. `newerCursor`
is what lets the user scroll back down to "now" from the island they landed on.
If you drop it, the reader is stranded in history with no way forward except
leaving the screen.

---

# PART 2 — API REFERENCE

## 2.1 `GET /api/v1/search`

### Request

| Param | Type | Required | Bounds | Notes |
|---|---|---|---|---|
| `q` | string | **yes** | 1–100 chars, trimmed | Empty/whitespace is a 400, not an empty result |
| `filter` | enum | no | `all` \| `message` \| `community` \| `people` | Defaults to `all` |
| `cursor` | string | no | 1–2048 chars, opaque | Omit for page 1. Echo `nextCursor` verbatim for page N+1 |
| `limit` | int | no | 1–50, default 20 | Page size. See §5.3 for how `all` splits it |

`filter` decides how much work the backend does: `filter=message` issues exactly
one downstream call, `filter=all` issues three in parallel. A single-category tab
is genuinely cheaper — use the specific filter when a specific tab is active.

### Response — HTTP 200

```json
{
  "success": true,
  "message": "Search results fetched",
  "data": {
    "pagination": {
      "totalData": 20,
      "totalPage": 1,
      "currentPage": 1,
      "limit": 20,
      "nextCursor": "eyJ2IjoxLCJtIjoiMTc4Mj…",
      "hasMore": true
    },
    "data": [ /* SearchItem[] — see §3 */ ],
    "hasMore": true,
    "nextCursor": "eyJ2IjoxLCJtIjoiMTc4Mj…"
  }
}
```

`hasMore` and `nextCursor` appear **twice** — once inside `pagination` and once
at the top level of `data`. They are always the same value; read whichever you
prefer, and treat them as a pair.

### `pagination` fields you must NOT trust

| Field | Reality |
|---|---|
| `totalData` | The number of rows **in this page**, not a corpus total. |
| `totalPage` | Always `1`. Cursor-mode fiction. |
| `currentPage` | Always `1`. Cursor-mode fiction. |

There is no total result count anywhere in this API, by design — counting
matches across three services would cost more than the search. **Never render
"N results" and never derive a page count.** Page on `nextCursor` only.

---

## 3. Row shapes — `SearchItem`

Every row is a discriminated union on `type`. Model it as a sealed
class / enum with associated values, not as one struct with optional fields.

```kotlin
// Kotlin
@Serializable
@JsonClassDiscriminator("type")
sealed interface SearchItem {
    val id: String

    @Serializable @SerialName("message")
    data class Message(override val id: String, val message: MessageHit) : SearchItem

    @Serializable @SerialName("community")
    data class Community(override val id: String, val community: CommunityRow) : SearchItem

    @Serializable @SerialName("person")
    data class Person(
        override val id: String,
        val bucket: Bucket,          // CHAT | OTHER
        val person: PersonRow,       // itself a union on `type` — USER | GROUP
    ) : SearchItem
}
```

```swift
// Swift
enum SearchItem: Decodable {
    case message(id: String, MessageHit)
    case community(id: String, CommunityRow)
    case person(id: String, bucket: Bucket, PersonRow)
}
```

**Forward compatibility:** if you meet a `type` you do not know, skip the row.
Do not throw — a decode failure on one unknown row must not fail the page.

### 3.1 `type: "message"`

`id` is the `messageId`. One conversation can legitimately appear several times
in the list — **never de-duplicate by `roomId`**, you will silently drop hits.

```json
{
  "type": "message",
  "id": "507f1f77bcf86cd799439011",
  "message": {
    "messageId": "507f1f77bcf86cd799439011",
    "conversationType": "PRIVATE",
    "roomId": "prv_9fK2mQ",
    "conversationName": "Jane Cooper",
    "conversationAvatarUrl": "https://…/avatar.jpg?X-Amz-Signature=…",
    "senderId": "usr_1a2b3c",
    "senderName": "Jane Cooper",
    "text": "Google released a new product today.",
    "createdAt": "2026-09-01T10:22:41.113Z"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `messageId` | string | 24-hex ObjectId |
| `conversationType` | `PRIVATE` \| `GROUP` \| `COMMUNITY` | Half of the navigation key |
| `roomId` | string | `prv_*` / `grp_*` / **the community id** for COMMUNITY |
| `conversationName` | string | Peer name / group name / community name. May be `""` |
| `conversationAvatarUrl` | string | **Freshly presigned per response — expires.** §9.2 |
| `senderId` | string \| null | `null` on rows with no sender |
| `senderName` | string | Live snapshot name, falling back to the frozen-at-send name. May be `""` |
| `text` | string | The matched body. **Not** highlighted — see §9.3 |
| `createdAt` | string | **ISO-8601**, not epoch ms |

**What message search covers:** 1:1, group and community message bodies, in one
reverse-chronological list. System lines ("X joined the group") are excluded.
Messages you deleted for yourself, history you cleared, and messages posted
after you were banned from a community are excluded. Groups you **left or were
kicked from** are excluded even though the conversation is still in your inbox.

### 3.2 `type: "community"`

`id` is the community id. This is the row returned by community discovery, so it
covers **every PUBLIC community on the platform** plus your own private ones —
not only communities you have joined. `isJoined` tells you which.

```json
{
  "type": "community",
  "id": "68b0f2c41a9e4d0012ab34cd",
  "community": {
    "id": "68b0f2c41a9e4d0012ab34cd",
    "name": "Google Developers",
    "handle": "googledevs",
    "description": "Everything Android and Cloud.",
    "type": "PUBLIC",
    "category": { "id": "cat_1", "name": "Technology" },
    "memberCount": 18402,
    "memberLimit": 100000,
    "avatarUrl": "https://…?X-Amz-Signature=…",
    "avatarUrlExpiresIn": 3600,
    "avatar": { /* MediaObject */ },
    "createdAt": 1756713600000,
    "isJoined": true,
    "isBanned": false,
    "membershipStatus": "ACTIVE",
    "hasRequested": false,
    "isMuted": false,
    "muteUntil": null,
    "isLive": false,
    "streamEnabled": true,
    "chatEnabled": true,
    "announcementEnabled": true,
    "moderationStatus": "ACTIVE",
    "status": "ACTIVE",
    "unreadMessageCount": 3,
    "firstUnreadMessageId": "507f…",
    "lastActivity": { "type": "message", "preview": "…", "dateTime": 1757240000000 }
  }
}
```

**Two fields the community LIST row has and this one does NOT.** Declare them
optional or your decoder will fail:

- **no `role`** — by definition a discovery row has no membership role. Use
  `membershipStatus` / `isJoined` instead.
- **no top-level `lastActivityAt`** — the timestamp lives at
  `lastActivity.dateTime`, and `lastActivity` itself is optional (absent when
  the community has no chat activity for you). Render **no timestamp** when it
  is absent; do not render an empty slot and do not substitute `createdAt`.

Also absent: `isMemberMuted` / `memberMutedUntil`. A moderation-muted member
will not be flagged as muted on a search row — read the community detail before
deciding a composer is locked.

**Searchable fields are `name` and `handle` only.** `description` and category
are returned but never matched. Matching is formatting-insensitive: `Dr. Jhatka`,
`dr_jhatka`, `Dr-Jhatka` and `dr jhatka` all match each other, and multi-word
queries match across fields (`text text1` finds a community named "Text
Community" with handle `text1`).

### 3.3 `type: "person"`

Two things live here, discriminated **again** on the inner `person.type`.

```json
{
  "type": "person",
  "id": "usr_1a2b3c",
  "bucket": "chat",
  "person": {
    "type": "USER",
    "userId": "usr_1a2b3c",
    "username": "janecooper",
    "firstName": "Jane",
    "lastName": "Cooper",
    "fullName": "Jane Cooper",
    "avatarUrl": "https://…?X-Amz-Signature=…",
    "avatarUrlExpiresIn": 3600,
    "avatar": { /* MediaObject */ },
    "isOnline": true,
    "roomId": "prv_9fK2mQ",
    "isFriend": true,
    "relationshipStatus": "FRIEND",
    "isBlockedByMe": false,
    "isBlockedByPeer": false,
    "friendshipId": "frn_88",
    "requesterId": null,
    "canSendRequest": false,
    "relationship": {
      "status": "FRIEND",
      "direction": null,
      "canAccept": false,
      "canReject": false,
      "canCancel": false,
      "canSendRequest": false
    }
  }
}
```

```json
{
  "type": "person",
  "id": "grp_7xQ",
  "bucket": "chat",
  "person": {
    "type": "GROUP",
    "roomId": "grp_7xQ",
    "name": "Google Nerds",
    "avatar": "avatars/grp_7xQ.jpg",
    "description": "…",
    "memberCount": 42,
    "isActiveMember": true
  }
}
```

**`bucket` is what you render sections from:**

| `bucket` | Contains | Suggested section |
|---|---|---|
| `chat` | Your accepted friends (whether or not a room exists yet) **and** groups you are an active member of | **Chats** |
| `other` | Everyone else who is discoverable, plus groups you left but whose conversation you kept | **People** |

`bucket` is decided by **friendship**, never by `roomId`. A pending or
unfriended peer with an existing conversation lands in `other` **carrying a
non-null `roomId`** — that is normal, and `roomId` is conversation metadata
only.

**`id` is `userId` for a USER row and `roomId` for a GROUP row.** Use `id` as
the stable list key; both are unique across the page.

**Action gating — read this before wiring buttons.** Use `canSendRequest` (or
`relationship.canSendRequest`) to decide whether to offer "Add Friend". Do
**not** derive it from `relationshipStatus`: `NONE` only means no friendship row
exists, it says nothing about whether this viewer is *allowed* to create one.
Absent on an older payload means allowed, and the server still refuses an
unauthorized send with `FRIEND_REQUEST_NOT_ALLOWED`.

**Blocks are one-way and both directions can appear:**
- `isBlockedByMe` — you blocked them. Row stays so you can offer **Unblock**.
- `isBlockedByPeer` — they blocked you. You only ever see this when the pair
  already has a conversation. `isOnline` is forced `false` and every action is
  off. Do not offer Unblock — you did not block them.

**`isOnline` is privacy-scoped.** A viewer denied by `whoCanSeeOnlineStatus` gets
`false`, indistinguishable from genuinely offline. Never present it as
"last seen unknown".

### 3.4 The `chat` and `recent` buckets exist on page 1 only

The people leg's `chat` bucket is a **bounded head**: up to 10 rows, served on
the first page of a people/all search and **omitted from every cursor page**.
Only the `other` bucket paginates.

Consequence: **the Chats section never grows as you scroll.** That is intended.
Do not render a "load more" affordance for it, and do not conclude the API is
broken when page 2 comes back with no `chat` rows.

---

## 4. Ordering — do not re-sort

Rows arrive in a **fixed section order: messages, then communities, then people**
(and within people, `chat` before `other`). Within a category, ordering is that
category's own stable key — messages newest-first, communities by descending id,
people by `firstName` then `userId`.

**There is no relevance score anywhere in this platform.** Nothing in the
payload ranks a row against another category's row, and re-sorting the merged
list client-side would invent a ranking rather than reveal one. Render in
arrival order and group by `type` for your section headers.

If you group rows into sections, accumulate across pages and append into the
matching section — do not rebuild the sections from the newest page alone.

---

## 5. Pagination

### 5.1 The loop

```
page1 = GET /search?q=…&filter=…&limit=20
render(page1.data)
cursor = page1.nextCursor

while user scrolls to the end AND page.hasMore AND cursor != null:
    next = GET /search?q=…&filter=…&limit=20&cursor=<cursor>
    append(next.data)
    if next.nextCursor == cursor: break     # server could not advance — stop
    cursor = next.nextCursor
```

### 5.2 Three ways paging ends. Handle all three.

1. `hasMore == false`
2. `nextCursor == null`
3. `nextCursor` equals the cursor you just sent — stop, or you will re-serve one
   page forever.

### 5.3 What `limit` means per filter

For a single-category filter, `limit` is that category's page size.

For `filter=all`, `limit` is split so that **no category can consume the whole
page**:

| Category | Share of `limit` | At `limit=20` |
|---|---|---|
| messages | ⌈limit / 2⌉ | 10 |
| communities | ⌈limit / 4⌉ | 5 |
| people | ⌊limit / 4⌋ | 5 |

Plus the people `chat` head on page 1 (§3.4), so an `all` page 1 can legitimately
return more than `limit` rows. That is expected — page on `nextCursor`, never on
row count.

### 5.4 The cursor is opaque, and there are four of them

You never need to know this. It is here so that when you see two different-looking
cursors you do not conclude something is broken, and so nobody is tempted to
"normalise" them:

| Filter | Codec |
|---|---|
| `message` | `<epochMs>_<24-hex objectId>` |
| `community` | a bare 24-hex id |
| `people` | base64url of an internal keyset |
| `all` | base64url JSON wrapping all three of the above |

They look similar and are **not interchangeable**. The chat inbox uses a
same-shaped `<ms>_<roomId>` cursor that is a completely different thing — never
cross them.

### 5.5 Stability guarantees

The cursors are keyset-based, not offset-based, so new messages, communities and
users arriving mid-scroll do not shift your pages. Within a category you will not
see a skipped or duplicated row across a page boundary.

One caveat worth defensive coding: if a downstream category has a transient
failure mid-scroll, the backend holds that category's position and re-asks for
the same page rather than restarting it. **Keying your list by `id` and ignoring
a row whose id is already rendered costs nothing and makes this invisible.** Do
it.

---

## 6. Message navigation

### 6.1 Resolving where a hit lives

A message row hands you the complete navigation key:

| `conversationType` | `roomId` is | Open |
|---|---|---|
| `PRIVATE` | the private room id, `prv_*` | 1:1 chat |
| `GROUP` | the group room id, `grp_*` | group chat |
| `COMMUNITY` | **the community id** (not a separate chat-room id) | community chat |

### 6.2 Loading the window around a message

If `messageId` is not already in your loaded timeline, fetch its window first.
Same `around` parameter on all three timelines:

```
GET /api/v1/chat/private/rooms/{roomId}/messages?around={messageId}&limit=30
GET /api/v1/chat/groups/rooms/{roomId}/messages?around={messageId}&limit=30
GET /api/v1/chat/community/rooms/{roomId}/messages?around={messageId}&limit=30
```

The response carries **four** continuation fields — all of them matter:

```json
{
  "data": { "data": [ /* messages */ ],
            "pagination": { … },
            "hasMoreOlder": true,
            "hasMoreNewer": true,
            "olderCursor": "1782133107521_507f…",
            "newerCursor": "1782140000000_507f…" }
}
```

- `olderCursor` / `hasMoreOlder` — scroll up from the island.
- `newerCursor` / `hasMoreNewer` — scroll back down toward live. **Store this.**
  Without it there is no path from the island back to the newest message, and the
  reader is stuck.

`limit` is 1–100, default 30.

### 6.3 Checking a message before you navigate (optional)

If you want to know whether a message still exists before switching screens —
for example to show "This message was deleted" instead of an empty room:

```
GET /api/v1/chat/messages/{messageId}/context?conversationType=PRIVATE&roomId=prv_9fK2mQ
```

```json
{ "data": { "messageId": "507f…", "roomId": "prv_9fK2mQ",
            "conversationType": "PRIVATE", "isAvailable": true,
            "anchor": { "sequenceNumber": 10422,
                        "beforeCursor": "1782133107521_507f…",
                        "afterCursor":  "1782133107521_507f…" } } }
```

- Always **HTTP 200** for a content-level answer. `isAvailable: false` with
  `error.code = MESSAGE_NOT_FOUND` means deleted or gone — that is a normal
  result, not a failure.
- An **access** failure (not a participant, room does not exist) is a real
  403/404 and is never disguised as `isAvailable: false`.
- `anchor.sequenceNumber` is present for PRIVATE and GROUP, omitted for
  COMMUNITY.

This call is optional. `?around=` alone is enough for the happy path.

### 6.4 Deep links from outside the app

There is no message-level deep link in the push/notification payload today —
a push always lands on the conversation, never on a specific message. If you
build one, carry the same `(conversationType, roomId, messageId)` triple and run
the §1.3 flow.

---

## 7. Errors

Every error uses the platform envelope:

```json
{
  "success": false,
  "message": "The pagination cursor is not valid. Please start the search again.",
  "code": "INVALID_CURSOR",
  "error": {
    "statusCode": 400,
    "code": "INVALID_CURSOR",
    "message": "The pagination cursor is not valid. Please start the search again.",
    "retryable": false,
    "requestId": "…"
  }
}
```

| Status | `code` | Meaning | What the app does |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | `q` empty or > 100 chars, bad `filter`, `limit` out of 1–50. `error.details` names the field | Fix the request. Never retry as-is |
| 400 | `INVALID_CURSOR` | The cursor could not be read, or was not one this endpoint issued | **Drop the cursor and re-fetch page 1.** Do not surface an error |
| 401 | `UNAUTHORIZED` | Token rejected | Normal refresh-then-retry; on refresh failure, sign out |
| 403 | `ACCOUNT_BANNED` | The account is banned | Run the ban teardown — see `BAN_MOBILE_INTEGRATION_GUIDE.md`. **Do not** treat this as a generic sign-out |
| 429 | — | Rate limited (60/min/session for search, 100/min global) | Back off. Check `Retry-After` |
| 503 | `SEARCH_UNAVAILABLE` | Every search backend failed, or none could be reached at all | Retryable. Inline retry, keep existing rows |

A 200 always means at least one backend was actually queried — the endpoint
never answers 200 without calling one. So **an empty `data` array is a genuine
"no matches"**, never "nothing ran".

**403 is not 401.** A banned user hitting search gets a real 403 with
`ACCOUNT_BANNED`; routing it into your generic 401 sign-out will wipe the ban
message the user is meant to read.

### Partial failure is silent by design

If **one** category's backend fails, that category simply comes back empty with
a 200. There is no per-category error flag. An empty Communities section is
therefore indistinguishable from "no communities matched" — do not render
"community search failed". Only an all-backends-down request produces the 503.

---

## 8. Recent searches (separate APIs)

Global search does not store history. Two **different** subsystems do, and they
are not interchangeable:

| Endpoint | Stores | Use for |
|---|---|---|
| `GET /api/v1/users/search` with **no `q`** | Returns `{ recent: [...] }` — up to **10** recently-**viewed** USER/GROUP targets, newest first | The "Recent Search" list under an empty search box |
| `POST /api/v1/users/search/recent` | Record one: `{ "targetType": "USER"\|"GROUP", "targetId": "…" }` | Call when the user opens a profile or a group from search |
| `DELETE /api/v1/users/search/recent/{targetId}?targetType=USER` | Remove one | The ✕ on a recent row |
| `DELETE /api/v1/users/search/recent` | Clear all | The **"Clear all"** action beside the "Recent" header |

The store keeps the newest **20** per user and the list serves the newest **10**.
Rows are ordered by `lastViewedAt` descending. `recordRecentSearch` upserts, so
re-opening someone bumps them to the top rather than duplicating them.

Both destructive actions should be **optimistic**: hide the row(s) immediately,
and on failure un-hide by refetching rather than by replaying what was there.
| `GET /api/v1/users/recent-searches` | A **different** table that stores free-text **query strings** | A "recent terms" dropdown, if you build one |

Note the shape switch on `GET /users/search`: with no `q` it returns
`{ recent }` and **no** `chat`/`other`; with a `q` it returns `{ chat, other }`
and **no** `recent`. Decode it as a union, not as one struct.

---

## 9. Gotchas

### 9.1 Two timestamp formats in one response

`message.createdAt` is an **ISO-8601 string**. `community.createdAt`,
`community.lastActivity.dateTime` and every other timestamp are **epoch
milliseconds (number)**. This is not a bug you can normalise away server-side —
code for both.

### 9.2 Avatar URLs are presigned and expire

`conversationAvatarUrl`, `avatarUrl` and everything inside `avatar` are freshly
signed per response. `avatarUrlExpiresIn` (seconds) tells you when a community/
user avatar dies.

- **Do not persist these URLs.** Cache the decoded *image* keyed by the object
  key or the entity id, never the signed URL.
- **Do not reuse a URL from page 1 on page 5** if the page set has been open a
  long time. Re-search or re-fetch the entity.
- A 403 on an image load almost always means an expired signature, not a
  permission problem.

### 9.3 There is no highlight metadata

`text` is the raw message body with no match offsets. Do your own
case-insensitive, formatting-insensitive substring highlight client-side, using
the same normalisation the backend matches with (lowercase, strip non-alphanumerics)
if you want highlighting to agree with why the row matched.

### 9.4 Message search covers your 80 most recently active rooms per kind

For scalability the whole-account message search scopes to the caller's **80 most
recently active** private rooms, 80 groups and 80 community rooms. A user in
hundreds of rooms can therefore get an empty result for a message that exists in
a long-dormant conversation.

There is no flag in the response telling you truncation happened. If your product
surface needs exhaustive recall in one room, use the **per-room** search instead:

```
GET /api/v1/chat/private/rooms/{roomId}/messages/search?q=…&limit=30&cursor=…
GET /api/v1/chat/groups/rooms/{roomId}/messages/search?q=…&limit=30&cursor=…
GET /api/v1/chat/community/rooms/{roomId}/messages/search?q=…&limit=30&cursor=…
```

Those are room-scoped, unaffected by the 80-room cap, and use the same
`<epochMs>_<objectId>` cursor. Note their `limit` allows up to 100 and defaults
to 30, and they do **not** filter out system messages.

### 9.5 Multilingual matching — what to expect per script

Search is Unicode-aware end to end. Send the user's raw input; do **not**
transliterate, strip accents, or lowercase on the client — the server owns
normalisation and doing it twice loses information.

**People and communities** (name / username / handle) match on a normalised
shadow: lowercased, **diacritics folded**, then every non-letter/non-digit
stripped. Consequences worth designing for:

| Query | Matches | Why |
|---|---|---|
| `nguyen` | `Nguyễn` | diacritics are folded, so an unaccented query works — this is how Vietnamese is usually typed |
| `Nguyễn` | `Nguyễn` | the accented query works too |
| `dang` | `Đặng` | Vietnamese `đ` folds to `d` |
| `cafe` | `Café` | same fold for Latin accents generally |
| `dr jhatka` | `Dr. Jhatka`, `dr_jhatka`, `Dr-Jhatka` | punctuation, spaces and underscores are all stripped |
| `ทดสอบ` | `ทดสอบ` | Thai consonants are preserved |
| `กัน` | `กิน` **and** `กัน` | Thai vowel/tone marks are folded, so matching is mark-insensitive |
| `日本語` / `한국어` | themselves | Han and Hangul pass through unchanged |

Multi-word queries are **order-independent and cross-field**: every whitespace
token must match *something*, but different tokens may match different fields.
`text text1` finds a community named "Text Community" whose handle is `text1`.
Thai and Japanese have no word spaces, so such a query arrives as one token —
that is fine, matching is substring-based (§9.6).

**Message bodies** are matched differently: a case-insensitive **raw substring**,
with no diacritic folding. Searching `nguyen` will *not* find the word `Nguyễn`
inside a message the way it finds the *person* Nguyễn. Set expectations in copy
if that matters for your market; for message bodies people generally retype what
they saw, so exact-script matching is the right behaviour.

**Do not** apply a minimum query length above 1 character for CJK — a single Han
character is a real word, and a 2- or 3-character minimum copied from a Latin
product makes the feature useless in those locales.

### 9.6 Matching is substring, not word-based

Searching `test` matches `Testing`, and a prefix matches while the user is still
typing. It is not tokenised, not stemmed and not language-aware. Expect
mid-word hits and do not promise "whole word" semantics in your UI copy.

### 9.7 Empty vs. not-yet-searched

While the debounce timer is running you have a typed term and no results.
Render the **skeleton**, not "No results found" — otherwise every search flashes
an empty state before it has run. Only show "No results" once a response for the
current `(q, filter)` has actually arrived with zero rows.

### 9.8 `x-lang`

Send your `x-lang` header (`en` / `th` / `vi`) as usual. It is forwarded to every
downstream, so error messages and any localized content come back in the user's
language.

---

## 10. Test checklist

Search `google`, then:

- [ ] **All** returns a mix of message, community and person rows; sections
      render in message → community → person order.
- [ ] **Message** returns only `type: "message"`. Hits appear from 1:1, group
      and community conversations.
- [ ] **Community** returns only `type: "community"`, including communities you
      have **not** joined (`isJoined: false`).
- [ ] **People** returns only `type: "person"`, with both `chat` and `other`
      buckets on page 1 and only `other` on page 2.
- [ ] Each filter paginates: page 2 appends, no duplicate ids, no gaps, and
      paging stops cleanly at the end.
- [ ] Tab switching `All → Message → Community → People → All` resets the list
      and the cursor every time, sends the correct `filter`, and never shows the
      previous tab's rows.
- [ ] Type `google`, `github`, `facebook`, `telegram` in quick succession —
      exactly one request survives per settled term, and a late `google`
      response never overwrites `telegram` results.
- [ ] A message hit in a **recently loaded** conversation scrolls and highlights
      without a network call.
- [ ] A message hit thousands of messages back loads its `around` window,
      lands on the right row, highlights it, and can still scroll **down** to
      live afterwards.
- [ ] Tapping the **same** hit twice re-navigates and re-highlights (not a
      no-op).
- [ ] A community message hit opens the community chat at the right message.
- [ ] A short result list that does not fill the screen still loads page 2.
- [ ] A failed page 2 keeps the existing rows, shows an inline retry, and does
      **not** loop.
- [ ] A malformed/stale cursor produces `400 INVALID_CURSOR` and the app
      silently restarts at page 1.
- [ ] A banned account's search request produces `403 ACCOUNT_BANNED` and runs
      the ban teardown, not the generic sign-out.

### Recent Search (empty input)

- [ ] With the box empty, `GET /users/search` (no `q`) renders up to **10** rows
      under "Recent", newest first.
- [ ] Opening a row calls `POST /users/search/recent` and bumps it to the top on
      the next read — it does **not** appear twice.
- [ ] The per-row ✕ hides that row immediately and calls
      `DELETE /users/search/recent/{targetId}?targetType=USER`. On failure the
      row comes back.
- [ ] **Clear all** empties the list immediately and calls
      `DELETE /users/search/recent`. On failure the list comes back.
- [ ] Typing any character replaces Recent with search results; clearing the box
      brings Recent back without a flash of "no results".

### Multilingual

Run each of these against a seeded account (see §9.5 for why each matters):

- [ ] `nguyen` finds the person **Nguyễn** — the unaccented form is how it is
      normally typed.
- [ ] `Nguyễn` also finds them.
- [ ] `dang` finds **Đặng**.
- [ ] `cafe` finds the community **Café**.
- [ ] `dr jhatka`, `dr_jhatka` and `Dr-Jhatka` all find **Dr. Jhatka**.
- [ ] A Thai query (`ทดสอบ`) finds a Thai name, and a query differing only in
      tone/vowel marks still matches.
- [ ] A **single** Han character returns results — no client-side minimum length
      above 1, or CJK search is dead.
- [ ] A Vietnamese/Thai IME composing mid-word does not fire a request per
      composition step — debounce on the committed value.
- [ ] A message-body search for an accented word requires the accent (bodies are
      matched raw, unlike names) and this is not reported to the user as an
      error.
- [ ] Errors come back in the user's language when `x-lang` is sent.

---

## 11. Quick reference

```
SEARCH        GET  /api/v1/search?q=&filter=&cursor=&limit=
              filter: all | message | community | people   (default all)
              q: 1–100   limit: 1–50 (default 20)   cursor: opaque, echo verbatim
              → { pagination:{…,nextCursor,hasMore}, data:SearchItem[], hasMore, nextCursor }

ROW TYPES     message   → { messageId, conversationType, roomId, conversationName,
                            conversationAvatarUrl, senderId, senderName, text,
                            createdAt (ISO STRING) }
              community → discovery row: NO role, NO top-level lastActivityAt
              person    → { bucket: chat|other, person: USER|GROUP row }

NAVIGATE      PRIVATE   roomId = prv_*
              GROUP     roomId = grp_*
              COMMUNITY roomId = the community id

AROUND        GET /api/v1/chat/private/rooms/{roomId}/messages?around={messageId}&limit=30
              GET /api/v1/chat/groups/rooms/{roomId}/messages?around={messageId}&limit=30
              GET /api/v1/chat/community/rooms/{roomId}/messages?around={messageId}&limit=30
              → keep newerCursor / hasMoreNewer or the reader is stranded

CONTEXT       GET /api/v1/chat/messages/{messageId}/context?conversationType=&roomId=
              always 200; isAvailable discriminates found vs deleted

PER-ROOM      GET /api/v1/chat/{private|groups|community}/rooms/{roomId}/messages/search?q=&limit=&cursor=

RECENTS       GET    /api/v1/users/search                  (no q) → { recent: [...] }  10 rows
              POST   /api/v1/users/search/recent           { targetType, targetId }
              DELETE /api/v1/users/search/recent/{id}?targetType=USER   one row (✕)
              DELETE /api/v1/users/search/recent                        Clear all
              separate from /search — recents are not a search result

LANGUAGE      names/handles: lowercased, diacritics FOLDED, punctuation stripped
              → nguyen finds Nguyễn · dang finds Đặng · cafe finds Café
              → Thai marks folded (mark-insensitive) · Han/Hangul unchanged
              message BODIES: raw case-insensitive substring, NO diacritic fold
              send raw user input; never transliterate or lowercase client-side
              no minimum query length above 1 char (one Han character is a word)

ERRORS        400 VALIDATION_FAILED · 400 INVALID_CURSOR (restart at page 1)
              401 UNAUTHORIZED · 403 ACCOUNT_BANNED (ban teardown!) · 429 · 503 SEARCH_UNAVAILABLE
              200 with empty data == genuinely no matches (a leg always ran)

LIMITS        debounce 400 ms · 60 search req/min/session · 100 req/min global
              message search scope = 80 most recently active rooms per kind
              people `chat` bucket = page 1 only, max 10 · only `other` paginates
```
