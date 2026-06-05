# Group Chat — Invite Links

**Source:** `apps/chat-service/src/api/routes/group-invite-link.routes.ts` · `controllers/group-invite-link.controller.ts` · `services/group-invite-link.service.ts` · `validators/group-invite-link.validator.ts` · `repositories/group-invite-link.repository.ts`

**Endpoints (base `/api/chat/invite-links`):**

- `POST /` — create link `{ roomId, expiresAt?, maxUses?, shareName? }` (auth)
- `POST /revoke` — revoke `{ token }` (auth, OWNER/ADMIN)
- `GET /preview/:token` — **public, no auth** — preview group before joining
- `POST /join` — join via `{ token }` (auth)
- `GET /room/:roomId` — list active links (auth, paginated)

**Validation:** create — `roomId` 5–100; `expiresAt` ISO datetime nullish; `maxUses` positive int nullish; `shareName` ≤200. revoke/join — `token` 10–100. `token` generated as `nanoid(24)`.

**Rules:**

- Create: caller must be ACTIVE member; if `room.settings.allowMemberInviteLink` is falsy AND caller role is `MEMBER` → `CHAT_MEMBERS_CANNOT_CREATE_LINKS`. (OWNER/ADMIN/MODERATOR bypass that flag.)
- Revoke: caller must be ACTIVE member with role `{OWNER, ADMIN}`.
- Join/preview: link must exist, not expired (`expiresAt`), not over `maxUses` (`usedCount >= maxUses`); room must be active.
- Join → `MEMBER_JOINED` system message (actor = joining user); increments `usedCount`.

---

### TC-GCHAT-081 — Owner creates an invite link

| Field                     | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                                                       |
| **API/Event Name**        | `POST /api/chat/invite-links`                                                                   |
| **Test Scenario**         | Happy path — owner creates a link                                                               |
| **Category**              | Happy Path                                                                                      |
| **Priority**              | High                                                                                            |
| **Preconditions**         | Caller OWNER of active group                                                                    |
| **Request Payload**       | `{ "roomId":"grp_x", "shareName":"Join us", "maxUses":100 }`                                    |
| **Expected Response**     | `201` link `{ token (24 chars), roomId, createdBy, maxUses:100, usedCount:0, status:"ACTIVE" }` |
| **Expected DB Changes**   | New `GroupInviteLink` row                                                                       |
| **Expected Socket/Event** | None                                                                                            |
| **Notes**                 | `expiresAt`/`maxUses` default null; `shareName` default "".                                     |

### TC-GCHAT-082 — Admin creates a link with expiry

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                      |
| **API/Event Name**        | `POST /api/chat/invite-links`                                  |
| **Test Scenario**         | Link with future `expiresAt`                                   |
| **Category**              | Optional Params                                                |
| **Priority**              | Medium                                                         |
| **Preconditions**         | Caller ADMIN                                                   |
| **Request Payload**       | `{ "roomId":"grp_x", "expiresAt":"2030-01-01T00:00:00.000Z" }` |
| **Expected Response**     | `201` link with `expiresAt`                                    |
| **Expected DB Changes**   | New link with expiry                                           |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | —                                                              |

### TC-GCHAT-083 — Member creates link when `allowMemberInviteLink` enabled

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                           |
| **API/Event Name**        | `POST /api/chat/invite-links`                                       |
| **Test Scenario**         | Plain member allowed to create                                      |
| **Category**              | RBAC                                                                |
| **Priority**              | Medium                                                              |
| **Preconditions**         | Caller MEMBER; `room.settings.allowMemberInviteLink=true` (default) |
| **Request Payload**       | `{ "roomId":"grp_x" }`                                              |
| **Expected Response**     | `201` link created                                                  |
| **Expected DB Changes**   | New link                                                            |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | Default settings allow member links.                                |

### TC-GCHAT-084 — Member blocked when `allowMemberInviteLink` disabled

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                      |
| **API/Event Name**        | `POST /api/chat/invite-links`                                  |
| **Test Scenario**         | Member create blocked by settings                              |
| **Category**              | RBAC                                                           |
| **Priority**              | High                                                           |
| **Preconditions**         | Caller MEMBER; `settings.allowMemberInviteLink=false`          |
| **Request Payload**       | `{ "roomId":"grp_x" }`                                         |
| **Expected Response**     | `400` `CHAT_MEMBERS_CANNOT_CREATE_LINKS`                       |
| **Expected DB Changes**   | None                                                           |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | Only the `MEMBER` role is gated; OWNER/ADMIN/MODERATOR bypass. |

### TC-GCHAT-085 — Non-member cannot create a link

