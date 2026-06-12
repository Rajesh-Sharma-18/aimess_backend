# chat-service — Security & Correctness Audit

Findings discovered while reading the real source for the test pass. Every item
cites a `file:line`. Ordered by severity. Test suite is **212/212 green**; these
are gaps the green suite does not (and mostly cannot, with mocked deps) catch.

Legend — Type: `Security` (authz/IDOR/exposure), `MissingValidation`, `Bug`,
`DataIntegrity`, `Inconsistency`.

---

## HIGH

### H1 — Unauthenticated debug route leaks user identity + wipes cache

- Type: Security
- Endpoint: `GET /debug/snapshot/:userId`
- File: `src/api/routes/health.routes.ts:25-52`
- Detail: Mounted on `/` with **no `authenticate`**. The file itself says
  "DEBUG ONLY — remove before production." For any `userId` it deletes the Redis
  snapshot cache (`redis.del`), re-fetches from user-service + auth-service, and
  returns `displayName/username/account`. Anonymous user enumeration +
  cache-poisoning/DoS vector (forces a gRPC fan-out per call).
- Recommendation: Delete the route (or gate behind `authenticate` + an internal
  network/feature flag) before any non-dev deploy.

### H2 — Message read endpoints not gated on membership/participation

- Type: Security (IDOR — confidential message history)
- Endpoints: `GET /private/rooms/:roomId/messages`, `.../messages/search`,
  `GET /groups/:roomId/messages`, `.../messages/search`,
  `GET /community/rooms/:roomId/messages` (before_ts/latest history mode),
  `.../messages/search`
- Files:
  - private: `src/services/private-message.service.ts:154-172,179-210,216-244,271-286`
    (only `findByRoomId` existence check; **no** `participants.includes(userId)`).
  - group: `src/services/group-message.service.ts:189-237,363-373` — comment at
    `:208-210` explicitly states "no membership gate".
  - community: `src/services/community-message.service.ts:408-465,659-672` — the
    `before_ts`/latest list and `searchMessages` take a `userId` but never check
    `memberRepo.findByRoomAndUser`. Only `getMessagesSince` (after_ts),
    `getConversation`, `listMedia` do.
- Detail: Participation is enforced inconsistently. `listMedia` (private/group/
  community), `getConversation`, community `after_ts`/sync all gate; the plain
  timeline + search reads do not. A user who learns a `roomId` (room IDs leak
  via inbox bumps, forwards, invite previews) can page another conversation's
  full text history and search it.
- Recommendation: Add the same participation/active-member check used by
  `listMedia`/`getConversation` to every timeline + search read path; centralize
  it so it can't drift per endpoint.

### H3 — `addMember` does not authorize the actor

- Type: Security (broken access control)
- Endpoint: `POST /api/chat/group-members/add`
- File: `src/services/group-member.service.ts:21-69` (no check that
  `invitedBy`/actor is a member, let alone OWNER/ADMIN); controller passes
  `invitedBy: actorId` at `src/api/controllers/group-member.controller.ts:12-21`.
- Detail: Any authenticated user can add **any** userId to **any** group (subject
  only to existence + member-limit + already-member). Contrast `kick`/`updateRole`
  which do verify actor role. Lets an outsider inject themselves or others into a
  private group.
- Recommendation: Load the actor's active membership and require OWNER/ADMIN (or
  MODERATOR per policy) before `upsert`; mirror the `kick` guard.

### H4 — Invite-link listing exposes live join tokens to any authed user

- Type: Security (IDOR / sensitive-data exposure)
- Endpoint: `GET /api/chat/invite-links/room/:roomId`
- Files: `src/api/controllers/group-invite-link.controller.ts:49-62` (never reads
  `req.auth`), `src/services/group-invite-link.service.ts:136-142`
  (`getActiveLinks` takes only `roomId`).
- Detail: Returns every active invite token for an arbitrary `roomId` with no
  membership/role check. Since tokens grant group entry (`POST /invite-links/join`
  needs only the token), this lets any user enumerate and join groups they were
  never invited to.
- Recommendation: Require the caller to be an active OWNER/ADMIN of `roomId`
  before listing; consider not returning raw tokens in bulk at all.

### H5 — Community "leave" sets status to `active` instead of `left` (no-op leave)

- Type: Bug / DataIntegrity
- Endpoint: `POST /api/chat/community/rooms/:roomId/leave`
- File: `src/services/community-room.service.ts:60-65`
- Detail: `this.memberRepo.updateStatus(roomId, userId, "active", { leftAt })` —
  the 3rd arg is the **new status** (see `repositories/room-member.repository.ts:38-50`).
  It writes `status:"active"` while stamping `leftAt`, so the member stays
  ACTIVE. `incMemberNumber(-1)` still runs, so `memberNumber` drifts below the
  true active count. Compare the correct `markAllLeft` which uses `"left"`
  (`room-member.repository.ts:96-101`). Also no 404 when room/membership absent.
