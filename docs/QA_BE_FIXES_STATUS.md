# QA Audit — Backend Fix Status

**Date:** 2026-08-12 · **Branch:** `rajesh-dev` · **Commits:** `dc55e7a4`, `15ec5482`, `4b70e494`

## Scope note — read this first

`QA_AUDIT_REPORT.md` is **not in the repository**. Searched the tree for the file
and grepped for the `AUDIT-1xx` identifiers; zero hits. The only audit document
present is [tests/AUDIT_REPORT.md](../tests/AUDIT_REPORT.md) (2026-06-11), a
different report with H/M/L numbering whose findings are largely already fixed.

Everything below was therefore worked from the findings **quoted in the task
brief**. That covers all four P0s and the named P1/P2 items. It does **not**
cover:

- the full §4 / §14 P2+P3 lists — only ~18 ids were quoted, by one-line summary
- §5 "verified correct behaviours" — no regression baseline was available, so
  the guarantee below is "no new test failures", derived empirically
- AUDIT-114's repro steps (see Not Fixed)

Attach the report to close the remainder.

---

## 1. Status per finding

| ID                      | Severity | Status                     | Where                                                                                                                                                                          |
| ----------------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AUDIT-101               | P0       | **Fixed**                  | [community-room.service.ts](../apps/chat-service/src/services/community-room.service.ts)                                                                                       |
| AUDIT-102               | P0       | **Fixed**                  | [community.routes.ts](../apps/chat-service/src/api/routes/community.routes.ts), [general-room.repository.ts](../apps/chat-service/src/repositories/general-room.repository.ts) |
| AUDIT-103               | P0       | **Fixed**                  | [private-message.service.ts](../apps/chat-service/src/services/private-message.service.ts)                                                                                     |
| AUDIT-104               | P0       | **Fixed**                  | [private-message.service.ts](../apps/chat-service/src/services/private-message.service.ts)                                                                                     |
| AUDIT-001               | P1       | **Fixed**                  | [api-gateway/app.ts](../apps/api-gateway/src/app.ts)                                                                                                                           |
| AUDIT-105               | P1       | **Fixed**                  | [chat-message-orchestrator.ts](../apps/chat-service/src/services/chat-message-orchestrator.ts)                                                                                 |
| AUDIT-106               | P1       | **Fixed**                  | [access-guard.ts](../apps/chat-service/src/lib/access-guard.ts), orchestrator                                                                                                  |
| AUDIT-115               | P1       | **Fixed**                  | same as 106                                                                                                                                                                    |
| AUDIT-107               | P1       | **Fixed**                  | [rate-limiters.ts](../apps/auth-service/src/middleware/rate-limiters.ts)                                                                                                       |
| AUDIT-108               | P1       | **Fixed**                  | [community.service.ts](../apps/community-service/src/services/community.service.ts)                                                                                            |
| AUDIT-109               | P1       | **Fixed**                  | [group-room.service.ts](../apps/chat-service/src/services/group-room.service.ts)                                                                                               |
| AUDIT-110               | P1       | **Fixed**                  | [group-message.service.ts](../apps/chat-service/src/services/group-message.service.ts)                                                                                         |
| AUDIT-111               | P1       | **Fixed**                  | [inbox.controller.ts](../apps/chat-service/src/api/controllers/inbox.controller.ts)                                                                                            |
| AUDIT-112               | P1       | **Fixed** (needs backfill) | [download-authz.ts](../apps/media-service/src/lib/download-authz.ts)                                                                                                           |
| AUDIT-113               | P1       | **Fixed**                  | [private-message.service.ts](../apps/chat-service/src/services/private-message.service.ts)                                                                                     |
| AUDIT-147               | P2       | **Fixed**                  | [media.service.ts](../apps/media-service/src/services/media.service.ts)                                                                                                        |
| AUDIT-002               | P1       | **Already correct**        | `app.disable("x-powered-by")` is at [app.ts:43](../apps/api-gateway/src/app.ts) — see §4                                                                                       |
| AUDIT-114               | P1       | **Not a code defect**      | un-run `backfill:revision`, not a dead endpoint — see §4                                                                                                                       |
| AUDIT-116–146, 148, 149 | P2/P3    | **Not addressed**          | not quoted in the brief; needs the report                                                                                                                                      |

