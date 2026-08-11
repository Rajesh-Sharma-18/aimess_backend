# Offline-First List & Timeline Contract

Backend response to `docs/BACKEND_LIST_ACTIVITY_GAPS.md` (iOS offline-first merge
work). Every change below is **additive**: no field was renamed or removed, no
response envelope changed, no socket event was retired. A client that ignores
these fields behaves exactly as it did before.

Timestamps are **integer epoch milliseconds, UTC**, everywhere.

---

## 1. The identity quartet

Four fields answer the three questions a preview + timestamp cannot:

| Field             | Answers                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `clientMessageId` | "Is this the server's copy of the message I sent optimistically?" |
| `seq`             | "Which of two rows sharing one millisecond is newer?"             |
| `revision`        | "Has this message been edited/deleted/reacted-to/pinned since?"   |
| `messageId`       | The server id, for rows that previously carried none.             |

Defaults are **`null` / `0` / `""`, never `undefined`** — an absent JSON key
means "keep your cached value", a present default means "no information". The
two are not interchangeable in a monotonic merge.

`clientMessageId` is stored verbatim at insert and never rewritten. It is
`null` for server-generated messages (system lines, call rows), and blanked on
community SYSTEM rows where the column doubles as an internal dedup token.

Source of truth: `apps/chat-service/src/lib/list-row-identity.ts`.

---

## 2. Where the quartet now appears

### Message representations (already carried it — unchanged)

`clientMessageId`, `sequenceNumber` and `revision` are columns on
`PrivateMessage`, `GroupMessage` and `GeneralRoomMessage`, and were already
serialized onto every message representation: REST history (V1 + V2), `?around=`
windows, search, the `/changes` delta feed, and the `message:new` /
`community:message:new` / `message:edited` / `community:message:edited` socket
events.

### Inbox — `GET /api/v1/chat/inbox`

`lastMessage` now carries `messageId`, `clientMessageId`, `seq`, `revision`
alongside its existing fields. `lastMessageId` and `lastMessageAt` (epoch ms)
are unchanged.

This holds on every path that writes the row's snapshot — a new send, a
system-message bump, a call-row transition, and the delete-recalc that rolls the
row back to the previous visible message — and through the per-viewer overlays
(delete-for-me fallback, left-member preview cap).

### Private conversation list — `GET /chat/private/conversations`

`PrivateConversationListItem` deliberately drops the raw `lastMessage`, so this
list previously carried **no** message identity at all. `lastActivity` now
carries `messageId`, `clientMessageId`, `seq`, `revision` and `contentType`.