- Recommendation: Pass `"left"`. Add a not-a-member guard. Audit `memberNumber`
  for existing drift.

### H6 — Notification "mark read" is unscoped and unvalidated (IDOR)

- Type: Security (IDOR) + MissingValidation
- Endpoint: `POST /api/chat/notifications/read`
- Files: route `src/api/routes/notification.routes.ts:10` (**no `validateBody`**),
  controller `src/api/controllers/notification.controller.ts:34-38`
  (`const { notificationId } = req.body`), service
  `src/services/notification.service.ts:14-16` (`markRead(notificationId)` — no
  `userId`).
- Detail: `notificationId` is taken from the body with no schema and no caller
  scoping, then updated directly. A user can mark **another user's** notification
  read by guessing/observing an id. `getNotifications`/`markAllRead`/`unreadCount`
  are correctly scoped to `userId`, making this the outlier.
- Recommendation: Add `validateBody(markReadSchema)` (one already exists in
  `validators/notification.validator.ts:8-10`) and pass `userId` into
  `markRead`, scoping the repo update to `{ id, userId }`.

### H7 — Media download authorizes by key-prefix only (attachment IDOR)

- Type: Security (IDOR)
- Endpoint: `POST /api/chat/media/download-url`
- File: `src/api/controllers/media.controller.ts:82-117`
- Detail: The only check is `objectKey.startsWith("chat-uploads/")`
  (`:91-93`). The key embeds an `ownerId` (`buildObjectKey` at `:42-46`) but it
  is never compared to `req.auth.userId`, nor is any room-participation check
  done. Any authed user who learns/guesses an object key gets a presigned view
  URL to another user's chat attachment.
- Recommendation: Verify the caller owns the key (parse ownerId and compare) or
  is a participant of a room where the key appears, before presigning.

### H8 — `GET /calls/:callId` returns any call to any authed user

- Type: Security (IDOR / sensitive-data exposure)
- Endpoint: `GET /api/chat/calls/:callId`
- Files: controller `src/api/controllers/call.controller.ts:22-27`, service
  `src/services/call.service.ts:184-186` (`getCallByCallId` just
  `findByCallId`).
- Detail: No check that `req.auth.userId` is the caller or callee. Exposes
  callerId/calleeId/duration/timestamps/privateRoomId of arbitrary calls.
  `getCallHistory` correctly filters by participant (`:188-205`), and the
  lifecycle methods (`answer/decline/end`) all enforce participant — this read
  is the outlier.
- Recommendation: After fetch, 403/404 unless `userId ∈ {callerId, calleeId}`.

---

## MEDIUM

### M1 — Private message pin has no participation check

- Type: Security (broken access control)
- Endpoint: `POST /private/rooms/:roomId/messages/:messageId/pin`
- File: `src/services/private-pin.service.ts:20-63`
- Detail: `pin()` checks room existence, pin limit, and message existence, but
  **not** `room.participants.includes(userId)`. `unpin()` (`:65-89`) does check
  participation (`CHAT_NOT_A_PARTICIPANT`). So a non-participant can pin into a
  room (and trigger a `pin:updated` broadcast) they can't unpin from.
- Recommendation: Add the same participant guard to `pin()`.

### M2 — Group pin path has no membership check

- Type: Security (broken access control)
- Endpoint: `POST /groups/:roomId/messages/:messageId/pin`
- File: `src/api/controllers/group-message.controller.ts:303-330` → `GroupPinService.pin`
  (no member lookup; contrast community pin which requires active admin/moderator
  at `src/services/community-pin.service.ts:18-32`).
- Detail: No active-membership or role gate before pinning a group message and
  broadcasting. (The group `GroupPinService` was not shown to gate; verify and
  add a guard.) Community enforces admin/moderator; group does not.
- Recommendation: Require active membership (and decide on a role policy) for
  group pin/unpin, matching the community pin service.

### M3 — Community message DELETE: no query validation, deleteForMe unguarded

- Type: MissingValidation + Security
- Endpoint: `DELETE /api/chat/community/messages/:messageId?type=…`
- Files: route `src/api/routes/community.routes.ts:90-95` (**no `validateQuery`**),
  controller `src/api/controllers/community-message.controller.ts:257-288`
  (`type` read raw; anything ≠ `"forEveryone"` → `deleteForMe`), service
  `src/services/community-message.service.ts:848-857` (`deleteForMe` checks only
  message existence — **no membership, no ownership**).
