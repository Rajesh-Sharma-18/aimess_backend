# AIMess Call Push Notification Audit

Date: 2026-08-18 · Scope: 1:1 and group call notifications across
`chat-service`, `notifications-service`, `packages/constants`, and the web
client's notification router.

This was an **audit-first** pass, as instructed. The call system was not
rewritten and no call state, event, queue, or model was replaced. Four
behavioural defects were found and fixed; everything else in this document
records what already exists and was verified, so the next person does not
re-litigate it.

---

## Reference Behavior

The UX model being followed (stated as a target, not as a claim about any
specific competitor's internals):

- One live ring alert per call, which resolves — is replaced or dismissed —
  the moment the call is answered, declined, cancelled or missed.
- A missed call produces exactly one after-the-fact alert and one history
  entry; an answered call produces neither.
- Cancel, decline, busy, and failure are distinct outcomes and must never be
  reported to the user as "missed".
- The lifecycle is noisy (calling → ringing → connected → ended); the
  notification surface is not. Intermediate states never notify.
- History survives the transport. A user who was offline, socket-disconnected,
  or whose push failed still finds the call in the Notification Center on next
  open.

---

## Current AIMess Flow

```
CallService (chat-service)          ← canonical call state, the source of truth
  │  claimStatusTransition (atomic CAS on Call.status)
  ├─ Redis pub  self:<userId> / call:<callId>  → Socket.IO gateway → live clients
  └─ AMQP  call.push.queue (durable)
        │
        ▼
notifications-service consumers/call.consumer.ts
  │  call.incoming   → pushToUser  CALL_INCOMING   (push only, skipInbox)
  │  call.missed     → pushToUser  CALL_MISSED     (push only, skipInbox)
  │  call.cancelled  → pushToUser  CALL_CANCELLED  (silent data push, dismiss ring)
  │  call.handled    → pushToUser  CALL_HANDLED    (silent data push, stop sibling ring)
  │  call.activity   → pushToUser  call.activity   (inbox row only, skipPush)
  │
  ├─ settings / quiet-hours gate  (notification-settings.service.ts)
  ├─ inbox row via gRPC CreateNotification → chat-service → notification:new socket
  └─ FCM (sendPush) / APNs PushKit (sendVoipPush) per device token
```

Two independent delivery paths carry every ring: Redis→Socket.IO for live
clients, and AMQP→FCM/APNs for everyone else. Neither depends on the other, so
a socket failure cannot lose a notification and a push failure cannot lose the
persisted inbox row.

---

## Problems Found

### P1 — Quiet hours exempted the entire call category, so missed-call pushes woke users at night

- **Root cause:** `evaluateDelivery` short-circuited on `category ===
"callEnabled"` and returned `ALLOW` before the quiet-hours check. The
  exemption was written for the live ring (correctly — a ring is worthless a
  minute later) but the category also carries `CALL_MISSED`, which is a report
  of something that already finished.
- **Service / file / function:** notifications-service ·
  `src/services/notification-settings.service.ts` · `evaluateDelivery`
- **Impact:** a user with quiet hours configured was woken by an alert for a
  call that had already ended. The information was not time-critical and was
  already waiting in their Notification Center.
- **Severity:** Medium (notification spam, preference not honoured)

### P2 — A caller-cancelled ring was always recorded as a missed call for the callee

- **Root cause:** `isUnreadCallActivity` returned `true` for `CANCELLED`
  unconditionally, and `buildCallActivityText` mapped `CANCELLED` + `INCOMING`
  to the _missed_ copy. The reasoning in the code was that a callee cannot tell
  a timeout from a hang-up — true for a long ring, false for a misdial the
  caller took back in two seconds.
- **Service / file / function:** packages/constants ·
  `src/chat/call-activity-text.ts` · `isUnreadCallActivity`,
  `buildCallActivityText`
- **Impact:** an accidental dial the caller cancelled immediately left the
  callee with an unread "Missed call" badge for a call that, from their seat,
  never meaningfully happened. Contradicts the requirement that a cancel must
  not become a missed call.
- **Severity:** Medium (false missed-call state)

### P3 — The missed-call push deep-linked to a route that resolves to nothing

- **Root cause:** `handleCallMissed` built `aimess://call/<callId>`. A call
  that is over has no screen; the matching Notification-Center row already
  deep-links to the conversation. On web, `notificationRouter.parseDeepLink`
  has no `call` branch, so the tap fell through to `inferRoute`, which depends
  on `senderId` being populated on the push — a second, unrelated condition.
- **Service / file / function:** notifications-service ·
  `src/consumers/call.consumer.ts` · `handleCallMissed`; aimess_website ·
  `src/utils/notificationRouter.ts` · `parseDeepLink`
- **Impact:** tapping a missed-call push could land nowhere instead of opening
  the chat with the caller.
- **Severity:** Medium (broken navigation on a primary notification)

### P4 — `parseDeepLink` did not recognise `aimess://conversation/:id` (web)

- **Root cause:** the branch matched `message`, `chat`, and `user` but not
  `conversation`, which is the scheme the call-history row (and now the
  missed-call push) actually ships.
- **Service / file / function:** aimess_website ·
  `src/utils/notificationRouter.ts` · `parseDeepLink`
- **Impact:** same as P3 — silently dependent on the `inferRoute` fallback.
- **Severity:** Low (masked by a fallback, but the fallback is not guaranteed)

### P5 — Call history erased by the `callEnabled` toggle (fixed in a parallel session)

Landed in the working tree alongside this audit, recorded here so the policy is
documented in one place: `pushToUser` returned on `CATEGORY_OFF` _before_ the
inbox write, so turning call notifications off also erased the call-history row.
Because the two ends of one call are two accounts with two toggles, history
appeared for one participant and not the other. The gate is now
`decision === "CATEGORY_OFF" && !skipPush` — the toggle silences alerts, it does
not erase the log, and the push side stays fully gated. This is the documented
distinction the brief asks for in §19:

- **Signalling and the incoming-call UI** are never preference-gated. They run
  over Redis/Socket.IO from `CallService` and never touch `pushToUser`.
- **The push** is preference-gated: `callEnabled = false` stops the ring push
  and the missed-call push entirely.
- **The history row** is written regardless, so the Notification Center and the
  DM call card always agree.

### P6 — `NO_ANSWER` was dropped by the gateway, so almost no missed call ever became MISSED

Found by driving the live stack, not by reading code — the source looked
correct at every layer.

- **Root cause:** `apps/api-gateway/src/grpc/clients/messaging.client.ts` ·
  `endCallBreaker` assembled the `EndCall` gRPC request from `callId`,
  `userId` and `legId` only. `reason` was declared on `EndCallParams`,
  accepted by the socket schema, present in `messaging.proto`, and read by
  chat-service's handler — but never written into the wire message. The
  request object is untyped at the `call()` boundary, so the omission
  compiled cleanly.
- **Impact:** the highest-severity finding in this audit. `noAnswer` in
  `CallService.endCall` was permanently false, so a ring the caller let run
  out settled as **CANCELLED, never MISSED**. That is the path essentially
  every missed call takes: the client's ring timeout fires at the same 60s as
  the server sweep and always wins the race. `fanOutUnansweredRing` therefore
  never ran from it — **no `call.missed` event and no missed-call push** — and
  the caller read "Cancelled" where they should have read "No answer".
- **Verified live, both directions:** before the fix `call:end` with
  `reason: "NO_ANSWER"` returned `status: ENDED` and wrote CANCELLED; after,
  it returns `status: MISSED`, the caller's row reads "Outgoing voice/video
  call" and the callee's arrives **unread** as "Missed voice call".
- **Severity:** High

### P7 — Duplicate re-export in the constants barrel (housekeeping)

`packages/constants/src/index.ts` exported `./chat/call-activity-text.js`
twice. Harmless, removed while in the file. **Severity:** Trivial

### Findings recorded but deliberately NOT changed

- **`CallStatus.FAILED` has no producer.** The enum, the timeline status and
  the i18n copy all exist; nothing ever writes it. This is not currently a
  defect: a pre-answer signalling failure settles as `CANCELLED` or `MISSED`,
  and a mid-call media failure is reconciled to `ENDED` by the LiveKit
  `room_finished` / `participant_left` webhook. No path misclassifies a failure
  as MISSED, which is the actual requirement. Adding a producer would mean a
  new client-reported failure API; out of scope until a real failure mode is
  observed that neither existing terminal state describes.
- **BUSY produces no call row.** `initiateCall` throws
  `ConflictError("CALL_USER_BUSY")` before any row exists, so the callee gets
  no notification and neither side gets history. This satisfies "no false
  missed call" but means an attempted call to a busy user is invisible to them.
  Changing it means persisting a call row for a call that never rang — a
  product decision, not a bug fix, so it is flagged rather than taken.
- **The incoming-call push carries the callee's LiveKit JWT** (`data.token`,
  `data.livekitUrl`), so a push-woken client can join without a socket. This is
  a deliberate trade-off against the "minimum information in the payload"
  principle. It is removable — `answerCall` mints the callee a fresh token on
  the answer path, so the pushed one is redundant server-side — but removing it
  is a client-contract change that would break any mobile build reading
  `data.token`. Recommended as a coordinated change with the iOS/Android
  clients, not a unilateral backend edit.

