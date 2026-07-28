# AIMESS Client V2 Migration Rulebook

**Branch:** `features/update-all-the-list-api-with-v2`
**Audience:** iOS and Web frontend teams
**Reference implementation:** Android (`aimess_native_android`), which has shipped all of it. Where a
rule is subtle, the Android file that implements it is named so you can read working code.

V1 is frozen, not removed. Every endpoint below is **additive** — nothing you ship today breaks. But
V1 cannot express the two sync axes, so any client still on V1 will keep losing edits, deletes and
reactions across reconnects. Treat this as the migration you do before the next release, not an
optional cleanup.

---

## Part 1 — The rules

These are binding. Everything in Part 2 is a consequence of one of them.

### R1. There are two axes. Use the right one for the right job.

| Axis         | Field            | Monotonic per        | Answers                                        |
| ------------ | ---------------- | -------------------- | ---------------------------------------------- |
| **Sequence** | `sequenceNumber` | room, per insert     | _Where does this message sit in the timeline?_ |
| **Revision** | `revision`       | room, per **change** | _What have I not seen yet?_                    |

`sequenceNumber` is assigned once and never changes. It orders the timeline and detects insert gaps.
It says nothing about an edit, a delete or a reaction on a message you already hold.

`revision` bumps on **every** mutation of a room — insert, edit, delete, reaction. It is the Telegram
`pts`. It is the only correct catch-up cursor.

There is no third axis. **Timestamp pagination is gone.**

#### Delete these from your client. All of them.

| Delete                                                                | Replace with                 |
| --------------------------------------------------------------------- | ---------------------------- |
| `before_ts=` on any message endpoint                                  | `before_seq=`                |
| `after_ts=` on any message endpoint                                   | `after_seq=`                 |
| `before_cursor=` / `after_cursor=` on any message endpoint            | `before_seq=` / `after_seq=` |
| `cursor=` (opaque `<ms>_<id>`) on any message endpoint                | `before_seq=`                |
| any `createdAt`-based page boundary                                   | `sequenceNumber`             |
| any client-side "did I already load this?" check keyed on a timestamp | `sequenceNumber`             |

Sequence is the **only** pagination axis for messages. `before_seq` / `after_seq` / `around`, nothing
else. The V2 timeline schema is `.strict()`, so a leftover `before_ts` or `before_cursor` is a **400**,
not a silently-ignored param — you will find these the moment you point at V2.

Why this is not negotiable: the timestamp cursors page on `(createdAt, id)`, and under load the server
writes many messages inside the same millisecond. A timestamp boundary steps over the rows that share
its millisecond and **drops them permanently** — the client never knows they existed, because the
next page starts after the gap. This was reproduced with real inverted rows in community history. A
sequence boundary cannot skip: `sequenceNumber` is a per-room monotonic integer with no ties.

**Never sort by `createdAt` either.** Order by `sequenceNumber`, with `createdAt` and then
`clientMessageId` only as tiebreakers for legacy rows that predate sequence allocation.

> Exception, and it is the only one: **list** endpoints (conversation inbox, joined communities) are
> not per-room timelines and have no sequence axis. They still paginate on time — see 2.11 and 2.12.
> Do not "clean up" those; deleting `before_ts` there breaks list paging.

### R2. History and catch-up are REST. Sockets are live events only.

Do not fetch history over the socket. `chat:catchup`, `chat:catchup:result`, `community:catchup`,
`community:catchup:result` and `community:messages:fetch` still exist on the gateway for older
clients — **do not build against them**. They are a parallel, second implementation of paging with
its own cursor rules, and keeping both in sync is where the drift comes from.

One drain, one code path, all three surfaces:

```
GET /api/v2/chat/{private|group|community}/rooms/{roomId}/changes?since_revision=<n>&limit=<n>
```

When a socket event arrives whose `revision` jumps by more than 1, you have missed something: run the
same REST drain. Do not invent a socket gap-fill.

> Android: `ChatRepositoryImpl.revisionCatchup()` is the single drain; `ChatSyncTrigger` is how the
> socket bridges ask for it. Both socket catch-up implementations were deleted.

