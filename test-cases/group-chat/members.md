# Group Chat — Members (add / leave / kick / list)

**Source:** `apps/chat-service/src/api/routes/group-member.routes.ts` · `controllers/group-member.controller.ts` · `services/group-member.service.ts` · `validators/group-member.validator.ts` · `repositories/group-member.repository.ts`, `group-room.repository.ts`

**Endpoints (base `/api/chat/group-members`):**

- `POST /add` — add a member (body: `{ roomId, userId }`)
- `POST /:roomId/leave` — leave a group
- `POST /kick` — remove a member (body: `{ roomId, userId, reason? }`)
- `POST /role` — change role (see `roles-permissions.md`)
- `GET /:roomId` — list active members (paginated)

**Validation:** `addMemberSchema` / `kickMemberSchema`: `roomId` & `userId` strings 5–100; `reason` ≤1000 optional.

**Business rules:**

- Add blocked when `memberCount >= memberLimit` → `CHAT_GROUP_MEMBER_LIMIT_REACHED`.
- Add of an already-ACTIVE member → `CHAT_ALREADY_MEMBER` (409). Re-adding a LEFT/KICKED member reactivates via `upsert`.
- Owner cannot leave → `CHAT_OWNER_CANNOT_LEAVE`.
- Kick requires actor role in `{OWNER, ADMIN, MODERATOR}`; cannot kick equal-or-higher role (`CHAT_CANNOT_KICK_HIGHER_ROLE`).

**System messages:** add → `MEMBER_ADDED` (actor=invitedBy); leave → `MEMBER_LEFT` (actor=self); kick → `MEMBER_REMOVED` (actor=kicker). All emit `message:new` SYSTEM on `conv:<roomId>` and bump `memberCount`.

---

### TC-GCHAT-040 — Owner adds a new member

| Field                     | Value                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                                                                                                          |
| **API/Event Name**        | `POST /api/chat/group-members/add`                                                                                            |
| **Test Scenario**         | Happy path — add user under member limit                                                                                      |
| **Category**              | Happy Path                                                                                                                    |
| **Priority**              | High                                                                                                                          |
| **Preconditions**         | Caller is OWNER/ADMIN; target not yet a member; memberCount < limit                                                           |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "user-2" }`                                                                                   |
| **Expected Response**     | `201` new `GroupMember` (`role:"MEMBER"`, `status:"ACTIVE"`)                                                                  |
| **Expected DB Changes**   | New/upserted `GroupMember`; `GroupRoom.memberCount`+1; SYSTEM `MEMBER_ADDED` message; `lastSequence`+1                        |
| **Expected Socket/Event** | `message:new` on `conv:<roomId>`, `systemEvent:"MEMBER_ADDED"`, `systemData:{ targetUserId, targetName, actorId, actorName }` |
| **Notes**                 | `invitedBy = actorId`. NOTE: `addMember` does NOT verify actor's role — see TC-GCHAT-052 (any active member can add).         |

### TC-GCHAT-041 — Add member when group is full

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                           |
| **API/Event Name**        | `POST /api/chat/group-members/add`             |
| **Test Scenario**         | memberCount == memberLimit                     |
| **Category**              | Business Rule                                  |
| **Priority**              | High                                           |
| **Preconditions**         | Group at capacity                              |
| **Request Payload**       | `{ "roomId": "grp_full", "userId": "user-N" }` |
| **Expected Response**     | `400` `CHAT_GROUP_MEMBER_LIMIT_REACHED`        |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | Guard: `memberCount >= memberLimit`.           |

### TC-GCHAT-042 — Add an already-active member

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                          |
| **API/Event Name**        | `POST /api/chat/group-members/add`            |
| **Test Scenario**         | Duplicate add                                 |
| **Category**              | Business Rule                                 |
| **Priority**              | Medium                                        |
| **Preconditions**         | Target already ACTIVE member                  |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "existing" }` |
| **Expected Response**     | `409` `CHAT_ALREADY_MEMBER`                   |
| **Expected DB Changes**   | None; `memberCount` unchanged                 |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |

### TC-GCHAT-043 — Re-add a previously-LEFT member (reactivation)

