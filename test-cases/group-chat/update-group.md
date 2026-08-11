# Group Chat — Update Group + Get Room

**Source:** `apps/chat-service/src/api/routes/group-room.routes.ts` · `controllers/group-room.controller.ts` (`update`, `getRoom`, `getUserGroups`) · `services/group-room.service.ts` (`updateRoom`, `getRoom`, `getUserGroups`) · `validators/group-room.validator.ts` (`updateGroupSchema`) · `services/group-system-message.service.ts`

**Endpoints:**

- `PATCH /api/chat/groups/rooms/:roomId` — update name/description/avatar/memberLimit (OWNER or ADMIN)
- `GET /api/chat/groups/rooms/:roomId` — fetch a single active group
- `GET /api/chat/groups/my-groups` — paginated list of the caller's groups

**Validation (`updateGroupSchema`, all optional):** `name` (1–100, trimmed), `description` (≤1000), `avatar` (string), `memberLimit` (int 2–5000).

**RBAC:** `updateRoom` requires the caller to be an ACTIVE member with role in `{OWNER, ADMIN}`; else `CHAT_ONLY_OWNER_ADMIN_UPDATE`. Non-member → `CHAT_NOT_A_MEMBER` (404).

**System messages:** one per _actually changed_ presentational field — `ROOM_RENAMED` (name), `AVATAR_CHANGED` (avatar), `DESCRIPTION_CHANGED` (description). `memberLimit` changes are silent (no system message). Re-sending an unchanged value posts nothing.

---

### TC-GCHAT-014 — Owner updates group name

| Field                     | Value                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Update Group                                                                                    |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`                                                                       |
| **Test Scenario**         | Owner renames the group                                                                                      |
| **Category**              | Happy Path                                                                                                   |
| **Priority**              | High                                                                                                         |
| **Preconditions**         | Caller is OWNER of an active group                                                                           |
| **Request Payload**       | `{ "name": "New Name" }`                                                                                     |
| **Expected Response**     | `200` updated `GroupRoom` with `name:"New Name"`                                                             |
| **Expected DB Changes**   | `GroupRoom.name` updated; 1 SYSTEM `GroupMessage` `ROOM_RENAMED`; `lastSequence`+1; `lastMessageAt` bumped   |
| **Expected Socket/Event** | `message:new` on `conv:<roomId>`, `systemEvent:"ROOM_RENAMED"`, `systemData:{ newName, actorId, actorName }` |
| **Notes**                 | —                                                                                                            |

### TC-GCHAT-015 — Admin updates avatar + description in one call

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group                                                                   |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`                                                      |
| **Test Scenario**         | Admin changes avatar and description together                                               |
| **Category**              | RBAC                                                                                        |
| **Priority**              | High                                                                                        |
| **Preconditions**         | Caller is ADMIN of active group                                                             |
| **Request Payload**       | `{ "avatar": "a/new.png", "description": "updated" }`                                       |
| **Expected Response**     | `200` updated room                                                                          |
| **Expected DB Changes**   | Two SYSTEM messages: `AVATAR_CHANGED` and `DESCRIPTION_CHANGED`; `lastSequence`+2           |
| **Expected Socket/Event** | Two `message:new` SYSTEM emits on `conv:<roomId>` (`AVATAR_CHANGED`, `DESCRIPTION_CHANGED`) |
| **Notes**                 | Verifies per-field system-message generation.                                               |

### TC-GCHAT-016 — Member (non-admin) cannot update

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Update Group                              |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`                 |
| **Test Scenario**         | Plain member tries to rename                           |
| **Category**              | RBAC                                                   |
| **Priority**              | High                                                   |
| **Preconditions**         | Caller is MEMBER (not owner/admin)                     |
| **Request Payload**       | `{ "name": "Hax" }`                                    |
| **Expected Response**     | `400` `CHAT_ONLY_OWNER_ADMIN_UPDATE`                   |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | MODERATOR is also rejected (only OWNER/ADMIN allowed). |

### TC-GCHAT-017 — Moderator cannot update

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group                 |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`    |
| **Test Scenario**         | Moderator tries to update settings        |
| **Category**              | RBAC                                      |
| **Priority**              | High                                      |
| **Preconditions**         | Caller is MODERATOR                       |
| **Request Payload**       | `{ "memberLimit": 200 }`                  |
| **Expected Response**     | `400` `CHAT_ONLY_OWNER_ADMIN_UPDATE`      |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | Update gate is strictly `{OWNER, ADMIN}`. |