### R3. Room is the source of truth. The UI never renders a network payload.

```
REST / socket → validate → map → local DB (one transaction) → observable query → UI
```

A socket payload never reaches a view. A REST response never reaches a view. Both write to the local
store, and the UI observes the store. This is what makes offline, reconnect and multi-device
consistent instead of three separate code paths.

### R4. Every inbound write is idempotent, keyed on `id` (the server message id).

Look up the existing row by server id first. If present, **merge** — do not replace. A thinner
payload must never:

- resurrect a deleted message (`isDeleted` is sticky-true),
- drop an `editedAt` marker,
- downgrade a read/delivered tick,
- replace a local file path with a remote URL,
- downgrade a known media type to `TEXT`/`DOCUMENT`,
- move a message's timestamp (the sort key is immutable after insert).

> Android: `MessageEntityMerge.mergeServerInto` is the single merge used by every write path.

### R5. Sends are optimistic and reconciled by `clientMessageId`.

Write the local row first with a client-generated id, then send. The server echoes `clientMessageId`
back; reconcile on it. **`clientMessageId` must be an UPPERCASE UUID** — the community send path
matches it case-sensitively and a lowercase id silently produces a duplicate bubble.

### R6. Presigned media URLs expire. Never persist one and never render one twice.

Every `files[].url` and `thumbnailUrl` is a presigned GET valid for ~1 hour. Storing it and rendering
it later paints a broken image. Download once to a local cache keyed by `objectKey`, render the local
file, and re-resolve from `objectKey` when the cache misses. The same applies to avatars — key your
image cache on the URL **path minus query**, or the rotating signature busts the cache on every load.

> Android: `MediaDownloadManager.ensureLocal` / `ensureThumbnail`, cache in `MediaFileStore`.

### R7. All timestamps on the wire are UTC epoch milliseconds.

Send `nowUtcMillis()`. Parse tolerantly (epoch seconds, epoch ms, ISO with `Z`, with offset, and
**without** offset — an offset-less string is UTC, not local). Convert to local time only at render.
Date-of-birth and similar calendar values are not instants — never zone-convert them.

### R8. Absence is an answer, not an error.

`bio: null`, `isOnline: null`, `friendsCount: null` mean the viewer is outside that user's privacy
scope. Render nothing. Do not show "unknown", do not retry, do not treat it as a failure.

---

## Part 2 — What changed

Status legend: **NEW** = endpoint did not exist · **CHANGED** = shape changed · **PARITY** = existed
for one surface, now exists for all three.

### 2.1 Timeline — `GET /api/v2/chat/{private|group|community}/rooms/{roomId}/messages` — CHANGED

The V2 schema is `.strict()`. **An unknown query param is a 400**, not a warning. Remove your V1
params before you point at V2.

**Sequence only** (R1). These four are the entire pagination surface:

| Param                | Meaning                                                     |
| -------------------- | ----------------------------------------------------------- |
| `before_seq`         | older page: `sequenceNumber < seq`, newest-first            |
| `after_seq`          | newer page: `sequenceNumber > seq`, oldest-first            |
| `around=<messageId>` | window centred on and including a message (jump-to-message) |
| `limit`              | 1–100, default 40                                           |

`before_seq` and `after_seq` are mutually exclusive — sending both is a **400**.

**Rejected with 400 — do not send:** `before_ts`, `after_ts`, `cursor`, `page`, `offset`, and any V1
param not in the table above.

`before_cursor` / `after_cursor` still parse, but treat them as **removed**. They exist only so the
server can serve rooms whose entire history predates sequence allocation (every `sequenceNumber` is
`0`). No client should send them, and no client should carry code paths for them: if you hit such a
room, the fix is a backend seq backfill, not a client fallback. Building the fallback is how you end
up maintaining two pagination implementations again — the exact thing this migration removes.

Response adds, beyond the V1 envelope:

```jsonc
{
  "data": [ /* messages */ ],
  "hasMore": true,            // OLDER direction (back-compat alias)
  "nextCursor": "…",          // OLDER direction (back-compat alias)
  "hasMoreOlder": true,
  "hasMoreNewer": false,
  "olderCursor": "941",
  "newerCursor": "981",
  "roomRevision": 1042,       // room's current change high-water
  "pinnedMessage": { … }      // see 2.3
}
```

