# Realtime message ordering — root cause and fix

Status: implemented
Scope: web client (`aimess_website`) message ordering. Backend read paths audited; no schema change.

---

## 1. Reproduction

1. Open a private chat between A and B.
2. A sends `1 2 3 4 5 6` as fast as the composer allows (no waiting for the tick).
3. While the rows still show the pending clock, hard-reload the page.
4. Re-enter the same chat. The initial history request is in flight.
5. Immediately send `7 8 9 10 11`.
6. Watch the transcript before every row settles.

Observed: the visible order is not the send order — rows swap while pending rows
are promoted. Reloading again shows the correct order.

The failure is _timing_-dependent, so it needs two things to show up reliably:

- messages persisted close enough together that the server's `createdAt` order
  and the server's `sequenceNumber` order can disagree (§4.1), and
- one optimistic row on screen whose position is decided by the **client** clock
  while its neighbours' positions are decided by the **server** clock (§4.3).

Step 3–5 (reload, then send into an in-flight history fetch) is what makes both
happen at once, which is why the bug reproduces there and not on a quiet chat.

The deterministic form of this reproduction lives in
`src/component/chat/messages/messageOrder.test.ts`; it replays the exact wire
sequences below without needing a live server.

---

## 2. Current message lifecycle (as audited)

```
composer
  -> optimistic row appended to the transcript's local `messages` state
     id = tmp-<Date.now()>-<counter>, clientMessageId = <ts>-<rand>,
     status = "pending", sortTs = Date.now()          <-- CLIENT CLOCK
  -> socket emit `message:send` carrying clientMessageId
       chat-service:
         allocateSequenceBlock(roomId)   -- atomic $inc on the room doc  [round trip 1]
         createMessage({ sequenceNumber, ... createdAt: new Date() })    [round trip 2]
  -> ack (SendMessageResult): { messageId, sequenceNumber, sentAt }
       applySendAck() patches the optimistic row in place:
         id := messageId, sequenceNumber := seq, sortTs := sentAt   <-- SERVER CLOCK
  -> broadcast `message:new` to both participants (full row, carries
     sequenceNumber and serverTs)
       sender side: reconciled onto the existing row by clientMessageId
       peer side:   inserted by sortTs
  -> REST history / pagination / `around` / catch-up (`/changes`) deliver the
     same rows again, deduped by id then by clientMessageId
```

The metadata needed for a correct order is already on every one of those
payloads. The client throws it away.

## 3. Current database ordering

`PrivateMessage` (and `GroupMessage`, `GeneralRoomMessage`) already carry a
server-authoritative, per-room, monotonic `sequenceNumber`, allocated by an
atomic `$inc` with write-conflict retry:

- `apps/chat-service/src/repositories/private-room.repository.ts:42` `allocateSequence`
- `apps/chat-service/src/repositories/private-room.repository.ts:85` `allocateSequenceBlock`

The message read paths order by it
(`private-message.repository.ts:153,173,497,536,546,937`), the cursor conventions
are built on it, and the client already sorts every REST page by it before
mapping. **Nothing about the backend ordering contract is broken.**

## 4. The exact race

### 4.1 `sequenceNumber` order and `createdAt` order are not the same order

`sequenceNumber` is allocated in one round trip and `createdAt` is stamped in the
next:

```
private-message.service.ts:290     allocateRoomSlot(...)            // seq assigned here
private-message.service.ts:328     this.messageRepo.createMessage(entity)
private-message.repository.ts:110    createdAt: (data.createdAt as Date) ?? new Date()
```

Two concurrent sends interleave freely in the gap between those two awaits, so
the message that won the `$inc` can lose the `create`:

```
send A: $inc -> seq 5 ............ create -> createdAt 10:00:00.412
send B: ........ $inc -> seq 6 ... create -> createdAt 10:00:00.408
```

`seq(A) < seq(B)` but `createdAt(A) > createdAt(B)`.