### TC-GCHAT-018 — Non-member cannot update

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group                    |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`       |
| **Test Scenario**         | Outsider updates someone else's group (IDOR) |
| **Category**              | Security                                     |
| **Priority**              | High                                         |
| **Preconditions**         | Caller is not a member of the room           |
| **Request Payload**       | `{ "name": "Stolen" }`                       |
| **Expected Response**     | `404` `CHAT_NOT_A_MEMBER`                    |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | Membership checked before role.              |

### TC-GCHAT-019 — Update memberLimit only (no system message)

| Field                     | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group                                              |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`                                 |
| **Test Scenario**         | Owner raises member cap                                                |
| **Category**              | Business Rule                                                          |
| **Priority**              | Medium                                                                 |
| **Preconditions**         | Caller OWNER                                                           |
| **Request Payload**       | `{ "memberLimit": 500 }`                                               |
| **Expected Response**     | `200` `memberLimit:500`                                                |
| **Expected DB Changes**   | `memberLimit` updated; **no** SYSTEM message; `lastSequence` unchanged |
| **Expected Socket/Event** | None                                                                   |
| **Notes**                 | memberLimit is intentionally silent.                                   |

### TC-GCHAT-020 — Re-sending unchanged name posts no system message

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group                                             |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`                                |
| **Test Scenario**         | name equals current value                                             |
| **Category**              | Edge Case                                                             |
| **Priority**              | Medium                                                                |
| **Preconditions**         | Caller OWNER; group already named "Same"                              |
| **Request Payload**       | `{ "name": "Same" }`                                                  |
| **Expected Response**     | `200` (no-op update)                                                  |
| **Expected DB Changes**   | No new SYSTEM message (snapshot comparison `data.name !== room.name`) |
| **Expected Socket/Event** | None                                                                  |
| **Notes**                 | Prevents spam from idempotent client re-sends.                        |

### TC-GCHAT-021 — Update non-existent room

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group                                   |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`                      |
| **Test Scenario**         | roomId does not exist                                       |
| **Category**              | Error Handling                                              |
| **Priority**              | Medium                                                      |
| **Preconditions**         | Authenticated user                                          |
| **Request Payload**       | `{ "name": "X" }`, `:roomId = grp_unknown`                  |
| **Expected Response**     | `404` `CHAT_NOT_A_MEMBER` (membership lookup fails first)   |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | Member check precedes room check, so error is NOT_A_MEMBER. |

### TC-GCHAT-022 — Update a disbanded group

| Field                     | Value                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group                                                                                               |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`                                                                                  |
| **Test Scenario**         | Group already disbanded                                                                                                 |
| **Category**              | Edge Case                                                                                                               |
| **Priority**              | Medium                                                                                                                  |
| **Preconditions**         | Group has `status:"DISBANDED"`; caller was OWNER                                                                        |
| **Request Payload**       | `{ "name": "Zombie" }`                                                                                                  |
| **Expected Response**     | `404` (`findActiveByRoomAndUser`/`findActiveByRoomId` exclude disbanded → `CHAT_NOT_A_MEMBER` / `CHAT_GROUP_NOT_FOUND`) |
| **Expected DB Changes**   | None                                                                                                                    |
| **Expected Socket/Event** | None                                                                                                                    |
| **Notes**                 | Active filters block updates post-disband.                                                                              |

### TC-GCHAT-023 — Invalid validation on update (name 101 chars)

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group              |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId` |
| **Test Scenario**         | name too long                          |
| **Category**              | Input Validation                       |
| **Priority**              | Low                                    |
| **Preconditions**         | Caller OWNER                           |
| **Request Payload**       | `{ "name": "<101 chars>" }`            |
| **Expected Response**     | `400` validation error                 |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | —                                      |