| Field                     | Value                         |
| ------------------------- | ----------------------------- |
| **Feature/Module**        | Group Chat / Invite Links     |
| **API/Event Name**        | `POST /api/chat/invite-links` |
| **Test Scenario**         | Outsider creates a link       |
| **Category**              | Security                      |
| **Priority**              | High                          |
| **Preconditions**         | Caller not a member           |
| **Request Payload**       | `{ "roomId":"grp_x" }`        |
| **Expected Response**     | `400` `CHAT_NOT_A_MEMBER`     |
| **Expected DB Changes**   | None                          |
| **Expected Socket/Event** | None                          |
| **Notes**                 | —                             |

### TC-GCHAT-086 — Create link for non-existent group

| Field                     | Value                         |
| ------------------------- | ----------------------------- |
| **Feature/Module**        | Group Chat / Invite Links     |
| **API/Event Name**        | `POST /api/chat/invite-links` |
| **Test Scenario**         | roomId unknown/disbanded      |
| **Category**              | Error Handling                |
| **Priority**              | Medium                        |
| **Preconditions**         | Authenticated                 |
| **Request Payload**       | `{ "roomId":"grp_unknown" }`  |
| **Expected Response**     | `404` `CHAT_GROUP_NOT_FOUND`  |
| **Expected DB Changes**   | None                          |
| **Expected Socket/Event** | None                          |
| **Notes**                 | —                             |

### TC-GCHAT-087 — Preview link (public, no auth)

| Field                     | Value                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                                                     |
| **API/Event Name**        | `GET /api/chat/invite-links/preview/:token`                                                   |
| **Test Scenario**         | Anonymous user previews group before joining                                                  |
| **Category**              | Happy Path                                                                                    |
| **Priority**              | High                                                                                          |
| **Preconditions**         | Active link + active room                                                                     |
| **Request Payload**       | path `:token`                                                                                 |
| **Expected Response**     | `200` `{ token, groupId, groupName, groupAvatar, description, memberCount, memberLimit }`     |
| **Expected DB Changes**   | None                                                                                          |
| **Expected Socket/Event** | None                                                                                          |
| **Notes**                 | **No `authenticate`** on this route — intentionally public. Confirm no sensitive fields leak. |

### TC-GCHAT-088 — Preview expired link

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                   |
| **API/Event Name**        | `GET /api/chat/invite-links/preview/:token` |
| **Test Scenario**         | `expiresAt` in the past                     |
| **Category**              | Business Rule                               |
| **Priority**              | Medium                                      |
| **Preconditions**         | Link with past `expiresAt`                  |
| **Request Payload**       | —                                           |
| **Expected Response**     | `400` `CHAT_INVITE_LINK_EXPIRED`            |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | —                                           |

### TC-GCHAT-089 — Preview link past max uses

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                   |
| **API/Event Name**        | `GET /api/chat/invite-links/preview/:token` |
| **Test Scenario**         | `usedCount >= maxUses`                      |
| **Category**              | Business Rule                               |
| **Priority**              | Medium                                      |
| **Preconditions**         | Link with `maxUses=1`, `usedCount=1`        |
| **Request Payload**       | —                                           |
| **Expected Response**     | `400` `CHAT_INVITE_LINK_USAGE_LIMIT`        |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | —                                           |

### TC-GCHAT-090 — Preview unknown / revoked token

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                   |
| **API/Event Name**        | `GET /api/chat/invite-links/preview/:token` |
| **Test Scenario**         | Token not found / revoked                   |
| **Category**              | Error Handling                              |
| **Priority**              | Medium                                      |
| **Preconditions**         | Token absent or REVOKED                     |
| **Request Payload**       | —                                           |
| **Expected Response**     | `404` `CHAT_INVITE_LINK_NOT_FOUND`          |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | `findActiveByToken` excludes revoked.       |

### TC-GCHAT-091 — Join via valid link

| Field                     | Value                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                                                                                           |
| **API/Event Name**        | `POST /api/chat/invite-links/join`                                                                                                  |
| **Test Scenario**         | New user joins via link                                                                                                             |
| **Category**              | Happy Path                                                                                                                          |
| **Priority**              | High                                                                                                                                |
| **Preconditions**         | Active link; caller not yet a member; group under cap                                                                               |
| **Request Payload**       | `{ "token":"<24chars>" }`                                                                                                           |
| **Expected Response**     | `200` `{ room }`                                                                                                                    |
| **Expected DB Changes**   | New ACTIVE `GroupMember` (`role:"MEMBER"`, `invitedBy=link.createdBy`); `memberCount`+1; link `usedCount`+1; SYSTEM `MEMBER_JOINED` |
| **Expected Socket/Event** | `message:new` on `conv:<roomId>`, `systemEvent:"MEMBER_JOINED"`, `systemData:{ actorId(joiner), actorName }`                        |
| **Notes**                 | Join attributes the system message to the joiner (not the link creator).                                                            |