Found and fixed while in the area (not in the brief):

- **F1/F2/F3** from [tests/AUDIT.md](../apps/auth-service/tests/AUDIT.md) —
  `/login` ran with no validation, `sensitiveAuthRateLimiter` was mounted
  nowhere, and its window was 15 **milliseconds**. See §4.
- Community `join` incremented `memberNumber` on every call, double-counting
  against the `community.member.synced` consumer and inflating further on repeat.
- Three test-harness breaks, one of which stopped media-service's suite from
  running at all (see §5).

---

## 2. What each fix does

### AUDIT-101 — community room self-join

`POST /chat/community/rooms/:roomId/join` upserted `RoomMember{status:"active"}`
after only a ban check. Every community guard (`assertCommunityMember`,
`assertCommunityReadAccess`) trusts that mirror row, so any authenticated user
could name any roomId — a PRIVATE community included — and buy full read **and**
write access to its chat.

Membership is owned by community-service. The route now routes through
`assertCommunityMember`, which short-circuits on an already-active mirror and
otherwise does the authoritative `checkCommunityMembership` lookup, healing the
mirror **only** when community-service confirms ACTIVE. Non-members get
`CHAT_NOT_A_MEMBER`, banned callers `USER_BANNED`.

### AUDIT-102 — unauthenticated room listing

`GET /rooms` and `GET /rooms/search` carried no `authenticate`, and
`findActiveRooms()` returned every active room with no PUBLIC/PRIVATE filter and
no `skip`/`take` — the response builder only pretended to paginate. An anonymous
caller got every private community's name and `lastMessage` preview text.

Both routes now require a token and are scoped to PUBLIC communities plus the
caller's own membership rows. A null/unsynced `communityType` is treated as
PRIVATE, matching `assertCommunityReadAccess`. `limit`/`page` moved into the
query, bounded by a validator (max 50).

### AUDIT-103 / 104 — private write paths

`sendMessage` checked friendship and block state but never participation:
friendship answers "may these two talk", not "is the sender in THIS room".
`forwardMessage` bound the SOURCE room but not the TARGET, so a message could be
injected into a DM the caller is not part of. Both now call
`assertPrivateParticipant` before anything else — before the friendship
round-trip and before a sequence number is allocated.

### AUDIT-106 / 115 — client-controlled fan-out

`receiverId` came from the request body and drove the persisted row, the
`message:new` personal fan-out, the `conv:updated` bump and the push. Omitted, it
published to `user:""` and the real peer received nothing; forged, all three
reached someone outside the room.

New `privateRoomPeerId(room, userId)` in `access-guard.ts` is the single
authority. The service derives and persists the peer; the orchestrator reads it
back off the returned row, so there is no second source of truth and no extra
I/O. `receiverId` stays accepted on the wire and is ignored.

### AUDIT-105 — forged read receipts

`markReadDirect`'s GROUP branch is self-guarding (`markReadUpTo` returns seq 0
for a non-member); the PRIVATE branch went straight to the room write. A stranger
could advance a DM's read state and publish a `message:read` receipt in their
name to `conv:<roomId>` and to each participant's `user:<id>`. Reached from both
`POST .../read` and `POST /chat/conversations/read/bulk`. Now calls
`assertParticipant` — the same call `reactDirect` already made.

### AUDIT-110 / 113 — reactor list leak

`getMessageReactions` (group and private) returned the reactor identity list
(userId + displayName + avatar) for any `messageId` with no membership check,
ignoring the `roomId` parameter entirely. Both now guard and bind the message to
the room; the group side additionally clamps to a LEFT/KICKED member's read
cutoff, matching the other group read paths.

### AUDIT-109 — disband did not end the group

