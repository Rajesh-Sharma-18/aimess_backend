# Backend Master Prompt — Offline-First List & Timeline Consistency Gaps

Source: AIMess iOS offline-first merge work (ChatList, CommunityList, ChatRoom, CommunityChat).
The iOS client already enforces a monotonic freshness/identity merge at its local-cache
boundary. The gaps below are the ones iOS **cannot** close on its own, because the required
metadata is not in the payloads or the events are not delivered.

Nothing here asks for a breaking change. Every item is an additive field or an additional
event/scope. Existing clients that ignore the new fields keep working.

---

## MASTER PROMPT (paste to the backend agent/team)

> You are working on the AI-MESS backend (TypeScript / Node / Express, MongoDB, Redis,
> Socket.IO, BullMQ). The iOS client is offline-first: SQLite is the source of truth for
> rendering, and every incoming row — REST page, delta sync, socket event, pagination page —
> is merged field-by-field against the cached row using a monotonic freshness rule
> (newer wins; older is discarded; equal timestamps need a tie-breaker or the cached row is
> preserved). The client cannot use response arrival time, request order, or socket delivery
> order as freshness, because none of those are monotonic under retries, reconnects, and
> offline replay.
>
> Today the client is forced to fall back on timestamp-only comparison in several places,
> and in two cases it cannot resolve identity at all, which produces duplicate message
> bubbles and previews that need a manual refresh. Implement the changes in
> `docs/BACKEND_LIST_ACTIVITY_GAPS.md` (Sections 1–5), in priority order. For each item:
> add the field or event, keep it backward compatible, document the exact shape and units,
> and confirm the replay/idempotency behavior. Do not change existing field names or remove
> anything. Timestamps: epoch **milliseconds**, integer, UTC — everywhere, no exceptions.

---

## Section 1 — Message identity (P0, causes duplicate bubbles)

**Problem.** The client sends a message with a locally generated `clientMessageId` and shows
it optimistically. If a REST history page or a delta-sync page containing that same message
arrives before the socket acknowledgement, the client has no way to know the two are the same
logical message: the page row carries only the server `_id`, while the local row is still
keyed by `clientMessageId`. Result: two bubbles for one message until the ack lands.

**Required.**

1. Echo `clientMessageId` on **every** representation of a message, not just the send ack:
   - `GET /chat/rooms/{roomId}/messages` (private + group history)
   - `GET /chat/community/rooms/{roomId}/messages`
   - the `/changes` delta-sync payloads for both
   - `community:message:new` and the private `message:new` socket events
   - the inbox row's `lastMessage` object (see Section 2)
2. Value must be exactly what the client sent, unmodified, for the lifetime of the message.
   Null is acceptable only for messages that were never sent from a client (system messages,
   server-generated events).
3. This is the single highest-value change in this document. Without it, identity matching
   degrades to timestamp comparison, which cannot distinguish "the server's copy of my
   message" from "a different message sent in the same millisecond".

**Acceptance:** send a message, immediately pull history for the room before the ack is
delivered — the returned row carries the same `clientMessageId` the client sent.

---

## Section 2 — Conversation/community list row metadata (P0)

**Problem.** List rows carry a preview and a timestamp but no message identity and no
monotonic counter. When a pull-to-refresh returns a page built before the user's last send,
the client can only compare timestamps; when timestamps tie, it must preserve the cached row
to avoid flicker, which means a legitimately newer server row can be ignored.

Community rows are worse: they carry only `lastActivity.dateTime` — no last-message id at all.

**Required.**

1. **Private/group inbox** (`GET /api/v2/chat/inbox`), on each row:
   - `lastMessageId` — already present, keep
   - `lastMessage.clientMessageId` — new (Section 1)
   - `lastMessage.seq` — new: the message's per-room sequence number
   - `lastMessage.revision` — new: monotonic per-message revision (see Section 3)
   - `lastMessageAt` — epoch ms (verify: currently inconsistent, some paths emit seconds)
2. **Community list** (`GET /communities/mine` and the `after_ts` delta):
   - `lastActivity.messageId` — new
   - `lastActivity.clientMessageId` — new
   - `lastActivity.seq` — new
   - `lastActivity.senderId` — new (currently only `username` is reliably present)
   - `lastActivity.contentType` — verify present on every row, not only text messages
   - `lastActivity.dateTime` — epoch ms, verify units
3. **Preview semantics.** An empty or missing preview must mean "no information", never
   "clear the preview". If the last message was deleted, say so explicitly (Section 4) rather
   than sending an empty string — the client currently preserves its cached preview when the
   incoming one is empty, and will keep doing so.

**Acceptance:** two list responses for the same room with identical `lastMessageAt` can be
ordered deterministically by `seq`, without the client having to guess.

---

## Section 3 — Edit / revision precedence (P1)

**Problem.** A history page fetched before an edit lands will carry the pre-edit body. The
client protects itself by comparing `editedAt`, but `editedAt` is absent from reaction-only,
receipt-only, and some sync representations, and there is no monotonic revision the client can
rely on across all of them.

**Required.**

1. `revision`: integer, starts at 0 on create, increments on **every** server-side mutation of
   the message (edit, delete, reaction change, pin change, moderation).
2. Present on every message representation listed in Section 1, including partial ones.
3. `editedAt` (epoch ms) present whenever the body was edited, on every representation.
4. Edit events (`message:edited`, `community:message:edited`) must carry the resulting
   `revision`, so an out-of-order or duplicated edit event is a no-op rather than a rollback.

