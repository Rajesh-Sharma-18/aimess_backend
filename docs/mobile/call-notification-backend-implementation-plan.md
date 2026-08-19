# Call Notification List — Backend Implementation Plan

**Input:** `docs/mobile/call-notification-list-implementation-guide.md` (audit, 2026-08-19)
**Scope:** backend only (`chat-service`, `notifications-service`, `api-gateway` docs)
**Rule followed:** every audit finding below was re-verified against the current source and, where possible, against the running stack before being accepted. Findings that turned out to be already correct are recorded as such and left alone.

---

## 1. Current architecture (unchanged by this work)

```
Call row (aimess_chat.calls)            ← SOURCE OF TRUTH
  │
  ├─ CallService lifecycle (initiate / answer / decline / end / sweep / LiveKit webhook / teardown)
  │     └─ postCallChatMessageSafe()    ← THE choke point, 14 call sites
  │           ├─ CallChatMessageService → DM call card (PrivateMessage upsert)
  │           └─ projectCallActivitySafe() → AMQP "call.activity"
  │
  └─ publishCallMissedSafe() → AMQP "call.missed"  ← the user-visible tray push
                                    │
        call.push.queue (durable) ───┘
                 ↓
        notifications-service call.consumer.ts
          ├─ handleCallActivity  → pushToUser({skipPush:true})  → the LIST row
          └─ handleCallMissed    → pushToUser({skipInbox:true}) → the PUSH
                 ↓ gRPC CreateNotification
        chat-service createNotificationImpl → Mongo + Redis notify:<userId>
                 ↓
        api-gateway /notify → mobile
```

Three projections of one call: the `Call` row, the DM card, the Notification row. This plan does not add a fourth, does not add a table, and does not bypass `call.activity`.

---

## 2. Gap → code mapping (verified)