When the reaction overlay wins (a reaction newer than the last message, visible
only to the actor and the reacted-to message's owner), the identity block is
**deliberately blanked** and `contentType` is `SYSTEM`: the overlay is an
activity line, not a message, and a client merging by identity must not read it
as an edit of whatever message it temporarily covers.

### Community list — `GET /communities/mine`, `GET /communities/activity`

`lastActivity` gains `messageId`, `clientMessageId`, `seq`, `senderId` and
`contentType`. `dateTime` was already epoch ms.

`senderId` is populated on SYSTEM rows too, even though `userId` stays `null`
there — `userId: null` is what stops the client rendering `"<actor>: <system
text>"`, but the merge still needs to know who sent the underlying message.

Backed by four new nullable `Community` columns
(`lastActivityMessageId`, `lastActivityClientMessageId`, `lastActivitySeq`,
`lastActivityContentType`), denormalized from the same `community.activity`
event as the preview. **No backfill is required**: an un-bumped community
reports the "no information" defaults until its next activity.

The `UpdateMessageActivity` gRPC carries the same fields. It is the synchronous
companion to the queue publish and both write through the same forward-only
`lastActivityAt` guard, so without this whichever landed first would blank what
the other wrote.

### `conv:updated` / `community:updated`

`lastMessage` is now **self-describing** — one documented shape, no branching:

```json
{
  "communityId": "…",
  "roomId": "…",
  "lastMessageId": "…",
  "lastMessage": {
    "contentType": "TEXT",
    "text": "…",
    "clientMessageId": "…",
    "seq": 1234,
    "revision": 0,
    "senderId": "…",
    "senderName": "…",
    "createdAt": 1731000000000
  },
  "lastMessageAt": 1731000000000,
  "senderId": "…",
  "senderName": "…",
  "unread": true
}
```

`senderId` / `senderName` / `lastMessageAt` are **mirrored** into `lastMessage`,
not moved — the top-level fields stay exactly where existing clients read them.

---

## 3. Revision

`revision` is an integer allocated from the room's monotonic `lastRevision`
counter, starting at 0 on create and re-stamped on every server-side mutation:
edit, delete-for-everyone, reaction change, call-state transition, forward, and
now **pin / unpin**.

Pin/unpin previously mutated only the separate pin collection, so a pin was
invisible to `/changes` and an offline client never learned about it. All three
surfaces now bump the target message (and, on a pin switch, the replaced one).
The bump is best-effort: a failure is logged, never fatal to the pin.

`revision` is monotonic per room, not per message, and is never derived from a
timestamp — an out-of-order event carrying an older `revision` is safely
discardable.

---

## 4. Deletion tombstones

### One shape across all three surfaces

The three surfaces store deletion under different column names (`isDeleted` +
`deletedAt` on private/group, `deletedForAll` + `deletedForAllAt` on community),
which forced clients to branch per conversation type. Every serialized message
now also carries the normalized pair:

```json
{ "deletedForEveryone": true, "deletedAt": 1731000000000 }
```

The raw columns are still serialized alongside, unchanged.

### Delete events

`message:delete` and `community:message:deleted` now carry `revision`,
`clientMessageId`, `deletedAt` (epoch ms) and `deletedForEveryone`, so a
replayed or out-of-order delete is a no-op rather than a rollback. REST delete
returns the same object byte-for-byte.

### Deleting the latest message

Already correct before this work and unchanged: the room's snapshot is
recalculated to the newest remaining **visible** message (per viewer — a
recipient who personally hid that message gets their own), and the list row is
re-bumped with it. An empty preview is emitted only when the viewer genuinely
has no visible message left. It now carries that message's identity too.

### Deleted messages in history pages — deliberately unchanged

History pages continue to **omit** deleted messages; the `/changes` feed is the
tombstone axis and deliberately does not filter them (see the `[roomId,
revision]` index comments on all three message models).

This is a considered deviation from §4.1 of the source document, which assumes a
backend where history pages can re-deliver a deleted message. Here they cannot:
a deleted message is never in a history page, so there is nothing to reinsert.
Adding tombstones to history would create a second, weaker tombstone axis with
no new capability, and would make existing clients start rendering rows they
have never rendered. If a client still wants them, the cheap change is an opt-in
`include_deleted=1` query flag on the timeline reads — say so and it can be
added.

---

## 5. Community socket delivery scope

**Already correct — verified, not changed.**

`community:updated` is published **per member to that member's personal
`user:<userId>` Redis channel** (`publishCommunityUpdated`), and the `/community`
namespace joins `user:<userId>` at connect. Delivery therefore does not depend
on the client having called `community:join` for that community — an open
`CommunityList` with no chat room open still receives the bump.

- **Recipient list**: `getActiveMemberIds` → `findActiveByRoom`, so a member who
  left, was kicked, banned or removed stops receiving events immediately.
- **Emitted for every accepted message**, plus system lines, deletes (with
  per-recipient preview overrides) and reaction overlays.
- **`community:added`** carries `addedAt` as `Date.now()` — epoch ms, verified.

### Reconnect replay — `GET /communities/activity?after_ts=<epoch-ms>`

New. Returns only the changed list-activity blocks, oldest-first:

```json
{
  "pagination": { "nextCursor": "1731000000000", "hasMore": false, "…": "…" },
  "data": [
    {
      "communityId": "…",
      "lastActivity": { "…": "…" },
      "lastActivityAt": 1731000000000,
      "unreadMessageCount": 3,
      "firstUnreadMessageId": "…"
    }
  ]
}
```

It is a projection of `listMine(direction: "after")` — the same `lastActivityAt`
keyset, which every accepted message already bumps, so there is one ordering and
one definition of "activity". `nextCursor` is epoch ms, fed straight back as
`after_ts`.

(The source document assumed `/communities/mine?after_ts=` was scoped to
membership/meta changes. It is not — it keysets on `lastActivityAt`, which _is_
the per-message activity clock. `/communities/activity` exists to give clients a
smaller payload and an explicitly named replay channel, not different data.)

---

## 6. Timestamp audit

| Field                   | Surface                     | Result                  |
| ----------------------- | --------------------------- | ----------------------- |
| `lastMessageAt`         | `GET /chat/inbox`           | epoch ms                |
| `lastActivity.dateTime` | `GET /communities/mine`     | epoch ms                |
| `addedAt`               | `community:added`           | epoch ms (`Date.now()`) |
| `createdAt`             | all message representations | epoch ms                |
| `editedAt`              | edit events + history       | epoch ms                |
| `deletedAt`             | delete events + tombstones  | epoch ms                |
| `mutedUntil`            | mute events + list rows     | see below               |

Every REST response passes through `ApiResponse.toJSON` →
`serializeDates`, which converts **every** `Date` in the payload tree to epoch
ms. A `Date`-typed field therefore cannot reach a client as anything else.

A repo-wide search for seconds-producing arithmetic (`getTime() / 1000`,
`Math.floor(Date.now() / 1000)`) finds exactly two hits, both APNs protocol
fields (`apns-expiration`, `notification.expiry`) which are **specified** in
seconds and are correct.

**`mutedUntil` is the one exception**: it is pre-formatted to an ISO-8601 string
before serialization, so `serializeDates` never sees it. It is not a _seconds_
bug — ISO-8601 is unambiguous — but it is not epoch ms either. Renaming it would
break existing clients, so epoch-ms mirrors were added alongside:

- `memberMutedUntilMs` on the inbox row and group membership
- `muteUntilMs` on the community list row

The ISO strings stay exactly as they are.

---

## Known limitations

- **Per-viewer community overlays emit an empty identity block.** When
  `chatLastMessageToActivity` / the personal-join overlay / the reaction overlay
  wins over the denormalized column, the row reports the "no information"
  defaults rather than that message's identity. Those overlays are fed by a gRPC
  summary whose payload has no identity fields yet. Per §2.3 of the source
  document, empty means "no information, keep your cached value", so this is
  correct-but-incomplete, not wrong. Closing it means extending the
  `ChatCommunitySummary` proto.
- **`community.activity` events for reaction add/remove, edit and pin** do not
  carry the quartet; only send, forward and delete-recalc do. Those activity
  types either describe no single message or reuse the reaction overlay above.
