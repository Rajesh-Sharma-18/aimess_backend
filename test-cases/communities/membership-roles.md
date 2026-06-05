# Communities — Membership & Roles (RBAC matrix)

**Source:** `apps/community-service/src/api/routes/community.routes.ts` (`GET /:id/members`, `POST /:id/members`, `PUT /:id/members/:userId/role`, `POST /:id/transfer-admin`), `services/community.service.ts` (`listMembers`, `addMembers`, `updateMemberRole`, `transferAdmin`), `lib/community-authz.ts`.

> **Service:** community-service. Roles: `ADMIN` (rank 2) > `MODERATOR` (1) > `MEMBER` (0). `assertCommunityRole` requires ACTIVE status AND rank ≥ minRole. Only one ADMIN per community (`adminId`).

## RBAC matrix (who can do what)

| Action                 | MEMBER | MODERATOR | ADMIN | non-member |
| ---------------------- | ------ | --------- | ----- | ---------- |
| List members (PUBLIC)  | ✅     | ✅        | ✅    | ✅         |
| List members (PRIVATE) | ✅     | ✅        | ✅    | ❌ 403     |
| Add members            | ❌ 403 | ✅        | ✅    | ❌         |
| Update member role     | ❌     | ❌ 403    | ✅    | ❌         |
| Transfer admin         | ❌     | ❌        | ✅    | ❌         |
| Kick (LEFT)            | ❌     | ✅\*      | ✅    | ❌         |
| Ban / Unban            | ❌     | ❌ 403    | ✅    | ❌         |
| Mute / Warn member     | ❌     | ✅\*      | ✅    | ❌         |
| View audit logs        | ❌ 403 | ✅        | ✅    | ❌         |

\* MODERATOR must strictly outrank the target (cannot act on a peer MODERATOR or ADMIN).

---

### TC-COMM-061 — List members of PUBLIC community as non-member

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Members                                                            |
| **API/Event Name**        | `GET /api/v1/communities/:id/members`                                            |
| **Test Scenario**         | Non-member lists PUBLIC roster                                                   |
| **Category**              | RBAC / Pagination                                                                |
| **Priority**              | Medium                                                                           |
| **Preconditions**         | PUBLIC community                                                                 |
| **Request Payload**       | query `page,limit,status`                                                        |
| **Expected Response**     | `200` paginated members (default status ACTIVE) with snapshot + presigned avatar |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | None                                                                             |
| **Notes**                 | PUBLIC roster is public. limit ≤50.                                              |

### TC-COMM-062 — List members of PRIVATE community as non-member forbidden

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Communities / Members                                       |
| **API/Event Name**        | `GET /api/v1/communities/:id/members`                       |
| **Test Scenario**         | Outsider lists PRIVATE roster                               |
| **Category**              | RBAC / Security                                             |
| **Priority**              | High                                                        |
| **Preconditions**         | PRIVATE community; caller not a member                      |
| **Request Payload**       | query                                                       |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`                                 |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | `assertCommunityRole(membership, MEMBER)` for PRIVATE only. |

### TC-COMM-063 — Filter members by status

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Members                                                |
| **API/Event Name**        | `GET /api/v1/communities/:id/members?status=BANNED`                  |
| **Test Scenario**         | List banned members                                                  |
| **Category**              | Pagination/Filter/Sort                                               |
| **Priority**              | Low                                                                  |
| **Preconditions**         | Member can view                                                      |
| **Request Payload**       | `status=BANNED` (enum ACTIVE/PENDING/BANNED/LEFT)                    |
| **Expected Response**     | `200` filtered list; banned rows include bannedAt/bannedBy/banReason |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | Invalid status enum → `400`.                                         |

### TC-COMM-064 — Add members (MODERATOR+)

| Field                     | Value                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Members                                                                                                                                       |
| **API/Event Name**        | `POST /api/v1/communities/:id/members`                                                                                                                      |
| **Test Scenario**         | Moderator bulk-adds users                                                                                                                                   |
| **Category**              | RBAC / Happy Path                                                                                                                                           |
| **Priority**              | High                                                                                                                                                        |
| **Preconditions**         | MODERATOR+                                                                                                                                                  |
| **Request Payload**       | `{ "userIds": ["<uuid1>","<uuid2>"] }` (1–100, deduped)                                                                                                     |
| **Expected Response**     | `201` `{ added: [...], skipped: [...] }`                                                                                                                    |
| **Expected DB Changes**   | New MEMBER rows (or LEFT→reactivate); memberCount recomputed                                                                                                |
| **Expected Socket/Event** | RabbitMQ `community.member.added` (via `add_members`) per added user (skipped not emitted)                                                                  |
| **Notes**                 | Caller-self → skipped ALREADY_MEMBER; ACTIVE → ALREADY_MEMBER; BANNED → skipped BANNED. NOTE: friend-validation is currently commented out in `addMembers`. |

### TC-COMM-065 — Add members by plain MEMBER forbidden

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Communities / Members                  |
| **API/Event Name**        | `POST /api/v1/communities/:id/members` |
| **Test Scenario**         | Member tries to add                    |
| **Category**              | RBAC                                   |
| **Priority**              | High                                   |
| **Preconditions**         | Caller MEMBER                          |
| **Request Payload**       | `{ "userIds": ["<uuid>"] }`            |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`            |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | —                                      |