`hasMoreNewer` / `newerCursor` are what make jump-to-message work: after an `around=` window you can
page **both** ways from the anchor. A client that only reads `hasMore` will jump into a message and
then be unable to scroll back down to the present.

### 2.2 Changes feed — `GET …/rooms/{roomId}/changes` — NEW (all three surfaces)

```
?since_revision=<n>   0 = cold start
&limit=<n>            1–200, default 100
```

```jsonc
{
  "roomRevision": 1042,
  "resetRequired": false,
  "hasMore": true,
  "nextRevisionCursor": "1102",
  "data": [
    /* messages, current state, revision ASC */
  ],
}
```

Drain rules:

1. Loop while `hasMore`, advancing `since_revision`.
2. Advance your stored cursor from the **maximum revision you actually applied**, not only from
   `nextRevisionCursor` — the server may leave that field `0`/`null`, and a client that trusts it
   blindly gets stuck re-issuing `since_revision=0` forever.
3. `resetRequired: true` means your cursor is below the server's retention horizon. Re-baseline from
   one newest timeline page and jump the cursor to `roomRevision`. **This is an idempotent upsert, not
   a local wipe** — deleting local rows here destroys unsent optimistic messages.
4. Seed the cursor **only** from this feed. Never from a timeline page's max revision: a history page
   can contain a revision higher than an old message's unfetched mutation, and seeding from it skips
   that change permanently.
5. Rows in `data` may be tombstones. Private/group: `isDeleted: true`. Community: `syncEventType:
"deleted"` or `deletedForAll: true`. Apply as a soft delete, keeping the row.

Run this on chat open, on reconnect, and on a detected live revision gap.

### 2.3 Embedded pinned message — CHANGED (private + group now match community)

Timeline responses on all three surfaces carry `pinnedMessage`. Stop making a separate pin call.

```jsonc
{
  "messageId": "…", "roomId": "…", "communityId": "…",
  "senderId": "…", "senderName": "…", "senderHandle": "…", "senderAvatar": "…",
  "messageType": "TEXT", "text": "…", "media": [ … ],
  "createdAt": 1782133107521, "pinnedAt": 1782133200000, "pinnedBy": "…",
  "isAvailable": true
}
```

`text`/`messageType` come from the **live** message when it still exists, falling back to the
pin-time snapshot when it does not. `isAvailable: false` = pinned message deleted; render the banner
as unavailable rather than hiding the pin.

### 2.4 Jump-to-message — behaviour change

`GET /api/v1/chat/messages/{messageId}/context` is **deprecated for clients.** It answers in the
retired V1 cursor shape (`beforeCursor`/`afterCursor`), and its `isAvailable` reports live messages as
gone whenever the id form or room key does not line up exactly.

Use `?around=` alone. It already does everything `/context` did — participant assert, anchor
resolution, `404 CHAT_MESSAGE_NOT_FOUND` when the message is gone — and returns the window as well.
One round trip, not two.

Classify the outcome from the `around` call:

- window returned and the anchor is in it → jump
- `404` / `410` → "this message is no longer available"
- anything else → transient; say "couldn't load", **never** claim a deletion

> Android deleted its `/context` client entirely. See `ChatRepositoryImpl.locateMessage`.

**Do not re-fetch what you already hold.** After a jump you have a detached island of messages plus
your live tail, with a gap between. Track the island's bounds. When paging older from the tail
descends into the island, stop fetching and adopt the island's oldest row as the new edge. Without
this, a single pin tap costs ~15 redundant page requests replaying rows already in your DB.

### 2.5 Reactions — CHANGED

`POST /api/v2/chat/{private|group}/messages/{messageId}/react` with `{ "emoji": "👍" }` is
**set** semantics: one reaction per user per message. Changing your reaction is one write and one
broadcast, not a remove followed by an add. Removal stays `DELETE …/reactions/{emoji}` and is an
idempotent toggle-off.

Reaction payloads are **grouped** (`[{ emoji, count, userIds }]`), not a flat per-user list. A
reaction event carries the full authoritative set for that message — replace, do not merge.

