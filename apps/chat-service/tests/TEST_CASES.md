# chat-service — Test Cases

Endpoint-by-endpoint test catalogue for **chat-service** (MongoDB via Prisma 7,
layered routes → controllers → services → repositories). Every case is grounded
in the real route/validator/service code. Cases are tagged:

- **[E]** EXECUTED — a Jest test asserts this (212/212 green; see `tests/**`).
- **[D]** DOCUMENTED-ONLY — true of the code but not yet covered by a test.

## Conventions (verified in code)

- **Base path:** all business routes under `/api/chat/*`; health under `/`.
- **Auth:** `authenticate` = shared `@aimess/auth-jwt` verifier against
  `JWT_ACCESS_SECRET`. Populates `req.auth = { userId, sessionId }`. Missing /
  malformed / forged / expired token → **401**.
- **Success envelope** (`ApiResponse` from `@aimess/utils`):
  `{ success: true, message, data }`, Dates serialized to **epoch ms**.
- **Error envelope** (`src/middleware/error-handler.ts`): **NOT** the flat
  `{ success:false, message }`. It is
  `{ success:false, error:{ statusCode, code, message } }`. The rate-limiter is
  the one exception — it returns `{ success:false, message, retryAfterSec }`.
- **Status mapping:** Zod fail → 400; AppError carries its own status
  (`BadRequestError`→400, `ForbiddenError`→403, `NotFoundError`→404,
  `ConflictError`→409, `GoneError`→410); Prisma `P2023`→400, `P2025`→404,
  `P2002`→409; otherwise 500.
- **Rate limits** (Redis sliding window, fail-open if Redis down): pm:send 60/min,
  cm:send 30/min, gm:send 30/min, gr:create 10/day, inbox 120/min, sync 120/min,
  media upload 30/min, media download 120/min. Keyed by `userId` (or IP).

---

## 1. Health / debug (`/`)

### GET /health

- Desc: liveness probe; no auth, no controller.
- Positive: **[E]** 200 `{ success:true, service:"chat-service", timestamp }`.
- Edge: **[E]** unknown route → 404, app still boots.
- Status: 200.

### GET /debug/snapshot/:userId

- Desc: **DEBUG-ONLY** route (file says "remove before production"). Clears the
  Redis snapshot cache for `userId`, re-fetches from user-service + auth-service,
  returns raw snapshot. **No auth.**
- Security: **[D]** any anonymous caller can resolve any userId's display
  name/account and force a cache wipe (see AUDIT High-1). No test (intentionally
  not exercised; flagged for removal).
- Status: 200.

---

## 2. Private rooms (`/api/chat/private`)

### GET /conversations

- Auth required. Positive **[E]** enriched paginated list; **[E]** empty → 200
  empty data; Security **[E]** 401 without token.

### POST /rooms/:peerId (get-or-create; rate-limited pm:send)

- Positive **[E]** returns existing room; **[E]** creates when friends + none
  exists. Negative/Security **[E]** 403 when not friends
  (`CHAT_FRIENDSHIP_REQUIRED`). Security **[E]** 401 without token.

### DELETE /rooms/:roomId (delete-for-me)

- Positive **[E]** soft-deletes for caller. Negative **[E]** 404 unknown room.
  Security **[E]** IDOR — non-participant → 404 (participation enforced).

### POST /rooms/:roomId/mute (validateBody muteRoomSchema)

- Positive **[E]** valid ISO datetime; **[E]** `null` muteUntil (indefinite).
  Negative **[E]** 400 invalid datetime; **[E]** 404 muting a room not in.
  Edge **[D]** missing body `{}` accepted (muteUntil is nullish → indefinite).

### POST /rooms/:roomId/unmute

- Positive **[E]** 200. Security **[E]** 401 forged token.
  Negative **[D]** 404 unmuting a room the caller is not in.

### GET /presence/:userId

- Positive **[E]** online + lastSeen; **[E]** offline → false/null.
  Security **[E]** 401 missing/forged token.
- **[D]** No participation/friendship check — any authed user can probe any
  userId's online state (see AUDIT Low).

---

## 3. Private messages (`/api/chat/private`)

### GET /rooms/:roomId/messages (validateQuery messageTimelineQuerySchema)

- Positive **[E]** newest page, epoch-ms dates. Negative **[E]** 404 unknown
  room; **[E]** 400 when both before_ts & after_ts.
  Negative **[D]** 400 when both before_seq & after_seq; `around` window path;
  seq path. Security **[E]** 401 without token.
- **[D]** Room existence is checked but **participation is NOT** (see AUDIT
  High-2) — a non-participant who knows a roomId reads the timeline.

### GET /rooms/:roomId/messages/search (validateQuery messageSearchQuerySchema)

- Positive **[E]** matches for a query. Edge **[E]** empty `q` short-circuits
  (no repo call). **[D]** No participation check.

### GET /rooms/:roomId/media (validateQuery mediaListQuerySchema)

- Positive **[E]** lists media for a participant. Security **[E]** IDOR — 403
  for a non-participant (`CHAT_NOT_PARTICIPANT`). Negative **[E]** 400 invalid
  type enum. (Participation **is** enforced here.)

### PATCH /messages/:messageId (edit; validateBody editMessageSchema; pm:send)

- Positive **[E]** edits own TEXT within 15-min window → broadcasts
  `message:edited`. Security **[E]** 400 editing another user's message.
  Negative **[E]** 400 empty text; **[E]** 404 missing message.
  Edge **[D]** 400 non-TEXT message; **[D]** 410 (`GoneError`) past edit window.

### POST /messages/:messageId/report (validateBody reportMessageSchema; pm:send)

- Positive **[E]** reports another user's message → 201. Security **[E]** 400
  reporting own message; **[E]** 403 reporting in a room not part of.
  Negative **[E]** 400 invalid reason enum. Edge **[D]** 400 duplicate report
  (P2002 → `CHAT_ALREADY_REPORTED`).

### DELETE /messages/:messageId (validateQuery deleteMessageQuerySchema; pm:send)

- Positive **[E]** delete-for-me → tombstone publish. Security **[E]**
  forEveryone on someone else's → 400 (own-only). Negative **[E]** 404 missing;
  **[E]** 400 invalid type. Edge **[D]** already-deleted → 400.

### GET /rooms/:roomId/pins

- Positive **[E]** lists pins. **[D]** No participation check on list.

### POST /rooms/:roomId/messages/:messageId/pin (pm:send)

- Positive **[E]** 201 + `pin:updated` publish. Negative **[E]** 404 in a
  non-existent room. **[D]** **No participation check on pin** (see AUDIT
  Medium) — unlike unpin.

### DELETE /rooms/:roomId/messages/:messageId/pin (pm:send)

- Security **[E]** 400 unpin in a room you're not in (participation enforced).
  Edge **[D]** 400 unpinning a pin you didn't create (`CHAT_UNPIN_OWN_ONLY`).

### POST /rooms/:roomId/messages/:messageId/forward (validateBody; pm:send)

- Positive **[E]** forwards + emits `message:new`. Security **[E]** 403 when not
  friends with receiver. Negative **[E]** 400 missing targetRoomId.
  Edge **[D]** idempotent re-forward via clientMessageId; **[D]** 404 forwarding
  a deleted source.

### GET /rooms/:roomId/messages/:messageId/reactions

- Positive **[E]** grouped reactions + selfReacted. Negative **[E]** 404 when
  the message has no reactions record.

---

## 4. Group rooms (`/api/chat/groups`)

### POST / (create; validateBody createGroupSchema; gr:create 10/day)

- Positive **[E]** 201 room + OWNER member. Negative **[E]** 400 empty name;
  **[E]** 400 name > 100; **[E]** 400 memberLimit < 2.
  Security **[E]** mass-assignment — extra body fields stripped by Zod;
  **[E]** 401 without token.

### GET /my-groups

- Positive **[E]** caller's active groups. Edge **[E]** none → 200 empty.

### GET /:roomId

- Positive **[E]** isJoined=true for active member; **[E]** isJoined=false for a
  non-member viewer (any authed user may fetch detail by design). Negative
  **[E]** 404 unknown group.

### PATCH /:roomId (validateBody updateGroupSchema)

- Positive **[E]** OWNER updates name. Security **[E]** 400 plain MEMBER update
  (`CHAT_ONLY_OWNER_ADMIN_UPDATE`). Negative **[E]** 404 non-member;
  **[E]** 400 invalid memberLimit type.

### POST /:roomId/disband

