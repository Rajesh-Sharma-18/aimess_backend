# AIMess Call History Implementation

WhatsApp-style Calls list: filter tabs, consecutive-attempt aggregation, direction
and outcome indicators, and call-back from the row.

---

## Existing Architecture

Audited before any code was written. What already existed:

| Concern                     | Where it lives                                                                        | Reused as-is                    |
| --------------------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| Call model                  | `apps/chat-service/prisma/schema.prisma` → `model Call`                               | yes — no schema change          |
| Call state machine          | `apps/chat-service/src/services/call.service.ts`                                      | yes — untouched                 |
| Call history storage        | `calls` collection (`Call` rows)                                                      | yes                             |
| Raw history API             | `GET /api/chat/calls` → `CallService.getCallHistory`                                  | yes — untouched                 |
| Outcome vocabulary          | `packages/constants/src/chat/group-system-message-text.ts` → `CALL_TIMELINE_STATUSES` | yes                             |
| Outcome copy                | `packages/constants/src/chat/call-activity-text.ts` → `buildCallActivityText`         | yes                             |
| Real-time carrier           | `call.activity` → notifications inbox → `notification:new` on `/notify`               | yes                             |
| Identity + deleted accounts | `UserSnapshotService.getUserSnapshotsMap` + `resolveDisplayName`                      | yes                             |
| Call initiation (FE)        | `useCall().initiate(peerId, mode, peerInfo)` (`src/contexts/CallContext.tsx`)         | yes                             |
| Call icons                  | `public/images/call/*.svg` + `MaskIcon`                                               | yes                             |
| Date formatting             | `formatLastSeen` (`src/utils/aimessTime.ts`)                                          | yes                             |
| Filter pills                | `NotificationTabs` styling                                                            | extracted to a shared component |

### Canonical values found (not assumed)

`Call.type`: `AUDIO` | `VIDEO`.
`Call.status`: `RINGING` | `IN_PROGRESS` | `ENDED` | `MISSED` | `DECLINED` | `FAILED`.

There is **no `CANCELLED` in the database.** A ring the caller hung up on is stored
`ENDED` with a null `answeredAt` (`CallService.endCall`); `CANCELLED` exists only at
the presentation layer, where the DM timeline row and the Notification Center line
already use it. A ring that times out becomes `MISSED` — for **both** participants,
since one row serves both sides.

Direction is not stored. It is `callerId === viewerId ? OUTGOING : INCOMING`.

---

## Current Problems

1. **No Calls view existed on web at all.** Call history was only visible as
   `call.activity` rows mixed into the Notification Center's Friends tab.
2. `GET /api/chat/calls` returns raw rows: no filter, no aggregation, no peer
   identity (just ids), and it includes live `RINGING` rows that can never
   transition once rendered.
3. Nothing shared the direction/outcome projection, so any new consumer would
   have had to re-derive it and would have been free to disagree with the
   existing inbox and timeline copy.

---

## New Architecture

```
GET /api/v1/chat/calls/history?filter=&cursor=&limit=
  → CallController.getGroupedCallHistory
  → CallHistoryService.getHistory                 (consecutive-run aggregation)
      → CallRepository.findHistoryPage            (indexed, filtered, cursor-bounded)
      → resolveContacts()                         (bulk cached snapshots + presigned avatars)
  → { items, nextCursor, hasMore }
```

The projection itself lives in **one shared module**,
`packages/constants/src/chat/call-history.ts`, so the aggregator, the REST
response and the client all read a call the same way.

The raw `GET /api/chat/calls` feed is **unchanged** — mobile pages it, and grouping
changes what "a page" means. The new grouped list is a sibling route registered
before `/:callId` (which would otherwise capture `history`).

---

## Filter Behavior

| Tab               | Rule                                              |
| ----------------- | ------------------------------------------------- |
| **All** (default) | every settled 1:1 call                            |
| **Incoming**      | `currentUserId === receiverId`                    |
| **Outgoing**      | `currentUserId === callerId`                      |
| **Missed**        | rang me and never connected — `result === MISSED` |

Live rows (`RINGING`, `IN_PROGRESS`) are excluded from every tab: they have no
outcome yet, and the list has no mechanism to transition a row it already drew.
They appear as soon as they settle, via the real-time path below.

Group calls are excluded (`groupId: null`) — they have no single peer to key a row
on, and they are already absent from every other call-history surface (a group
call is never projected into the Notification Center either). The raw feed still
returns them.

---

## Grouping Algorithm

Consecutive runs over the sorted sequence — **not** a global group-by.

```
Mohit  INCOMING VOICE MISSED
Mohit  INCOMING VOICE MISSED
Mohit  INCOMING VOICE MISSED
Rajesh OUTGOING VOICE ANSWERED
Mohit  INCOMING VOICE MISSED
```

→ `Mohit (3)`, `Rajesh`, `Mohit` — **not** `Mohit (4)`, `Rajesh`.

Rows arrive newest-first, so the **first** row of a run is its latest call: that is
where the row's timestamp, call type, outcome and `latestCallId` come from.
`firstCallAt`/`oldestCallId` move as older rows fold in.

### Aggregation Key

`contactId | direction | callType | result`

`contactId` is the **peer**, never `callerId` — the viewer is the caller on half
their own history, so keying on `callerId` would merge "I called Mohit" with
"Mohit called me".

### Timeframe

**No time window.** AIMess had no existing grouping window to reuse, so none was
invented — adjacency in the sorted history is the only rule. Two calls a month
apart with nothing between them group, exactly as they do in the reference UI.

---

## attemptCount

Number of calls collapsed into the row. `1` renders no count; `> 1` renders
`Mohit Vasundhara Infotech (4)`.

## Group Timestamp

`lastCallAt` — the **newest** call in the run. Four missed calls at 10:01, 10:03,
10:05, 10:08 display `10:08`.

---

## Direction Resolution

```ts
resolveCallDirection(call, viewerId); // callerId === viewerId ? OUTGOING : INCOMING
```

One resolver, in the shared module. Derived only from the call record's own
participants — never from notification text, a label, or a UI string.

## Status Resolution

Two steps, both in the shared module:

```ts
resolveCallTimelineStatus(call); // DB status → CallTimelineStatus
//   ENDED + answeredAt == null → CANCELLED
resolveCallResult(status, direction); // → ANSWERED | MISSED | NO_ANSWER
```

The canonical DB status is **unchanged**; this is a presentation layer on top.

**Outcome model.** Every call that never connected collapses to one viewer-relative
pair: the side that was rung **MISSED** it, the side that placed it got
**NO_ANSWER**. `MISSED`, `CANCELLED`, `DECLINED` and `FAILED` all land there — which
end hung up first is lifecycle bookkeeping, not something either participant
experienced, and exposing it told each side the other's business. The canonical
state is still on the wire as `callStatus` if a surface ever needs it.

> ⚠️ **This differs from the original spec** (§4/§6/§21 asked for distinct
> ANSWERED/MISSED/DECLINED/CANCELLED/FAILED with a cancel grace window). It was
> changed on request, to match the concurrent notification-copy work that
> establishes "AiMess has no user-facing cancelled or declined call" as the
> product rule. Switching back is a one-function change in `resolveCallResult`
> plus the label map in `callHistoryConstants.ts`.

`NO_ANSWER` is **not** an error state: it renders with the normal name colour and a
green outgoing arrow, matching how the DM timeline card and the inbox line already
present the caller's own unanswered call.

---

## API Changes

**New:** `GET /api/v1/chat/calls/history`

Query: `filter` (`all` | `incoming` | `outgoing` | `missed`, default `all`),
`cursor` (opaque, ISO `initiatedAt`), `limit` (1–50, default 20).

```jsonc
{
  "items": [
    {
      "id": "…", // == latestCallId, stable list key
      "latestCallId": "…", // call-back and call-details act on THIS
      "oldestCallId": "…",
      "contact": {
        "id": "…",
        "name": "…",
        "avatarUrl": "…",
        "isDeleted": false,
      },
      "direction": "INCOMING",
      "result": "MISSED",
      "callStatus": "MISSED", // canonical CallTimelineStatus
      "callType": "AUDIO",
      "attemptCount": 4,
      "lastCallAt": 1755500880000,
      "firstCallAt": 1755500460000,
      "durationSec": 0,
      "roomId": "…",
    },
  ],
  "nextCursor": "2026-08-18T10:01:00.000Z",
  "hasMore": true,
}
```

Unchanged: `GET /api/chat/calls`, `GET /api/chat/calls/:callId`.

---

## Backend Changes

| File                                                       | Change                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/constants/src/chat/call-history.ts`              | **new** — shared projection: direction, timeline status, result, filter match, group key |
| `packages/constants/src/chat/call-activity-text.ts`        | exported `cancelCountsAsMissed`                                                          |
| `packages/constants/src/index.ts`                          | export the new module                                                                    |
| `apps/chat-service/src/repositories/call.repository.ts`    | **new** `findHistoryPage`                                                                |
| `apps/chat-service/src/services/call-history.service.ts`   | **new** — aggregation + pagination                                                       |
| `apps/chat-service/src/api/controllers/call.controller.ts` | **new** `getGroupedCallHistory`                                                          |
| `apps/chat-service/src/api/routes/call.routes.ts`          | `GET /history`, above `/:callId`                                                         |
| `apps/chat-service/src/api/validators/call.validator.ts`   | `callHistoryGroupedQuerySchema`                                                          |
| `apps/chat-service/src/server.ts`                          | wire `CallHistoryService` + contact resolver                                             |
| `apps/api-gateway/src/docs/openapi/**`                     | path + 3 schemas                                                                         |

`CallService` is untouched.

## Frontend Changes

| File                                                                     | Change                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `src/component/common/FilterTabs.tsx`                                    | **new** — THE pill row                                                          |
| `src/component/notifications/NotificationTabs.tsx`                       | now renders `FilterTabs`                                                        |
| `src/assets/styles/_common.scss`                                         | `.notifications__tab*` → shared `.filter-tabs`; new `.call-list` / `.call-item` |
| `src/controller/chat/callHistory.{api,apiType}.ts`, `useCallHistory.ts`  | **new**                                                                         |
| `src/component/calls/**`                                                 | **new** — item, list, constants, view hook                                      |
| `src/views/calls/CallsView.tsx`, `src/app/(layout-pages)/calls/page.tsx` | **new** route                                                                   |
| `src/constants/PATHS.ts`, `api-endpoints.ts`, `MenuSidebar.tsx`          | route + endpoint + nav entry                                                    |
| `src/messages/{en,vi,th}.json`                                           | new `calls` namespace + `common.navCallsAlt`                                    |

No new dependencies.

### Timestamps

`formatLastSeen` (existing) — `just now` · `5 minutes ago` · `today at 2:35 PM` ·
`yesterday at 11:20 AM` · `Aug 3 at 11:20 AM`. Honours the user's 12/24-hour
preference and locale. No second date utility was created. Fed from `lastCallAt`.

### Icons and colour

All from the existing set, via `MaskIcon` so they take semantic theme tokens:
`missed-arrow.svg` (↙), `call-arrow-out.svg` (↗), `phone.svg`, `videocam.svg`.
`call-arrow-in.svg` is unused here — it ships with a hardcoded red fill and cannot
serve an answered incoming call, which must be green.

| Outcome              | Arrow   | Name         |
| -------------------- | ------- | ------------ |
| ANSWERED incoming    | green ↙ | normal       |
| ANSWERED outgoing    | green ↗ | normal       |
| NO_ANSWER (outgoing) | green ↗ | normal       |
| MISSED               | red ↙   | red (`$red`) |

---

## Callback Behavior

The row's right-hand icon reflects the **latest** call in the group and starts that
kind of call: `AUDIO` → voice, `VIDEO` → video.

It calls `useCall().initiate(...)` — the same entry point the chat header uses — so
every server-side gate still applies: friendship, block, `whoCanCallMe`, the
platform kill-switch, and the busy check. **Nothing here bypasses `call:initiate`.**
The button's disabled state (deleted peer, or a call already live on this device)
is a courtesy; the backend remains authoritative.

Accessible name: `Call {name}` / `Video call {name}`, with a matching `title`,
keyboard activation and a visible focus ring.

---

## Pagination Strategy

**Server-side filtering.** Filtering a fetched page on the client would make
`limit` meaningless (ask for 20, render 3) and would break the group boundary.

**Groups are never split across pages.** A run is only emitted once a differing row
has been seen after it (or history ran out), and `nextCursor` is the **oldest row of
the last emitted group**. With the existing exclusive `lt` cursor, the next page
therefore begins at the first row this page did not consume. Page 1 ending with
`Mohit (2)` and page 2 starting with another `Mohit (2)` is structurally impossible
unless they were genuinely separate runs.

**Application-level, not an aggregation pipeline** — documented decision:

- `$group` cannot express "consecutive runs"; it collapses every match, including
  ones separated by another contact.
- `$setWindowFields` could, but only over the whole scanned set, and two of the
  four grouping axes (direction, result) are viewer-relative projections that do
  not exist as fields on the document.
- Grouping in the service keeps one definition of those axes, shared with the
  client.

The database still does all the selection: participant equality picks the index,
`initiatedAt` gives both the cursor bound and the sort. The service reads batches
(`limit × 3`, capped at 100) and stops as soon as it has one page of complete
groups — it never loads a user's whole history.

### Indexing

**No new index.** The existing `@@index([callerId, initiatedAt(sort: Desc)])` and
`@@index([calleeId, initiatedAt(sort: Desc)])` already serve every new query:
participant equality is the prefix, `initiatedAt` covers both the `lt` bound and
the sort. `status` / `answeredAt` / `groupId` are residual predicates over an
already participant-scoped, date-bounded set.

---

## Real-Time Updates

A settled call already reaches **both** participants as one `call.activity` inbox
row, delivered as `notification:new` on the `/notify` namespace. That existing
event is the trigger — no new event, no new socket, no new consumer.

On arrival the Calls queries are **invalidated, not spliced**. Whether a new call
joins the run above it depends on the four grouping axes _and_ on adjacency, which
is exactly the computation the server owns; merging client-side would be a second
grouping implementation free to disagree (`Mohit (3)` sitting next to a stray
`Mohit` the server would have folded in). Refetching makes group reconciliation
automatic and always correct.

**All tabs are invalidated, not just the visible one** — that is what keeps the
filter authoritative: an answered call arriving while Missed is open simply is not
returned by the Missed query, and the tab the user switches to next cannot serve a
stale page.

## Unread / Badge Behavior

**Unchanged.** Missed-call badging lives in the notification inbox
(`isUnreadCallActivity`) and counts _notification rows_, not history rows. Display
count (`attemptCount`) and unread count are separate concepts and remain so — four
grouped attempts do not deflate the badge, and the Calls view has no badge of its
own.

---

## Test Matrix

Backend — `apps/chat-service/tests/calls/call-history.service.test.ts`, **18 tests, all passing**:

| Area         | Covered                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction    | resolved from the record, opposite for the two participants                                                                                               |
| Status       | unanswered `ENDED` → `CANCELLED` without mutating the DB status                                                                                           |
| Result       | all four non-connected statuses → MISSED (in) / NO_ANSWER (out); ENDED → ANSWERED                                                                         |
| Grouping     | 3 consecutive collapse; run interrupted by another contact does not merge; direction / call type / outcome never merge; peer (not caller) is the identity |
| Filters      | all, incoming, outgoing, missed; answered never in Missed; abandoned inbound ring is missed                                                               |
| attemptCount | correct; latest/oldest call ids; `lastCallAt > firstCallAt`                                                                                               |
| Pagination   | group never split across a boundary (3 pages verified); empty history; malformed cursor rejected                                                          |
| Resilience   | identity-lookup outage still returns rows                                                                                                                 |

Frontend — verified by `tsc --noEmit` + ESLint (both clean). Not covered by
automated tests: the repo has no FE test harness, so tab selection, icon/colour
rendering, responsive width, dark/light mode and the callback click path were not
given automated coverage. See **Remaining Issues**.

## Regression Testing

- `apps/chat-service/tests/calls` — full suite run; the new suite passes and no
  previously-passing call test was broken by this work.
- `apps/notifications-service/tests/consumers` — passing.
- Typecheck: `@aimess/constants`, `@aimess/chat-service`, `@aimess/api-gateway`, website — clean.
- Lint: chat-service (only pre-existing `no-console` warnings in an unrelated test), website — clean.
- Untouched: call initiate / accept / decline / cancel / end, video and audio
  calling, call notifications and pushes, permissions, friendship and block gates,
  deleted-account behaviour, and the raw `GET /api/chat/calls` contract.

## Files Changed

See the two tables under **Backend Changes** / **Frontend Changes**.

---

## Remaining Issues

1. **No frontend tests.** The website repo has no test runner configured;
   everything FE-side is covered only by types and lint. Spec §37's checks were
   not automated.
2. **Not run against a live server.** No dev server or database was started during
   this work, so the view has not been exercised end-to-end — no screenshots, and
   dark/light and responsive rendering were not visually verified.
3. **Scan-budget ceiling.** A single uninterrupted run longer than ~3000 calls is
   emitted mid-flight and may split across a page. Marked with a `ponytail:`
   comment in `call-history.service.ts`.
4. **Cursor ties.** Two calls sharing an identical `initiatedAt` millisecond can be
   skipped by the exclusive `lt` cursor — pre-existing behaviour inherited from the
   raw feed, not introduced here.
5. **Group calls excluded** from the grouped list (consistent with every other
   call-history surface). If group call history is ever wanted, it needs group
   identity resolution and a group call-back path that web does not have.
6. **Concurrent edits.** While this was being built, another session was editing
   the same call-copy constants (`call-activity-text.ts`,
   `group-system-message-text.ts`, `notification.messages.ts`) and left 4 failing
   assertions in `apps/chat-service/tests/calls/call-activity-notification.test.ts`
   — they assert the old cancelled/declined copy. Those failures are **not** from
   this work and were left alone.