This is not a defect in the sequence allocator — a sequence and a wall clock are
different things and only one of them can be authoritative. The defect is that
the client uses **both**, in different places.

### 4.2 The client sorts by `createdAt` at realtime and by `sequenceNumber` on reload

Every REST page is sorted by `sequenceNumber` on arrival:

```
useDmTranscript.ts:229    [...result.data].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
useDmTranscript.ts:1478   (same, `around` jump)
useDmTranscript.ts:1494   (same, forward walk)
useDmTranscript.ts:1579   (same, jump-to-latest)
```

…and then that order is immediately discarded, because every merge ends with a
timestamp-only sort:

```
useDmTranscript.ts:279    [...mergedRest, ...preserved].sort((a, b) => (a.sortTs ?? 0) - (b.sortTs ?? 0))
useDmTranscript.ts:726    next.sort((a, b) => (a.sortTs ?? 0) - (b.sortTs ?? 0))
useDmTranscript.ts:1388 1426 1501 1517 1561 1597 1681      (all identical)
useGroupTranscript.ts:279 603 810 860 935 951 995 1035 1562 (all identical)
```

and the socket insertion point is chosen the same way:

```
useDmTranscript.ts:411    const insertAt = prev.findIndex((m) => (m.sortTs ?? 0) > (mapped.sortTs ?? 0));
useGroupTranscript.ts:366 (identical)
```

`sortTs` is `serverTs` (== `createdAt`) for a confirmed row
(`dmMessageMapper.ts:299`). So the realtime list is ordered by `createdAt` and
the post-reload list is ordered by `sequenceNumber` — and §4.1 says those are
different orders. **That alone reproduces "wrong live, right after reload."**

The community transcript is the same bug wearing a helper:
`compareChatMessages` (`mapCommunityMessage.ts:189`) is `sortTs` then
`id.localeCompare` — still no `sequenceNumber`.

### 4.3 Optimistic rows are positioned by the client clock

```
useDmTranscript.ts:971 1068 1117 1181 1221        sortTs: Date.now()
useDmTranscript.ts:850                            sortTs: Date.now() + descriptor.batchIndex
useGroupTranscript.ts:749 1057                    (same)
useCommunityChatTranscript.ts:1110 1269           (same)
```

A pending row's position is therefore decided by the device clock and its
neighbours' by the server clock. Any device/server skew — NTP drift, a VM
resuming, a laptop waking — moves every pending row by that skew relative to the
confirmed rows around it. `setMessages(prev => [...prev, optimistic])` puts the
row at the tail _initially_, so the skew is invisible until the next re-sort,
which arrives with the very next socket event, ack, page or catch-up tick —
hence "it reorders while messages are still being sent".

Skew is not even required: `Date.now()` is millisecond-resolution, so a burst
lands several rows on an identical `sortTs`. `Array.prototype.sort` is stable, so
they hold insertion order — until one of them acks and is re-stamped to its
`sentAt`, at which point it leaves the tie and the run reshuffles.

### 4.4 Why the reload step in the repro matters

`useDmTranscript.ts:227` merges the initial history page into `prev` rather than
replacing it, keyed on `id` **and** `clientMessageId`, so rows that arrived over
the socket while the fetch was in flight are preserved — that part is correct.
But the merge's last statement is the §4.2 timestamp sort, and its input is the
§4.3 mix of client-stamped pending rows and server-stamped confirmed rows. The
reload is what guarantees a fresh fetch overlapping a fresh burst of pending
rows, i.e. it is what makes §4.2 and §4.3 fire together.

### 4.5 Socket delivery order is genuinely unordered

The gateway relay is fire-and-forget and it awaits before it emits. `message:new`
always carries `senderId`/`senderName`, so `isPersonalizable` is true and the
fast `namespace.to(channel).emit(...)` path is skipped — every message goes
through the branch that awaits a Redis-adapter `fetchSockets()` round trip
(`api-gateway/src/sockets/emit-personalized.ts:39-54`). Both call sites invoke it
with `void` and never sequence it (`chat.ns.ts:704`), so two messages on one
channel race. The same row is also published on two channels (`conv:<roomId>`
and `user:<id>`), each through its own `void` call, so N messages produce 2N
independent races.