### TC-GCHAT-092 — Join via expired link

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links          |
| **API/Event Name**        | `POST /api/chat/invite-links/join` |
| **Test Scenario**         | expired link                       |
| **Category**              | Business Rule                      |
| **Priority**              | Medium                             |
| **Preconditions**         | Link `expiresAt` past              |
| **Request Payload**       | `{ "token":"…" }`                  |
| **Expected Response**     | `400` `CHAT_INVITE_LINK_EXPIRED`   |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | —                                  |

### TC-GCHAT-093 — Join via link at max uses

| Field                     | Value                                |
| ------------------------- | ------------------------------------ |
| **Feature/Module**        | Group Chat / Invite Links            |
| **API/Event Name**        | `POST /api/chat/invite-links/join`   |
| **Test Scenario**         | usedCount at maxUses                 |
| **Category**              | Business Rule                        |
| **Priority**              | Medium                               |
| **Preconditions**         | `maxUses=1`, `usedCount=1`           |
| **Request Payload**       | `{ "token":"…" }`                    |
| **Expected Response**     | `400` `CHAT_INVITE_LINK_USAGE_LIMIT` |
| **Expected DB Changes**   | None                                 |
| **Expected Socket/Event** | None                                 |
| **Notes**                 | —                                    |

### TC-GCHAT-094 — Join when already a member

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                             |
| **API/Event Name**        | `POST /api/chat/invite-links/join`                                    |
| **Test Scenario**         | Existing active member re-joins via link                              |
| **Category**              | Edge Case                                                             |
| **Priority**              | Medium                                                                |
| **Preconditions**         | Caller already ACTIVE member                                          |
| **Request Payload**       | `{ "token":"…" }`                                                     |
| **Expected Response**     | `409` `CHAT_ALREADY_MEMBER` (bubbles from `addMember`)                |
| **Expected DB Changes**   | None; `usedCount` NOT incremented (addMember throws before increment) |
| **Expected Socket/Event** | None                                                                  |
| **Notes**                 | Confirm `usedCount` not wasted on an already-member join.             |

### TC-GCHAT-095 — Join when group is full

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links               |
| **API/Event Name**        | `POST /api/chat/invite-links/join`      |
| **Test Scenario**         | memberCount == memberLimit              |
| **Category**              | Business Rule                           |
| **Priority**              | High                                    |
| **Preconditions**         | Group at capacity; valid link           |
| **Request Payload**       | `{ "token":"…" }`                       |
| **Expected Response**     | `400` `CHAT_GROUP_MEMBER_LIMIT_REACHED` |
| **Expected DB Changes**   | None                                    |
| **Expected Socket/Event** | None                                    |
| **Notes**                 | Cap enforced inside `addMember`.        |

### TC-GCHAT-096 — Join unknown / revoked token

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links          |
| **API/Event Name**        | `POST /api/chat/invite-links/join` |
| **Test Scenario**         | Token not active                   |
| **Category**              | Error Handling                     |
| **Priority**              | Medium                             |
| **Preconditions**         | Token revoked/absent               |
| **Request Payload**       | `{ "token":"…" }`                  |
| **Expected Response**     | `404` `CHAT_INVITE_LINK_NOT_FOUND` |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | —                                  |

### TC-GCHAT-097 — Owner revokes a link

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                               |
| **API/Event Name**        | `POST /api/chat/invite-links/revoke`                    |
| **Test Scenario**         | Owner revokes                                           |
| **Category**              | Happy Path                                              |
| **Priority**              | High                                                    |
| **Preconditions**         | Caller OWNER; active link                               |
| **Request Payload**       | `{ "token":"…" }`                                       |
| **Expected Response**     | `200` revoked link (`status:"REVOKED"`)                 |
| **Expected DB Changes**   | `GroupInviteLink.status="REVOKED"`, `revokedBy` set     |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | Subsequent join/preview → `CHAT_INVITE_LINK_NOT_FOUND`. |

### TC-GCHAT-098 — Member cannot revoke a link

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                             |
| **API/Event Name**        | `POST /api/chat/invite-links/revoke`                  |
| **Test Scenario**         | Plain member / moderator revoke                       |
| **Category**              | RBAC                                                  |
| **Priority**              | High                                                  |
| **Preconditions**         | Caller MEMBER or MODERATOR                            |
| **Request Payload**       | `{ "token":"…" }`                                     |
| **Expected Response**     | `400` `CHAT_INSUFFICIENT_PERMISSIONS`                 |
| **Expected DB Changes**   | None                                                  |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | Revoke gate is `{OWNER, ADMIN}` (MODERATOR excluded). |

### TC-GCHAT-099 — Revoke unknown token

