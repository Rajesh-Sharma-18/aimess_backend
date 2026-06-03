# Group Chat — Create Group

**Source:** `apps/chat-service/src/api/routes/group-room.routes.ts` · `controllers/group-room.controller.ts` (`create`) · `services/group-room.service.ts` (`createGroup`) · `validators/group-room.validator.ts` (`createGroupSchema`) · `repositories/group-room.repository.ts`, `group-member.repository.ts` · `services/group-system-message.service.ts` · `docs/SOCKET_EVENTS.md` §4.2

**Endpoint:** `POST /api/chat/groups`
**Auth:** `authenticate` (JWT access token) required.
**Rate limit:** `gr:create` — 10 requests / 24h per user (`createRateLimit`).

**Validation (`createGroupSchema`):**

| Field         | Rule                                       | Default |
| ------------- | ------------------------------------------ | ------- |
| `name`        | string, min 1, max 100, trimmed (required) | —       |
| `description` | string, max 1000                           | `""`    |
| `avatar`      | string                                     | `""`    |
| `memberLimit` | int, min 2, max 5000                       | `50`    |

**Behavior:** creates `GroupRoom` (`type:"GROUP"`, `status:"ACTIVE"`, `memberCount:1`, default `settings`), creates `GroupMember` for creator (`role:"OWNER"`, `status:"ACTIVE"`), posts a `GROUP_CREATED` system message (sets `lastMessageAt`), re-reads room, returns `201 { room, member }`.

---

### TC-GCHAT-001 — Create group with all valid fields

| Field                     | Value                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Create Group                                                                                                                                                         |
| **API/Event Name**        | `POST /api/chat/groups`                                                                                                                                                           |
| **Test Scenario**         | Happy path — name, description, avatar, memberLimit all provided                                                                                                                  |
| **Category**              | Happy Path                                                                                                                                                                        |
| **Priority**              | High                                                                                                                                                                              |
| **Preconditions**         | Authenticated user with valid access token                                                                                                                                        |
| **Request Payload**       | `{ "name": "Team AIMess", "description": "Core team", "avatar": "avatars/g1.png", "memberLimit": 100 }`                                                                           |
| **Expected Response**     | `201` `{ data: { room: { roomId, type:"GROUP", name, memberCount:1, memberLimit:100, status:"ACTIVE", lastMessageAt }, member: { role:"OWNER", status:"ACTIVE" } } }`             |
| **Expected DB Changes**   | New `GroupRoom` (1 row); new `GroupMember` (creator = OWNER/ACTIVE); 1 `SYSTEM` `GroupMessage` (`GROUP_CREATED`); room `lastSequence=1`, `lastMessageAt`/`lastMessagePreview` set |
| **Expected Socket/Event** | `message:new` on `conv:<roomId>` with `contentType:"SYSTEM"`, `systemEvent:"GROUP_CREATED"`, `systemData:{ groupName, actorId, actorName }`                                       |
| **Notes**                 | Creator becomes OWNER automatically; `roomId` is `grp_…` (see `generateRoomId`).                                                                                                  |

### TC-GCHAT-002 — Create group with only required `name`

| Field                     | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Create Group                                       |
| **API/Event Name**        | `POST /api/chat/groups`                                         |
| **Test Scenario**         | Defaults applied for description/avatar/memberLimit             |
| **Category**              | Optional Params                                                 |
| **Priority**              | Medium                                                          |
| **Preconditions**         | Authenticated user                                              |
| **Request Payload**       | `{ "name": "Just Name" }`                                       |
| **Expected Response**     | `201` room with `description:""`, `avatar:""`, `memberLimit:50` |
| **Expected DB Changes**   | `GroupRoom.memberLimit=50`, `description=""`, `avatar=""`       |
| **Expected Socket/Event** | `message:new` `GROUP_CREATED` on `conv:<roomId>`                |
| **Notes**                 | Confirms Zod defaults.                                          |

### TC-GCHAT-003 — Missing `name`

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Group Chat / Create Group                 |
| **API/Event Name**        | `POST /api/chat/groups`                   |
| **Test Scenario**         | Required param missing                    |
| **Category**              | Required Params                           |
| **Priority**              | High                                      |
| **Preconditions**         | Authenticated user                        |
| **Request Payload**       | `{ "description": "no name" }`            |
| **Expected Response**     | `400` validation error (name required)    |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | `validateBody` rejects before controller. |

### TC-GCHAT-004 — `name` empty / whitespace only

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Group Chat / Create Group              |
| **API/Event Name**        | `POST /api/chat/groups`                |
| **Test Scenario**         | name trims to empty (min 1 fails)      |
| **Category**              | Input Validation                       |
| **Priority**              | Medium                                 |
| **Preconditions**         | Authenticated user                     |
| **Request Payload**       | `{ "name": "   " }`                    |
| **Expected Response**     | `400` validation error                 |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | `.trim()` applied then min 1 enforced. |

### TC-GCHAT-005 — `name` exceeds 100 chars

| Field                     | Value                       |
| ------------------------- | --------------------------- |
| **Feature/Module**        | Group Chat / Create Group   |
| **API/Event Name**        | `POST /api/chat/groups`     |
| **Test Scenario**         | name too long               |
| **Category**              | Input Validation            |
| **Priority**              | Medium                      |
| **Preconditions**         | Authenticated user          |
| **Request Payload**       | `{ "name": "<101 chars>" }` |
| **Expected Response**     | `400` validation error      |
| **Expected DB Changes**   | None                        |
| **Expected Socket/Event** | None                        |
| **Notes**                 | —                           |

