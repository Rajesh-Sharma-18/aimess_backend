# Group Chat — Disband Group

**Source:** `apps/chat-service/src/api/routes/group-room.routes.ts` · `controllers/group-room.controller.ts` (`disband`) · `services/group-room.service.ts` (`disbandGroup`) · `repositories/group-room.repository.ts` (`disband`) · `repositories/group-invite-link.repository.ts` (`revokeAllForRoom`)

**Endpoint:** `POST /api/chat/groups/rooms/:roomId/disband`
**Auth:** `authenticate`. No request body.

**RBAC:** caller must be an ACTIVE member with role `OWNER` → else `CHAT_ONLY_OWNER_DISBAND`. Non-member → `CHAT_NOT_A_MEMBER`.

**Behavior:** sets `GroupRoom.status:"DISBANDED"`, `disbandedAt`, `disbandedBy`; revokes all active invite links for the room. Returns `200` disbanded room (`CHAT_GROUP_DISBANDED`).

> **Note:** disband does NOT post a system message and does NOT emit a dedicated socket event (no `GROUP_DISBANDED` event exists). Members are not actively notified in real-time — flagged as a gap.

---

### TC-GCHAT-031 — Owner disbands group

| Field                     | Value                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Disband                                                                                           |
| **API/Event Name**        | `POST /api/chat/groups/rooms/:roomId/disband`                                                                  |
| **Test Scenario**         | Happy path — owner disbands                                                                                    |
| **Category**              | Happy Path                                                                                                     |
| **Priority**              | High                                                                                                           |
| **Preconditions**         | Caller is OWNER of active group with active invite links                                                       |
| **Request Payload**       | —                                                                                                              |
| **Expected Response**     | `200` disbanded room, `status:"DISBANDED"`, `CHAT_GROUP_DISBANDED`                                             |
| **Expected DB Changes**   | `GroupRoom.status="DISBANDED"`, `disbandedAt`/`disbandedBy` set; all active `GroupInviteLink` rows → `REVOKED` |
| **Expected Socket/Event** | None (no disband event emitted)                                                                                |
| **Notes**                 | After disband, room is excluded from all `findActive*` queries.                                                |

### TC-GCHAT-032 — Admin cannot disband

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Group Chat / Disband                          |
| **API/Event Name**        | `POST /api/chat/groups/rooms/:roomId/disband` |
| **Test Scenario**         | Admin attempts disband                        |
| **Category**              | RBAC                                          |
| **Priority**              | High                                          |
| **Preconditions**         | Caller is ADMIN (not owner)                   |
| **Request Payload**       | —                                             |
| **Expected Response**     | `400` `CHAT_ONLY_OWNER_DISBAND`               |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | Only OWNER may disband.                       |

### TC-GCHAT-033 — Member cannot disband

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Group Chat / Disband                          |
| **API/Event Name**        | `POST /api/chat/groups/rooms/:roomId/disband` |
| **Test Scenario**         | Plain member attempts disband                 |
| **Category**              | RBAC                                          |
| **Priority**              | High                                          |
| **Preconditions**         | Caller is MEMBER                              |
| **Request Payload**       | —                                             |
| **Expected Response**     | `400` `CHAT_ONLY_OWNER_DISBAND`               |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |

### TC-GCHAT-034 — Non-member cannot disband (IDOR)

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Group Chat / Disband                          |
| **API/Event Name**        | `POST /api/chat/groups/rooms/:roomId/disband` |
| **Test Scenario**         | Outsider disbands another group               |
| **Category**              | Security                                      |
| **Priority**              | High                                          |
| **Preconditions**         | Caller not a member                           |
| **Request Payload**       | —                                             |
| **Expected Response**     | `404` `CHAT_NOT_A_MEMBER`                     |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |

### TC-GCHAT-035 — Disband already-disbanded group

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Disband                                                                                          |
| **API/Event Name**        | `POST /api/chat/groups/rooms/:roomId/disband`                                                                 |
| **Test Scenario**         | Idempotency — disband twice                                                                                   |
| **Category**              | Edge Case                                                                                                     |
| **Priority**              | Medium                                                                                                        |
| **Preconditions**         | Group already DISBANDED                                                                                       |
| **Request Payload**       | —                                                                                                             |
| **Expected Response**     | `404` `CHAT_NOT_A_MEMBER` (active membership lookup fails on disbanded room)                                  |
| **Expected DB Changes**   | None                                                                                                          |
| **Expected Socket/Event** | None                                                                                                          |
| **Notes**                 | `findActiveByRoomAndUser` excludes disbanded room state implicitly via member lookup; second disband blocked. |

### TC-GCHAT-036 — Disband non-existent room

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Group Chat / Disband                          |
| **API/Event Name**        | `POST /api/chat/groups/rooms/:roomId/disband` |
| **Test Scenario**         | Unknown roomId                                |
| **Category**              | Error Handling                                |
| **Priority**              | Medium                                        |
| **Preconditions**         | Authenticated user                            |
| **Request Payload**       | `:roomId = grp_unknown`                       |
| **Expected Response**     | `404` `CHAT_NOT_A_MEMBER`                     |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |

### TC-GCHAT-037 — Disband revokes all active invite links

| Field                     | Value                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Disband                                                                                                                |
| **API/Event Name**        | `POST /api/chat/groups/rooms/:roomId/disband`                                                                                       |
| **Test Scenario**         | Verify link cleanup                                                                                                                 |
| **Category**              | DB State                                                                                                                            |
| **Priority**              | Medium                                                                                                                              |
| **Preconditions**         | OWNER; group has ≥2 active invite links                                                                                             |
| **Request Payload**       | —                                                                                                                                   |
| **Expected Response**     | `200` disbanded                                                                                                                     |
| **Expected DB Changes**   | Every active `GroupInviteLink` for the room → `REVOKED`; subsequent `join`/`preview` on those tokens → `CHAT_INVITE_LINK_NOT_FOUND` |
| **Expected Socket/Event** | None                                                                                                                                |
| **Notes**                 | `inviteLinkRepo.revokeAllForRoom(roomId, userId)`.                                                                                  |

### TC-GCHAT-038 — Members lose access after disband

| Field                     | Value                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Disband                                                                                                                                       |
| **API/Event Name**        | `GET /api/chat/groups/rooms/:roomId/conversation` (post-disband)                                                                                           |
| **Test Scenario**         | Members can no longer read messages                                                                                                                        |
| **Category**              | Business Rule                                                                                                                                              |
| **Priority**              | Medium                                                                                                                                                     |
| **Preconditions**         | Group disbanded                                                                                                                                            |
| **Request Payload**       | —                                                                                                                                                          |
| **Expected Response**     | Conversation/membership-gated endpoints behave per their active-membership check; room excluded from my-groups/inbox                                       |
| **Expected DB Changes**   | None                                                                                                                                                       |
| **Expected Socket/Event** | None                                                                                                                                                       |
| **Notes**                 | `getConversation`/`listMedia` use `findActiveByRoomAndUser`; membership row still ACTIVE but room is DISBANDED — see gap note (member status not flipped). |

### TC-GCHAT-039 — Unauthenticated disband

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Group Chat / Disband                          |
| **API/Event Name**        | `POST /api/chat/groups/rooms/:roomId/disband` |
| **Test Scenario**         | No token                                      |
| **Category**              | AuthN                                         |
| **Priority**              | High                                          |
| **Preconditions**         | None                                          |
| **Request Payload**       | —                                             |
| **Expected Response**     | `401` Unauthorized                            |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |
