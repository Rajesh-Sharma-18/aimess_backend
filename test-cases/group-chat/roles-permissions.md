# Group Chat — Roles & Permissions (RBAC matrix)

**Source:** `apps/chat-service/src/api/routes/group-member.routes.ts` (`POST /role`) · `controllers/group-member.controller.ts` (`updateRole`) · `services/group-member.service.ts` (`updateRole`, `kick`) · `validators/group-member.validator.ts` (`updateRoleSchema`) · `services/group-room.service.ts` (`updateRoom`, `disbandGroup`)

**Endpoint:** `POST /api/chat/group-members/role` — body `{ roomId, userId, role }`, `role ∈ {OWNER, ADMIN, MODERATOR, MEMBER}`.

**Role hierarchy** (`roleOrder`): `OWNER > ADMIN > MODERATOR > MEMBER`.

**updateRole RBAC:**

- Actor must be ACTIVE member with role in `{OWNER, ADMIN}` → else `CHAT_INSUFFICIENT_PERMISSIONS`.
- An ADMIN cannot assign `OWNER` or `ADMIN` (only OWNER may) → `CHAT_INSUFFICIENT_PERMISSIONS`.
- Posts `ROLE_CHANGED` system message; `systemData:{ targetUserId, targetName, newRole, actorId, actorName }`.

> **Note:** `updateRole` does NOT block self-demotion, does NOT prevent multiple OWNERs, and does NOT verify the target is currently an active member's role hierarchy relative to the actor (unlike `kick`). Flagged below.

### RBAC matrix — privileged group actions

| Action                                | OWNER | ADMIN | MODERATOR | MEMBER                              | Non-member            |
| ------------------------------------- | ----- | ----- | --------- | ----------------------------------- | --------------------- |
| Update group (name/avatar/desc/limit) | ✅    | ✅    | ❌        | ❌                                  | ❌ (404)              |
| Disband group                         | ✅    | ❌    | ❌        | ❌                                  | ❌ (404)              |
| Add member                            | ✅    | ✅    | ✅\*      | ✅\*                                | ✅\* (no check — gap) |
| Kick member (lower role)              | ✅    | ✅    | ✅        | ❌                                  | ❌                    |
| Promote to ADMIN/OWNER                | ✅    | ❌    | ❌        | ❌                                  | ❌                    |
| Promote to MODERATOR/MEMBER           | ✅    | ✅    | ❌        | ❌                                  | ❌                    |
| Create invite link                    | ✅    | ✅    | ✅\*\*    | ✅\*\* (if `allowMemberInviteLink`) | ❌                    |
| Revoke invite link                    | ✅    | ✅    | ❌        | ❌                                  | ❌                    |
| Delete others' messages               | ✅    | ✅    | ✅        | ❌                                  | ❌                    |

\* `addMember` has no role check (gap — see members.md TC-GCHAT-052). \*\* MODERATOR/MEMBER need `room.settings.allowMemberInviteLink`.

---

### TC-GCHAT-056 — Owner promotes member to ADMIN

| Field                     | Value                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                                                                                                                 |
| **API/Event Name**        | `POST /api/chat/group-members/role`                                                                                                |
| **Test Scenario**         | Owner sets ADMIN                                                                                                                   |
| **Category**              | RBAC                                                                                                                               |
| **Priority**              | High                                                                                                                               |
| **Preconditions**         | Caller OWNER; target ACTIVE MEMBER                                                                                                 |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "u2", "role": "ADMIN" }`                                                                           |
| **Expected Response**     | `200` member `role:"ADMIN"`                                                                                                        |
| **Expected DB Changes**   | `GroupMember.role="ADMIN"`; SYSTEM `ROLE_CHANGED` (`newRole:"ADMIN"`)                                                              |
| **Expected Socket/Event** | `message:new` on `conv:<roomId>`, `systemEvent:"ROLE_CHANGED"`, `systemData:{ targetUserId, newRole:"ADMIN", actorId, actorName }` |
| **Notes**                 | —                                                                                                                                  |

### TC-GCHAT-057 — Owner promotes member to OWNER (multiple owners) — BUSINESS RULE GAP

| Field                     | Value                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                                                                                                            |
| **API/Event Name**        | `POST /api/chat/group-members/role`                                                                                           |
| **Test Scenario**         | Owner assigns OWNER to another member                                                                                         |
| **Category**              | Business Rule                                                                                                                 |
| **Priority**              | High                                                                                                                          |
| **Preconditions**         | Caller OWNER                                                                                                                  |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "u2", "role": "OWNER" }`                                                                      |
| **Expected Response**     | `200` (CURRENT — allowed). Group now has TWO OWNERs                                                                           |
| **Expected DB Changes**   | Target `role="OWNER"`; original owner unchanged                                                                               |
| **Expected Socket/Event** | `message:new` `ROLE_CHANGED` (`newRole:"OWNER"`)                                                                              |
| **Notes**                 | **Gap:** no single-owner invariant, no demotion of the previous owner, no dedicated ownership-transfer flow. Flag for review. |