### TC-COMM-066 — Add members empty array

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Communities / Members                     |
| **API/Event Name**        | `POST /api/v1/communities/:id/members`    |
| **Test Scenario**         | userIds = []                              |
| **Category**              | Input Validation                          |
| **Priority**              | Low                                       |
| **Preconditions**         | MODERATOR+                                |
| **Request Payload**       | `{ "userIds": [] }`                       |
| **Expected Response**     | `400` ("At least one userId is required") |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | max 100.                                  |

### TC-COMM-067 — Promote member to MODERATOR (ADMIN)

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Roles                                                   |
| **API/Event Name**        | `PUT /api/v1/communities/:id/members/:userId/role`                    |
| **Test Scenario**         | Admin promotes a member                                               |
| **Category**              | RBAC / Happy Path                                                     |
| **Priority**              | High                                                                  |
| **Preconditions**         | Caller ADMIN; target ACTIVE MEMBER                                    |
| **Request Payload**       | `{ "role": "MODERATOR" }`                                             |
| **Expected Response**     | `200` member DTO role MODERATOR                                       |
| **Expected DB Changes**   | role updated; audit `MEMBER_PROMOTED`                                 |
| **Expected Socket/Event** | RabbitMQ `community.member.role.changed`                              |
| **Notes**                 | role enum is only MODERATOR/MEMBER — cannot set ADMIN via this route. |

### TC-COMM-068 — Demote moderator to MEMBER (ADMIN)

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Communities / Roles                                         |
| **API/Event Name**        | `PUT /api/v1/communities/:id/members/:userId/role`          |
| **Test Scenario**         | Admin demotes a moderator                                   |
| **Category**              | Happy Path                                                  |
| **Priority**              | Medium                                                      |
| **Preconditions**         | Caller ADMIN; target ACTIVE MODERATOR                       |
| **Request Payload**       | `{ "role": "MEMBER" }`                                      |
| **Expected Response**     | `200` member role MEMBER; audit `MEMBER_DEMOTED`            |
| **Expected DB Changes**   | role updated                                                |
| **Expected Socket/Event** | RabbitMQ `community.member.role.changed`                    |
| **Notes**                 | Setting same role is a no-op (returns unchanged, no event). |