- Positive **[E]** OWNER disbands. Security **[E]** 400 non-owner (ADMIN);
  **[E]** 401 forged token. Negative **[D]** 404 non-member.

---

## 5. Group messages (`/api/chat/groups`)

### GET /:roomId/messages (validateQuery messageTimelineQuerySchema)

- Positive **[E]** page returned (**explicitly no membership gate**). Negative
  **[E]** 400 both before_ts & after_ts; **[E]** 400 both before_seq & after_seq.
  Security **[E]** 401 without token.
- **[D]** Non-member reads any group's history if roomId known (see AUDIT
  High-2; visibility documented as intentional in source, but unverified vs
  community/private which DO gate).

### GET /:roomId/conversation (validateQuery conversationQuerySchema)

- Positive **[E]** active member gets offset page (+ advances read pointer).
  Security **[E]** 403 non-member. Negative **[E]** 400 pageNumber < 1.

### GET /:roomId/media (validateQuery mediaListQuerySchema)

- Positive **[E]** active member gets media. Security **[E]** **400** non-member
  (note: `BadRequestError`, not 403 — see AUDIT Low inconsistency).

### POST /messages/delete (validateBody deleteGroupMessageSchema; gm:send)

- Positive **[E]** delete own → tombstone publish; **[E]** ADMIN deletes
  another's. Security **[E]** 400 plain MEMBER deletes another's. Negative
  **[E]** 404 missing; **[E]** 400 missing messageId.

### PATCH /messages/:messageId (validateBody editGroupMessageSchema; gm:send)

- Positive **[E]** edit own TEXT in window. Security **[E]** 400 editing a
  non-TEXT message. Negative **[E]** 400 empty text. Edge **[D]** 410 past
  window; **[D]** 400 editing another's.

### GET /:roomId/pins / POST .../pin / DELETE .../pin

- Positive **[E]** pin returns 201 + `pin:updated`; **[E]** lists pins.
  **[D]** No membership check in `GroupPinService.pin` path (see AUDIT Medium).

### POST /:roomId/messages/:messageId/forward (validateBody; gm:send)

- Positive **[E]** emits `message:new`. Security **[E]** 403 forwarding into a
  room not a member of. Negative **[E]** 400 targetRoomId too short.

### GET /:roomId/messages/:messageId/reactions

- Positive **[E]** grouped result. Negative **[E]** 404 missing message.

### GET /:roomId/messages/search

- **[D]** Search path takes no userId — no membership gate (see AUDIT High-2).

---

## 6. Group members (`/api/chat/group-members`)

### POST /add (validateBody addMemberSchema)

- Positive **[E]** adds member to a non-full group. Negative **[E]** 404 unknown
  group; **[E]** 400 at member limit; **[E]** 409 already-active member;
  **[E]** 400 missing userId.
- **[D]** Service does **NOT verify the actor (invitedBy) is a member/admin** of
  the room — any authed user can add anyone to any group (see AUDIT High-3).

### POST /:roomId/leave

- Positive **[E]** non-owner leaves. Negative **[E]** 400 OWNER cannot leave;
  **[E]** 404 not a member.

### POST /kick (validateBody kickMemberSchema)

- Positive **[E]** ADMIN kicks MEMBER. Security **[E]** 400 MEMBER lacks
  permission; **[E]** 400 kicking equal-or-higher role.

### POST /role (validateBody updateRoleSchema)

- Positive **[E]** OWNER promotes to ADMIN. Security **[E]** 400 ADMIN granting
  OWNER/ADMIN. Negative **[E]** 400 invalid role enum.

### GET /:roomId (list members)

- Positive **[E]** paginated active members. Security **[E]** 401 without token.
- **[D]** Any authed user can list any group's members (no membership check;
  see AUDIT Low).

---

## 7. Group invite links (`/api/chat/invite-links`)

### POST / (validateBody createInviteLinkSchema)

- Positive **[E]** admin/owner creates. Security **[E]** 400 plain MEMBER when
  the group forbids member links. Negative **[E]** 404 unknown group;
  **[E]** 400 missing roomId.

### POST /revoke (validateBody revokeInviteLinkSchema)

- Positive **[E]** owner revokes. Negative **[E]** 404 unknown token;
  **[E]** 400 too-short token. Security **[E]** 400 non-admin revoke.

