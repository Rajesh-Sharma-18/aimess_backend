# Call Notification Audit

Date: 2026-08-18
Scope: 1:1 audio/video call → Notification Center ("Notifications" page, Friends tab).

## Problem

Some users see call entries in the Notifications list, others never do — even
though the call demonstrably happened and the call card is present in the chat
transcript for both participants. The gap is per-_user_, not per-call: the same
call produces a Notification row for one participant and nothing for the other.

## Root Cause

**A per-user notification _preference_ was deleting the persisted call _history_
row, not just the push.**

Call history reaches the Notification Center as one inbox row per participant,
written by the `call.activity` projection
(`apps/notifications-service/src/consumers/call.consumer.ts` →
`pushToUser({ skipPush: true })`). That projection is inbox-only: it sends no
push at all, because the live ring (`call.incoming`) and the missed-call alert
(`call.missed`) already own push delivery for a call.

`pushToUser` gates every send on the recipient's account preferences
(`apps/notifications-service/src/services/push.service.ts`). Its rule was:

- `CATEGORY_OFF` (the user switched this class of notification off) → suppress
  the push **and** the inbox row, return immediately.
- `QUIET_HOURS` → suppress only the push, keep the inbox row.

`call.activity` runs under `category: "callEnabled"`. So a user with **Call
notifications turned off** got _no history row at all_, while the person on the
other end of the very same call — whose toggle was on — got theirs. Both saw the
call card in the DM, because the chat timeline row is written by chat-service and
never consults notification preferences. That is exactly the reported symptom.

Verified against the live database, not inferred:

```
aimess_users.notification_settings  → exactly 1 of 299 users has callEnabled=false
                                      (d16e6e16-7ea3-4418-ac92-3ffebd0a56fa)

aimess_chat.calls (1:1, last 3 days) → every terminal call wrote 2 notification
                                      rows, EXCEPT the 3 calls where that user
                                      was a participant, which wrote 1 (the
                                      other side's) — never that user's.
```

The toggle is an _alerting_ preference. Call history is a log of something that
already happened, derived from the canonical call record for both ends at once.
Silencing an alert must not erase the log.

Two secondary defects in the same path meant a single failure could delete call
history for **both** participants permanently — see Issues 2 and 3.

## Call Lifecycle Audit

Publish choke point: `CallService.postCallChatMessageSafe`
(`apps/chat-service/src/services/call.service.ts`) — all 14 lifecycle call sites
route through it, and it projects `call.activity` for any
`isTerminalCallStatus(outcome)`. Group calls return earlier (group timeline
instead), which is why community/group calls never reach the Friends tab.

| Scenario                                   | Caller row                   | Receiver row                | Call status | Notification         | Result                                                                          |
| ------------------------------------------ | ---------------------------- | --------------------------- | ----------- | -------------------- | ------------------------------------------------------------------------------- |
| A→B answered, then ended                   | OUTGOING, read               | INCOMING, read              | ENDED       | 1 per side           | OK                                                                              |
| A→B declined                               | OUTGOING, read               | INCOMING, read              | DECLINED    | 1 per side           | OK                                                                              |
| A→B cancelled (long ring)                  | OUTGOING, read ("Cancelled") | INCOMING, unread ("Missed") | CANCELLED   | 1 per side           | OK                                                                              |
| A→B cancelled (< grace window)             | OUTGOING, read               | INCOMING, read              | CANCELLED   | 1 per side           | OK                                                                              |
| A→B never answered (60s sweep)             | OUTGOING, read               | INCOMING, unread            | MISSED      | 1 per side           | OK after fix (see Issue 2/3)                                                    |
| A→B failed                                 | OUTGOING, read               | INCOMING, read              | FAILED      | 1 per side           | OK                                                                              |
| B→A (all of the above)                     | mirrored                     | mirrored                    | same        | 1 per side           | Symmetric — direction is derived per recipient from `callerId`, never hardcoded |
| CALLING / RINGING / CONNECTING / CONNECTED | —                            | —                           | live        | none                 | Correct: only terminal states project                                           |
| Group / community call                     | —                            | —                           | any         | none in Friends      | By design (group timeline)                                                      |
| Recipient offline                          | written                      | written                     | any         | 1 per side           | Persistence never consults presence                                             |
| Recipient's `callEnabled` = off            | written                      | **was missing**             | any         | 1 per side after fix | **The bug**                                                                     |
| Recipient in quiet hours                   | written                      | written                     | any         | 1 per side           | Already correct                                                                 |