| Field                     | Value                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                                                                              |
| **API/Event Name**        | `POST /api/chat/group-members/add`                                                                |
| **Test Scenario**         | User who left is added back                                                                       |
| **Category**              | DB State                                                                                          |
| **Priority**              | Medium                                                                                            |
| **Preconditions**         | Target has `status:"LEFT"` row                                                                    |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "returner" }`                                                     |
| **Expected Response**     | `201` reactivated member (`status:"ACTIVE"`, `leftAt:null`, `kickedAt:null`)                      |
| **Expected DB Changes**   | `upsert` clears left/kicked/banned fields, new `joinedAt`; `memberCount`+1; SYSTEM `MEMBER_ADDED` |
| **Expected Socket/Event** | `message:new` `MEMBER_ADDED`                                                                      |
| **Notes**                 | Same path reactivates a KICKED member (no ban enforcement on add).                                |

### TC-GCHAT-044 — Add into a disbanded group

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Group Chat / Members                      |
| **API/Event Name**        | `POST /api/chat/group-members/add`        |
| **Test Scenario**         | roomId is disbanded                       |
| **Category**              | Error Handling                            |
| **Priority**              | Medium                                    |
| **Preconditions**         | Group DISBANDED                           |
| **Request Payload**       | `{ "roomId": "grp_dead", "userId": "u" }` |
| **Expected Response**     | `404` `CHAT_GROUP_NOT_FOUND`              |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | `findActiveByRoomId` returns null.        |

### TC-GCHAT-045 — Add: roomId too short (validation)

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Group Chat / Members                     |
| **API/Event Name**        | `POST /api/chat/group-members/add`       |
| **Test Scenario**         | roomId < 5 chars                         |
| **Category**              | Input Validation                         |
| **Priority**              | Low                                      |
| **Preconditions**         | Authenticated                            |
| **Request Payload**       | `{ "roomId": "ab", "userId": "user-2" }` |
| **Expected Response**     | `400` validation error                   |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | min 5.                                   |

### TC-GCHAT-046 — Member leaves the group

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                                                                               |
| **API/Event Name**        | `POST /api/chat/group-members/:roomId/leave`                                                       |
| **Test Scenario**         | Non-owner leaves                                                                                   |
| **Category**              | Happy Path                                                                                         |
| **Priority**              | High                                                                                               |
| **Preconditions**         | Caller is ACTIVE MEMBER/ADMIN/MODERATOR                                                            |
| **Request Payload**       | —                                                                                                  |
| **Expected Response**     | `200` member with `status:"LEFT"`, `CHAT_GROUP_LEFT`                                               |
| **Expected DB Changes**   | `GroupMember.status="LEFT"`, `leftAt` set; `memberCount`-1; SYSTEM `MEMBER_LEFT`                   |
| **Expected Socket/Event** | `message:new` on `conv:<roomId>`, `systemEvent:"MEMBER_LEFT"`, `systemData:{ actorId, actorName }` |
| **Notes**                 | —                                                                                                  |

### TC-GCHAT-047 — Owner cannot leave

| Field                     | Value                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Members                                                                                   |
| **API/Event Name**        | `POST /api/chat/group-members/:roomId/leave`                                                           |
| **Test Scenario**         | Owner tries to leave                                                                                   |
| **Category**              | Business Rule                                                                                          |
| **Priority**              | High                                                                                                   |
| **Preconditions**         | Caller is OWNER                                                                                        |
| **Request Payload**       | —                                                                                                      |
| **Expected Response**     | `400` `CHAT_OWNER_CANNOT_LEAVE`                                                                        |
| **Expected DB Changes**   | None                                                                                                   |
| **Expected Socket/Event** | None                                                                                                   |
| **Notes**                 | Owner must transfer ownership or disband first. NOTE: no ownership-transfer endpoint exists — see gap. |

### TC-GCHAT-048 — Leave when not a member

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                         |
| **API/Event Name**        | `POST /api/chat/group-members/:roomId/leave` |
| **Test Scenario**         | Non-member leaves                            |
| **Category**              | Error Handling                               |
| **Priority**              | Medium                                       |
| **Preconditions**         | Caller not active member                     |
| **Request Payload**       | —                                            |
| **Expected Response**     | `404` `CHAT_NOT_A_MEMBER`                    |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | —                                            |

### TC-GCHAT-049 — Admin kicks a member

| Field                     | Value                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                                                                                |
| **API/Event Name**        | `POST /api/chat/group-members/kick`                                                                 |
| **Test Scenario**         | Admin removes a plain member                                                                        |
| **Category**              | RBAC                                                                                                |
| **Priority**              | High                                                                                                |
| **Preconditions**         | Caller ADMIN; target is MEMBER                                                                      |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "target", "reason": "spam" }`                                       |
| **Expected Response**     | `200` member `status:"KICKED"`                                                                      |
| **Expected DB Changes**   | `status="KICKED"`, `kickedAt`/`kickedBy`/`kickReason` set; `memberCount`-1; SYSTEM `MEMBER_REMOVED` |
| **Expected Socket/Event** | `message:new` `MEMBER_REMOVED`, `systemData:{ targetUserId, targetName, actorId, actorName }`       |
| **Notes**                 | —                                                                                                   |