### TC-GCHAT-058 — Admin promotes member to MODERATOR

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Roles                                           |
| **API/Event Name**        | `POST /api/chat/group-members/role`                          |
| **Test Scenario**         | Admin grants MODERATOR                                       |
| **Category**              | RBAC                                                         |
| **Priority**              | High                                                         |
| **Preconditions**         | Caller ADMIN; target MEMBER                                  |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "u2", "role": "MODERATOR" }` |
| **Expected Response**     | `200` `role:"MODERATOR"`                                     |
| **Expected DB Changes**   | role updated; SYSTEM `ROLE_CHANGED`                          |
| **Expected Socket/Event** | `message:new` `ROLE_CHANGED`                                 |
| **Notes**                 | Admin may set MODERATOR/MEMBER.                              |

### TC-GCHAT-059 — Admin tries to promote to ADMIN (forbidden)

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                                       |
| **API/Event Name**        | `POST /api/chat/group-members/role`                      |
| **Test Scenario**         | Admin attempts to grant ADMIN                            |
| **Category**              | RBAC                                                     |
| **Priority**              | High                                                     |
| **Preconditions**         | Caller ADMIN                                             |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "u2", "role": "ADMIN" }` |
| **Expected Response**     | `400` `CHAT_INSUFFICIENT_PERMISSIONS`                    |
| **Expected DB Changes**   | None                                                     |
| **Expected Socket/Event** | None                                                     |
| **Notes**                 | `actor.role !== "OWNER" && newRole ∈ {OWNER, ADMIN}`.    |

### TC-GCHAT-060 — Admin tries to grant OWNER (forbidden)

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                                       |
| **API/Event Name**        | `POST /api/chat/group-members/role`                      |
| **Test Scenario**         | Admin attempts OWNER assignment                          |
| **Category**              | RBAC                                                     |
| **Priority**              | High                                                     |
| **Preconditions**         | Caller ADMIN                                             |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "u2", "role": "OWNER" }` |
| **Expected Response**     | `400` `CHAT_INSUFFICIENT_PERMISSIONS`                    |
| **Expected DB Changes**   | None                                                     |
| **Expected Socket/Event** | None                                                     |
| **Notes**                 | Privilege-escalation guard.                              |

### TC-GCHAT-061 — Moderator cannot change roles

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                                        |
| **API/Event Name**        | `POST /api/chat/group-members/role`                       |
| **Test Scenario**         | Moderator attempts to demote a member                     |
| **Category**              | RBAC                                                      |
| **Priority**              | High                                                      |
| **Preconditions**         | Caller MODERATOR                                          |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "u2", "role": "MEMBER" }` |
| **Expected Response**     | `400` `CHAT_INSUFFICIENT_PERMISSIONS`                     |
| **Expected DB Changes**   | None                                                      |
| **Expected Socket/Event** | None                                                      |
| **Notes**                 | Only OWNER/ADMIN may call updateRole.                     |

### TC-GCHAT-062 — Member cannot change roles (privilege escalation)

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Roles                                           |
| **API/Event Name**        | `POST /api/chat/group-members/role`                          |
| **Test Scenario**         | Member tries to make themselves ADMIN                        |
| **Category**              | Security                                                     |
| **Priority**              | High                                                         |
| **Preconditions**         | Caller MEMBER                                                |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "<self>", "role": "ADMIN" }` |
| **Expected Response**     | `400` `CHAT_INSUFFICIENT_PERMISSIONS`                        |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | Self-promotion blocked at actor-role gate.                   |

### TC-GCHAT-063 — Non-member cannot change roles

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                                       |
| **API/Event Name**        | `POST /api/chat/group-members/role`                      |
| **Test Scenario**         | Outsider changes a role                                  |
| **Category**              | Security                                                 |
| **Priority**              | High                                                     |
| **Preconditions**         | Caller not a member                                      |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "u2", "role": "ADMIN" }` |
| **Expected Response**     | `404` `CHAT_NOT_A_MEMBER`                                |
| **Expected DB Changes**   | None                                                     |
| **Expected Socket/Event** | None                                                     |
| **Notes**                 | —                                                        |