| Gap                                                                         | Verdict after re-verification                                                                                                                                                                                                                                                                                                                                      | Code                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **GAP-06** cancelled ring past grace gets an unread row but no visible push | **CONFIRMED.** `cancelCountsAsMissed` is referenced in exactly one place — `isUnreadCallActivity` in `packages/constants/src/chat/call-activity-text.ts`. `chat-service` never consults it. `publishCallMissedSafe` is reachable only from `fanOutUnansweredRing`, which runs only from `sweepMissedCalls` and `endCall`'s `noAnswer` branch.                      | `apps/chat-service/src/services/call.service.ts`                                                   |
| **GAP-07** generic `call:end` downgrades a missed call                      | **CONFIRMED.** `noAnswer` requires `params.reason === "NO_ANSWER"`, so a client that omits it settles a 60-second unanswered ring as `ENDED`/`CANCELLED`.                                                                                                                                                                                                          | `call.service.ts` `endCall`                                                                        |
| **GAP-01** `FAILED` has no producer                                         | **CONFIRMED.** No `CallStatus.FAILED` writer exists. Also confirmed the internal contradiction the audit names: `buildCallActivityText` renders `FAILED` with the missed-call copy while `isUnreadCallActivity` does not badge it.                                                                                                                                 | `packages/constants/src/chat/call-activity-text.ts`                                                |
| **GAP-02** legacy `CALL_MISSED` rows                                        | **NOT APPLICABLE.** The only `CALL_MISSED` producer left is a **push** (`skipInbox: true`); no active code writes a legacy inbox row. A live scan of 160 `CALLS` rows found **0** legacy rows.                                                                                                                                                                     | `call.consumer.ts`                                                                                 |
| **GAP-03** no `navigation` on call rows                                     | **CONFIRMED** against the live API: `navigation` and `referenceId` are both absent on a `call.activity` row. `serializeNotification` already parses `data.navigation`, so this is a producer-side omission.                                                                                                                                                        | `apps/notifications-service/src/consumers/call.consumer.ts`                                        |
| **GAP-04** socket list DTO differs from REST                                | **CONFIRMED.** gRPC `getNotifications` hand-rolls a row: `notificationId` (not `id`), no `category`, no `actor`, no fresh avatar resolution, `data` flat instead of `payload.data`, no `isDeleted`, no type filter, no `counts`.                                                                                                                                   | `apps/chat-service/src/grpc/service-impl.ts`                                                       |
| **GAP-05** stale AsyncAPI / OpenAPI                                         | **CONFIRMED.** `call:ice` is still documented in `asyncapi.yaml` although the implementation removed it; `call:outgoing_mirror`, `call:handled`, `call:rejoin`, `call:member_declined`, `notification:updated` are missing. OpenAPI has no call routes and no `/notifications/sync`.                                                                               | `apps/api-gateway/asyncapi/asyncapi.yaml`, `apps/api-gateway/src/docs/openapi/paths/chat.paths.ts` |
| **GAP-10** retry bounded at one attempt, no DLQ                             | **CONFIRMED**, with a constraint the audit did not state: **no consumer anywhere in notifications-service has a dead-letter exchange**, and the publisher comment records that queue args are immutable once declared. Adding `x-dead-letter-exchange` to `call.push.queue` would make the redeclare fail (`PRECONDITION_FAILED`) and kill the consumer on deploy. | `call.consumer.ts`, `apps/chat-service/src/events/publish-call-incoming.ts`                        |
| Cursor contract                                                             | **ALREADY CORRECT.** 8 pages × 20 rows round-tripped live: 160 rows, 160 unique, 0 duplicates. An epoch-ms cursor is rejected with a clean `400 INVALID_REQUEST`, not a silent page-1 repeat. Regression test only.                                                                                                                                                | —                                                                                                  |
| FCM data-map strings                                                        | **ALREADY CORRECT.** Every value in every call `data` map is wrapped in `String(...)`. Regression test only.                                                                                                                                                                                                                                                       | —                                                                                                  |
| Idempotency / dedupe                                                        | **ALREADY CORRECT.** `groupKey = call:<callId>` + `resurface: "false"`; every `postCallChatMessageSafe` call site sits behind a won `claimStatusTransition` / `claimForMissed`. Regression test only.                                                                                                                                                              | —                                                                                                  |
| **Extra finding**                                                           | `payload.data.markRead` — an internal server directive — leaks onto the public REST DTO. The socket relay strips it; REST does not.                                                                                                                                                                                                                                | `apps/chat-service/src/lib/notification-serializer.ts`                                             |
| GAP-08 ongoing row                                                          | **OUT OF SCOPE** — product decision, explicitly excluded by the brief.                                                                                                                                                                                                                                                                                             | —                                                                                                  |
| GAP-09 frozen locale                                                        | **DOCUMENT ONLY** — structured `data` is sufficient for the client to re-render; a server fix means storing copy keys, a wider refactor with no product driver.                                                                                                                                                                                                    | —                                                                                                  |
| GAP-11 backfill                                                             | **OUT OF SCOPE** — no product requirement.                                                                                                                                                                                                                                                                                                                         | —                                                                                                  |
| GAP-12 group calls                                                          | **OUT OF SCOPE, BY DESIGN** — `postCallChatMessageSafe` and `projectCallActivitySafe` both early-return on `groupId`.                                                                                                                                                                                                                                              | —                                                                                                  |

---

## 3. The P0 change (GAP-06 + GAP-07 are one fix)

Both gaps are the same missing question: **was this ring long enough that the callee genuinely missed it?**

The predicate already exists and is already the product rule — `cancelCountsAsMissed(ringDurationSec)`, in `packages/constants`, is what the inbox projection uses to decide whether the callee's row arrives badged. The bug is that only the _badge_ half consults it; the _lifecycle_ half does not. That is why the two disagree: the row says "you missed a call" and the push path says "nothing happened".

**Change:** in `CallService.endCall`, widen the `noAnswer` decision to accept either signal:

```
noAnswer = wasRinging
        && !call.answeredAt
        && call.callerId === userId
        && (reason === "NO_ANSWER" || cancelCountsAsMissed(ringDurationSec))
```

`ringDurationSec` is derived server-side from `endedAt - initiatedAt`. Nothing about the decision comes from the client.

That single predicate closes both gaps:

- **GAP-07** — a generic `call:end` after a ring past the grace window now resolves `MISSED`, not `ENDED`/`CANCELLED`.
- **GAP-06** — because it takes the `noAnswer` branch, `fanOutUnansweredRing` runs, which is the existing path to `publishCallMissedSafe`. No second push implementation.

The same predicate is applied to the two other pre-answer teardown paths the audit names, through one shared private helper so the decision lives in exactly one place:

- `reconcileFromLiveKitRoomFinished` (RINGING branch)
- `endCallsBetween` (unfriend/block on a ringing call)

### Invariants, and why each holds

| Invariant                                        | Why it holds                                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CONNECTED → never MISSED`                       | Every branch is gated on `wasRinging` (`status === RINGING`). An answered call is `IN_PROGRESS` and cannot reach it.                                                                                               |
| answered call → never a missed notification      | Same gate; additionally `!call.answeredAt`.                                                                                                                                                                        |
| `MISSED → never CANCELLED / ENDED`               | `endCall` short-circuits on any non-active status before computing anything, so a row already `MISSED` returns untouched. `claimStatusTransition` is scoped to the status that was read, so a racing writer loses. |
| short cancel → NOT missed                        | `cancelCountsAsMissed` is false below `CALL_CANCEL_GRACE_SEC` (5 s), so the cancel path is unchanged.                                                                                                              |
| callee's `call:end` on a ring is not "no answer" | The `call.callerId === userId` clause is preserved.                                                                                                                                                                |

### Database impact

None. No schema change, no migration, no new enum value. The DB `CallStatus` already has `MISSED`; this change only makes more of the pre-answer paths resolve to it instead of `ENDED`. `CANCELLED` remains a timeline-only vocabulary word, exactly as today.

### Event impact

A cancelled-past-grace ring now emits `call:missed` instead of `call:cancelled` on `/chat`, and gains a `call.missed` AMQP publish. Both events already exist and both are already handled by every client. The DM card for that call becomes `MISSED` instead of `CANCELLED` — which is what the callee's own notification row has been saying all along.

### API impact

None. No route, request or response shape changes.

### Notification impact

The row's `data.callStatus` becomes `MISSED` where it was `CANCELLED`. The user-facing copy is **identical** either way — `buildCallActivityText` already collapses `MISSED | CANCELLED | DECLINED | FAILED` onto one viewer-relative pair. The badge is also identical: `isUnreadCallActivity` returns true for `MISSED`, and returned true for `CANCELLED` past the grace window. So the visible change is exactly the one intended — **the missing tray push now fires** — and nothing else moves.

---

## 4. P1 changes

| #    | Change                                                                                                                                                                       | File                                                   | Rationale                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| P1-a | Add `navigation` to the `call.activity` data map                                                                                                                             | `notifications-service/src/consumers/call.consumer.ts` | GAP-03. One line; the serializer already parses it. Purely additive.                                               |
| P1-b | Strip `markRead` from the serialized DTO                                                                                                                                     | `chat-service/src/lib/notification-serializer.ts`      | Extra finding — an internal directive on a public contract. The socket relay already strips it; REST should match. |
| P1-c | Route the gRPC list through `serializeNotification`, emit **both** `id` and `notificationId`, add `category` / `isDeleted` / `payload` / `actor`, and accept a `type` filter | `chat-service/src/grpc/service-impl.ts`                | GAP-04. Additive; the rename hazard is avoided by emitting both keys.                                              |
| P1-d | Regression tests for cursor round-trip, FCM string serialization, duplicate AMQP delivery                                                                                    | tests                                                  | Already-correct behaviour that has no coverage.                                                                    |

---

## 5. P2 changes

| #    | Change                                                                                                                                 | File                                                         | Rationale                                                                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-a | Badge `FAILED` for `INCOMING` in `isUnreadCallActivity`                                                                                | `packages/constants/src/chat/call-activity-text.ts`          | GAP-01. **No producer is invented.** This only removes the contradiction between the two mappers, so the day something does write `FAILED` it behaves like every other unanswered outcome. Zero behavioural effect today.                          |
| P2-b | Bounded retry + explicit dead-letter queue for `call.push.queue`                                                                       | `notifications-service/src/consumers/call.consumer.ts`       | GAP-10. Implemented as an **explicit publish to `call.push.dlq`** rather than an `x-dead-letter-exchange` queue argument, because the existing queue's args are immutable and a changed redeclare would fail on deploy and take the consumer down. |
| P2-c | AsyncAPI: remove `call:ice`, add `call:outgoing_mirror`, `call:handled`, `call:rejoin`, `call:member_declined`, `notification:updated` | `apps/api-gateway/asyncapi/asyncapi.yaml`                    | GAP-05.                                                                                                                                                                                                                                            |
| P2-d | OpenAPI: add `GET /chat/notifications/sync` and the three `POST /chat/calls/{callId}/{answer,decline,end}` routes                      | `apps/api-gateway/src/docs/openapi/paths/chat.paths.ts`      | GAP-05.                                                                                                                                                                                                                                            |
| P2-e | Record the GAP-09 locale decision in the audit doc                                                                                     | `docs/mobile/call-notification-list-implementation-guide.md` | Documentation of a deliberate design, not a code change.                                                                                                                                                                                           |

---

## 6. Test plan

| Test                                              | Asserts                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| generic `call:end` after a long ring              | `MISSED`, not `ENDED`; missed push published; card `MISSED`            |
| generic `call:end` inside the grace window        | `ENDED`; card `CANCELLED`; **no** missed push                          |
| `call:end {reason:"NO_ANSWER"}`                   | `MISSED` (unchanged behaviour)                                         |
| answered → ended                                  | `ENDED` with a duration; **no** missed push; never `MISSED`            |
| answered → generic `call:end` after a long ring   | still `ENDED` — the ring-duration rule must not reach a connected call |
| callee sends `call:end` on a long ring            | `ENDED`/cancel path — only the caller's hangup can read as no-answer   |
| already-`MISSED` row + late `call:end`            | unchanged; no second fan-out                                           |
| LiveKit `room_finished` while ringing, past grace | `MISSED` + missed push                                                 |
| unfriend during a long ring                       | `MISSED` + missed push                                                 |
| duplicate `call.activity` delivery                | one notification row, `version` incremented                            |
| notification cursor round-trip                    | page 2 differs from page 1; no duplicate ids                           |
| FCM data map                                      | every value is a string                                                |
| `navigation` present on a call row                | parsed to a top-level `navigation` object                              |

---

## 7. Rollback

Every change is additive or a single predicate widening, in separate commits:

- P0 — revert one commit; `noAnswer` narrows back to `reason === "NO_ANSWER"`. No data migration is needed because no schema or enum changed, and rows already written as `MISSED` remain valid `MISSED` rows.
- P1-a / P1-b / P2-a — one-line reverts.
- P1-c — additive fields; reverting drops fields a client can already tolerate missing.
- P2-b — the DLQ is a separate queue; reverting leaves it declared and empty, which is harmless.
- P2-c / P2-d — documentation.

## 8. Risks

| Risk                                                                 | Mitigation                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A cancelled-past-grace ring now sends a tray push that did not exist | That is the fix. `collapseKey = call:missed:<callId>` keeps it distinct from the dismiss push, and the row it accompanies was already unread.                            |
| More calls resolve `MISSED` in the DB                                | `MISSED` is an existing enum value with existing readers; `GET /chat/calls` consumers see a more accurate status. The user-facing copy is unchanged (the collapse rule). |
| gRPC DTO change breaks the socket list                               | Both `id` and `notificationId` are emitted; no field is removed.                                                                                                         |
| DLQ redeclare failure                                                | Avoided by design — no argument change to the existing queue.                                                                                                            |

## 9. Out of scope

GAP-08 (live/ongoing notification row), GAP-11 (historical backfill), GAP-12 (group-call notification history — excluded by design at two independent early-returns). No change to group calls, friendship/community notifications, or any non-call notification category.

---

## 10. Outcome

| Gap                                                    | Status                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GAP-06** cancelled ring, no visible push             | **FIXED**                           | A ring past the grace window now resolves `MISSED` and rides the existing `fanOutUnansweredRing`, which publishes `call.missed`. No second push implementation. Applies to `endCall`, the LiveKit `room_finished` RINGING branch and the unfriend/block teardown.                                                                                                                                                                                                                                                                         |
| **GAP-07** generic `call:end` downgrades a missed call | **FIXED (server-side)**             | `ringResolvesAsMissed` accepts either `reason: "NO_ANSWER"` **or** a ring past the grace window, so a client that omits `reason` no longer suppresses the missed-call path. Sending `reason` remains the better contract (it is exact rather than threshold-based) but is no longer load-bearing.                                                                                                                                                                                                                                         |
| **GAP-01** `FAILED` has no producer                    | **RESOLVED — no producer invented** | No code path writes `FAILED` and none was added; inventing one to satisfy an enum would be fabricating a lifecycle. The contradiction the audit named _was_ fixed: `isUnreadCallActivity` now badges `FAILED` for `INCOMING`, matching `buildCallActivityText`, which already renders it with the missed-call line. Zero behavioural change today.                                                                                                                                                                                        |
| **GAP-02** legacy `CALL_MISSED` rows                   | **NOT APPLICABLE**                  | Re-verified: the only remaining `CALL_MISSED` producer is a push (`skipInbox: true`); no active code writes a legacy inbox row. A live scan of 160 `CALLS` rows found none. Nothing to remove, nothing to migrate.                                                                                                                                                                                                                                                                                                                        |
| **GAP-03** no `navigation` on call rows                | **FIXED**                           | The `call.activity` data map now carries `navigation`, which `serializeNotification` already projects to a top-level field. Same destination the missed-call push deep-links to.                                                                                                                                                                                                                                                                                                                                                          |
| **GAP-04** socket vs REST DTO drift                    | **FIXED**                           | The gRPC list is now built by `serializeNotification` — the same function REST uses — so it gains `category`, `payload`, `actor` (with read-time avatar refresh) and `isDeleted`. `notificationId`, `userId` and the flat `data` map are still emitted so no existing reader breaks.                                                                                                                                                                                                                                                      |
| **GAP-05** stale contract docs                         | **FIXED**                           | AsyncAPI: `call:ice` removed (messages, operations, payload schemas and the orphaned `IceCandidate`); `call:cancelled`, `call:missed`, `call:outgoing_mirror`, `call:handled`, `call:member_declined`, `call:rejoin` and `notification:updated` added. OpenAPI: `GET /chat/notifications/sync` and the three `POST /chat/calls/{callId}/…` routes added with their response schemas.                                                                                                                                                      |
| **GAP-08** live "ongoing" row                          | **OUT OF SCOPE**                    | Product decision, excluded by the brief. Only terminal statuses project, deliberately.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **GAP-09** frozen notification locale                  | **DOCUMENTED, NO CODE CHANGE**      | `pushToUser` resolves the recipient's locale and materializes `title`/`body` before the inbox write, so a row keeps the language it was written in. The structured `payload.data` is a complete description of the call (`callStatus` × `callDirection` × `callType` × `durationSec`), so a client can re-render the line in the current language with no backend work. A server fix means storing copy keys + params instead of a rendered string — a wider refactor with no product driver behind it.                                   |
| **GAP-10** retry bounded at one attempt, no DLQ        | **FIXED**                           | Three attempts, then the message is parked in `call.push.dlq`. Implemented as an explicit publish rather than an `x-dead-letter-exchange` argument: queue arguments are immutable once declared and chat-service asserts `call.push.queue` with `{durable:true}` only, so a changed redeclare would fail the channel and take the consumer down on deploy. Retries republish (with an incremented `x-delivery-attempt` header) rather than requeue, so a poisonous message goes to the back of the queue instead of spinning at the head. |
| **GAP-11** historical backfill                         | **OUT OF SCOPE**                    | No product requirement. The canonical `Call` rows are intact if it is ever wanted.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **GAP-12** group calls excluded                        | **OUT OF SCOPE, BY DESIGN**         | Unchanged: `postCallChatMessageSafe` and `projectCallActivitySafe` both early-return on `groupId`. Group call activity belongs to the group timeline.                                                                                                                                                                                                                                                                                                                                                                                     |
| Cursor contract                                        | **ALREADY CORRECT — now covered**   | Verified live (160 rows over 8 pages, 0 duplicates; an epoch-ms cursor is rejected with a clean `400`). Regression test added.                                                                                                                                                                                                                                                                                                                                                                                                            |
| FCM data-map strings                                   | **ALREADY CORRECT — now covered**   | Every value already `String(...)`-wrapped. Regression test added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Idempotency                                            | **ALREADY CORRECT — now covered**   | `groupKey` + `resurface: "false"`, behind won status claims. Regression test added.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `markRead` leaking onto the public DTO                 | **FIXED (found during this work)**  | `markRead` and `excludeSessionId` are write-time directives; both are now stripped by `serializeNotification`, matching what the `/notify` relay already did.                                                                                                                                                                                                                                                                                                                                                                             |