| Field                     | Value                                |
| ------------------------- | ------------------------------------ |
| **Feature/Module**        | Group Chat / Invite Links            |
| **API/Event Name**        | `POST /api/chat/invite-links/revoke` |
| **Test Scenario**         | Token not active                     |
| **Category**              | Error Handling                       |
| **Priority**              | Low                                  |
| **Preconditions**         | Token absent/revoked                 |
| **Request Payload**       | `{ "token":"…" }`                    |
| **Expected Response**     | `404` `CHAT_INVITE_LINK_NOT_FOUND`   |
| **Expected DB Changes**   | None                                 |
| **Expected Socket/Event** | None                                 |
| **Notes**                 | —                                    |

### TC-GCHAT-100 — Token too short (validation)

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links          |
| **API/Event Name**        | `POST /api/chat/invite-links/join` |
| **Test Scenario**         | token < 10 chars                   |
| **Category**              | Input Validation                   |
| **Priority**              | Low                                |
| **Preconditions**         | Authenticated                      |
| **Request Payload**       | `{ "token":"abc" }`                |
| **Expected Response**     | `400` validation error             |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | min 10.                            |

### TC-GCHAT-101 — `maxUses` zero/negative (validation)

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links             |
| **API/Event Name**        | `POST /api/chat/invite-links`         |
| **Test Scenario**         | maxUses not positive                  |
| **Category**              | Input Validation                      |
| **Priority**              | Low                                   |
| **Preconditions**         | Caller OWNER                          |
| **Request Payload**       | `{ "roomId":"grp_x", "maxUses":0 }`   |
| **Expected Response**     | `400` validation error (`positive()`) |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |
| **Notes**                 | —                                     |

### TC-GCHAT-102 — `expiresAt` not ISO datetime (validation)

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                      |
| **API/Event Name**        | `POST /api/chat/invite-links`                  |
| **Test Scenario**         | malformed expiresAt                            |
| **Category**              | Input Validation                               |
| **Priority**              | Low                                            |
| **Preconditions**         | Caller OWNER                                   |
| **Request Payload**       | `{ "roomId":"grp_x", "expiresAt":"tomorrow" }` |
| **Expected Response**     | `400` validation error (`.datetime()`)         |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | —                                              |

### TC-GCHAT-103 — List active links (paginated)

| Field                     | Value                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                                                                                                            |
| **API/Event Name**        | `GET /api/chat/invite-links/room/:roomId`                                                                                                            |
| **Test Scenario**         | List active links for a room                                                                                                                         |
| **Category**              | Pagination/Filter/Sort                                                                                                                               |
| **Priority**              | Medium                                                                                                                                               |
| **Preconditions**         | Room has active links                                                                                                                                |
| **Request Payload**       | query `limit`, `page`                                                                                                                                |
| **Expected Response**     | `200` `buildListResponse` of active links                                                                                                            |
| **Expected DB Changes**   | None                                                                                                                                                 |
| **Expected Socket/Event** | None                                                                                                                                                 |
| **Notes**                 | **NOTE:** `getActiveLinks` has no membership/role gate — any authenticated user can list a room's active tokens by roomId. Flag (token leak / IDOR). |

### TC-GCHAT-104 — Concurrency: last-slot join race past member cap

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                                           |
| **API/Event Name**        | `POST /api/chat/invite-links/join` (×N)                                             |
| **Test Scenario**         | Many users join via link when 1 slot remains                                        |
| **Category**              | Concurrency                                                                         |
| **Priority**              | Medium                                                                              |
| **Preconditions**         | memberCount = limit-1; valid high-`maxUses` link                                    |
| **Request Payload**       | N parallel `{ "token":"…" }`                                                        |
| **Expected Response**     | **Risk:** >1 can pass `memberCount >= memberLimit` before increments commit         |
| **Expected DB Changes**   | Group may exceed `memberLimit`; `usedCount` may over/under count                    |
| **Expected Socket/Event** | One `MEMBER_JOINED` per successful join                                             |
| **Notes**                 | Flag: same non-atomic check-then-increment as direct add (members.md TC-GCHAT-055). |

### TC-GCHAT-105 — Concurrency: maxUses=1 link used by two joiners

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Invite Links                                                   |
| **API/Event Name**        | `POST /api/chat/invite-links/join` (×2)                                     |
| **Test Scenario**         | Two users join a single-use link simultaneously                             |
| **Category**              | Concurrency                                                                 |
| **Priority**              | Medium                                                                      |
| **Preconditions**         | `maxUses=1`, `usedCount=0`                                                  |
| **Request Payload**       | two parallel `{ "token":"…" }`                                              |
| **Expected Response**     | **Risk:** both may pass `usedCount >= maxUses` before increment → both join |
| **Expected DB Changes**   | `usedCount` may reach 2 (> maxUses); two members added                      |
| **Expected Socket/Event** | Up to two `MEMBER_JOINED` emits                                             |
| **Notes**                 | Flag: single-use enforcement not atomic.                                    |