### TC-GCHAT-064 — Owner demotes an admin to member

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                                            |
| **API/Event Name**        | `POST /api/chat/group-members/role`                           |
| **Test Scenario**         | Owner demotes ADMIN → MEMBER                                  |
| **Category**              | RBAC                                                          |
| **Priority**              | Medium                                                        |
| **Preconditions**         | Caller OWNER; target ADMIN                                    |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "admin1", "role": "MEMBER" }` |
| **Expected Response**     | `200` `role:"MEMBER"`                                         |
| **Expected DB Changes**   | role updated; SYSTEM `ROLE_CHANGED`                           |
| **Expected Socket/Event** | `message:new` `ROLE_CHANGED`                                  |
| **Notes**                 | —                                                             |

### TC-GCHAT-065 — Invalid role enum value

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                                            |
| **API/Event Name**        | `POST /api/chat/group-members/role`                           |
| **Test Scenario**         | role not in enum                                              |
| **Category**              | Input Validation                                              |
| **Priority**              | Low                                                           |
| **Preconditions**         | Caller OWNER                                                  |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "u2", "role": "SUPERADMIN" }` |
| **Expected Response**     | `400` validation error                                        |
| **Expected DB Changes**   | None                                                          |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | `z.enum`.                                                     |

### TC-GCHAT-066 — Admin kicks an equal-role admin (forbidden)

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Roles                                                 |
| **API/Event Name**        | `POST /api/chat/group-members/kick`                                |
| **Test Scenario**         | Admin kicks another admin                                          |
| **Category**              | RBAC                                                               |
| **Priority**              | High                                                               |
| **Preconditions**         | Caller ADMIN; target ADMIN                                         |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "admin2" }`                        |
| **Expected Response**     | `400` `CHAT_CANNOT_KICK_HIGHER_ROLE`                               |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | `roleOrder.indexOf(actor) >= indexOf(target)` blocks equal/higher. |

### TC-GCHAT-067 — Moderator kicks an admin (forbidden)

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                          |
| **API/Event Name**        | `POST /api/chat/group-members/kick`         |
| **Test Scenario**         | Moderator kicks higher role                 |
| **Category**              | RBAC                                        |
| **Priority**              | High                                        |
| **Preconditions**         | Caller MODERATOR; target ADMIN              |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "admin1" }` |
| **Expected Response**     | `400` `CHAT_CANNOT_KICK_HIGHER_ROLE`        |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | —                                           |

### TC-GCHAT-068 — Member tries to kick (insufficient permissions)

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                            |
| **API/Event Name**        | `POST /api/chat/group-members/kick`           |
| **Test Scenario**         | Plain member kicks someone                    |
| **Category**              | RBAC                                          |
| **Priority**              | High                                          |
| **Preconditions**         | Caller MEMBER                                 |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "u2" }`       |
| **Expected Response**     | `400` `CHAT_INSUFFICIENT_PERMISSIONS`         |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | Actor role gate: `{OWNER, ADMIN, MODERATOR}`. |

### TC-GCHAT-069 — Cannot kick the OWNER

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| **Feature/Module**        | Group Chat / Roles                         |
| **API/Event Name**        | `POST /api/chat/group-members/kick`        |
| **Test Scenario**         | Admin tries to kick the owner              |
| **Category**              | Business Rule                              |
| **Priority**              | High                                       |
| **Preconditions**         | Caller ADMIN; target OWNER                 |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "owner" }` |
| **Expected Response**     | `400` `CHAT_CANNOT_KICK_HIGHER_ROLE`       |
| **Expected DB Changes**   | None                                       |
| **Expected Socket/Event** | None                                       |
| **Notes**                 | OWNER is highest role; never kickable.     |

### TC-GCHAT-070 — Owner kicks an admin

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Group Chat / Roles                                    |
| **API/Event Name**        | `POST /api/chat/group-members/kick`                   |
| **Test Scenario**         | Owner removes an admin                                |
| **Category**              | RBAC                                                  |
| **Priority**              | Medium                                                |
| **Preconditions**         | Caller OWNER; target ADMIN                            |
| **Request Payload**       | `{ "roomId": "grp_x", "userId": "admin1" }`           |
| **Expected Response**     | `200` kicked                                          |
| **Expected DB Changes**   | status KICKED; memberCount-1; SYSTEM `MEMBER_REMOVED` |
| **Expected Socket/Event** | `message:new` `MEMBER_REMOVED`                        |
| **Notes**                 | OWNER outranks ADMIN.                                 |

### TC-GCHAT-071 — Concurrency: two owners simultaneously change a role

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Roles                                           |
| **API/Event Name**        | `POST /api/chat/group-members/role` (×2)                     |
| **Test Scenario**         | Two owners set conflicting roles on same target              |
| **Category**              | Concurrency                                                  |
| **Priority**              | Low                                                          |
| **Preconditions**         | Two OWNERs (see TC-GCHAT-057); one target                    |
| **Request Payload**       | A: role ADMIN; B: role MEMBER                                |
| **Expected Response**     | Both `200`; last write wins                                  |
| **Expected DB Changes**   | Final role = last commit; two `ROLE_CHANGED` SYSTEM messages |
| **Expected Socket/Event** | Two `message:new` `ROLE_CHANGED` emits                       |
| **Notes**                 | No optimistic locking on role.                               |
