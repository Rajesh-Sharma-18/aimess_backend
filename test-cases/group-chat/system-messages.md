# Group Chat — System (lifecycle) Messages

**Source:** `apps/chat-service/src/services/group-system-message.service.ts` (`post`, `buildSystemText`) · `types/enums.ts` (`SystemEvent`) · callers: `group-room.service.ts`, `group-member.service.ts`, `group-invite-link.service.ts` · `docs/SOCKET_EVENTS.md` §4.2 (Group system messages), §4.3 (catch-up `systemEvent`/`systemData`) · commit `8bdd3cd` (include group system messages in `chat:catchup`)

**Contract:** every group lifecycle action posts a `contentType:"SYSTEM"` `GroupMessage` carrying a `systemEvent` code + structured `systemData`, plus an English `content.text` preview fallback. Each post:

1. resolves actor/target user snapshots (names, avatar) and folds `actorId/actorName` (+ `targetUserId/targetName`, `newRole`, `newName`) into `systemData`;
2. allocates the per-room monotonic `sequenceNumber` (so it flows through `chat:catchup`);
3. bumps the room's `lastMessageAt`/`lastMessagePreview` (sorts in inbox) — **does NOT raise unread counts**;
4. fans out `message:new` on `conv:<roomId>` with `contentType:"SYSTEM"`, `systemEvent`, `systemData`, `sentAt`, `sequenceNumber`.

**Best-effort:** the whole post is wrapped in try/catch — a failure is logged, never thrown, so a lifecycle action never fails because its system message did. The Redis publish is independently `.catch()`-guarded.

### Event → trigger map (implemented)

| `systemEvent`         | Triggered by                            | `systemData` (beyond actorId/actorName) |
| --------------------- | --------------------------------------- | --------------------------------------- |
| `GROUP_CREATED`       | `createGroup`                           | `groupName`                             |
| `MEMBER_ADDED`        | `addMember` (default)                   | `targetUserId`, `targetName`            |
| `MEMBER_JOINED`       | `join` via invite link (actor = joiner) | —                                       |
| `MEMBER_LEFT`         | `leave`                                 | —                                       |
| `MEMBER_REMOVED`      | `kick`                                  | `targetUserId`, `targetName`            |
| `ROLE_CHANGED`        | `updateRole`                            | `targetUserId`, `targetName`, `newRole` |
| `ROOM_RENAMED`        | `updateRoom` (name changed)             | `newName`                               |
| `AVATAR_CHANGED`      | `updateRoom` (avatar changed)           | —                                       |
| `DESCRIPTION_CHANGED` | `updateRoom` (description changed)      | —                                       |

> **Defined-but-unused `SystemEvent`s** (no code posts them in group chat): `ADMIN_ASSIGNED`, `ADMIN_REMOVED`, `INVITE_LINK_CREATED`, `CALL_STARTED`, `CALL_ENDED`, `MESSAGE_PINNED`, `MESSAGE_UNPINNED`, `MESSAGES_ENCRYPTED`. There is also **no** `GROUP_DISBANDED` event (disband emits nothing). Flagged.

---

### TC-GCHAT-141 — GROUP_CREATED system message

| Field                     | Value                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                                                                                                                                       |
| **API/Event Name**        | `POST /api/chat/groups` → `message:new` SYSTEM                                                                                                                                     |
| **Test Scenario**         | Creating a group posts GROUP_CREATED                                                                                                                                               |
| **Category**              | Business Rule                                                                                                                                                                      |
| **Priority**              | High                                                                                                                                                                               |
| **Preconditions**         | Authenticated user                                                                                                                                                                 |
| **Request Payload**       | `{ "name":"G" }`                                                                                                                                                                   |
| **Expected Response**     | (create returns 201)                                                                                                                                                               |
| **Expected DB Changes**   | 1 SYSTEM `GroupMessage` `systemEvent:"GROUP_CREATED"`, `sequenceNumber:1`; room `lastMessageAt` set, unread NOT incremented                                                        |
| **Expected Socket/Event** | `message:new` on `conv:<roomId>`: `contentType:"SYSTEM"`, `systemEvent:"GROUP_CREATED"`, `systemData:{ groupName, actorId, actorName }`, `contentText:"<actor> created the group"` |
| **Notes**                 | —                                                                                                                                                                                  |

