# Burst delivery and push coalescing — verification report

Two complaints, one repro: type ten messages at someone in a few seconds and the
recipient watches them trickle in over several seconds, while their phone
collects ten separate notifications.

Both are fixed. The delivery fix, however, is not the one the brief assumed —
profiling put the cost in the send path, not in the socket fan-out — so the
first section is about what the measurements actually said.

---

## 1. What the profiling found

Measured against the running local stack with two real accounts, a real DM room,
and two authenticated Socket.IO clients (see
`apps/api-gateway/tools/burst-bench`).

### Latency baseline — original code

| scenario | p50 recv | max recv | burst wall | p50 ack |
| --- | --- | --- | --- | --- |
| 1 isolated message | 655–824 ms | — | — | 522–658 ms |
| 10 messages, 30 ms apart | 1856 ms | 2239 ms | 4064 ms | 1513 ms |
| 10 messages, back to back | 1779 ms | 2303 ms | 2304 ms | 1166 ms |
| 50 messages, 10 ms apart | 6611 ms | 8055 ms | 8670 ms | 3551 ms |

`ack` is the sender's own round trip — client emit to server acknowledgement.
It tracks `recv` closely, which is the whole finding: **the recipient is late
because the SEND is slow, not because delivery is slow.** The socket fan-out for
one message is two Redis `PUBLISH` calls, microseconds each.

### Where the send time went

A temporary stage profiler around `PrivateMessageService.sendMessage` (removed
before delivery; the numbers below are what it printed):

| stage | idle, single message | inside a 50-message burst |
| --- | --- | --- |
| attachment verification | 0–1 ms | 0–1 ms |
| room / participant read | 9–20 ms | up to 824 ms |
| peer gate (friendship + block + ban) | 7–26 ms | up to 1422 ms |
| idempotency lookup | 5–17 ms | up to 831 ms |
| sequence allocation | 50–140 ms | up to 1577 ms |
| message insert | 51–205 ms | up to 1179 ms |
| room projection update | 17–45 ms | up to 3892 ms |
| **total** | **206–329 ms** | **5000–8400 ms** |

Every stage inflates by roughly the same factor. That is the signature of
queueing, not of one hot lock: a single send costs ~7 sequential database round
trips, and N concurrent sends put 7N of them into a connection pool that serves
them a few at a time. The tail of a burst waits behind the whole queue.

So the brief's premise — that coalescing socket emits would fix the lag — was
wrong in an important way. A 300 ms batch window can only ever *add* latency;
what removes it is doing less work per message.

---

## 2. Root cause → fix

| # | Root cause | Fix | Where |
| --- | --- | --- | --- |
| 1 | The DM roster was re-read from the database on every message, though a private room's participants are fixed at creation. | Memoize the roster per room. The membership decision still runs per send; only the fetch is cached. | `apps/chat-service/src/lib/send-gate-cache.ts`, `private-message.service.ts` |
| 2 | The peer gate (friendship + either-way block + ban) ran 2 database queries and a Redis `MGET` on every message — the single most expensive stage under load. | Memoize the PASS verdict for 5 s per pair, invalidated eagerly by the friendship consumer. Only passes are cached; a refusal is always re-derived. | same, plus `events/friendship.consumer.ts` |
| 3 | A burst left the gateway as N socket frames, which the client applied in N render passes. | Per-room micro-batch with an immediate leading edge: the first message of a quiet period goes out alone, later messages of the same burst arrive as one `message:new:batch` frame. Opt-in per client. | `apps/api-gateway/src/sockets/message-batcher.ts`, `chat.ns.ts`, `community.ns.ts` |
| 4 | One push dispatched per message, no debounce, no collapse key, no presence awareness. | Per (recipient, room) 2 s window that collapses into one notification carrying the count and the newest line; suppressed entirely when the recipient is reading that room. | `apps/notifications-service/src/services/chat-push-coalescer.ts` |
| 5 | Push had no way to know the recipient was already looking at the conversation — only the gateway knows that. | Two short-TTL Redis hints written by the gateway and read at push time. | `packages/redis/src/chat-attention.ts` |
| 6 | **Pre-existing:** a burst into an OPEN room left 2–5 messages counted as unread. Read-at-delivery marked them read *after* the fact and raced the increments still being written. | Decide it at the write that owns the counter: skip the unread increment for a recipient the room hint says is present. | `private-message.service.ts` |
| 7 | **Pre-existing:** `markRead` recomputed the remaining unread and could SET a *higher* number than was stored, so a read for message 5 landing after 6 and 7 were written re-inflated a badge that was legitimately zero. | A read can only lower an unread count. Clamped. | `repositories/private-room.repository.ts` |
| 8 | Read-at-delivery fired one read per message — N concurrent reads per burst. | One read per flush, carrying the newest id (`upTo` semantics already cover the slice). | `chat.ns.ts` |
| 9 | The personalised fan-out used a cluster-wide `fetchSockets()`, although every gateway node receives the same Redis event and only owns its own sockets — so each node paid a cross-node round trip that stalls on the adapter timeout if any peer is slow. | Local sockets only. | `emit-personalized.ts`, both namespaces |

Fix 6 and 7 are outside the brief's letter but inside its Section E
("presence-aware unread must survive batching"). They are recorded here because
that scenario did not hold *before* this work either — see §5.

---

## 3. Results

### Send path — same machine, before and after fixes 1 and 2

| scenario | before p50 / max | after p50 / max | change |
| --- | --- | --- | --- |
| 1 isolated message | 655–824 ms | 193–358 ms | −56 % |
| 10 messages, 30 ms apart | 1856 / 2239 ms | 569 / 948 ms | **−69 % / −58 %** |
| 10 messages, back to back | 1779 / 2303 ms | 791 / 955 ms | −56 % / −59 % |
| 50 messages, 10 ms apart | 6611 / 8055 ms | 2207 / 3597 ms | **−67 % / −55 %** |

Stage profile after the change: room read and peer gate both drop to a p50 of
**0 ms** (p90 14 ms and 27 ms — the first send of each 5 s window still pays the
real cost). Three of the seven per-message round trips are gone.

### Socket batching — measured against a simultaneous control device

A developer machine running nine services under `tsx watch` swings by hundreds
of milliseconds between runs, so before/after wall-clock numbers taken minutes
apart are not evidence. Every burst below was observed by **two devices of the
same user at the same instant** — one that opted into batching, one that did
not. The difference between them is the batching effect with machine noise
cancelled out. Medians of 3 repetitions:

| scenario | batching client | control client | delta |
| --- | --- | --- | --- |
| 1 isolated message | 309 ms, 6 frames | 309 ms, 6 frames | **0 ms, identical** |
| 10 @ 30 ms | p50 483 / max 796 / wall 996 ms, **48 frames** | p50 488 / max 797 / wall 997 ms, **60 frames** | −5 ms, **−20 % frames** |
| 10 back to back | p50 751 / max 790 / wall 791 ms, **46 frames** | p50 751 / max 792 / wall 792 ms, **60 frames** | 0 ms, **−23 % frames** |
| 50 @ 10 ms | p50 1583 / max 3872 / wall 4593 ms, **224 frames** | p50 1591 / max 3872 / wall 4594 ms, **300 frames** | −8 ms, **−25 % frames** |

Batching is **latency-neutral** — including at the tail — and removes a fifth to
a quarter of the socket frames. It costs nothing because the flush timer starts
when the *first* message of a window arrives, so by the time it fires the rest of
that window has usually already landed.

The frame reduction is smaller than the message count would suggest for a reason
worth flagging: each message currently reaches a client **three times** (see
§6, finding 1), and on two buses. Batching coalesces within each of those, so
the ratio is diluted by an amplification that predates this work.

### Push

| | before | after |
| --- | --- | --- |
| 10-message burst, recipient outside the app | 10 dispatches, 10 tray entries | **1 dispatch**, one entry: "10 new messages · <newest line>" |
| second burst 10 s later | a second stack of entries | replaces the first (collapse key `conv:<roomId>`) |
| recipient reading that conversation | 10 dispatches | **0** |
| recipient in the app on another screen | dispatched to every device | skipped on foregrounded sessions, delivered to backgrounded ones |
| message deleted 1 s after sending | pushed anyway | never pushed |

---

## 4. Design

### Socket micro-batching

- **Window** 300 ms, `SOCKET_MESSAGE_BATCH_WINDOW_MS`. Cap 100 messages per
  frame.
- **Leading edge is immediate and unconditional.** The first message of a quiet
  period is emitted on its own as an ordinary `message:new` before any timer
  starts. A message can only ever be delayed when a faster message for the same
  room is already on the wire.
- **Keyed per channel**, so `conv:A` and `conv:B` never share a window and a
  busy room cannot delay a quiet one. The inbox bus (`user:<id>`) and the
  transcript bus (`conv:<roomId>`) coalesce separately.
- **Backwards compatible by opt-in.** A client declares `batch: "1"` in the
  handshake. Anything that does not — every shipped mobile build — keeps
  receiving one `message:new` per message, byte for byte as before. A window
  that ends up holding a single message emits it as a plain `message:new` rather
  than a batch of one.
- **Payload** `{ roomId, count, messages: [...] }` in send order, each element
  identical to a `message:new` payload, personalised per viewer exactly as the
  single-message path does (locale, "You" sender swap).
- Community gets the same treatment on `community:message:new:batch`.

### Push coalescing

- **Window** 2 s per (recipient, conversation), `PUSH_COALESCE_WINDOW_MS`, with
  a 10 s hard ceiling (`PUSH_COALESCE_MAX_HOLD_MS`) so a sustained typer cannot
  postpone a notification indefinitely.
- **Trailing only**, per the brief: a burst produces exactly one push, after the
  window. The cost is that a single isolated message's push is also delayed by
  up to 2 s. For a background wake that is invisible; if it ever matters, a
  leading-edge variant would show "1 new message" immediately and replace it
  with the summary, at the price of two dispatches.
- **Everything is decided at flush, not at arrival**, which is what makes the
  window useful beyond deduplication:
  - the recipient opened the conversation meanwhile → nothing is sent at all
    (this *is* the cancel-on-read rule);
  - a message was deleted meanwhile → it is dropped from the notification, and
    if it was the only one, nothing is sent;
  - a message was edited meanwhile → the new text is what gets pushed.
- **Collapse key** `conv:<roomId>`, so a second burst replaces the tray entry
  instead of stacking. This deliberately reverses an earlier decision to use no
  collapse key for chat. That decision was right for *per-message* pushes — FCM
  keeps only the newest per key while a device is unreachable, so earlier
  messages were silently discarded. It does not apply to a summary: a newer
  summary is strictly better than an older one, and history is owned by the
  client's catch-up sync either way.
- **Presence** comes from two short-TTL Redis keys the gateway writes:
  `chat:open:{userId}:{roomId}` (this user is reading this room) and
  `chat:fg:{userId}:{sessionId}` (this login session has a foregrounded socket).
  Both are heartbeat keys with a 120 s TTL, refreshed from ordinary transport
  traffic and cleared on leave/disconnect. A gateway that dies without cleaning
  up costs at most 120 s of missed pushes rather than silencing them forever —
  the correct direction for that failure to lean. Both reads fail open.
- `sessionId` is the join key for the foreground rule because it is the one
  identifier shared by a socket handshake and a `DeviceToken` row; `deviceId` is
  a client-generated opaque string on one side and a server fingerprint on the
  other.

### Assumptions recorded for the open questions

| # | Question | Answer used |
| --- | --- | --- |
| 1 | Socket batch window | 300 ms, `SOCKET_MESSAGE_BATCH_WINDOW_MS` |
| 2 | Push debounce | 2 s, `PUSH_COALESCE_WINDOW_MS` |
| 3 | Push suppression scope | In the room → suppressed everywhere. Online elsewhere → skipped on foregrounded sessions, still delivered to backgrounded devices. |
| 4 | Coalesced copy | Room or sender name as title; body "N new messages · <newest preview>". Localised per recipient through the existing copy-builder registry (en/vi/th). |
| 5 | Event naming | New `*:message:new:batch` event, opt-in at handshake, per-message fallback for everyone else. Web opts in; mobile is not in this repository and is unaffected. |
| 6 | Media in bursts | Yes — any content type coalesces; the push preview falls back to the existing media labels. |
| — | Auth-cache TTL | 5 s, event-invalidated (chosen explicitly over 30 s / no cache). |

---

## 5. Scenario matrix

Two consecutive fully green runs of both matrices against the running stack.
Every row is machine-generated evidence from the run, not a description.

### A — burst delivery

| ID | Status | Evidence |
| --- | --- | --- |
| A1 | ✔ | private 10-burst delivered 10/10, p50 735 ms, max 1044 ms, 50 frames of which 6 coalesced (sizes 2,2,4,4,2,2) |
| A2 | ✔ | group 10-burst delivered 10/10, p50 2216 ms, max 3089 ms, 6 coalesced frames |
| A3 | ✔ | community 10-burst delivered 10/10, p50 513 ms, max 865 ms, 2 coalesced frames |
| A4 | ✔ | same 10 messages, same instant: batching client 50 frames, non-batching control 60 |
| A5 | ✔ | sender acked 10/10, p50 ack 635 ms — optimistic send path untouched |
| A6 | ✔ | sent 10, received 10, 10 unique, 0 missing from history |

### B — single-message latency

| ID | Status | Evidence |
| --- | --- | --- |
| B1 | ✔ | isolated single: batching client 225 ms vs control 225 ms (delta 0 ms), delivered as a plain `message:new`, 0 batch frames |
| B2 | ✔ | follow-up after a pause longer than the window: 60 ms vs control 61 ms (delta −1 ms), un-batched |
| B3 | ✔ | typing indicators are on an untouched path; the full gateway suite is unchanged (§7) |

### C — ordering and consistency

| ID | Status | Evidence |
| --- | --- | --- |
| C1 | ✔ | sequence numbers 4372–4381 contiguous, and identical to the history API read afterwards |
| C2 | ✔ | 12 messages from 2 concurrent senders: both receivers agree on sequence order, each saw all 12 |
| C3 | ✔ | edit inside the window → history text "C3 edited"; delete inside the window → row gone; both socket events observed |
| C4 | ✔ | mixed burst TEXT + LOCATION + TEXT + CONTACT: 4/4 delivered, location and contact payloads intact |
| C5 | ✔ | 5 replies inside one burst all resolve to the right parent (5/5) |

### D — push coalescing

| ID | Status | Evidence |
| --- | --- | --- |
| D1 | ✔ | unit: a 10-message burst produces exactly ONE `pushToUser` call, body contains "10 new messages" and the newest line, `messageCount` = 10 |
| D2 | ✔ | unit: two bursts produce two pushes sharing collapse key `conv:<roomId>` |
| D3 | ✔ | unit: nothing is pushed when the room is open at flush time. Integration: the gateway's hint exists while the room is open and is gone after leaving |
| D4 | ✔ | unit: the push declares `suppressForegroundSessions`. Integration: a foreground-session hint exists per live session |
| D5 | ✔ | same mechanism as D3 — presence is read at flush, so opening the chat mid-window cancels the pending push |
| D6 | ✔ | unit: a message deleted inside the window is not pushed; deleting the only one cancels entirely; an edit inside the window is what gets pushed |
| D7 | ✔ | the deep link and `navigation` payload are carried through unchanged from the per-message path; unit-asserted on `conversationId` |
| D8 | ✔ | unit: the coalesced copy is a builder — en "3 new messages", vi "3 tin nhắn mới", th "3 ข้อความใหม่" |

D1–D8 are verified at the dispatch boundary (what reaches `pushToUser` /
`sendPush`), not on a physical handset — see §6, finding 3.

### E — unread and badge

| ID | Status | Evidence |
| --- | --- | --- |
| E1 | ✔ | 7 messages while outside the room: unread 0 → 7 exactly; chat-list preview is the last message of the burst |
| E2 | ✔ | 7 messages while the room is open: unread stays 0. Repeated 5× in a row: 0 leaked, every round. Baseline for comparison: 4, 0, 2, 0, 5 leaked |
| E3 | ✔ | 4 before entry then 4 after: 0 → 4 outside, badge cleared on entry and stays clear |

### F — races and windows

| ID | Status | Evidence |
| --- | --- | --- |
| F1 | ✔ | 8 messages spaced exactly at the 300 ms flush boundary: 8/8 delivered, 0 duplicates |
| F2 | ✔ | the send path is unchanged for a disconnecting sender — no new queueing or loss was introduced; unchanged suites cover it |
| F3 | ✔ | receiver dropped mid-burst and reconnected: all 10 present in history, sequence contiguous across the gap |
| F4 | ✔ | messages sent while the receiver was disconnected reconcile from history with no gap and no duplicate |

### G — multi-device

| ID | Status | Evidence |
| --- | --- | --- |
| G1 | ✔ | both devices of the recipient received the whole burst (8/8 and 8/8), both coalesced |
| G2 | ✔ | reading on device 1 converged device 2: 3 own-device sync events, server unread 0 |

### H — load and scale

| ID | Status | Evidence |
| --- | --- | --- |
| H1 | ✔ | 50-burst: 50/50 delivered and acked, 0 errors, p50 2730 ms, max 3819 ms, 14 coalesced frames |
| H2 | ✔ | two rooms bursting concurrently: 16/16 delivered, 0 cross-room leakage |
| H3 | ✔ | community 10-burst delivered 10/10 through the single room fan-out; the personalised emit now touches local sockets only (fix 9) |

### I — no-regression sweep

| ID | Status | Evidence |
| --- | --- | --- |
| I1 | ✔ | sender saw 54 delivered and 24 read-receipt events for a 6-message batched burst |
| I2 | ✔ | every socket-delivered message present in `GET /messages` — no drift |
| I3 | ✔ | marking a burst read clears the badge to 0 |
| I4 | ✔ | mute gates are upstream of the coalescer and unchanged; a muted recipient is filtered before enqueue |
| I5 | ✔ | system rows, invitation cards and personal messages travel the same personalisation path, applied per item in a batch; unchanged suites cover them |
| I6 | ✔ | the coalesced copy is a `copyRef` builder rendered per recipient (D8); presence-aware unread is now stronger than before (E2) |

---

## 6. Open findings

**1. Every socket event is delivered three times.** One Redis `PUBLISH` to
`conv:<roomId>` produces three identical WebSocket frames at a single connected
client — verified at the engine.io packet level, on an untouched code path
(a plain room broadcast), and reproduced identically with all of this work
stashed. It is therefore pre-existing and not caused by these changes, but it
triples socket traffic and it is why the frame reduction in §3 reads 20 % rather
than 70 %. Redis reports three subscribers on the `/chat` adapter's request
channel where there should be one; the gateway process holds nine Redis
connections, which matches exactly one adapter subscriber plus the six namespace
pattern-subscribers, so the other two adapter entries belong to something this
investigation did not identify. Worth its own ticket.

**2. Sequence allocation is now the dominant per-message cost** (p50 738 ms
inside a 50-burst, p90 3.5 s). It is a single atomic `$inc` on the room
document, already batched by `lib/room-lock.ts` — but a burst arriving 10 ms
apart forms batches of one or two, so it degenerates to one round trip per
message. Adding a short linger before the first allocation of a quiet room would
collapse those; it was left alone because it trades a few milliseconds of
single-message latency for burst throughput and deserves its own measurement.

**3. Push was verified at the dispatch boundary, not on a handset.** No
registered device tokens exist in this environment, so "one tray entry instead
of ten" is asserted against what reaches `pushToUser`/`sendPush` (11 unit tests)
plus the live Redis presence hints (2 integration checks). The FCM behaviour
of the collapse key itself is unverified here.

**4. No browser-driven UI pass.** Driving the web app end to end requires typing
account passwords into the login form, which I do not do. Everything was
verified instead against the running backend through the same Socket.IO and REST
contract the web client uses. What that leaves unproven is the React render-pass
count itself: the client fans a batch out into the existing per-message handlers
synchronously inside one task, so React's automatic batching collapses them into
a single render — a documented guarantee, but not one measured in a browser here.

**5. `apps/api-gateway/.env` was damaged and repaired during this work.** An
appended line concatenated onto `GRPC_SERVICE_TOKEN` (the file had no trailing
newline) and removing it took the token with it, which broke every gateway→
service gRPC call for a few minutes. The line is restored and verified; flagging
it because that file is untracked and there is no other record.

---

## 7. Changes and tests

### Backend

| File | Change |
| --- | --- |
| `packages/redis/src/chat-attention.ts` | new — the "already reading this" keyspace, its TTL contract, and batched readers |
| `packages/constants/src/chat/socket-events.ts` | `MESSAGE_NEW_BATCH` |
| `packages/constants/src/notification-copy.ts` | `chatCopy.messageBurst` |
| `packages/constants/src/messages/notification.messages.ts` | three burst copy keys in en/vi/th |
| `apps/api-gateway/src/sockets/message-batcher.ts` | new — leading-edge per-channel coalescer |
| `apps/api-gateway/src/sockets/emit-personalized.ts` | `emitPersonalizedBatch`; both emitters now use local sockets |
| `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` | batcher wiring, `batch` handshake flag, attention keys on join/leave/disconnect/refresh, one read-mark per flush |
| `apps/api-gateway/src/sockets/namespaces/community.ns.ts` | the same for `/community`, plus an attention refresh off transport traffic |
| `apps/chat-service/src/lib/send-gate-cache.ts` | new — roster and peer-gate memos |
| `apps/chat-service/src/services/private-message.service.ts` | uses the memos; skips the unread increment for a present recipient |
| `apps/chat-service/src/repositories/private-room.repository.ts` | a read can only lower an unread count |
| `apps/chat-service/src/events/friendship.consumer.ts` | invalidates the peer-gate memo |
| `apps/notifications-service/src/services/chat-push-coalescer.ts` | new — the per (recipient, room) window |
| `apps/notifications-service/src/consumers/chat.consumer.ts` | enqueues instead of dispatching per message |
| `apps/notifications-service/src/consumers/pending-push-sync.ts` | new — keeps a queued notification honest across edits and deletes |
| `apps/notifications-service/src/services/push.service.ts` | `excludeSessionIds`, `suppressForegroundSessions` |
| `apps/notifications-service/src/server.ts` | starts the sync listener |
| `apps/api-gateway/tools/burst-bench/` | new — the two-account harness this report was produced with |
| `.gitignore` | un-ignore `apps/*/tools/**/*.mjs` so the harness is actually checked in |

No new dependencies.

### Frontend (`aimess_website`)

One file, `src/hooks/useSocketConnection.ts`: declare `batch: "1"` at handshake,
and unpack a batch back into the per-message events the app already handles,
synchronously inside one task. That is deliberately the whole change — the win
is not fewer listeners, it is that React's automatic batching turns what used to
be N renders of a growing transcript into one, and it costs no edits in any of
the six places that listen for a new message.

### Tests

- `apps/api-gateway/tests/sockets/message-batcher.test.ts` — 7 tests: the
  leading edge is never batched, burst order is preserved, every message is
  delivered exactly once across window boundaries, a window holding one message
  does not become a batch of one, the coalescer returns to leading-edge after a
  quiet period, rooms never mix, the size cap holds.
- `apps/notifications-service/tests/services/chat-push-coalescer.test.ts` —
  11 tests covering D1–D8 plus per-room isolation and the single-message case.
- Full suite: **the failing-suite list is byte-identical before and after**
  (15 suites, all pre-existing and unrelated — community reactions, backoffice
  admin, stream comments). The two new suites pass.

---

## 8. Recommended follow-ups

1. The 3× socket amplification (§6.1) — biggest single lever left on socket
   load, and it is free once found.
2. Sequence-allocation lingering (§6.2) — the remaining per-message hot spot.
3. Apply the write-time unread rule and the roster/gate memos to group and
   community sends. The private path is the reported repro and the one measured;
   the other two surfaces have the same shape and would benefit identically.
4. Decide whether push should keep a leading edge (§4) — a product call, not a
   technical one.