### TC-GCHAT-024 — Empty update body

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group                           |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId`              |
| **Test Scenario**         | No fields supplied (all optional)                   |
| **Category**              | Edge Case                                           |
| **Priority**              | Low                                                 |
| **Preconditions**         | Caller OWNER                                        |
| **Request Payload**       | `{}`                                                |
| **Expected Response**     | `200` unchanged room, no system messages            |
| **Expected DB Changes**   | None meaningful                                     |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | All fields `null` → no field-change branches taken. |

### TC-GCHAT-025 — Get a single active group

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Group Chat / Get Room                    |
| **API/Event Name**        | `GET /api/chat/groups/rooms/:roomId`     |
| **Test Scenario**         | Fetch group metadata                     |
| **Category**              | Happy Path                               |
| **Priority**              | Medium                                   |
| **Preconditions**         | Active group exists                      |
| **Request Payload**       | — (path `:roomId`)                       |
| **Expected Response**     | `200` `GroupRoom` (`CHAT_GROUP_FETCHED`) |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | —                                        |

### TC-GCHAT-026 — Get a non-existent / disbanded group

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Group Chat / Get Room                 |
| **API/Event Name**        | `GET /api/chat/groups/rooms/:roomId`  |
| **Test Scenario**         | Unknown or disbanded roomId           |
| **Category**              | Error Handling                        |
| **Priority**              | Medium                                |
| **Preconditions**         | roomId absent or `status:"DISBANDED"` |
| **Request Payload**       | —                                     |
| **Expected Response**     | `404` `CHAT_GROUP_NOT_FOUND`          |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |
| **Notes**                 | Uses `findActiveByRoomId`.            |

### TC-GCHAT-027 — Get room by non-member (no membership gate) — SECURITY

| Field                     | Value                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Get Room                                                                                                                                 |
| **API/Event Name**        | `GET /api/chat/groups/rooms/:roomId`                                                                                                                  |
| **Test Scenario**         | A user who is NOT a member fetches full group metadata                                                                                                |
| **Category**              | Security                                                                                                                                              |
| **Priority**              | High                                                                                                                                                  |
| **Preconditions**         | Active group exists; caller is not a member                                                                                                           |
| **Request Payload**       | —                                                                                                                                                     |
| **Expected Response**     | `200` full room object (CURRENT behavior — `getRoom` has no membership check)                                                                         |
| **Expected DB Changes**   | None                                                                                                                                                  |
| **Expected Socket/Event** | None                                                                                                                                                  |
| **Notes**                 | **Potential IDOR / info-leak:** any authenticated user can read any active group's name, avatar, description, memberCount by roomId. Flag for review. |

### TC-GCHAT-028 — my-groups pagination (limit/cursor)

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / My Groups                                                               |
| **API/Event Name**        | `GET /api/chat/groups/my-groups?limit=20&cursor=<lastMessageAt>`                     |
| **Test Scenario**         | Paginate caller's groups ordered by lastMessageAt desc                               |
| **Category**              | Pagination/Filter/Sort                                                               |
| **Priority**              | Medium                                                                               |
| **Preconditions**         | Caller is active member of >20 groups                                                |
| **Request Payload**       | query `limit`, `cursor`, `page`                                                      |
| **Expected Response**     | `200` paginated list (`buildPaginatedResponse`, sort key `lastMessageAt`)            |
| **Expected DB Changes**   | None                                                                                 |
| **Expected Socket/Event** | None                                                                                 |
| **Notes**                 | Only ACTIVE groups where caller is ACTIVE member; cursor = `lastMessageAt` boundary. |

### TC-GCHAT-029 — my-groups returns empty list

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Group Chat / My Groups                           |
| **API/Event Name**        | `GET /api/chat/groups/my-groups`                 |
| **Test Scenario**         | User belongs to no groups                        |
| **Category**              | Edge Case                                        |
| **Priority**              | Low                                              |
| **Preconditions**         | Caller has no active memberships                 |
| **Request Payload**       | —                                                |
| **Expected Response**     | `200` empty data, message `CHAT_NO_GROUPS_FOUND` |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | —                                                |

### TC-GCHAT-030 — Concurrent updates: two admins rename simultaneously

| Field                     | Value                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Update Group                                                                                              |
| **API/Event Name**        | `PATCH /api/chat/groups/rooms/:roomId` (×2)                                                                            |
| **Test Scenario**         | Two admins PATCH a different name at the same time                                                                     |
| **Category**              | Concurrency                                                                                                            |
| **Priority**              | Low                                                                                                                    |
| **Preconditions**         | Two ADMINs in the same group                                                                                           |
| **Request Payload**       | A: `{ "name": "Alpha" }`, B: `{ "name": "Beta" }`                                                                      |
| **Expected Response**     | Both `200`; last write wins on `name`                                                                                  |
| **Expected DB Changes**   | Two `ROOM_RENAMED` SYSTEM messages (both compared against the pre-update snapshot); final name is last committed write |
| **Expected Socket/Event** | Two `message:new` `ROOM_RENAMED` emits                                                                                 |
| **Notes**                 | Snapshot read is non-transactional — both may see the old name and both post a rename.                                 |