### TC-GCHAT-006 — `memberLimit` below minimum (1)

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Group Chat / Create Group           |
| **API/Event Name**        | `POST /api/chat/groups`             |
| **Test Scenario**         | memberLimit < 2                     |
| **Category**              | Input Validation                    |
| **Priority**              | Medium                              |
| **Preconditions**         | Authenticated user                  |
| **Request Payload**       | `{ "name": "X", "memberLimit": 1 }` |
| **Expected Response**     | `400` validation error (min 2)      |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | —                                   |

### TC-GCHAT-007 — `memberLimit` above maximum (5001)

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Group Chat / Create Group              |
| **API/Event Name**        | `POST /api/chat/groups`                |
| **Test Scenario**         | memberLimit > 5000                     |
| **Category**              | Input Validation                       |
| **Priority**              | Medium                                 |
| **Preconditions**         | Authenticated user                     |
| **Request Payload**       | `{ "name": "X", "memberLimit": 5001 }` |
| **Expected Response**     | `400` validation error (max 5000)      |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | —                                      |

### TC-GCHAT-008 — `memberLimit` non-integer

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Group Chat / Create Group              |
| **API/Event Name**        | `POST /api/chat/groups`                |
| **Test Scenario**         | float memberLimit                      |
| **Category**              | Input Validation                       |
| **Priority**              | Low                                    |
| **Preconditions**         | Authenticated user                     |
| **Request Payload**       | `{ "name": "X", "memberLimit": 10.5 }` |
| **Expected Response**     | `400` validation error (`int()`)       |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | —                                      |

### TC-GCHAT-009 — Unauthenticated request

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Group Chat / Create Group                   |
| **API/Event Name**        | `POST /api/chat/groups`                     |
| **Test Scenario**         | No / invalid access token                   |
| **Category**              | AuthN                                       |
| **Priority**              | High                                        |
| **Preconditions**         | None                                        |
| **Request Payload**       | `{ "name": "X" }` (no Authorization header) |
| **Expected Response**     | `401` Unauthorized                          |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | `authenticate` middleware.                  |

### TC-GCHAT-010 — Rate limit: 11th create in 24h

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Create Group                                 |
| **API/Event Name**        | `POST /api/chat/groups`                                   |
| **Test Scenario**         | Exceed 10 creates / 24h per user                          |
| **Category**              | Rate Limit                                                |
| **Priority**              | Medium                                                    |
| **Preconditions**         | Same user created 10 groups within window                 |
| **Request Payload**       | `{ "name": "Group 11" }`                                  |
| **Expected Response**     | `429` Too Many Requests                                   |
| **Expected DB Changes**   | None for the blocked request                              |
| **Expected Socket/Event** | None                                                      |
| **Notes**                 | `windowMs:86_400_000`, `maxRequests:10`, key `gr:create`. |

### TC-GCHAT-011 — System message bumps brand-new group into inbox

| Field                     | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Create Group                                                |
| **API/Event Name**        | `POST /api/chat/groups` → `GET /api/chat/inbox`                          |
| **Test Scenario**         | Newly created (message-less) group appears in unified inbox              |
| **Category**              | DB State                                                                 |
| **Priority**              | Medium                                                                   |
| **Preconditions**         | Authenticated user creates a group                                       |
| **Request Payload**       | `{ "name": "Inbox Test" }`                                               |
| **Expected Response**     | Group appears in inbox ordered by `lastMessageAt` (set by GROUP_CREATED) |
| **Expected DB Changes**   | `lastMessageAt` non-null after create                                    |
| **Expected Socket/Event** | `message:new` SYSTEM on `conv:<roomId>`                                  |
| **Notes**                 | Confirms re-read returns the post-system-message `lastMessageAt`.        |

### TC-GCHAT-012 — `description` exceeds 1000 chars

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Group Chat / Create Group                        |
| **API/Event Name**        | `POST /api/chat/groups`                          |
| **Test Scenario**         | description too long                             |
| **Category**              | Input Validation                                 |
| **Priority**              | Low                                              |
| **Preconditions**         | Authenticated user                               |
| **Request Payload**       | `{ "name": "X", "description": "<1001 chars>" }` |
| **Expected Response**     | `400` validation error                           |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | —                                                |

### TC-GCHAT-013 — Concurrent creates count toward shared rate limit

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Group Chat / Create Group                          |
| **API/Event Name**        | `POST /api/chat/groups`                            |
| **Test Scenario**         | Fire 12 creates in parallel for same user          |
| **Category**              | Concurrency                                        |
| **Priority**              | Low                                                |
| **Preconditions**         | Authenticated user, fresh window                   |
| **Request Payload**       | 12 × `{ "name": "Gn" }`                            |
| **Expected Response**     | ≤10 succeed `201`; remainder `429`                 |
| **Expected DB Changes**   | At most 10 `GroupRoom` rows                        |
| **Expected Socket/Event** | One `GROUP_CREATED` per successful create          |
| **Notes**                 | Verifies rate-limit counter is atomic under burst. |