### TC-COMM-069 — Update role by MODERATOR forbidden (privilege escalation)

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Communities / Roles                                |
| **API/Event Name**        | `PUT /api/v1/communities/:id/members/:userId/role` |
| **Test Scenario**         | Moderator tries to promote themselves/others       |
| **Category**              | Security / RBAC                                    |
| **Priority**              | High                                               |
| **Preconditions**         | Caller MODERATOR                                   |
| **Request Payload**       | `{ "role": "MODERATOR" }`                          |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`                        |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | Role change is ADMIN-only.                         |

### TC-COMM-070 — Change own role rejected

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Communities / Roles                                |
| **API/Event Name**        | `PUT /api/v1/communities/:id/members/:userId/role` |
| **Test Scenario**         | Admin targets self                                 |
| **Category**              | Business Rule                                      |
| **Priority**              | Medium                                             |
| **Preconditions**         | Caller ADMIN; userId == caller                     |
| **Request Payload**       | `{ "role": "MEMBER" }`                             |
| **Expected Response**     | `400` `COMMUNITY_MEMBER_CANNOT_MODIFY_SELF`        |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | —                                                  |

### TC-COMM-071 — Modify the ADMIN's role rejected

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Communities / Roles                                      |
| **API/Event Name**        | `PUT /api/v1/communities/:id/members/:userId/role`       |
| **Test Scenario**         | Target is the community admin                            |
| **Category**              | Business Rule                                            |
| **Priority**              | High                                                     |
| **Preconditions**         | Caller ADMIN; target is adminId / role ADMIN             |
| **Request Payload**       | `{ "role": "MEMBER" }`                                   |
| **Expected Response**     | `400` `COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN`             |
| **Expected DB Changes**   | None                                                     |
| **Expected Socket/Event** | None                                                     |
| **Notes**                 | Admin role immutable via this route; use transfer-admin. |

### TC-COMM-072 — Update role of non-existent / inactive target

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Communities / Roles                                |
| **API/Event Name**        | `PUT /api/v1/communities/:id/members/:userId/role` |
| **Test Scenario**         | Target not a member or LEFT/BANNED                 |
| **Category**              | Error Handling                                     |
| **Priority**              | Medium                                             |
| **Preconditions**         | Caller ADMIN; target not ACTIVE                    |
| **Request Payload**       | `{ "role": "MODERATOR" }`                          |
| **Expected Response**     | `404` `COMMUNITY_MEMBER_NOT_FOUND`                 |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | —                                                  |

### TC-COMM-073 — Transfer admin (ADMIN)

| Field                     | Value                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Roles                                                                                                       |
| **API/Event Name**        | `POST /api/v1/communities/:id/transfer-admin`                                                                             |
| **Test Scenario**         | Admin hands ownership to another ACTIVE member                                                                            |
| **Category**              | RBAC / Happy Path                                                                                                         |
| **Priority**              | High                                                                                                                      |
| **Preconditions**         | Caller ADMIN; target ACTIVE member                                                                                        |
| **Request Payload**       | `{ "userId": "<uuid>" }`                                                                                                  |
| **Expected Response**     | `200` community DTO; caller now `myRole: MEMBER`                                                                          |
| **Expected DB Changes**   | target → ADMIN; `adminId` updated; caller → MEMBER (stays ACTIVE); audit `ADMIN_TRANSFERRED` (reason `explicit_transfer`) |
| **Expected Socket/Event** | RabbitMQ `community.admin.transferred`                                                                                    |
| **Notes**                 | Telegram-style — caller is not removed.                                                                                   |

### TC-COMM-074 — Transfer admin to self / to non-member

| Field                     | Value                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Roles                                                                                  |
| **API/Event Name**        | `POST /api/v1/communities/:id/transfer-admin`                                                        |
| **Test Scenario**         | userId == caller, or target not ACTIVE                                                               |
| **Category**              | Business Rule                                                                                        |
| **Priority**              | Medium                                                                                               |
| **Preconditions**         | Caller ADMIN                                                                                         |
| **Request Payload**       | `{ "userId": "<self-or-stranger>" }`                                                                 |
| **Expected Response**     | `400` `COMMUNITY_MEMBER_CANNOT_MODIFY_SELF` (self) / `404` `COMMUNITY_MEMBER_NOT_FOUND` (non-member) |
| **Expected DB Changes**   | None                                                                                                 |
| **Expected Socket/Event** | None                                                                                                 |
| **Notes**                 | —                                                                                                    |

### TC-COMM-075 — Transfer admin by non-admin forbidden

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Communities / Roles                           |
| **API/Event Name**        | `POST /api/v1/communities/:id/transfer-admin` |
| **Test Scenario**         | Moderator/member attempts transfer            |
| **Category**              | RBAC / Security                               |
| **Priority**              | High                                          |
| **Preconditions**         | Caller not ADMIN                              |
| **Request Payload**       | `{ "userId": "<uuid>" }`                      |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`                   |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |

### TC-COMM-076 — Concurrent role edits on same member

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Communities / Roles                                      |
| **API/Event Name**        | `PUT /api/v1/communities/:id/members/:userId/role`       |
| **Test Scenario**         | Two admin requests change a member's role simultaneously |
| **Category**              | Concurrency                                              |
| **Priority**              | Low                                                      |
| **Preconditions**         | Two ADMIN sessions (or admin + transfer)                 |
| **Request Payload**       | conflicting roles                                        |
| **Expected Response**     | Both `200`; last write wins                              |
| **Expected DB Changes**   | Final role = last update; no `$transaction`              |
| **Expected Socket/Event** | role.changed per applied change                          |
| **Notes**                 | Document last-write-wins; no optimistic lock.            |

### TC-COMM-077 — List audit logs (MODERATOR+)

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Audit                                                                |
| **API/Event Name**        | `GET /api/v1/communities/:id/audit-logs?page=&limit=`                              |
| **Test Scenario**         | Moderator views moderation trail                                                   |
| **Category**              | RBAC / Pagination                                                                  |
| **Priority**              | Medium                                                                             |
| **Preconditions**         | MODERATOR+                                                                         |
| **Request Payload**       | query                                                                              |
| **Expected Response**     | `200` paginated audit entries (action, actorId, targetUserId, metadata, createdAt) |
| **Expected DB Changes**   | None                                                                               |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | MEMBER/non-member → `403`.                                                         |