### GET /preview/:token (PUBLIC — no auth)

- Positive **[E]** group preview without auth. Negative **[E]** 404
  unknown/revoked; **[E]** 400 expired link. Edge **[D]** 400 usage-limit
  reached.

### POST /join (validateBody joinByInviteLinkSchema)

- Positive **[E]** joins via valid link. Edge **[E]** 400 usage-limit reached.
  Negative **[E]** 404 unknown token. Security **[E]** 401 without token.

### GET /room/:roomId (list active links)

- Positive **[E]** lists active links. Security **[E]** 401 without token.
- **[D]** **No membership/role check** — any authed user lists a room's live
  join tokens → can join private groups (see AUDIT High-4).

---

## 8. Community rooms (`/api/chat/community`)

### GET /rooms (PUBLIC — no auth)

- Positive **[E]** anonymous list of active rooms; **[E]** bearer token ignored
  (no auth middleware) so no `hasUnread`. Edge **[E]** empty → 200 empty.

### GET /rooms/search (PUBLIC — no auth)

- Positive **[E]** search hits.
- **[D]** `query` read straight from `req.query` with **no validateQuery** — an
  absent `query` reaches the service as `undefined` (see AUDIT Medium).

### POST /rooms/:roomId/join

- Positive **[E]** joins a room not banned from. Negative **[E]** 404 unknown
  room. Security **[E]** 400 banned; **[E]** 401 without token.

### POST /rooms/:roomId/leave

- Positive **[E]** "leaves" a room (200). Security **[E]** 401 forged token.
- **[D]** **BUG:** service calls `updateStatus(...,"active",...)` — status is set
  to `active`, not `left`. Leave does not remove the member (see AUDIT High-5).
  No 404 when room/membership absent.

---

## 9. Community messages (`/api/chat/community`)

### GET /rooms/:roomId/messages (validateQuery communityTimelineQuerySchema)

- Positive **[E]** latest page (UPPER `contentType` wire shape); **[E]**
  `after_ts` → incremental-sync mode. Security **[E]** 403 incremental-sync for
  a non-member (`CHAT_NOT_A_MEMBER`). Negative **[E]** 400 both before_ts &
  after_ts; **[E]** 401 without token.
- **[D]** History/scroll mode (`before_ts`/latest) is **NOT membership-gated**;
  only the `after_ts`/sync path checks membership (see AUDIT High-2).

### GET /rooms/:roomId/sync (validateQuery communitySyncQuerySchema)

- Positive **[E]** messages since cursor for active member. Negative **[E]** 400
  missing required since_ts. Security **[E]** 403 non-member.

### GET /rooms/:roomId/conversation (validateQuery conversationQuerySchema)

- Positive **[E]** active member page. Security **[E]** 403 non-member;
  **[E]** 403 banned (non-active) member.

### GET /rooms/:roomId/media (validateQuery mediaListQuerySchema)

- Positive **[E]** active member media. Security **[E]** 403 non-member.

### GET /rooms/:roomId/messages/search (validateQuery messageSearchQuerySchema)

- **[D]** Service `searchMessages` does **not** check membership (see AUDIT
  High-2).

### DELETE /messages/:messageId (cm:send) — `?type=forMe|forEveryone`

- Positive **[E]** forEveryone on own message + broadcast. Security **[E]** 400
  forEveryone on another's without a mod role. Negative **[E]** 404 missing.
- **[D]** **No `validateQuery`** on `type` (defaults to forMe). `deleteForMe`
  does **no membership/ownership check** — any authed user can soft-hide any
  community message id for themselves (see AUDIT Medium).

### PATCH /messages/:messageId (validateBody editCommunityMessageSchema; cm:send)

- Positive **[E]** edit own text + broadcast. Security **[E]** 400 editing
  another's. Negative **[E]** 400 missing communityId; **[E]** 400 empty text.
- **[D]** `communityId` from **body** drives the broadcast room, decoupled from
  the message's real `roomId` (see AUDIT Medium — broadcast spoofing).

### POST /messages/:messageId/react (validateBody reactCommunityMessageBodySchema)

- Positive **[E]** toggles reaction for active member. Security **[E]** 403
  non-member. Negative **[E]** 400 missing emoji.
- **[D]** Reaction read-modify-write is non-atomic (source-noted; see AUDIT Low).