- Detail: Unlike the private delete route (which has
  `validateQuery(deleteMessageQuerySchema)`), community delete accepts any/no
  `type`. `deleteForMe` lets any authed user soft-hide any community message id
  for themselves regardless of membership.
- Recommendation: Add a `validateQuery` enum for `type`; add active-membership
  check to `deleteForMe`.

### M4 — Community edit/react broadcast room comes from client body, not the message

- Type: Security (event spoofing) + DataIntegrity
- Endpoints: `PATCH /community/messages/:messageId`,
  `POST /community/messages/:messageId/react`
- Files: controller `src/api/controllers/community-message.controller.ts:174-217`
  (`communityId` from `req.body`, used as the `community:<communityId>` publish
  channel) and `:219-255`. Validators only require `communityId` non-empty
  (`validators/community.validator.ts:58-65,82-85`).
- Detail: Authorization is on message ownership/membership, but the **broadcast
  target** `communityId` is attacker-controlled and never reconciled against the
  message's real `roomId`. A user editing their own message can emit a
  `community:message:edited` into an unrelated community room (which clients in
  that room render), enabling cross-room content injection / confusion.
- Recommendation: Derive the broadcast `communityId` from the loaded message's
  `roomId`, not from the request body; drop `communityId` from the body or assert
  it equals `message.roomId`.

### M5 — Community room search has no query validation

- Type: MissingValidation
- Endpoint: `GET /api/chat/community/rooms/search`
- Files: route `src/api/routes/community.routes.ts:37` (no `validateQuery`),
  controller `src/api/controllers/community.controller.ts:27-40`
  (`const { query } = req.query` passed straight to `searchRooms(query)`).
- Detail: A missing `query` reaches the service as `undefined`; behaviour then
  depends on the repo's regex/`$text` handling (potential 500 or full-table
  scan). The `searchRoomsSchema` validator exists
  (`validators/community.validator.ts:94-96`) but is **not wired**.
- Recommendation: Add `validateQuery(searchRoomsSchema)`; enforce min/max length.

---

## LOW

### L1 — Inconsistent status code for "not a member" on group media

- Type: Inconsistency
- Endpoint: `GET /groups/:roomId/media`
- File: `src/services/group-message.service.ts:375-387` throws
  `BadRequestError` (**400**) for a non-member, whereas community/private media
  and group `getConversation` use `ForbiddenError` (**403**)
  (e.g. `private-message.service.ts:301`, `community-message.service.ts:694`,
  `group-message.service.ts:305`). Same for `deleteForMe`/`deleteMessage`
  not-a-member (`:418,:435` → 400).
- Recommendation: Standardize "not a member/participant" on 403 across the
  service.

### L2 — Presence and member-list reads have no relationship gate

- Type: Security (minor info exposure)
- Endpoints: `GET /private/presence/:userId`,
  `GET /group-members/:roomId`
- Files: `src/api/controllers/presence.controller.ts:11-20` (any authed user can
  query any user's online/last-seen), `src/api/controllers/group-member.controller.ts:56-76`
  (lists any group's members with no membership check).
- Recommendation: Gate presence behind a friendship/shared-room check and member
  listing behind room membership, per privacy requirements.

### L3 — Non-atomic reaction read-modify-write

- Type: DataIntegrity
- Endpoint: `POST /community/messages/:messageId/react`
- File: `src/services/community-message.service.ts:755-806` (the code comments
  "NOTE: non-atomic read-modify-write"). Concurrent reactions on the same
  message can lost-update.
- Recommendation: Use an atomic array/`$addToSet`/`$pull`-style update or an
  optimistic-concurrency guard.

### L4 — `getMessagesAround` swallows a missing room (community) vs throws (private/group)

- Type: Inconsistency
- Endpoint: `GET /community/rooms/:roomId/messages?around=…`
- File: `src/services/community-message.service.ts:574-594` returns `{ items: [] }`
  when the anchor is missing, while private/group throw 404
  (`private-message.service.ts:260-261`, `group-message.service.ts:276-277`).
- Recommendation: Pick one behaviour (404 is clearer) for parity.

### L5 — `reactToMessage` localized message reuses the wrong key

- Type: Inconsistency (minor UX)
- Endpoint: `POST /community/messages/:messageId/react`
- File: `src/api/controllers/community-message.controller.ts:252-254` returns
  `t("CHAT_MESSAGE_EDITED")` with a `// TODO: add CHAT_MESSAGE_REACTED` note.
- Recommendation: Add and use a `CHAT_MESSAGE_REACTED` catalog key.