**Acceptance:** replaying an old edit event after a newer one has been applied does not change
the stored body on the client.

---

## Section 4 — Deletion tombstones (P1)

**Problem.** Community deletes remove the row outright and private deletes rely on a flag that
some history representations omit. A page fetched before the delete can reinsert a deleted
message. The client makes deletion sticky locally, but it cannot resist a page that simply
re-delivers the message as if nothing happened, and it cannot recover a preview for a
conversation whose latest message was deleted while the client had no local history.

**Required.**

1. History and `/changes` responses must include tombstone entries for deleted messages within
   the requested range: `{ messageId, clientMessageId, deletedAt, deletedForEveryone, revision }`.
   A deleted message must not simply vanish from the page — the client needs to be told.
2. Deleting the latest message in a room must update that room's list row to the newest
   remaining non-deleted message, and the list response must reflect that in the same
   `lastMessage`/`lastActivity` block. Do not emit an empty preview.
3. `community:message:deleted` and the private equivalent must carry `revision` and be
   idempotent on replay.

**Acceptance:** delete the latest message in a room, then request the inbox — the row shows
the previous message, not an empty preview and not the deleted one.

---

## Section 5 — Community socket delivery scope and replay (P0 for the reported bug)

**Problem.** `CommunityList` is often the only visible screen; the client does not join every
community's socket room. The reported symptom — "the first message after joining does not
update the list until pull-to-refresh" — happens when neither a list-scoped event nor a
reliable `community:updated` reaches the client.

**Required.**

1. **Delivery scope.** `community:message:new` (or a lighter list-activity event) must be
   delivered to every community the authenticated user is a member of, for the whole session,
   independent of which room the socket has explicitly joined. If a lighter event is preferred,
   it must carry: `communityId`, `messageId`, `clientMessageId`, `senderId`, `senderName`,
   `contentType`, `preview`, `createdAt` (ms), `seq`.
2. **`community:updated` consistency.** Emit it for every accepted message. Fix the payload to
   a single documented shape — the client currently has to accept nested `lastMessage.*`,
   flat `lastMessageText`/`lastMessageContentType`, `lastMessage.sender.*`, and both numeric
   and ISO-8601 timestamps, because all of these appear in practice. Pick one and document it:

   ```json
   {
     "communityId": "…",
     "roomId": "…",
     "lastMessageId": "…",
     "lastMessage": {
       "clientMessageId": "…",
       "text": "…",
       "contentType": "TEXT|IMAGE|VIDEO|VOICE|DOCUMENT|GIF|STICKER|LOCATION|CONTACT|SYSTEM",
       "senderId": "…",
       "senderName": "…",
       "createdAt": 1731000000000,
       "seq": 1234,
       "revision": 0
     },
     "unread": true
   }
   ```

3. **Reconnect replay.** After a socket reconnect the client must be able to close the gap
   without a full reload. Either replay missed `community:updated` events, or expose
   `GET /communities/activity?after_ts=<ms>` returning only the changed list-activity blocks.
   The existing `/communities/mine?after_ts=` delta is close but is scoped to membership/meta
   changes, not per-message activity.
4. **Membership authority.** A message event for a community the user is no longer a member of
   must not be delivered. The client deliberately refuses to create a row from a message event
   alone (that would resurrect a kicked/banned/left community), so a message for an unknown
   community is dropped and recovered only via `/communities/mine`. If the backend leaks
   post-removal message events, the user sees nothing — which is correct but wastes a sync.
5. **`community:added`** must carry `addedAt` in epoch **milliseconds**. A seconds value here
   makes a brand-new community sort to the bottom of the list.

**Acceptance:** with CommunityChat never opened, sending a message from another device updates
the CommunityList row's preview, sender, timestamp, unread badge, and position, with no
pull-to-refresh.

---

## Section 6 — Units and consistency audit (P2, but cheap)

Sweep every timestamp the mobile clients consume and confirm epoch **milliseconds**, integer:

| Field                   | Endpoint/event              | Verified? |
| ----------------------- | --------------------------- | --------- |
| `lastMessageAt`         | `GET /api/v2/chat/inbox`    | ☐         |
| `lastActivity.dateTime` | `GET /communities/mine`     | ☐         |
| `addedAt`               | `community:added`           | ☐         |
| `createdAt`             | all message representations | ☐         |
| `editedAt`              | edit events + history       | ☐         |
| `deletedAt`             | delete events + tombstones  | ☐         |
| `mutedUntil`            | mute events + list rows     | ☐         |

Mixed units are the single easiest way to make new activity look older than cached activity —
the client normalizes defensively (values below `100_000_000_000` are treated as seconds), but
that heuristic breaks for any real timestamp before 1973 and should not be load-bearing.

---

## Priority order

1. Section 5 — fixes the reported CommunityList bug
2. Section 1 — removes duplicate message bubbles
3. Section 2 — makes list ordering deterministic
4. Section 4 — stops deleted messages reappearing
5. Section 3 — stops edits regressing
6. Section 6 — removes the class of bug entirely

## Out of scope

No field renames, no removals, no response-envelope changes. The iOS client's local merge
policy (`AIMess/Data/LocalStorage/Database/LatestActivityMerge.swift`) already handles
everything that can be resolved client-side; do not expect it to be relaxed once these land.