### TC-GCHAT-142 — MEMBER_ADDED system message

| Field                     | Value                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / System Messages                                                                                                               |
| **API/Event Name**        | `POST /api/chat/group-members/add` → SYSTEM                                                                                                |
| **Test Scenario**         | Adding a member posts MEMBER_ADDED                                                                                                         |
| **Category**              | Business Rule                                                                                                                              |
| **Priority**              | High                                                                                                                                       |
| **Preconditions**         | Admin adds a user                                                                                                                          |
| **Request Payload**       | `{ "roomId":"grp_x", "userId":"u2" }`                                                                                                      |
| **Expected Response**     | 201                                                                                                                                        |
| **Expected DB Changes**   | SYSTEM message `MEMBER_ADDED`; unread unchanged                                                                                            |
| **Expected Socket/Event** | `message:new` `systemEvent:"MEMBER_ADDED"`, `systemData:{ targetUserId, targetName, actorId, actorName }`, text `"<actor> added <target>"` |
| **Notes**                 | actor = invitedBy.                                                                                                                         |

### TC-GCHAT-143 — MEMBER_JOINED system message (via link)

| Field                     | Value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                                    |
| **API/Event Name**        | `POST /api/chat/invite-links/join` → SYSTEM                                     |
| **Test Scenario**         | Joining via link posts MEMBER_JOINED attributed to joiner                       |
| **Category**              | Business Rule                                                                   |
| **Priority**              | High                                                                            |
| **Preconditions**         | Valid link; new joiner                                                          |
| **Request Payload**       | `{ "token":"…" }`                                                               |
| **Expected Response**     | 200                                                                             |
| **Expected DB Changes**   | SYSTEM `MEMBER_JOINED` (`actorId` = joiner)                                     |
| **Expected Socket/Event** | `message:new` `systemEvent:"MEMBER_JOINED"`, text `"<joiner> joined the group"` |
| **Notes**                 | Differs from MEMBER_ADDED: actor is the joining user, no targetUserId.          |

### TC-GCHAT-144 — MEMBER_LEFT system message

| Field                     | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                               |
| **API/Event Name**        | `POST /api/chat/group-members/:roomId/leave` → SYSTEM                      |
| **Test Scenario**         | Leaving posts MEMBER_LEFT                                                  |
| **Category**              | Business Rule                                                              |
| **Priority**              | High                                                                       |
| **Preconditions**         | Non-owner member leaves                                                    |
| **Request Payload**       | —                                                                          |
| **Expected Response**     | 200                                                                        |
| **Expected DB Changes**   | SYSTEM `MEMBER_LEFT` (`actorId` = self)                                    |
| **Expected Socket/Event** | `message:new` `systemEvent:"MEMBER_LEFT"`, text `"<actor> left the group"` |
| **Notes**                 | —                                                                          |

### TC-GCHAT-145 — MEMBER_REMOVED system message (kick)

| Field                     | Value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                                    |
| **API/Event Name**        | `POST /api/chat/group-members/kick` → SYSTEM                                    |
| **Test Scenario**         | Kick posts MEMBER_REMOVED                                                       |
| **Category**              | Business Rule                                                                   |
| **Priority**              | High                                                                            |
| **Preconditions**         | Admin kicks a member                                                            |
| **Request Payload**       | `{ "roomId":"grp_x", "userId":"target" }`                                       |
| **Expected Response**     | 200                                                                             |
| **Expected DB Changes**   | SYSTEM `MEMBER_REMOVED` (`actorId` = kicker, `targetUserId`)                    |
| **Expected Socket/Event** | `message:new` `systemEvent:"MEMBER_REMOVED"`, text `"<actor> removed <target>"` |
| **Notes**                 | —                                                                               |

### TC-GCHAT-146 — ROLE_CHANGED system message