Duplicate prevention is structural and unchanged: every row carries
`groupKey = call:<callId>` with `resurface: "false"`, so a redelivered event or a
racing second terminal transition updates the same card instead of stacking one.

## Issues Found

### Issue 1 — Call history suppressed by the call _push_ toggle (P0, the root cause)

- **Root cause**: `pushToUser` returns on `CATEGORY_OFF` before the inbox write,
  including for `skipPush` projections that have no push to suppress.
- **Affected file**: `apps/notifications-service/src/services/push.service.ts`
- **Affected flow**: `call.activity` → `pushToUser` → chat-service
  `CreateNotification` → Notification Center.
- **Severity**: High — deterministic, permanent, per-user loss of call history.
  Presents exactly as "some users get call notifications, others never do".
- **Fix**: `CATEGORY_OFF` now suppresses the row only when the send is a real
  push (`!skipPush`). An inbox-only projection persists; the push path is
  unchanged, because `skipPush` still returns before any device is touched.
  Verified by two tests: history persists with `callEnabled: false`, and a real
  `CALL_INCOMING` push is still fully suppressed by the same toggle.

### Issue 2 — One participant's failure erased the other's history (P1)

- **Root cause**: `handleCallActivity` wrote the two sides in a sequential
  `for … await` loop. The caller is written first; a throw there exited the
  handler before the callee's row was ever attempted.
- **Affected file**: `apps/notifications-service/src/consumers/call.consumer.ts`
- **Severity**: Medium-High — one flaky recipient silently costs the other
  participant their call history.
- **Fix**: the two sides are written independently via `Promise.allSettled`.
  Failures are logged per recipient with `{callId, recipient, peer, direction,
callType, callStatus, notificationType}` and then rethrown so the message is
  redelivered rather than silently lost.

### Issue 3 — A transient error dropped the event permanently (P1)

- **Root cause**: the consumer nacked with `requeue = false` on _any_ error, on
  the assumption that every failure is a deterministic parse error. A transient
  failure (chat-service restarting, gRPC deadline) therefore destroyed that
  call's history for both participants with no retry and no trace.
- **Affected file**: `apps/notifications-service/src/consumers/call.consumer.ts`
- **Severity**: Medium — matches the one observed call in the database that
  produced **zero** rows on either side (a MISSED call swept at
  2026-08-17T10:46Z, with working rows minutes before and after).
- **Fix**: retry once (`requeue = !message.fields.redelivered`), then drop. A
  genuinely poisonous message still cannot spin the queue, and replay is safe
  because every projection is keyed on `groupKey = call:<callId>`.

### Non-issues confirmed during the audit (no change made)

- Persistence never depended on socket connectivity or presence: the row is
  written by an AMQP consumer over gRPC, and the socket event is published
  afterwards by `createNotificationImpl` as an additional delivery.
- Caller/receiver handling is symmetric — direction is derived per recipient
  from the call record's own `callerId`, never hardcoded and never parsed from
  text.
- One row per call, not one per lifecycle state: only terminal statuses project,
  and `groupKey` collapses re-deliveries.
- Category routing is correct: `call.` prefix → FRIENDS in both
  `categorize()` and `categoryWhere()` (chat-service
  `lib/notification-category.ts`), and the web client mirrors it in
  `useNotificationsInbox.ts`.
- The REST list, cursor pagination, ordering, unread count and serializer are
  type-agnostic — nothing filters call rows out.
- `CALL_INCOMING` and `CALL_MISSED` remain push-only (`skipInbox`), so a call
  still yields exactly one Notification-Center card.

## Changes Made

| File                                                                        | Why                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/notifications-service/src/services/push.service.ts`                   | Root cause. `CATEGORY_OFF` no longer discards an inbox-only (`skipPush`) history row; push suppression unchanged.                                                                                                                     |
| `apps/notifications-service/src/consumers/call.consumer.ts`                 | Both participants' rows written independently (`Promise.allSettled`); per-recipient structured error log; rethrow so the event is redelivered; retry-once instead of drop-on-first-error; `handleCallActivity` exported for the test. |
| `apps/notifications-service/tests/services/push.service.test.ts`            | Two tests: history persists when the call category is off; a real call push is still suppressed by it.                                                                                                                                |
| `apps/notifications-service/tests/consumers/call-activity.consumer.test.ts` | New. One row per participant with per-side direction/`markRead`/`groupKey`; caller-side failure does not cost the callee their row, and the handler throws so the message is redelivered.                                             |

No backend contract changed. No producer changed. No new notification type,
table, or category.

## Notification Architecture

```
Call lifecycle (chat-service CallService)
  └─ terminal transition only  (ENDED | MISSED | DECLINED | CANCELLED | FAILED)
       └─ postCallChatMessageSafe            ← single choke point, 14 call sites
            ├─ Chat activity  → PrivateMessage row (upsert on call:<callId>)
            └─ projectCallActivitySafe
                 └─ AMQP  call.activity  →  call.push.queue (durable, no TTL)
                      └─ notifications-service handleCallActivity
                           ├─ side OUTGOING (caller)   ─┐
                           └─ side INCOMING (callee)   ─┤ independent
                                └─ pushToUser(skipPush) ┘
                                     └─ gRPC CreateNotification (chat-service)
                                          ├─ PERSIST Notification row  ← source of truth
                                          │    groupKey = call:<callId> (idempotent)
                                          └─ Redis → socket notification:new
                                                              + notification:count_update
                                                                   ↓
                    GET /api/v1/chat/notifications (cursor, category=FRIENDS)
                                                                   ↓
                                            web useNotificationsInbox → list
```

Persistence happens before and independently of delivery. Socket delivery,
push delivery, and the recipient's presence, tab state, or preferences cannot
change whether the row exists.

## Test Results

Automated (`pnpm test:all`, filtered):

- `chat-service/tests/calls/**` + all notification suites — **35 suites, 443
  tests, all passing.** Covers: audio and video, ENDED/MISSED/DECLINED/
  CANCELLED/FAILED projection, cancel grace window, one-row-per-call upsert,
  terminal-is-terminal guard, unread rules, no-answer sweep, group calls
  excluded from Friends.
- `notifications-service/tests/services/push.service.test.ts` — 24 tests
  including the two new gate cases (category-off keeps history; category-off
  still kills a real call push).
- `notifications-service/tests/consumers/call-activity.consumer.test.ts` — new;
  per-side rows, direction, `markRead`, shared `groupKey`, and independence of
  the two writes.
- `tsc --noEmit`: chat-service and notifications-service — clean.
- `eslint` on all changed files — clean.

Database verification (live dev data, `aimess_chat` / `aimess_users`), which is
how the root cause was located rather than guessed:

- 14 terminal 1:1 calls over 3 days → 23 `call.activity` rows instead of 28.
- All 5 missing rows belong to the single account with `callEnabled = false`
  (3 rows) or to the one call that produced zero rows on either side (2 rows —
  Issues 2/3).
- Every other call has exactly 2 rows, correct direction per side, correct
  read/unread split, and one shared `groupKey`.

Offline receiver, socket reconnect, refresh, multiple tabs, and pagination need
no behavioural change and were re-confirmed by inspection: none of those paths
participate in whether the row is written, and all of them read the same
persisted row through the same cursor-paginated query.

## Regression Results

- No producer, wire payload, DTO, or REST/socket contract changed — clients need
  no update.
- Call placement, ringing, accept, decline, cancel, end, missed sweep, call
  cards, call-back, `lastActivity` and the chat list are untouched: the fix is
  entirely inside notification delivery, downstream of every call state change.
- `CALL_INCOMING` / `CALL_CANCELLED` / `CALL_HANDLED` / `CALL_MISSED` pushes are
  unchanged, and the category toggle still suppresses them exactly as before
  (asserted by a new test, so it cannot regress silently).
- Friend, community, system, login and mention notifications are unaffected:
  none of them use `skipPush`, so the `CATEGORY_OFF` behaviour for every
  existing type is byte-for-byte what it was.

## Remaining Issues

1. **Historical rows are not backfilled.** The three call-history rows that were
   never written for the `callEnabled = false` account, and the two for the
   2026-08-17T10:45Z missed call, stay missing — the fix is forward-looking. A
   backfill would have to replay from `aimess_chat.calls`; not done because it
   was not requested and the canonical call rows are intact if it is ever wanted.
2. **Group/community calls still produce no Notification-Center history** (they
   post to the group timeline instead). Pre-existing and deliberate, not part of
   this bug.
3. **Retry is bounded at one attempt.** A failure that outlives the redelivery
   still drops the event; it is now loud (an `error` log naming the callId and
   recipient) rather than silent. A dead-letter queue would be the next step if
   this ever shows up in practice.