---

## Changes Made

| File                                                                           | Change                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/constants/src/chat/call-activity-text.ts`                            | Added `CALL_CANCEL_GRACE_SEC` and `cancelCountsAsMissed`; `buildCallActivityText` and `isUnreadCallActivity` take an optional `ringDurationSec` and only treat a cancelled ring as missed once it outlived the grace window. An absent value keeps the previous behaviour. |
| `packages/constants/src/index.ts`                                              | Removed the duplicated `call-activity-text` re-export.                                                                                                                                                                                                                     |
| `apps/chat-service/src/events/publish-call-incoming.ts`                        | `CallActivityPayload` carries `ringDurationSec`.                                                                                                                                                                                                                           |
| `apps/chat-service/src/services/call.service.ts`                               | `projectCallActivitySafe` derives `ringDurationSec` from the call record (`endedAt - initiatedAt`) — server-side, never client-supplied.                                                                                                                                   |
| `apps/notifications-service/src/services/notification-settings.service.ts`     | `evaluateDelivery` takes an optional `type`; new `QUIET_HOURS_EXEMPT_TYPES = {CALL_INCOMING}` replaces the category-wide call exemption. Typeless callers keep the old behaviour.                                                                                          |
| `apps/notifications-service/src/services/push.service.ts`                      | Passes `type` into `evaluateDelivery`.                                                                                                                                                                                                                                     |
| `apps/notifications-service/src/lib/notification-copy.ts`                      | `callCopy.activity` accepts and forwards `ringDurationSec`.                                                                                                                                                                                                                |
| `apps/notifications-service/src/consumers/call.consumer.ts`                    | Reads `ringDurationSec` from the event and forwards it to both the copy builder and the unread decision; the missed-call push now deep-links to the conversation.                                                                                                          |
| `aimess_website/src/utils/notificationRouter.ts`                               | `parseDeepLink` recognises `aimess://conversation/:id`.                                                                                                                                                                                                                    |
| `apps/api-gateway/src/grpc/clients/messaging.client.ts`                        | `EndCall` gRPC request now carries `reason`, so NO_ANSWER reaches chat-service and a timed-out ring settles as MISSED.                                                                                                                                                     |
| `apps/chat-service/tests/calls/call-activity-notification.test.ts`             | Grace-window cases for text and unread.                                                                                                                                                                                                                                    |
| `apps/notifications-service/tests/services/notification-settings.gate.test.ts` | Quiet hours silence `CALL_MISSED`, never `CALL_INCOMING`.                                                                                                                                                                                                                  |