### POST /rooms/:roomId/pins & POST .../messages/:messageId/pin (cm:send)

- Positive **[E]** moderator pins + broadcast. Security **[E]** 403 plain member.
  Negative **[E]** 404 pinning when not a member.

### DELETE /rooms/:roomId/pins/:messageId (validateQuery) & DELETE .../pin (validateBody)

- Negative **[E]** 400 unpin missing required body messageId.

### GET /rooms/:roomId/pins

- Positive **[E]** lists pins for a room (any authed user — no membership gate;
  **[D]**).

---

## 10. Inbox / Sync / Notifications / Media / Calls

### GET /api/chat/inbox (validateQuery inboxQuerySchema; inbox 120/min)

- Positive **[E]** merged private+group newest-first. Edge **[E]** both empty;
  **[E]** after_ts → oldest-first. Negative **[E]** 400 both before_ts &
  after_ts; **[E]** 400 limit > 100; **[E]** 400 non-numeric before_ts.
  Security **[E]** 401 missing/forged token.

### GET /api/chat/sync (validateQuery syncQuerySchema; sync 120/min)

- Positive **[E]** private path → events + next_seq + conversationType=PRIVATE;
  **[E]** type=group skips private probe. Security/Negative **[E]** 403 when
  participant of neither; **[E]** IDOR — non-participant of a private room → 403,
  never the data. Negative **[E]** 400 missing conv_id; **[E]** 400 invalid type
  enum; **[E]** 400 limit > 200. Security **[E]** 401 missing/forged token.

### Notifications (`/api/chat/notifications`)

- GET / : Positive **[E]** paginated, forwards userId; Edge **[E]** empty;
  **[E]** custom limit/page. Security **[E]** 401 missing/forged/expired/malformed.
- POST /read : Positive **[E]** marks read, returns updated row. Security
  **[E]** 401 without token.
  **[D]** **No `validateBody`**, and `markRead(notificationId)` is **not scoped
  to the caller** — IDOR: mark anyone's notification read (see AUDIT High-6).
- POST /read-all : Positive **[E]** marks all for caller → 200 null. Security
  **[E]** 401.
- GET /unread-count : Positive **[E]** count for caller. Security **[E]** 401.

### Media (`/api/chat/media`)

- POST /upload-url (upload 30/min): Positive **[E]** presigned url + objectKey
  for allowed mime. Negative **[E]** 400 disallowed content type; **[E]** 400
  missing filename; **[E]** 400 filename > 255. Security **[E]** 401
  missing/forged.
- POST /download-url (download 120/min): Positive **[E]** presigned view url for
  a key under `chat-uploads/`. Security **[E]** 400 rejects a key outside the
  prefix (path-escape). Negative **[E]** 400 missing objectKey. Security **[E]**
  401 without token.
  **[D]** Prefix-only check — **no per-user/per-room ownership** of the key (see
  AUDIT High-7, IDOR on attachments).

### Calls (`/api/chat/calls`)

- GET / (validateQuery callHistoryQuerySchema): Positive **[E]** hasMore +
  nextCursor; Edge **[E]** more rows than limit. Negative **[E]** 400 limit > 50.
  Security **[E]** 401 without token.
- GET /:callId : Positive **[E]** returns the call when found. Negative **[E]**
  404 when not found. Security **[E]** 401 forged token.
  **[D]** `getCallByCallId` returns the call with **no caller/callee
  authorization** — any authed user can fetch any call by id (see AUDIT High-8,
  IDOR / sensitive-data exposure).

---

## Uncovered areas (documented-only, no executed test)

See `AUDIT.md` for severity. High-level uncovered surface:

1. `GET /debug/snapshot/:userId` (debug route) — not exercised.
2. Private/group send + react + markRead + catchup happen over **gRPC/socket**,
   not REST — outside this REST suite entirely.
3. Edit window expiry (410 GoneError) on all three edit endpoints.
4. Duplicate-report conflict (P2002 → 400) on private report.
5. `around`/seq cursor branches on private & group message lists.
6. Community `before_ts` history mode membership behaviour, and community
   `searchMessages` / `deleteForMe` membership behaviour.
7. Call authorization (getCallById), media key ownership, notification read
   IDOR, invite-link list authorization — all the IDOR findings below are
   documented from code, none have a failing test pinning the gap.