### 2.6 Read receipts and unread — CHANGED

`deliveredTo` and `readBy` arrays were **removed** from private and community message payloads. They
were unbounded per-message arrays; do not depend on them.

`community:read_sync` (fan-out to the reader's own devices) now carries `readerId` and `unreadCount`:

```jsonc
{ "communityId": "…", "readerId": "…", "upToMessageId": "…", "unreadCount": 0, "readAt": 1782… }
```

Without `unreadCount` a second device could not clear its own badge. Apply it directly; do not
recompute locally.

The read pointer is a **message**, not a timestamp. "Read" means seen at the bottom of the timeline —
not "the screen was open". Marking read while the user is scrolled up in history is wrong.

Group `delivered` has no server-side storage yet. Do not render a delivered tick in groups.

### 2.7 Shared media — `GET …/rooms/{roomId}/media` — PARITY

Now on all three surfaces (`/chat/private/rooms/{id}/media`, `/chat/groups/{id}/media`,
`/chat/community/rooms/{id}/media`). `?type=IMAGE|VIDEO|GIF|VOICE|DOCUMENT|STICKER&cursor=&limit=`
(limit max 100).

This is a **separate** history from the timeline. A user who has never scrolled back can still open
the media tab and see everything — backfill from this endpoint, do not derive the media tab from
whatever the timeline happens to have cached.

Order the grid newest-first. Apply **R6**: the tiles must render cached local files, not the
presigned URLs in the response, or every tile older than an hour renders black. Resolve lazily around
the visible range — a room with 300 photos must not fetch 300 files on open.

### 2.8 Public user profile — `GET /api/v1/users/{userId}` — NEW

There was no get-user-by-id endpoint. Clients were searching by name and filtering the result. Stop
doing that.

```jsonc
{
  "userId": "…",
  "username": "…",
  "displayName": "…",
  "firstName": "…",
  "lastName": "…",
  "bio": null,
  "avatarUrl": "…",
  "coverImageUrl": "…",
  "isOnline": null,
  "lastSeenAt": null,
  "friendsCount": null,
  "groupsCount": null,
  "communitiesCount": null,
  "isDeletedUser": false,
  "relationship": {
    "friendshipId": "…",
    "status": "NONE|PENDING|ACCEPTED|BLOCKED",
    "direction": "INCOMING|OUTGOING",
    "canAccept": false,
    "canReject": false,
    "canCancel": false,
  },
}
```

- Carries **no** `email`, `account` or `dateOfBirth`. Do not expect them.
- Blocked in either direction → **404**, never 403 (a 403 would confirm the account exists).
- `whoCanViewProfile` / `whoCanSeeOnlineStatus` are now **enforced**. They were stored and ignored
  before, so turning them on hides data that used to show for anyone who set `FRIENDS`. See **R8**.
- `isDeletedUser: true` → render a "Deleted Account" card, not an error.
- `relationship` is the same block `GET /friends/status/{userId}` returns, so the profile screen needs
  **one** call, not two. Drive the friend CTA from it.

### 2.9 Group members — `GET /chat/groups/{roomId}/members` — CHANGED

The response is a **paginated envelope**, not a bare array:

```jsonc
{ "data": [ … ], "pagination": { "totalData": 42, "hasMore": true, "nextCursor": "…", "limit": 50 } }
```

Typing this as an array yields an empty members screen with no error. Rows are enriched with
`displayName` / `username` / `avatarUrl` from the user snapshot — render them directly rather than
re-resolving each member.

### 2.10 Group lifecycle — NEW events and system messages

- `group:added` is emitted to the creator on group creation and to each added member, so the inbox
  gains the room instantly instead of on next refresh.
- A newly added member's socket is auto-joined to the conversation room; they receive live messages
  without reconnecting.
- Telegram-style system messages for join / leave / add / remove / role change. Role-change and
  member-added previews are **personalised for the subject** ("You were added" vs "X was added") —
  render the preview the server sends; do not compose it client-side.
- System rows arrive as `contentType: "SYSTEM"` with a `systemEvent`. A client that reads only
  `messageType` sees `TEXT` and renders an empty bubble.

### 2.11 Inbox / conversation list — CHANGED

> **This is a list, not a timeline. The seq-only rule (R1) does not apply here** — a conversation
> list has no per-room sequence to page on. Keep the time cursors on these endpoints.

`GET /api/v2/chat/inbox` — opaque compound `(lastMessageAt, roomId)` cursor via
`before_cursor` / `after_cursor` + `limit` (max 100, default 20). The two cursors are mutually
exclusive. The cursor is opaque: echo `nextCursor` verbatim, never parse or construct it.

`GET /chat/private/conversations` takes `before_ts` / `after_ts` / `limit` (epoch ms) — deliberately
the same shape as the joined-communities list, so one pagination helper serves both.

Also fixed server-side, no client work needed but worth knowing: a deleted conversation no longer
reappears on a new message until that message is genuinely newer than the deletion point, and
`lastActivity` / unread drift is corrected.

Private room details and inbox rows now carry **friendship metadata** — use it to gate the composer
and the friend CTA without a second call.

### 2.12 Cursor pagination on lists — CHANGED

> Same note as 2.11: **lists keep their time cursors.** R1 removes timestamp paging from _message_
> endpoints only.

`GET /api/v2/communities/mine?scope=joined` requires **one of** `before_ts`, `after_ts`, `q` or
`categoryId`. Sending only `scope` + `limit` is a **400**. First page: `before_ts = now()` in epoch
ms.

### 2.13 Search — PARITY

Private and group search now match community search in behaviour and response shape. Recent searches
gained delete endpoints: remove one entry, and clear all.

### 2.14 Notifications — CHANGED

- Unread counts sync across REST and socket (`notification:count`, `notification:count_update`).
- Read-all is **type-aware** — it clears the tab you are on, not everything.
- Per-community notification preferences are enforced server-side.
- Payloads carry a user snapshot, so a notification row renders without an extra profile fetch.
- Render title/body from the wire; key the row on `notificationId`.

### 2.15 Calls — CHANGED

Busy detection on call initiate, with cleanup, and call events publish to `self:<id>` so your own
other devices are notified.

---

## Part 3 — Socket contract

Three namespaces over one connection. Handshake is `auth { token }` only — **the client never sends
its own user id**; the server derives it from the token.

| Namespace    | Carries                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `/chat`      | messages, receipts, reactions, typing, presence, inbox + community list bumps, `read_sync`, `pin:updated`, calls |
| `/community` | `community:message:*`, `community:member:*`, `community:stats:updated`, `community:read_sync`                    |
| `/notify`    | `notification:count`, `notification:count_update`                                                                |

Rules:

- **`message:new` now carries `revision`.** Track it per room. A jump of more than 1 means a missed
  change → run the REST `/changes` drain (**R2**). Debounce so an out-of-order burst asks once.
- **Ack integers arrive as strings.** `sentAt` and `sequenceNumber` come back as JSON strings (gRPC
  int64). A plain "parse as number" returns 0 and silently corrupts your ordering key.
- Typing is fire-and-forget on both namespaces — **never** emit it with an ack callback. Expire a
  typist locally after ~6s without a refresh. Filter out your own id.
- On reconnect you must re-join every room; the server drops subscriptions on disconnect.
- Event names are **not** yet unified across namespaces. `/chat` currently reuses one name for both
  directions on delete, read and delivered — so re-emitting what you received self-loops. Do not
  echo. A rename to imperative-in / past-tense-out is designed (`packages/constants/src/chat/
socket-events.ts`) but **not deployed**; build against the names you observe today.

---

## Part 4 — Migration checklist

Work top to bottom. Each item is independently shippable.

**Foundation**

- [ ] Local store is the source of truth; no view binds to a payload (**R3**)
- [ ] Idempotent merge-on-`id` for every inbound write, with the sticky fields (**R4**)
- [ ] Optimistic send with an **uppercase-UUID** `clientMessageId` (**R5**)
- [ ] One time utility: UTC epoch ms on the wire, local only at render (**R7**)

**Sync**

- [ ] Persist `revision` per message and `roomRevision` per room
- [ ] Implement the `/changes` drain once, shared by all three surfaces (**R2**, 2.2)
- [ ] Trigger it on open, on reconnect, and on a live revision gap
- [ ] Delete any socket catch-up code you have
- [ ] Order by `sequenceNumber` → `createdAt` → `clientMessageId` (**R1**)

**Timeline**

- [ ] Move to `/api/v2/.../messages`; strip params V2's `.strict()` will reject
- [ ] **Grep the client for `before_ts`, `after_ts`, `before_cursor`, `after_cursor`, `cursor=` and
      delete every message-endpoint use** — leave the _list_ endpoints alone (2.11, 2.12)
- [ ] Page with `before_seq` / `after_seq` only; delete the opaque-cursor code path entirely
- [ ] Read `hasMoreNewer` / `newerCursor` so a jump can scroll back to the present
- [ ] `around=` for jump-to-message; drop `/context` (2.4)
- [ ] Track jump-island bounds so paging never replays cached rows (2.4)
- [ ] Read `pinnedMessage` off the timeline; delete the separate pin call (2.3)

**Media**

- [ ] Cache by `objectKey`, render local files, re-resolve on miss (**R6**)
- [ ] Image cache keyed on URL path minus query
- [ ] Media tab backfills from `/media`, newest-first, resolved lazily (2.7)

**Screens**

- [ ] `GET /users/{userId}` for any profile; delete the search-and-filter workaround (2.8)
- [ ] Handle null privacy fields as "render nothing" (**R8**)
- [ ] Group members: paginated envelope, not an array (2.9)
- [ ] System messages: branch on `contentType: "SYSTEM"` + `systemEvent` (2.10)
- [ ] `unreadCount` from `read_sync`; drop `deliveredTo` / `readBy` (2.6)
- [ ] Grouped reactions, set semantics (2.5)
- [ ] `before_ts` on the first `/communities/mine?scope=joined` page (2.12)

---

## Part 5 — Deploy and known gaps

**Order:** backend ships **before or with** the clients. V2 is strict-schema, `pinnedMessage` is
embedded, and `GET /users/{userId}` is new — a client ahead of the backend gets 400s and 404s.

**Behaviour change to flag before rollout:** privacy scopes (`whoCanViewProfile`,
`whoCanSeeOnlineStatus`) are now enforced. Defaults are permissive, so most users are unaffected —
but anyone who had set `FRIENDS` will suddenly be respected, and their profile data will disappear
for non-friends. That is the intent; make sure support knows.

**Known gaps — do not design around them:**

- Group `delivered` has no storage. No group delivered tick.
- Socket event names are not unified across namespaces; `/chat` reuses one name per direction on
  delete/read/delivered. Do not echo received events.
- `community` message rows may still carry `revision: 0` in older rooms. Fall back to the timestamp
  `/sync?since_ts` feed until a room has its first revisioned message, then switch to `/changes`
  automatically.
- `MINIO_PUBLIC_ENDPOINT` is environment-specific and ships blank in `.env.example`. If it is unset,
  the server presigns against `localhost` and **every media URL is unreachable from a device.** Set
  it in every environment you deploy.

---

## Appendix — Android reference

| Concern                    | File                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| The one catch-up drain     | `ChatRepositoryImpl.revisionCatchup` / `fetchChangesPage` / `persistChangesPage` |
| Socket → REST re-sync seam | `ChatSyncTrigger`                                                                |
| Idempotent merge           | `MessageEntityMerge.mergeServerInto`                                             |
| Jump-to-message            | `ChatRepositoryImpl.locateMessage`, `JumpHistoryRegistry`                        |
| Timeline paging            | `ChatRepositoryImpl.fetchRoomPage` / `loadOlderPage` / `loadNewerHistoryPage`    |
| Media cache                | `MediaDownloadManager`, `MediaFileStore`, `MediaDownloadResolver`                |
| Shared-media tabs          | `SharedMediaPreviewResolver`, `buildChatProfileContent`                          |
| Time contract              | `AimessTime`, `AimessTimeFormatter`                                              |
| Architecture rules         | `AGENTS.md` §4a (layering), §9a (sync)                                           |