Two variable-latency network awaits also sit between the sequence allocation and
the publish — `resolveMediaUrl` and `resolveBroadcastContent`, both presign calls
(`grpc/service-impl.ts:381,391`) — so publish order is not tied to
`sequenceNumber` either.

This is why "do not depend on Socket.IO arrival order" is not a style rule here.
Arrival order is measurably not send order, and no amount of listener hygiene
fixes that. Ordering on `sequenceNumber` makes it irrelevant.

### 4.6 The client also erased the ordering key in four places

Even where the wire carried `sequenceNumber`, the client dropped it:

- `mapCommunityMessage.ts` `normalizeRestMessage` did not forward
  `sequenceNumber`, so **every community REST row** arrived with none.
- `mergePreservedMedia` built its result as `{ ...incoming, ... }`, and spreading
  copies keys whose value is `undefined` — so merging a REST row over a live
  socket row **erased** the sequence the live row already had.
- The community send ack had no `sequenceNumber` field at all
  (`SendCommunityMessageResponse` was `{message_id, room_id, sent_at}`), so a
  community row promoted from its ack could never acquire one.
- `mergePendingOutbox` — the **last write before render for all three
  transcripts** — re-sorted the whole list on `sortTs`, discarding whatever order
  the transcript had just built. Worse, it did so _conditionally_ (only when a
  queued row had no rendered twin), so the order flipped depending on whether the
  outbox happened to hold an orphan.

### 4.7 Two stale-response holes in the DM transcript

- The DM transcript never cleared `messages` on a room change (group and
  community both did), so the history loader took its merge branch and folded the
  previous conversation's rows into the new one.
- Neither the DM nor the group initial-history `.then` checked that its room was
  still open. Every other fetch in those files already guards on `jumpEpochRef`;
  the seed did not, so a slow response for the room the reader just left landed
  in the room they were now in.

### 4.8 What was ruled out

Checked and **not** the cause:

- Backend persistence order — `sequenceNumber` is atomic, per-room, monotonic,
  write-conflict-retried. Verified against every allocator entry point.
- Backend read order — the sequence-keyset paths the web client paginates with
  order by `sequenceNumber`.
- Stale-closure `setMessages` — all 39 message writes already use the functional
  form.
- Duplicate listeners — `on`/`off` are paired in each effect's cleanup.
- Duplicate insertion from ack + broadcast — the ack patches in place and the
  broadcast reconciles by `clientMessageId`.
- The Redux `messages` slice — it is the offline-outbox store; no transcript
  renders from it.
- React key churn on the temp→server id swap — already solved by `rowKey`.
- Client influence on `createdAt` — `clientTs` is stored and echoed but never
  feeds `createdAt`, `sequenceNumber`, or any sort.

---

## 5. Canonical ordering strategy

One rule, one function, in `messageOrder.ts`:

```
compareChatMessages(a, b)

  tier 0  confirmed, no usable sequenceNumber (legacy pre-backfill row)
          ordered by sortTs, then id
  tier 1  confirmed, sequenceNumber > 0
          ordered by sequenceNumber, then id
  tier 2  no server position yet (pending / failed / locally authored)
          ordered by pendingOrder (a process-monotonic counter)

  tier compares before key, so: legacy < sequenced < unsent
```

The sequence is checked **first**, so a row is only "unsent" while it genuinely
has no server position. `pendingOrder` counts as much as `status` there: a row
the client authors and never sends (a local call log) is unsent forever, and
without that check it would fall to the legacy tier and jump to the top.

Properties this buys:

- **Server-authoritative.** A confirmed row's position comes from
  `sequenceNumber` and nothing else. `sortTs` is demoted to display plus the
  legacy fallback, so §4.1's disagreement stops being visible and §4.5's
  scrambled delivery stops mattering.