Disband flipped `GroupRoom.status` to `DISBANDED`, but **nothing** on the
authorization path reads that field — every guard resolves a `GroupMember` row.
The group kept accepting messages, reactions and pins.

Memberships are now ended at `disbandedAt` in the same operation. That reuses the
existing LEFT semantics instead of adding a room-status check to every guard:
`assertGroupMember` (ACTIVE-only) denies all writes, while
`assertGroupReadAccess` keeps history readable up to the cutoff — the group goes
read-only rather than vanishing.

### AUDIT-111 — inbox cursor dropped conversations

Legacy `before_ts` mode emitted a **bare epoch-ms** `nextCursor`, while the
endpoint documents "echo `pagination.nextCursor` back verbatim" into
`before_cursor`. A bare value there parses to a boundary with no tiebreaker, so
the exclusive keyset degrades to `lastMessageAt < ts` and every conversation
sharing that millisecond is skipped **permanently**.

`nextCursor` is now always the compound `<ms>_<roomId>` token. A bare ms is a
coarse INCLUSIVE jump (may repeat the boundary row; clients de-dupe by roomId);
only a token carrying the roomId is exclusive, and that one cannot drop anything.
`before_ts`/`after_ts` now also accept the compound form — they previously 400'd
on it via `z.coerce.number()` → NaN.

### AUDIT-112 / 147 — media

Download authz for `COMMUNITY_CHAT_ATTACHMENT` / `GROUP_CHAT_ATTACHMENT` fell
back to a check that only asserted the key started with the category prefix — a
condition every key in the category satisfies. Any authenticated caller who
learned a key got a presigned URL. Two paths reached it: no registry row, and a
row with a null `resourceId`.

Object keys are `{prefix}/{ownerId}/{fileId}.{ext}` — they carry the uploader's
id and nothing about the room, so when membership is unprovable the only
relationship the key supports is "you uploaded this". That is now the rule.

`resourceId` was separately taken on trust at upload time and written to the
registry, which is exactly what the download guard reads back — an unverified
value poisons its own authorization. It is now verified through the same
`checkMediaAccess` RPC and is **required** for the three chat categories.

### AUDIT-001 / 107 / 108

- **001** — a terminal 404 hands a `NotFoundError` to `errorHandler`. Unmatched
  paths previously fell through to Express's `finalhandler` and returned HTML.
- **107** — `changePasswordRateLimiter`, 5/hour/user, mounted after auth so it
  keys on userId. The endpoint verifies `currentPassword`, so an unthrottled one
  is a password oracle at request speed for anyone holding a stolen token.
- **108** — `autoApprove: true` on a PRIVATE community bypasses the join-request
  queue, which is the only thing making it private. Link creation stays open to
  every ACTIVE member; `autoApprove` now requires MODERATOR+. PUBLIC is
  unaffected.

---

## 3. Contract changes

All additive or widening. No client change is required.