| Field                     | Value                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                                                          |
| **API/Event Name**        | `POST /api/chat/group-members/role` → SYSTEM                                                          |
| **Test Scenario**         | Role change posts ROLE_CHANGED with newRole                                                           |
| **Category**              | Business Rule                                                                                         |
| **Priority**              | High                                                                                                  |
| **Preconditions**         | Owner promotes a member                                                                               |
| **Request Payload**       | `{ "roomId":"grp_x", "userId":"u2", "role":"ADMIN" }`                                                 |
| **Expected Response**     | 200                                                                                                   |
| **Expected DB Changes**   | SYSTEM `ROLE_CHANGED`, `systemData:{ targetUserId, targetName, newRole:"ADMIN", actorId, actorName }` |
| **Expected Socket/Event** | `message:new` `systemEvent:"ROLE_CHANGED"`, text `"<actor> changed <target>'s role to ADMIN"`         |
| **Notes**                 | —                                                                                                     |

### TC-GCHAT-147 — ROOM_RENAMED system message

| Field                     | Value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                                            |
| **API/Event Name**        | `PATCH /api/chat/groups/:roomId` (name) → SYSTEM                                        |
| **Test Scenario**         | Rename posts ROOM_RENAMED with newName                                                  |
| **Category**              | Business Rule                                                                           |
| **Priority**              | High                                                                                    |
| **Preconditions**         | Owner renames                                                                           |
| **Request Payload**       | `{ "name":"New" }`                                                                      |
| **Expected Response**     | 200                                                                                     |
| **Expected DB Changes**   | SYSTEM `ROOM_RENAMED`, `systemData:{ newName:"New", actorId, actorName }`               |
| **Expected Socket/Event** | `message:new` `systemEvent:"ROOM_RENAMED"`, text `'<actor> renamed the group to "New"'` |
| **Notes**                 | Only when name actually changes (see TC-GCHAT-020).                                     |

### TC-GCHAT-148 — AVATAR_CHANGED system message

| Field                     | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                                           |
| **API/Event Name**        | `PATCH /api/chat/groups/:roomId` (avatar) → SYSTEM                                     |
| **Test Scenario**         | Avatar change posts AVATAR_CHANGED                                                     |
| **Category**              | Business Rule                                                                          |
| **Priority**              | Medium                                                                                 |
| **Preconditions**         | Admin changes avatar                                                                   |
| **Request Payload**       | `{ "avatar":"a/x.png" }`                                                               |
| **Expected Response**     | 200                                                                                    |
| **Expected DB Changes**   | SYSTEM `AVATAR_CHANGED` (no extra systemData)                                          |
| **Expected Socket/Event** | `message:new` `systemEvent:"AVATAR_CHANGED"`, text `"<actor> changed the group photo"` |
| **Notes**                 | —                                                                                      |

### TC-GCHAT-149 — DESCRIPTION_CHANGED system message

| Field                     | Value                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                                                      |
| **API/Event Name**        | `PATCH /api/chat/groups/:roomId` (description) → SYSTEM                                           |
| **Test Scenario**         | Description change posts DESCRIPTION_CHANGED                                                      |
| **Category**              | Business Rule                                                                                     |
| **Priority**              | Medium                                                                                            |
| **Preconditions**         | Owner changes description                                                                         |
| **Request Payload**       | `{ "description":"new desc" }`                                                                    |
| **Expected Response**     | 200                                                                                               |
| **Expected DB Changes**   | SYSTEM `DESCRIPTION_CHANGED`                                                                      |
| **Expected Socket/Event** | `message:new` `systemEvent:"DESCRIPTION_CHANGED"`, text `"<actor> updated the group description"` |
| **Notes**                 | —                                                                                                 |

### TC-GCHAT-150 — System messages do NOT increment unread

| Field                     | Value                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                                                  |
| **API/Event Name**        | any lifecycle action                                                                          |
| **Test Scenario**         | Lifecycle chatter shouldn't raise badges                                                      |
| **Category**              | Business Rule                                                                                 |
| **Priority**              | High                                                                                          |
| **Preconditions**         | A member with unreadCount=0                                                                   |
| **Request Payload**       | e.g. someone is added/renamed                                                                 |
| **Expected Response**     | —                                                                                             |
| **Expected DB Changes**   | Other members' `unreadCount` UNCHANGED after the SYSTEM message; `lastMessageAt` still bumped |
| **Expected Socket/Event** | `message:new` SYSTEM (no `unread`-raising side effect)                                        |
| **Notes**                 | Contrast with a real text send which increments unread.                                       |