- **Total and transitive.** Every row maps to one `(tier, key, id)` triple. A
  "seq when both have one, else timestamp" rule would not be: A(seq 5, ts 100),
  B(no seq, ts 50), C(seq 6, ts 40) gives A < C, B < A, C < B — a cycle, and
  `Array.sort` on a cyclic comparator produces garbage.
- **Same-millisecond safe.** `sequenceNumber` is unique per room, so confirmed
  rows never tie. Unsent rows tie-break on a counter, not a clock.
- **Clock-skew immune.** No client timestamp participates in the order of
  anything that has a sequence number.
- **Scoped per room.** `sequenceNumber` is per-room by construction, and each
  transcript holds one room's array.
- **Convergent.** An unsent row has no server position, so it sits at the tail —
  the only place a user can create one. The moment it acks it takes the exact
  position it will have after a reload.

`pendingOrder` is stamped once and never re-stamped, is not sent to the server
and is not persisted. Rows that are **rebuilt** rather than composed — a queued
outbox message redrawn after a reload, a pending upload redrawn on every change
to the upload queue — use `reservePendingOrder(clientMessageId)`, which allocates
once per key and then remembers. Minting a fresh rank in a builder that re-runs
each render would make the unsent tail reshuffle under the reader.

## 6. Reconciliation strategy

`mergeMessage` / `mergeMessages` in `messageOrder.ts` are the idempotent upsert,
matching on `id` first and `clientMessageId` second:

| case                                             | behaviour                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| unknown row                                      | insert at its canonical index (binary search, not append-then-sort)                                     |
| pending row with the same `clientMessageId`      | promote in place — keep `rowKey`, adopt server `id`/`sequenceNumber`, clear `pendingOrder` and `status` |
| same server `id` already present                 | update in place, never insert a second                                                                  |
| newer server state for a known row               | update in place; position is `sequenceNumber`, so it cannot move                                        |
| out-of-order arrival                             | insert; the canonical index puts it right                                                               |
| pagination row already seen over the socket      | deduped by `id`, and by `clientMessageId` for a row still on screen under its temp id (`newRowsOnly`)   |
| reload snapshot row already seen over the socket | same                                                                                                    |

Because position is a pure function of `(tier, key, id)`, an edit / delete /
reaction / receipt that rewrites a row's content cannot move it — a property of
the comparator, not something each handler has to remember.

The one thing every promotion path **must** do is re-place the row: promoting an
unsent row to its sequence is precisely a rank change, and `.map()` / `splice()`
rewrite the ordering field while keeping the old slot. Every promotion site now
re-sorts.

## 7. Pagination and reload strategy

Unchanged in shape, corrected in the final step: every path still merges into
`prev` rather than replacing it, and now finishes with `compareChatMessages`:

- initial history — merge, canonical sort, plus a room-generation guard on the
  response and a `messages` clear on room change
- older / newer page — dedupe on `id` **and** `clientMessageId`, canonical sort
- forward walk / `around` island / jump-to-latest — merge, canonical sort
- `/changes` catch-up — merge, canonical sort
- socket `message:new` — canonical insert, and a canonical re-sort on promotion
- `mergePendingOutbox` (last write before render) — canonical sort
- `displayMessages` — a final canonical sort before album coalescing, which
  groups _adjacent_ rows and so must see the final order

## 8. Socket lifecycle

No change needed and none made. `on`/`off` are paired per effect, room
join/leave is scoped to `roomId`, and the reconnect path is the revision-cursor
catch-up, which now merges through the same function. Given §4.5, making arrival
order irrelevant is the only durable fix; listener hygiene alone would not have
been one.

## 9. Backend changes

The ordering contract itself was already correct, so nothing about sequence
allocation, persistence, or the sequence-keyset reads changed. Two gaps were
closed:

- **The community send ack now carries `sequenceNumber`** — additive proto field
  4 on `SendCommunityMessageResponse`, populated in `service-impl.ts`, coerced
  from the proto-loader int64 string in the gateway client. Old clients ignore an
  unknown field; a server older than this returns none and the client simply
  keeps the row's tail slot until the echo. Private and group already carried it.
- **Two comments** now record that `createdAt` is deliberately not the ordering
  key, and that the timeline index's third column is unused by the query that
  index names — the previous comment claimed a determinism the query does not ask
  for, which is exactly how a reader concludes the timestamp axis is already
  sequence-ordered.

## 10. Files changed

Frontend (`aimess_website`):

| file                                                          | change                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/component/chat/messages/messageOrder.ts`                 | **new** — canonical comparator, sort, idempotent merge, binary insert, `newRowsOnly`, pending-rank counters                                                                                                                                  |
| `src/component/chat/messages/messageOrder.test.ts`            | **new** — 34 cases, the full ordering/merge matrix                                                                                                                                                                                           |
| `src/component/chat/messages/mapCommunityMessage.ts`          | re-export the canonical comparator; forward `sequenceNumber` in `normalizeRestMessage`; stop `mergePreservedMedia` erasing it                                                                                                                |
| `src/component/chat/messages/historyWindow.ts`                | `addLive` uses the canonical comparator                                                                                                                                                                                                      |
| `src/component/chat/messages/chatDateSeparators.ts`           | clamp the day forward — the render order is the sequence, and timestamps along it are not monotonic                                                                                                                                          |
| `src/component/message/hooks/useDmTranscript.ts`              | 10 sorts → canonical; socket insert → `insertMessage`; promotion re-sorts; `pendingOrder` on optimistic rows; clear `messages` on room change; generation guard on the seed fetch; dedupe on `clientMessageId`; final sort before coalescing |
| `src/component/message/hooks/useGroupTranscript.ts`           | same                                                                                                                                                                                                                                         |
| `src/component/community/hooks/useCommunityChatTranscript.ts` | canonical sort on the promotion branch; history page ordered by sequence; ack stamps `sequenceNumber`; `pendingOrder` on optimistic rows                                                                                                     |
| `src/component/message/hooks/applySendAck.ts`                 | clear `pendingOrder` on promotion and re-place the row                                                                                                                                                                                       |
| `src/hooks/usePendingOutbox.ts`                               | canonical sort (was the last write before render); reserved, stable `pendingOrder`; deterministic reservation order                                                                                                                          |
| `src/types/chat.types.ts`                                     | `pendingOrder?: number`                                                                                                                                                                                                                      |
| `src/types/chatSocket.types.ts`                               | `sequenceNumber?` on the community send ack                                                                                                                                                                                                  |

Backend (`aimess_backend`):

| file                                                                   | change                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/grpc-contracts/proto/community.proto`                        | additive `sequence_number = 4` on `SendCommunityMessageResponse`   |
| `apps/chat-service/src/grpc/service-impl.ts`                           | populate it from the saved row                                     |
| `apps/api-gateway/src/grpc/clients/community.client.ts`                | type it and coerce the int64 string                                |
| `apps/chat-service/tests/community/send-community-message-ack.test.ts` | assert the new field carries the real sequence                     |
| `apps/chat-service/src/repositories/private-message.repository.ts`     | comment: `createdAt` is not the ordering key                       |
| `apps/chat-service/prisma/schema.prisma`                               | comment: the timeline index's third column is unused by that query |

## 11. Tests

`node --test src/component/chat/messages/messageOrder.test.ts` — 34 cases:

- bursts of 2 / 10 / 50 / 100 arriving shuffled, three seeds each
- `sequenceNumber` contradicting `createdAt` (§4.1)
- a whole burst on one identical `createdAt`
- client clock ±1 day, ±5 s and 0 against the server
- ack promotes in place, no duplicate, `rowKey` preserved
- echo after ack, echo before ack, echo three times
- one row of a burst acking first, the rest converging on server order
- reload snapshot landing after socket rows; snapshot replayed twice
- the §1 repro end to end, echoes and history interleaved
- older page, overlapping page, out-of-order pages, live row mid-pagination
- edit / delete / reaction / receipt not moving a row; reply ordered by its own seq
- media holding its slot; failed media retrying; album partial acks
- legacy rows; comparator transitivity across all three tiers
- reserved ranks stable across rebuilds; `newRowsOnly` catching a temp-id twin
- two senders × 100 messages converging on one order for both clients
- **the acceptance property**: live order == reload order over 40 arrival
  permutations with contradictory timestamps and duplicate re-delivery

Also run: `tsc --noEmit` clean, `eslint` clean over every touched tree, the two
pre-existing frontend suites (46 tests total, all passing), and the backend
suites. chat-service: 1699 passing; the 51 failures are the documented
pre-existing baseline (media resolve-on-read and friends) — none reference the
changed field, and the one test this change did break is fixed and now asserts
the new contract. api-gateway: 407 passing, 9 pre-existing failures (i18n
catalog parity, `/stream` leave idempotency), untouched by this work.

## 12. Regression

The change is confined to _ordering and merging_. Content mapping, send payloads,
media upload, receipts, typing, calls, and the REST/socket contracts are
otherwise untouched. `rowKey` still pins render identity across the temp→server
id promotion, so no bubble remounts.

Two things this deliberately changes, worth knowing:

- **Day separators clamp forward.** The rendered order is the sequence, and a
  row's timestamp does not always rise with it — `createdAt` is stamped after the
  sequence, call rows are backdated to when the call ended, and an unsent row
  still carries the device clock. A bare `startOfLocalDay(ts)` on a row that dips
  backwards would open a second header for a day already passed and file every
  following message under it. A dipping row now belongs to the header it is
  rendered beneath.
- **A media row composed before a text now lands after it, live as well as after
  reload.** The media's `message:send` only fires once its upload completes, so
  the server genuinely sequences the text first. Previously the live order showed
  the media in its composed slot and disagreed with the server until the next
  reload; now both agree. Making the media _keep_ its composed slot requires the
  server to reserve the sequence at compose time (send the row first, attach the
  object key after) — a send-path change, not an ordering change.

## 13. Found during the audit, not fixed here

Real defects outside this bug's blast radius, recorded so they are not lost:

- **The timestamp pagination axis mixes two orders.** `getMessagesTimeline` pages
  by `(createdAt, _id)` but attaches `olderCursor`/`newerCursor` built from the
  page's min/max `sequenceNumber`. When the two orders disagree, a row whose
  sequence falls inside the page's range but whose `createdAt` falls outside can
  be skipped. The web client paginates on the sequence axis and is unaffected;
  mobile uses the timestamp axis. Fixing it means changing cursor semantics.
- **Album parts allocate their sequence one at a time inside the insert loop**, so
  a concurrent peer message can land between album siblings.
  `allocateSequenceBlock(roomId, count)` already exists and would reserve the
  whole contiguous range in one `$inc`; the album path never calls it that way.
- **The `clientMessageId` uniqueness guard is not in the schema.** It is a partial
  unique index created at boot via `$runCommandRaw`, and `ensureMongoIndex` treats
  an `IndexOptionsConflict` — which is what Mongo raises when a _non_-unique index
  already exists on the same keys — as success. Pre-insert idempotency is
  otherwise a read-then-write.
- **`message:reaction` and `message:edited` broadcasts carry no ordering cursor**
  (no `revision` on edited, nothing on reaction), so two crossing updates resolve
  last-write-wins with no way to reject the stale one.
- **`message:delete` has no personal-bus copy** while `message:new` does, so a
  client outside the room keeps a deleted row until it refetches.
- **The conversation list still orders on a bare timestamp.** That is the inbox
  axis, deliberately mirroring the server's inbox keyset — a conversation-level
  timestamp and message-level ordering are different concepts and this fix does
  not conflate them. Noted only because the inbox is fed `newest.sortTs`, which is
  device-derived for a media row.
