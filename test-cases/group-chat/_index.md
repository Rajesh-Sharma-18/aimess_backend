# Group Chat — Test Case Index

Module: **GROUP-CHAT** (chat-service group rooms). ID prefix `TC-GCHAT-NNN` (001–163).

**Source roots:**

- Routes: `apps/chat-service/src/api/routes/{group-room,group-member,group-message,group-invite-link}.routes.ts` (mounted in `routes/index.ts`, base `/api/chat`).
- Controllers / services / repositories: `apps/chat-service/src/api/controllers/group-*`, `services/group-*`, `repositories/group-*`.
- Socket contract: `docs/SOCKET_EVENTS.md` (`/chat` namespace).

## Files

| File                      | Area                                                                          | TC range |
| ------------------------- | ----------------------------------------------------------------------------- | -------- |
| `create-group.md`         | `POST /groups` — create, validation, rate limit                               | 001–013  |
| `update-group.md`         | `PATCH /groups/:roomId`, `GET /groups/:roomId`, `GET /groups/my-groups`       | 014–030  |
| `delete-group.md`         | `POST /groups/:roomId/disband`                                                | 031–039  |
| `members.md`              | add / leave / kick / list members                                             | 040–055  |
| `roles-permissions.md`    | `POST /group-members/role`, kick RBAC, full RBAC matrix                       | 056–071  |
| `moderation-mute-warn.md` | mute state, admin-delete; mute/warn/prefs/ban GAP assertions                  | 072–080  |
| `invite-links.md`         | create / revoke / preview / join / list                                       | 081–105  |
| `group-messages.md`       | send / edit / delete / forward / reactions / timeline / search / media / pins | 106–140  |
| `system-messages.md`      | lifecycle SYSTEM messages + catch-up                                          | 141–154  |
| `read-unread.md`          | unread increment, read pointer, message:read                                  | 155–163  |

**Total: 163 test cases.**

## Endpoints covered

Base path `/api/chat`.

**Groups** (`/groups`): `POST /`, `GET /my-groups`, `GET /:roomId`, `PATCH /:roomId`, `POST /:roomId/disband`.
**Group messages** (`/groups`): `GET /:roomId/messages/search`, `GET /:roomId/messages`, `GET /:roomId/conversation`, `GET /:roomId/media`, `POST /messages/delete`, `PATCH /messages/:messageId`, `GET /:roomId/pins`, `POST /:roomId/messages/:messageId/forward`, `GET /:roomId/messages/:messageId/reactions`.
**Group members** (`/group-members`): `POST /add`, `POST /:roomId/leave`, `POST /kick`, `POST /role`, `GET /:roomId`.
**Invite links** (`/invite-links`): `POST /`, `POST /revoke`, `GET /preview/:token` (public), `POST /join`, `GET /room/:roomId`.

**Socket (`/chat`) referenced:** `message:send`, `message:edit`(→`message:edited`), `message:react`(→`message:reaction`), `message:read`, `message:new` (incl. SYSTEM), `message:delete`, `conv:updated`, `chat:catchup`/`chat:catchup:result`.

## Coverage by category

Happy Path · Input Validation · Required/Optional Params · AuthN · RBAC · Business Rule · DB State · Error Handling · Edge Case · Rate Limit · File Upload\* · Pagination/Filter/Sort · Concurrency · Security — all represented. Heavy emphasis on RBAC (owner/admin/moderator/member matrices), Business Rules (member cap, last-owner-can't-leave, can't-kick-higher-role, promote-requires-admin), system-message generation per lifecycle action, and Security/IDOR.

\* **File Upload:** group avatar/media are passed as **object keys / URLs** in JSON payloads (`avatar` string on create/update; `files[].objectKey|url` on send) — there is **no multipart upload endpoint in chat-service group routes**. Actual binary upload is via the media service / MinIO presign flow (covered under the media/notifications modules). Avatar-as-string is covered in create-group/update-group; `mediaKey`/`files` send in group-messages.

---

## GAPS, AMBIGUITIES & RISKS (for reviewers)

### Security / RBAC gaps

1. **`addMember` has no RBAC or membership check on the inviter** (members.md TC-052). Any authenticated user can add arbitrary users to any active group (IDOR + privilege issue). The only gate is the group existing and not being full.
2. **Read endpoints lack a membership gate, inconsistently:** `GET /groups/:roomId` (TC-027), `GET /group-members/:roomId` (TC-053), `GET /groups/:roomId/messages` + `/search` + `/pins` + `/messages/:id/reactions` (TC-133), and `GET /invite-links/room/:roomId` (TC-103) return data to **any authenticated user** by roomId. In contrast `/conversation` and `/media` DO enforce active membership. This inconsistency leaks group metadata, member lists, message history, and **active invite tokens**.
3. **`getActiveLinks` leaks invite tokens** to non-members (TC-103) — combined with public `preview`/`join`, an outsider could enumerate and join.

### Business-rule gaps

4. **No ownership transfer flow.** Owner can't leave (`CHAT_OWNER_CANNOT_LEAVE`) and there's no transfer endpoint; the only escape is disband. `updateRole` can set a second `OWNER` (TC-057) with no single-owner invariant and without demoting the previous owner.
5. **No ban enforcement.** `GroupMemberStatus.BANNED` + `bannedAt/bannedBy` columns exist but no route writes them; a KICKED user can be freely re-added (TC-043, TC-079).
6. **Mute / warn / notification-prefs are NOT in group chat** (moderation-mute-warn.md). The `member-moderation` commit targets community-service. `GroupMember.notificationSettings` is read by the inbox but never written by any group route. `markReadSchema` + `GroupMemberService.markRead` exist but have **no HTTP route** (read-unread.md TC-161).
7. **Pin: list-only.** `GET /:roomId/pins` exists but no pin/unpin endpoint is wired in group routes; `MESSAGE_PINNED`/`MESSAGE_UNPINNED` system events are unused.

### Concurrency risks (non-atomic check-then-write)

8. **Member-cap race:** `memberCount >= memberLimit` check then `incMemberCount` is not atomic — group can exceed `memberLimit` under concurrent add / join-by-link (TC-055, TC-104).
9. **Single-use link race:** `usedCount >= maxUses` check then increment is not atomic — a `maxUses:1` link can admit 2+ joiners (TC-105).
10. **Double-decrement on concurrent kick** of the same member (no transactional status transition) can under-count `memberCount` (TC-054).

### Eventing / consistency gaps

11. **Disband emits nothing** — no `GROUP_DISBANDED` system message or socket event; members aren't notified in real time and their membership rows stay ACTIVE while the room is DISBANDED (delete-group.md TC-038), so membership-gated reads still pass the member check (room-active filters mostly cover this, but it's fragile).
12. **Forward idempotency double-fan-out:** the controller publishes `message:new` + `conv:updated` even when the service returns an existing (idempotent) forward (group-messages.md TC-124) — possible duplicate broadcasts.
13. **Unused `SystemEvent`s:** `ADMIN_ASSIGNED`, `ADMIN_REMOVED`, `INVITE_LINK_CREATED`, `CALL_STARTED/ENDED`, `MESSAGE_PINNED/UNPINNED`, `MESSAGES_ENCRYPTED` are defined but never posted in group chat.

### Ambiguities (assumed in cases, verify against intended spec)

- Error→HTTP-status mapping (e.g. `BadRequestError`→400, `NotFoundError`→404, `ConflictError`→409, `ForbiddenError`→403, `GoneError`→410) is assumed from the error classes; exact JSON error-body shape not asserted.
- `CHAT_EDIT_WINDOW_MS` / `CHAT_TEXT_MAX_CHARS` exact values are in `constants/media-limits.js` (not re-derived here).
- Group send / react / read are socket-only (no REST); their full payload contract lives in the websocket-events module — referenced, not duplicated.