| Surface                                      | Change                                                                       | Compatibility                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /chat/private/rooms/:id/messages`      | `receiverId` now **optional** and ignored                                    | Clients still sending it are unaffected; the server derives the peer                                                                      |
| `POST .../messages/:id/forward`              | `receiverId` now **optional** and ignored                                    | same                                                                                                                                      |
| `GET /chat/inbox`                            | `nextCursor` is always `<ms>_<roomId>`; `before_ts`/`after_ts` accept it too | A client echoing `nextCursor` works in either param. A client that _parsed_ the cursor as a number must stop — it is documented as opaque |
| `GET /chat/community/rooms`, `/rooms/search` | now require a token; results are viewer-scoped; `limit` capped at 50         | **Breaking for anonymous callers.** There should be none — the rest of the router was already authenticated                               |
| `POST /chat/community/rooms/:id/join`        | 403 for non-members instead of granting                                      | Behaviour restored to intent; the previous response was the vulnerability                                                                 |
| `POST /media/upload-url`                     | `resourceId` required for the three chat categories                          | The FE media guide already documents sending it; an upload without it produced an unauthorizable object                                   |

---

## 4. Not fixed

### AUDIT-114 — `/changes` returns `items: []`

Could not reproduce from the code. The stated root cause ("ensure
`allocateSequenceBlock` actually increments `lastRevision`") is **already
satisfied**: [private-room.repository.ts:79](../apps/chat-service/src/repositories/private-room.repository.ts)
increments both counters in one `$inc`; `allocateRoomSlot` hands out
`firstRev + i` correctly; `createMessage` and `createForwardedMessage` both stamp
`revision`; `findByRoomIdRevisionSince` filters `revision > since`.

Two candidates that need the repro to choose between:

1. Pre-backfill rows default to `revision = 0`, so `since_revision=0` excludes
   them — `/changes` would look permanently empty for any room whose messages
   predate the field. A backfill would fix it.
2. `enrichMessages`' per-viewer filter emptying the page after the slice (which
   is legal per the endpoint's own contract: `items.length < limit` with
   `hasMore: true`).

**Needs §4's repro steps.**

### AUDIT-002 — `poweredByHeader: false`

`app.disable("x-powered-by")` is already present at
[api-gateway/src/app.ts:43](../apps/api-gateway/src/app.ts), and this backend has
no Next.js app — `next.config` does not exist here. If the finding targets the
web frontend, it belongs in the `aimess_website` repo.

### AUDIT-116–146, 148, 149

Not quoted in the brief beyond a handful of one-line summaries. Needs the report.

### Still open, found in passing

`sensitiveAuthRateLimiter` is imported by **nothing**. Its window bug is fixed,
but `/auth/login`, `/register` and `/forgot-password` remain unthrottled at the
service layer. That is a separate change with its own blast radius (it will start
429-ing real traffic), so it was not folded in here.

---

## 5. Tests

**New suites**

| File                                                                                                                                                   | Covers                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| [chat-service/tests/private/audit-authz-regression.test.ts](../apps/chat-service/tests/private/audit-authz-regression.test.ts)                         | 103, 105, 106, 115, 113 |
| [api-gateway/tests/utils/not-found-envelope.test.ts](../apps/api-gateway/tests/utils/not-found-envelope.test.ts)                                       | 001                     |
| [auth-service/tests/account/change-password-rate-limit.test.ts](../apps/auth-service/tests/account/change-password-rate-limit.test.ts)                 | 107                     |
| [community-service/tests/invite-links/invite-auto-approve-gate.test.ts](../apps/community-service/tests/invite-links/invite-auto-approve-gate.test.ts) | 108                     |

**Extended:** `cross-room-idor-writes` (104), `group-message` (110),
`group-room` (109), `community-room` (101/102, rewritten — it previously asserted
the holes as intended behaviour), `chat-cursor` + `effective-last-activity` (111,
one case pinned the dropping semantics).

Every negative asserts both the rejection **and** that the side effect never
fired — a 403 that still wrote the row or still published the event is not a fix.

**Harness fixes** (both were causing pre-existing failures):

- `userServiceClient` had no `isFriendshipBlocked`, so every private send 500'd
  on "not a function".
- `privateRoomRepo.findByRoomId` had no default; the guards now run on the write
  paths too, so specs 404'd before reaching what they were testing.

**Result — full monorepo suite:**

|                       | Suites failed | Tests failed | Total |
| --------------------- | ------------- | ------------ | ----- |
| Baseline (`bf5f9645`) | 40            | 103          | 3904  |
| After                 | 35            | 83           | 3937  |

**Zero new failures.** Compared by test NAME, not count, against the same
baseline commit. Two pre-existing failures fixed as a side effect of the harness
work. All remaining failures pre-date this branch.

`tsc --noEmit` is clean across every service. (`pnpm typecheck` fails on
community-service, but on `prisma generate`'s Windows EPERM rename, not on types
— a known local issue.)

---

## 6. Migration / data cleanup required

### AUDIT-112 — backfill `MediaFile.resourceId`

Community and group attachments whose registry row has no `resourceId` are now
downloadable **by their uploader only**, because nothing recoverable from the
object key identifies the room to check membership against.

Backfill `resourceId` from the chat message carrying each `objectKey` to restore
access for the other members. The affected set cannot grow — `resourceId` is now
required at upload time (AUDIT-147).

Scoping query (registry side):

```
db.MediaFile.countDocuments({
  uploadCategory: { $in: ["COMMUNITY_CHAT_ATTACHMENT", "GROUP_CHAT_ATTACHMENT"] },
  $or: [{ resourceId: null }, { resourceId: { $exists: false } }]
})
```

Run it before deploying to size the impact. If the count is zero, no migration is
needed.

### AUDIT-109 — existing disbanded groups

Groups disbanded before this change still hold ACTIVE `GroupMember` rows and are
still writable. One-off:

```
db.GroupMember.updateMany(
  { roomId: { $in: <ids of GroupRoom where status="DISBANDED"> }, status: "ACTIVE" },
  { $set: { status: "LEFT", leftAt: <that room's disbandedAt> } }
)
```

Per-room, so `leftAt` matches each room's own `disbandedAt` and the read cutoff
stays consistent.

### AUDIT-101 — `memberNumber` drift

Every previous `join` call incremented `memberNumber` on top of the sync
consumer's own increment, so community member counts are inflated by an unknown
amount. Recompute from `RoomMember` where `status = "active"` per room.

---

## 7. Remaining risks

1. **The AUDIT-112 backfill is an availability risk.** Until it runs, members
   cannot download old community/group attachments they did not upload. Run the
   §6 dry run to size it — if the count is zero there is nothing to do.
2. **Rate limiting now returns 429 on real auth traffic** (F2). Default is 20
   per 15 min per IP. It keys on IP, so behind a NAT or a proxy with
   `TRUST_PROXY_HOPS=0` every client shares one bucket — verify that value, and
   raise `SENSITIVE_AUTH_RATE_LIMIT_MAX` if the deployment warrants it.
3. **P2/P3 coverage is unknown.** ~18 findings named in the brief, 30+
   unaccounted for. Needs the report.
4. **AUDIT-114's diagnosis is inferred, not reproduced.** §4 explains why the
   symptom follows from un-run maintenance rather than a code defect, but it was
   not checked against the original repro. If QA saw empty `items` on a room with
   messages sent after this branch, that is a different bug.
5. Login validation is back on (F1). The schema matches what clients send and
   Zod strips unknown keys, and login deliberately does **not** apply the min-8
   password policy — but any client sending a genuinely malformed body now gets
   a 400 where it previously got a 500 or a silent pass.
6. The community room list adds one indexed membership query per call. It
   replaces an unbounded full-table scan, so it should be a net win, but it is a
   new query on a hot path.

---

## 8. Issues 50 + 51 — community notification preferences vs. the mute icon

**Date:** 2026-08-12 · **Branch:** `rajesh-dev`

Filed as two symptoms; they are one defect in the storage model of
`CommunityMuteSetting`, which carried two contradictory meanings on one row.

### Root cause

`CommunityMuteSetting` holds both the three category toggles
(`chatEnabled` / `announcementEnabled` / `streamEnabled`) and `mutedUntil`. The
old code read `mutedUntil === null` on an existing row as "muted indefinitely":

- `apps/community-service/src/lib/community-notification-pref.ts:23-28,50` —
  `isMuteRowActive()` returned true for any row with `mutedUntil === null`, and
  the oracle short-circuited to `false` for **every** field before it ever read
  the requested toggle.
- `apps/community-service/src/repositories/community.repository.ts:3064-3078` —
  `upsertNotificationPrefs()` creates the row with `mutedUntil` unset, i.e.
  `null`.

So the first time a member touched **any** switch, the row it created was
indistinguishable from an indefinite mute. Every notification kind was
suppressed from then on and switching a category back on changed nothing —
**issue 51**. The same predicate fed the caller-facing mute flag
(`community.service.ts:924`, `muteFields()`), so the list/sidebar rendered the
mute icon while the panel showed all three switches green — **issue 50**.

### Fix — one meaning per field

`mutedUntil` is now a **timed** mute only (`null` = no timed mute). An
indefinite mute is stored as all three toggles false. `isMuted` is always
derived, never stored: a running timed mute, or all three off.

| File                                      | Change                                                                                                                                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/community-notification-pref.ts`      | `isMuteRowActive` → `isTimedMuteActive` (future timestamp only) + new `isCommunityMuted` derivation; oracle falls through to the per-field toggle                                                                                       |
| `repositories/community.repository.ts`    | `upsertMute(…, null)` writes all three toggles false; `findStreamMutedMemberIds` also excludes members under a running timed mute                                                                                                       |
| `services/community.service.ts`           | `muteFields`, `getNotificationPreferences`, `setNotificationPreferences` all derive `isMuted` via `isCommunityMuted`; `setNotificationPreferences` now publishes `community:notification-setting-updated` so other devices/tabs re-sync |
| `apps/api-gateway/asyncapi/asyncapi.yaml` | Documented that `isMuted` is derived and `muteUntil: null` is not an indefinite mute                                                                                                                                                    |

Delivery gating is unchanged in shape — `push.service.ts:327` still calls the
same oracle, so chat, announcement and livestream pushes resume the moment a
category is switched back on.

### Migration

`scripts/backfill-indefinite-community-mutes.ts` — **dry run by default**.

The old schema cannot distinguish a genuine indefinite mute from a preferences
row: both are `mutedUntil = null`, and a member who switched a category off and
back on again also lands on all-three-true. Without `--apply` those rows read as
un-muted after deploy, which is the fail-safe direction (notifications resume;
re-muting is one tap). Run with `--apply` only if preserving the old mutes
matters more than the members whose switches were genuinely on.

### Tests

- `tests/mute/community-mute-model.test.ts` (new) — the `isCommunityMuted` truth
  table, how `upsertMute` stores indefinite vs. timed mutes, and the livestream
  fan-out exclusion.
- `tests/mute/community-notification-pref.test.ts` — the case that asserted
  "`mutedUntil = null` ⇒ everything suppressed" now asserts the opposite, plus a
  re-enable-after-full-mute case.

49 tests pass across the four mute suites; `tsc --noEmit` clean in both repos.

---

## 9. Issues 52 + 53 — moderator deleting an admin's message · the join toast

**Date:** 2026-08-12 · **Branch:** `rajesh-dev`

### Issue 52 — role hierarchy on delete-for-everyone (groups + communities)

Both delete paths authorized on the ACTOR's role alone and never read the
message SENDER's, so a MODERATOR could delete an ADMIN's message:

- `apps/chat-service/src/services/group-message.service.ts:1179` —
  `if (!["ADMIN", "MODERATOR"].includes(member.role)) throw …`
- `apps/chat-service/src/services/community-message.service.ts:2439` —
  `if (!["admin", "moderator"].includes(liveRole)) throw …`

Kick/mute/ban already enforce an outrank rule
(`group-member.service.ts:496`), and stream-service's comment delete
(`livestream-comment.service.ts:377-407`) implements exactly the intended
hierarchy — chat's delete was the outlier.

**Fix.** One shared predicate,
`canDeleteOthersMessage(actorRole, senderRole)` in
`apps/chat-service/src/lib/access-guard.ts` (case-insensitive, so groups'
UPPERCASE `RoomMember.role` and communities' lowercase live role both use it):

| Actor       | May delete another's message        |
| ----------- | ----------------------------------- |
| OWNER/ADMIN | anyone's                            |
| MODERATOR   | a plain MEMBER's only               |
| MEMBER      | none (own messages only, unchanged) |

- Groups resolve the sender's role from `RoomMember` (a sender who has since
  left has no row and ranks as MEMBER, so their leftover messages stay
  moderatable).
- Communities resolve it from the same authoritative live lookup
  (`getCommunityLiveRole`), and only in the moderator branch — an admin delete
  still costs one gRPC call, not two.
- Denial keeps the existing `CHAT_INSUFFICIENT_PERMISSIONS` code/status, so no
  client contract changes. Sender-deletes-own and the muted-moderator
  moderation exemption are untouched.

### Issue 53 — the "You joined the community!" toast

No backend change. The server already writes the joiner's own PERSONAL system
line ("You joined the community", `community.service.ts:273`) into the
transcript; the web client was additionally raising a success toast for the same
event. The toast was removed client-side (see
`aimess_website/QA_FIXES_WEBSITE.md`); the system message, `community:added`
payload and join events are unchanged.

### Tests

- `tests/groups/group-message-delete-hierarchy.test.ts` (new) — moderator vs.
  admin / peer moderator / member / departed sender, admin over moderator, plus
  the shared predicate's case-insensitivity and fail-closed behaviour.
- `tests/community/community-delete-mute-guard.test.ts` — three new hierarchy
  cases; its fake room repo also gained the `allocateRevision` the service has
  required since the zero-loss revision work (two long-standing failures in that
  file now pass).

60 tests pass across the group + community delete suites; `tsc --noEmit` clean.

---

## 10. Issues 54 + 55 — the pinned location banner · the dead friend-request tap

**Date:** 2026-08-12 · **Branch:** `rajesh-dev`

Both defects are web-client only. The full write-up, with file:line for every
change, is in `aimess_website/QA_FIXES_WEBSITE.md`; this section records what
the backend was asked for and what it actually needed.

### Issue 54 — pinned banner shows "Pinned message" for a location

**No backend change.** `getActivePinSummary`
(`apps/chat-service/src/services/community-pin.service.ts:430`) already returns
`messageType: "LOCATION"` with `text: ""` — correct, since a location message
has no body text — and `message-preview.service.ts` already renders
`📍 <placeName>` for the inbox preview. The web client derived the banner text
from three hand-rolled content-type ladders, none of which had a `LOCATION`
rung, and fell through to its generic fallback string. Fixed client-side by
collapsing all three onto the existing `replyLabelFromMessage` /
`replyTypeLabel` helpers.

### Issue 55 — tapping a friend-request push opened nothing

**One documentation change; the payload was already right.**

`friend.requested` is the only notification whose navigation names a peer rather
than a room, because the DM does not exist until the request is accepted:

- `apps/notifications-service/src/consumers/friend.consumer.ts:52-60` —
  `{ screen: "PRIVATE_CHAT", userId: requesterId, conversationType:
"PRIVATE_PENDING", requestId }`, with `deepLink: aimess://user/<requesterId>`.

`NotificationNavigation.roomId` is optional and `userId` is documented as the
subject user for friend events, so this is contract-valid. Every web consumer of
`PRIVATE_CHAT` nonetheless read `roomId` and only `roomId`, resolved to `null`,
and dropped the tap — the foreground toast focused the window and did nothing,
the service worker landed on `/`.

Rather than synthesise a room id at publish time (which would force a
`GetOrCreatePrivateRooms` call for every pending request that may never be
accepted), the contract now states the client obligation explicitly:

- `packages/shared-types/src/events/community.ts` — `NotificationNavigation.roomId`
  documents that `PRIVATE_CHAT` may arrive with `userId` alone and that clients
  MUST fall back to it, since every platform's DM route get-or-creates the room
  from a peer id.

`group.consumer.ts` is unaffected — `GROUP_CHAT` navigation always carries
`roomId`.

**Mobile.** iOS and Android ship the same `NotificationRouter` shape and need
the same fallback plus an `aimess://user/:id` deep-link case. No server payload
changes, so nothing regresses while they catch up; the tap stays inert on those
clients until then.

### Tests

Comment-only backend change, so no new backend suite. Client side:
`aimess_website/scripts/check-firebase-sw.mjs` gained a case that drives the
service worker's real `notificationclick` handler with `userId`-only navigation
(6/6 pass, fails against the old worker); `tsc --noEmit` and `eslint` clean in
both repositories.