### TC-GCHAT-151 — System messages appear in chat:catchup with systemEvent/systemData

| Field                     | Value                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / System Messages                                                                                                                                       |
| **API/Event Name**        | `chat:catchup` → `chat:catchup:result`                                                                                                                             |
| **Test Scenario**         | Reconnecting client gap-fills lifecycle events it missed                                                                                                           |
| **Category**              | Edge Case                                                                                                                                                          |
| **Priority**              | High                                                                                                                                                               |
| **Preconditions**         | Member offline while group was renamed + a member added; reconnects with `sinceSeq`                                                                                |
| **Request Payload**       | `{ rooms:[{ roomId, sinceSeq, conversationType:"group" }] }`                                                                                                       |
| **Expected Response**     | `chat:catchup:result` events include SYSTEM rows with `systemEvent` set (e.g. `ROOM_RENAMED`) and JSON-encoded `systemData`; non-SYSTEM rows have `systemEvent:""` |
| **Expected DB Changes**   | None                                                                                                                                                               |
| **Expected Socket/Event** | `chat:catchup:result` per room                                                                                                                                     |
| **Notes**                 | Per commit 8bdd3cd — system messages now allocate a sequence so they are included (previously seq 0 excluded them).                                                |

### TC-GCHAT-152 — System message bumps inbox order but not unread

| Field                     | Value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                                            |
| **API/Event Name**        | lifecycle action → `GET /api/chat/inbox`                                                |
| **Test Scenario**         | Group floats to top of inbox on lifecycle event                                         |
| **Category**              | DB State                                                                                |
| **Priority**              | Medium                                                                                  |
| **Preconditions**         | Member with the group lower in inbox                                                    |
| **Request Payload**       | someone renames the group                                                               |
| **Expected Response**     | Group moves to top by `lastMessageAt` with SYSTEM preview text; `unreadCount` unchanged |
| **Expected DB Changes**   | `lastMessageAt`/`lastMessagePreview` updated                                            |
| **Expected Socket/Event** | `message:new` SYSTEM; (bump events for the list as applicable)                          |
| **Notes**                 | —                                                                                       |

### TC-GCHAT-153 — System message post failure is swallowed (lifecycle still succeeds)

| Field                     | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / System Messages                                              |
| **API/Event Name**        | any lifecycle action                                                      |
| **Test Scenario**         | Snapshot lookup / Redis publish throws                                    |
| **Category**              | Error Handling                                                            |
| **Priority**              | Medium                                                                    |
| **Preconditions**         | Force user-snapshot service or Redis to error                             |
| **Request Payload**       | e.g. add member                                                           |
| **Expected Response**     | Lifecycle HTTP response still `2xx`; member still added                   |
| **Expected DB Changes**   | Membership change persists; system message may be absent (logged warning) |
| **Expected Socket/Event** | Possibly no `message:new` (publish failure logged, not thrown)            |
| **Notes**                 | `post` is best-effort by design.                                          |

### TC-GCHAT-154 — Unknown actor/target name fallback

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / System Messages                                                   |
| **API/Event Name**        | any lifecycle action                                                           |
| **Test Scenario**         | User snapshot missing for actor/target                                         |
| **Category**              | Edge Case                                                                      |
| **Priority**              | Low                                                                            |
| **Preconditions**         | Snapshot returns no name                                                       |
| **Request Payload**       | add a user with no cached snapshot                                             |
| **Expected Response**     | —                                                                              |
| **Expected DB Changes**   | `content.text` uses fallbacks "Someone"/"a member"                             |
| **Expected Socket/Event** | `message:new` SYSTEM with fallback text but structured `systemData` ids intact |
| **Notes**                 | Clients should render from systemEvent+systemData (ids preserved).             |