---

## Call State Matrix

Canonical states: `Call.status` ∈ RINGING · IN_PROGRESS · ENDED · MISSED ·
DECLINED · FAILED. The timeline/history status (`CallTimelineStatus`) adds the
presentation states RINGING / ANSWERED / CANCELLED over the same record. No
second state machine exists.

| Outcome               | Written by                                       | Ring push     | Dismiss push                    | Missed push | Inbox row (callee)  | Inbox row (caller)       |
| --------------------- | ------------------------------------------------ | ------------- | ------------------------------- | ----------- | ------------------- | ------------------------ |
| Calling / Ringing     | `initiateCall`                                   | CALL_INCOMING | —                               | —           | none (live event)   | none                     |
| Accepted              | `answerCall`                                     | —             | CALL_HANDLED (silent, siblings) | —           | —                   | —                        |
| Connected             | `answerCall`                                     | —             | —                               | —           | —                   | —                        |
| Ended after connect   | `endCall`                                        | —             | —                               | —           | read history row    | read history row         |
| Declined              | `declineCall`                                    | —             | CALL_CANCELLED (silent)         | —           | read history row    | read history row         |
| Cancelled ≥ grace     | `endCall` (pre-answer)                           | —             | CALL_CANCELLED                  | —           | **unread** "Missed" | read "Cancelled"         |
| Cancelled < grace     | `endCall` (pre-answer)                           | —             | CALL_CANCELLED                  | —           | read "Cancelled"    | read "Cancelled"         |
| Missed (ring timeout) | `sweepMissedCalls` or `endCall reason=NO_ANSWER` | —             | CALL_CANCELLED (stop ring)      | CALL_MISSED | **unread** "Missed" | read "Outgoing"          |
| Busy                  | `initiateCall` (rejected)                        | —             | —                               | —           | none                | none (caller sees error) |
| Failed                | LiveKit reconcile → ENDED                        | —             | —                               | —           | read history row    | read history row         |

Both paths to MISSED (the sweep and the caller's own NO_ANSWER hangup) funnel
through one method, `fanOutUnansweredRing`, so they cannot drift.

---

## Push Matrix

| Receiver state                          | Delivery                                                       | Notes                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground, socket live                 | Redis → Socket.IO `call:incoming` **and** FCM                  | The client owns foreground suppression; the ring push is `dataOnly`, so Android draws no second tray entry beside the app's own full-screen ring UI.     |
| Background / minimized / inactive tab   | FCM data push, `priority: high`, TTL = ring window             | `requireInteraction` on web.                                                                                                                             |
| App closed (Android)                    | FCM data-only → `onMessageReceived`                            | Data-only is required: a notification-carrying message does not reliably reach a killed app.                                                             |
| App closed (iOS, VoIP token registered) | APNs PushKit → CallKit                                         | `allowVoip: true` on the ring and on the dismiss only, never on a missed call — Apple requires every VoIP push to raise CallKit.                         |
| App closed (iOS, no VoIP token)         | FCM with a notification block                                  | `effectiveDataOnly` in `push.service.ts` flips `dataOnly` off for this one case so a killed iOS app still shows a banner.                                |
| Offline at call time                    | Nothing delivered live                                         | The `call.activity` inbox row is persisted regardless of push outcome; the missed-call push carries the default 24h TTL.                                 |
| Reconnect / next login                  | `GET /api/v1/chat/notifications` + `notification:count_update` | No dependence on having held a socket during the call.                                                                                                   |
| Multiple devices                        | One inbox row, N device sends                                  | Persistence is keyed `callId + recipientId`; fan-out is per token. Tokens are de-duplicated by value and by `(user, device, tokenType)` at registration. |

The ring push expires with the ring window (`expiration` on the AMQP message
_and_ FCM `ttl` = `CALL_RINGING_TIMEOUT_SEC`), so a broker backlog cannot
deliver a ring after the call is over.

---

## Duplicate Prevention

Four independent layers, none of which relies on the others:

1. **State transitions are atomic.** Every terminal transition goes through
   `claimStatusTransition` / `claimForMissed` — an `updateMany` filtered on the
   expected status. Only the winner publishes. A sweep racing a user hangup, or
   two gateway nodes racing, produces one set of events.
2. **The projection has one choke point.** `call.activity` is published only
   from `postCallChatMessageSafe`, and only when
   `isTerminalCallStatus(outcome)`. There is no per-call-site publish to forget
   or duplicate, and no live state can leak a card.
3. **The inbox row is group-keyed.** Every row carries
   `groupKey = call:<callId>`. `CreateNotification` looks the group up
   (`findActiveByGroupKey`) and _transitions the existing row_ instead of
   inserting a second one, so an AMQP redelivery, a worker retry, a service
   restart or a second terminal transition all rewrite one card.
   `resurface: "false"` stops a late duplicate flipping a read card back to
   unread.
4. **Device-side collapse.** The ring, the dismiss and the answered-elsewhere
   push all share `collapseKey = call:<callId>`, so a re-published ring
   _replaces_ rather than stacks, and a dismiss replaces the ring it is
   cancelling. The missed-call push uses a distinct key
   (`call:missed:<callId>`) because the ring is long gone by then.

Idempotency key throughout: **`callId` + `recipientId` + purpose**
(`CALL_INCOMING` / `CALL_MISSED` / `call.activity`). Lifecycle _volume_ is
handled by design rather than by de-duplication: the intermediate states
(calling, ringing repeats, connected) have no notification producer at all, so
the five-events-five-pushes failure mode cannot arise in the first place.

---

## Test Results

**Automated** — `apps/chat-service/tests/calls/**` plus
`apps/notifications-service/tests/services/notification-settings.gate.test.ts`:
**172 passed, 0 failed**. `tsc --noEmit` clean on chat-service,
notifications-service, and aimess_website.

Coverage in those suites, by scenario, for both call types and both directions.
A→B and B→A are symmetric by construction: direction is derived per recipient
from `callerId` inside one shared projection, not written twice.

| #      | Scenario                           | Covered by                                                  |
| ------ | ---------------------------------- | ----------------------------------------------------------- |
| 1 / 8  | Audio / video accepted             | `call-service-lifecycle`, `calls.test`                      |
| 2 / 9  | Declined                           | `call-service-lifecycle`, `call-activity-notification`      |
| 3 / 10 | Cancelled (incl. new grace window) | `call-activity-notification`                                |
| 4 / 11 | Missed via sweep and via NO_ANSWER | `call-no-answer`, `call-ringing-card`                       |
| 5 / 12 | Busy                               | `call-initiate-busy-ack` (api-gateway), `call-service-gate` |
| 6 / 13 | Failed / teardown                  | `call-teardown-on-unfriend`, `call-service-lifecycle`       |
| 7 / 14 | Connected then ended               | `call-chat-message.service`, `call-content-type`            |

### Live run against the running stack (2026-08-18)

Driven over Socket.IO as two real users — A = Smiley Creatures
(`7b0db132…fba2ef`), B = Krish (`d16e6e16…0a56fa`) — against the dev
gateway, chat-service, RabbitMQ, notifications-service and Mongo. Every row
below was read back out of `aimess_chat.calls` and
`aimess_chat.notifications`, not inferred.

| Scenario                               | Call row           | Caller sees                     | Callee sees                    |
| -------------------------------------- | ------------------ | ------------------------------- | ------------------------------ |
| A→B audio, cancel at 2s (inside grace) | ENDED / CANCELLED  | read "Cancelled voice call"     | **not badged**                 |
| A→B audio, cancel at 7s (past grace)   | ENDED / CANCELLED  | read "Cancelled voice call"     | **unread** "Missed voice call" |
| A→B video, NO_ANSWER                   | **MISSED**         | read "Outgoing video call"      | unread "Missed video call"     |
| A→B audio, answered then ended         | ENDED, duration 1s | read "Voice call • 00:01"       | read "Voice call • 00:01"      |
| A→B audio, declined                    | DECLINED           | read "Declined voice call"      | read "Declined voice call"     |
| A→B, callee already in a call          | no row created     | ack `CONFLICT` (CALL_USER_BUSY) | nothing                        |
| B→A video, declined                    | DECLINED           | read "Declined video call"      | read "Declined video call"     |
| B→A audio, NO_ANSWER                   | **MISSED**         | read "Outgoing voice call"      | **unread** "Missed voice call" |
| B→A audio, answered then ended         | ENDED, duration 3s | read "Voice call • 00:03"       | read "Voice call • 00:03"      |

Confirmed by this run: the grace window behaves as designed at both ends of
the threshold; NO_ANSWER settles as MISSED after P6 (it settled as CANCELLED
before); audio and video are distinguished in every line; answered and
declined calls never produce a missed-call state; busy creates no row and no
false missed call; direction is resolved per reader, so A→B and B→A are
symmetric; and exactly one row per participant per call exists, keyed
`groupKey: call:<callId>`, with no duplicates across the whole run.

### One live gap not closed

User B has `callEnabled = false` in `notification_settings`. On the running
build their call-history row was written only intermittently (2 of 7 calls),
while User A — who has the toggle on — got a row every time. This is P5: the
category gate dropping the inbox-only projection. The fix is committed; the
running notifications-service predates it, and the intermittent successes are
the settings cache failing open (`getNotificationSettings` allows on gRPC
error and does not cache the fallback). Re-verify after a service restart.

Two environment notes from the same run, neither caused by these changes:
chat-service's gRPC listener (4004) died mid-run and had to be restarted, and
`initiateCall` intermittently returns `SERVICE_ERROR` to the client when the
gateway's opossum breaker opens — worth a look at the breaker timeout against
how long `initiateCall` actually takes (two user-service gRPC gates, the
caller lock, several Mongo reads and two LiveKit token mints).

**Not executed:** the live two-device matrix in §27/§28 of the brief (real
User A ↔ User B handsets across foreground / background / closed / offline).
That needs two provisioned handsets with valid FCM and APNs PushKit tokens; it
cannot be run from this environment. What WAS driven live is the server side of
that matrix (see above): the state machine, the events, and the persisted rows
for both participants. What remains unproven is only device-side delivery —
whether the FCM/APNs payload actually wakes a backgrounded or killed app. The
instrumentation for that is in place; the `[push:publish]` → `[push:consume]` →
`[push:deliver]` hop markers make each leg individually checkable on a real
device.

---

## Regression Results

Verified unchanged by inspection and by the passing suites: call buttons and
signalling (`initiateCall` / `answerCall` / `declineCall` / `endCall` untouched
except for one derived field on the outbound projection), the friendship and
privacy gate (`assertCanStartCall`, including the last-moment re-check inside
the caller lock), the block and deleted-account gates, group call ring fan-out,
call history and call cards, chat `lastActivity`, the notification unread count,
push-token registration and pruning, and message / friend / community / system
notifications (the `evaluateDelivery` change is additive, and typeless callers
keep the previous behaviour).

Friend-only call enforcement is server-side and was confirmed intact: the gate
runs in `assertCanStartCall` before any row, token, ring or push exists, and is
re-checked inside the caller lock immediately before the row is created and
again in `answerCall` while the call is still RINGING.

The only user-visible behaviour changes are the four fixed defects: a
missed-call push no longer fires during quiet hours, a cancel inside 5 seconds
no longer badges the callee, and a missed-call tap opens the conversation on
both the push and the web router.

---

## Observability

The pipeline is instrumented as numbered hops, which is what makes "why did A
get the push and B not?" answerable without a repro:

```
[push:publish]  chat-service → RabbitMQ    callId, callee, caller, type
[push:consume]  RabbitMQ → notifications   callId, callee, caller, type
[push:deliver]  token fan-out              userId, type, token count
                tokens=0 → the user has NO registered device; the backend is fine
```

Plus `CallService|sweep|…`, `CallService|missed|…`, and
`CallService|endCall|ignored from non-answering leg` on the state-machine side.
No token, credential, or message content is logged on any of these paths.

---

## Remaining Issues

1. **`CallStatus.FAILED` is presentation-only** — copy and enum exist, no
   producer. Not currently causing a misclassification (see above). Needs a
   client-reported failure reason to become real.
2. **A busy call leaves no record for the callee.** They never learn someone
   tried. Product decision, not a defect.
3. **LiveKit credentials travel in the ring push payload.** Removable
   server-side; needs a coordinated client change first.
4. **Device-side push delivery has not been executed** (§27/§28) — no
   provisioned handsets in this environment. The server side of the matrix was
   driven live and is recorded under Test Results.
5. **P5 not yet confirmed on the running build.** A callee with
   `callEnabled = false` still loses their call-history row on the deployed
   process; the fix is committed but the running notifications-service predates
   it. Restart and re-run the matrix to close this.
6. **`initiateCall` intermittently returns `SERVICE_ERROR`** when the gateway
   breaker opens. Seen repeatedly during the live run. Pre-existing, unrelated
   to these changes, but it is a user-visible "call failed" and deserves its own
   look at the breaker timeout.
7. **Pre-existing, unrelated:** notification tray images are presigned URLs
   with a 1h expiry against a 24h FCM TTL, so a push held for a long-offline
   device lands without its image. Documented at the `imageUrl` line in
   `push.service.ts`; unchanged here.