### TC-GCHAT-050 — Kick without reason

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                        |
| **API/Event Name**        | `POST /api/chat/group-members/kick`         |
| **Test Scenario**         | reason omitted (optional)                   |
| **Category**              | Optional Params                             |
| **Priority**              | Low                                         |
| **Preconditions**         | Caller ADMIN; target MEMBER                 |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "target" }` |
| **Expected Response**     | `200` kicked, `kickReason:null`             |
| **Expected DB Changes**   | As TC-GCHAT-049 with `kickReason=null`      |
| **Expected Socket/Event** | `message:new` `MEMBER_REMOVED`              |
| **Notes**                 | —                                           |

### TC-GCHAT-051 — List members (pagination)

| Field                     | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                                                                            |
| **API/Event Name**        | `GET /api/chat/group-members/:roomId?limit=50&cursor=<joinedAt>`                                |
| **Test Scenario**         | Paginated active member list ordered by joinedAt asc                                            |
| **Category**              | Pagination/Filter/Sort                                                                          |
| **Priority**              | Medium                                                                                          |
| **Preconditions**         | Group has >50 active members                                                                    |
| **Request Payload**       | query `limit`, `cursor`, `page`                                                                 |
| **Expected Response**     | `200` paginated members (`buildPaginatedResponse`, sort key `joinedAt`); only `status:"ACTIVE"` |
| **Expected DB Changes**   | None                                                                                            |
| **Expected Socket/Event** | None                                                                                            |
| **Notes**                 | KICKED/LEFT excluded. Cursor = `joinedAt` (`gt`).                                               |

### TC-GCHAT-052 — Plain member adds another user (missing RBAC) — SECURITY

| Field                     | Value                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                                                                                                                                                             |
| **API/Event Name**        | `POST /api/chat/group-members/add`                                                                                                                                               |
| **Test Scenario**         | A non-privileged member adds an arbitrary user                                                                                                                                   |
| **Category**              | Security                                                                                                                                                                         |
| **Priority**              | High                                                                                                                                                                             |
| **Preconditions**         | Caller is plain MEMBER of the group                                                                                                                                              |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "outsider" }`                                                                                                                                    |
| **Expected Response**     | `201` member added (CURRENT behavior — `addMember` does NOT check the actor's role or even active membership of the inviter)                                                     |
| **Expected DB Changes**   | New member added; `memberCount`+1                                                                                                                                                |
| **Expected Socket/Event** | `message:new` `MEMBER_ADDED`                                                                                                                                                     |
| **Notes**                 | **RBAC gap:** `addMember` never verifies `invitedBy` is an admin or even a member. Any authenticated user could add members to any active group (also an IDOR). Flag for review. |

### TC-GCHAT-053 — List members of a group you don't belong to — SECURITY

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Members                                                                             |
| **API/Event Name**        | `GET /api/chat/group-members/:roomId`                                                            |
| **Test Scenario**         | Non-member enumerates a group's members                                                          |
| **Category**              | Security                                                                                         |
| **Priority**              | High                                                                                             |
| **Preconditions**         | Caller not a member of roomId                                                                    |
| **Request Payload**       | —                                                                                                |
| **Expected Response**     | `200` full member list (CURRENT — `getMembers` has no membership gate)                           |
| **Expected DB Changes**   | None                                                                                             |
| **Expected Socket/Event** | None                                                                                             |
| **Notes**                 | **IDOR / info-leak:** member userIds + roles exposed to any authenticated user. Flag for review. |

### TC-GCHAT-054 — Concurrency: two admins kick same member

| Field                     | Value                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                                                                                                                                                                            |
| **API/Event Name**        | `POST /api/chat/group-members/kick` (×2)                                                                                                                                                        |
| **Test Scenario**         | Two admins kick the same target simultaneously                                                                                                                                                  |
| **Category**              | Concurrency                                                                                                                                                                                     |
| **Priority**              | Medium                                                                                                                                                                                          |
| **Preconditions**         | Target ACTIVE; two ADMINs                                                                                                                                                                       |
| **Request Payload**       | both: `{ "roomId": "grp_x", "userId": "target" }`                                                                                                                                               |
| **Expected Response**     | Both may return `200`; status ends KICKED                                                                                                                                                       |
| **Expected DB Changes**   | **Risk:** `memberCount` may be decremented TWICE (no transactional guard on `status` transition + `incMemberCount`), under-counting members. Two `MEMBER_REMOVED` system messages may be posted |
| **Expected Socket/Event** | Up to two `message:new` `MEMBER_REMOVED` emits                                                                                                                                                  |
| **Notes**                 | Flag: double-decrement race. Recommend idempotent status check inside a transaction.                                                                                                            |

### TC-GCHAT-055 — Concurrency: add past member cap (race)

| Field                     | Value                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Members                                                              |
| **API/Event Name**        | `POST /api/chat/group-members/add` (×N)                                           |
| **Test Scenario**         | Multiple adds when 1 slot remains                                                 |
| **Category**              | Concurrency                                                                       |
| **Priority**              | Medium                                                                            |
| **Preconditions**         | memberCount = limit-1                                                             |
| **Request Payload**       | N simultaneous distinct adds                                                      |
| **Expected Response**     | More than one may pass the `>= memberLimit` check before `incMemberCount` commits |
| **Expected DB Changes**   | **Risk:** group can exceed `memberLimit` (check-then-increment is not atomic)     |
| **Expected Socket/Event** | One `MEMBER_ADDED` per successful add                                             |
| **Notes**                 | Flag: member-cap race. Same race applies to join-by-link (see invite-links.md).   |
