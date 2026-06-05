# Group Chat — Moderation (mute / warn / notification prefs)

**Source:** `apps/chat-service/src/services/group-room.service.ts` (`getInboxGroups` — mute interpretation) · `repositories/group-member.repository.ts` (`notificationSettings`, `create`/`upsert` defaults) · `services/group-message.service.ts` (`deleteMessage` admin delete) · commit `6d9e19f` "member moderation features including mute, warn, notification preferences"

> **IMPORTANT — scope/gap finding.** In **chat-service group rooms** there is **no HTTP endpoint** to mute a member, warn a member, or set per-member notification preferences. The `member-moderation` commit (`mute`, `warn`, notification prefs) targets **community-service / community rooms**, not group chat. What exists in group chat today:
>
> - A `GroupMember.notificationSettings` JSON field (`{ mute: boolean, muteUntil: string|null }`), **defaulted** on member create/upsert and **read** by `getInboxGroups` to compute `isMuted`, but **never written by any group route** (no mute toggle endpoint).
> - "Removal" moderation = **kick** (see members.md) and **admin message delete** (see below + group-messages.md).
> - There is **no ban endpoint** despite a `BANNED` status + `bannedAt/bannedBy` columns existing in the schema (dead fields for group chat).
>
> The cases below cover (a) the one behavior that IS observable — mute state surfacing in the inbox — and (b) **negative/gap assertions** documenting the absent endpoints so coverage is explicit. Re-point these at community-service tests where the real mute/warn/prefs APIs live.

---

### TC-GCHAT-072 — Muted group shows `isMuted:true` in inbox

| Field                     | Value                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | --- | ------------------------------------------ |
| **Feature/Module**        | Group Chat / Moderation — Mute state                                                                   |
| **API/Event Name**        | `GET /api/chat/inbox` (group enrichment)                                                               |
| **Test Scenario**         | Member whose `notificationSettings.mute=true` sees the group flagged muted                             |
| **Category**              | Business Rule                                                                                          |
| **Priority**              | Medium                                                                                                 |
| **Preconditions**         | `GroupMember.notificationSettings = { mute:true, muteUntil:null }` (set directly / via community path) |
| **Request Payload**       | —                                                                                                      |
| **Expected Response**     | `200` inbox item for the group with `isMuted:true`                                                     |
| **Expected DB Changes**   | None (read-only)                                                                                       |
| **Expected Socket/Event** | None                                                                                                   |
| **Notes**                 | `getInboxGroups`: `isMuted = mute===true                                                               |     | (muteUntil && new Date(muteUntil) > now)`. |

### TC-GCHAT-073 — Timed mute expired → `isMuted:false`

| Field                     | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Moderation — Mute state                            |
| **API/Event Name**        | `GET /api/chat/inbox`                                           |
| **Test Scenario**         | `muteUntil` in the past                                         |
| **Category**              | Edge Case                                                       |
| **Priority**              | Low                                                             |
| **Preconditions**         | `notificationSettings = { mute:false, muteUntil:"<past ISO>" }` |
| **Request Payload**       | —                                                               |
| **Expected Response**     | `isMuted:false`                                                 |
| **Expected DB Changes**   | None                                                            |
| **Expected Socket/Event** | None                                                            |
| **Notes**                 | Past `muteUntil` does not mute.                                 |

### TC-GCHAT-074 — Active timed mute → `isMuted:true`

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Moderation — Mute state                              |
| **API/Event Name**        | `GET /api/chat/inbox`                                             |
| **Test Scenario**         | `muteUntil` in the future                                         |
| **Category**              | Edge Case                                                         |
| **Priority**              | Low                                                               |
| **Preconditions**         | `notificationSettings = { mute:false, muteUntil:"<future ISO>" }` |
| **Request Payload**       | —                                                                 |
| **Expected Response**     | `isMuted:true`                                                    |
| **Expected DB Changes**   | None                                                              |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | —                                                                 |

### TC-GCHAT-075 — Default notification settings on join (mute=false)

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Moderation — Defaults                                  |
| **API/Event Name**        | `POST /api/chat/group-members/add`                                  |
| **Test Scenario**         | New member gets default unmuted settings                            |
| **Category**              | DB State                                                            |
| **Priority**              | Low                                                                 |
| **Preconditions**         | Add a fresh member                                                  |
| **Request Payload**       | `{ "roomId":"grp_x", "userId":"u" }`                                |
| **Expected Response**     | `201`                                                               |
| **Expected DB Changes**   | `GroupMember.notificationSettings = { mute:false, muteUntil:null }` |
| **Expected Socket/Event** | `message:new` `MEMBER_ADDED`                                        |
| **Notes**                 | Default set by repo create/upsert.                                  |

### TC-GCHAT-076 — Mute toggle endpoint does NOT exist (gap assertion)

| Field                     | Value                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Group Chat / Moderation — Mute                                                                                                                   |
| **API/Event Name**        | (no route) e.g. `POST /api/chat/group-members/mute`                                                                                              |
| **Test Scenario**         | Attempt to mute a member via a group route                                                                                                       |
| **Category**              | Error Handling                                                                                                                                   |
| **Priority**              | Medium                                                                                                                                           |
| **Preconditions**         | Authenticated user                                                                                                                               |
| **Request Payload**       | any                                                                                                                                              |
| **Expected Response**     | `404` route not found                                                                                                                            |
| **Expected DB Changes**   | None                                                                                                                                             |
| **Expected Socket/Event** | None                                                                                                                                             |
| **Notes**                 | **Gap:** no group-chat mute API; `notificationSettings.mute` is unreachable via HTTP for group rooms. Mute/warn/prefs live in community-service. |

### TC-GCHAT-077 — Warn-member endpoint does NOT exist (gap assertion)

| Field                     | Value                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Moderation — Warn                                                                              |
| **API/Event Name**        | (no route) e.g. `POST /api/chat/group-members/warn`                                                         |
| **Test Scenario**         | Attempt to warn a member                                                                                    |
| **Category**              | Error Handling                                                                                              |
| **Priority**              | Medium                                                                                                      |
| **Preconditions**         | Authenticated user                                                                                          |
| **Request Payload**       | any                                                                                                         |
| **Expected Response**     | `404` route not found                                                                                       |
| **Expected DB Changes**   | None                                                                                                        |
| **Expected Socket/Event** | None                                                                                                        |
| **Notes**                 | **Gap:** warn feature is community-service-only; no group-chat warn route, no `MEMBER_WARNED` system event. |

### TC-GCHAT-078 — Notification-preferences endpoint does NOT exist (gap assertion)

| Field                     | Value                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Moderation — Prefs                                                                            |
| **API/Event Name**        | (no route) e.g. `PATCH /api/chat/group-members/notification-prefs`                                         |
| **Test Scenario**         | Attempt to set per-member notification prefs for a group                                                   |
| **Category**              | Error Handling                                                                                             |
| **Priority**              | Medium                                                                                                     |
| **Preconditions**         | Authenticated user                                                                                         |
| **Request Payload**       | any                                                                                                        |
| **Expected Response**     | `404` route not found                                                                                      |
| **Expected DB Changes**   | None                                                                                                       |
| **Expected Socket/Event** | None                                                                                                       |
| **Notes**                 | **Gap:** `notificationSettings` is writable only at create/upsert defaults; no update API in group routes. |

### TC-GCHAT-079 — Ban (vs kick) — no ban endpoint for group chat (gap assertion)

| Field                     | Value                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Moderation — Ban                                                                                                                                                         |
| **API/Event Name**        | (no route) e.g. `POST /api/chat/group-members/ban`                                                                                                                                    |
| **Test Scenario**         | Permanent ban so a kicked user can't be re-added                                                                                                                                      |
| **Category**              | Business Rule                                                                                                                                                                         |
| **Priority**              | Medium                                                                                                                                                                                |
| **Preconditions**         | Target is a member                                                                                                                                                                    |
| **Request Payload**       | any                                                                                                                                                                                   |
| **Expected Response**     | `404` route not found                                                                                                                                                                 |
| **Expected DB Changes**   | None                                                                                                                                                                                  |
| **Expected Socket/Event** | None                                                                                                                                                                                  |
| **Notes**                 | **Gap:** `GroupMemberStatus.BANNED` + `bannedAt/bannedBy` columns exist but are never written by any group route; a KICKED user can be freely re-added (see members.md TC-GCHAT-043). |

### TC-GCHAT-080 — Admin-delete as moderation action

| Field                     | Value                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Group Chat / Moderation — Admin delete                                                                                                          |
| **API/Event Name**        | `POST /api/chat/groups/messages/delete`                                                                                                         |
| **Test Scenario**         | Admin/moderator deletes another member's message                                                                                                |
| **Category**              | RBAC                                                                                                                                            |
| **Priority**              | High                                                                                                                                            |
| **Preconditions**         | Caller OWNER/ADMIN/MODERATOR; message authored by someone else                                                                                  |
| **Request Payload**       | `{ "messageId":"m1", "roomId":"grp_x" }`                                                                                                        |
| **Expected Response**     | `200` `deletedType:"ADMIN_DELETE"`                                                                                                              |
| **Expected DB Changes**   | Message tombstoned (`isDeleted`, `deletedType:"ADMIN_DELETE"`)                                                                                  |
| **Expected Socket/Event** | See group-messages.md — delete socket fan-out (`message:delete` is published by the socket gateway path; this HTTP path persists the tombstone) |
| **Notes**                 | The only message-level moderation present in group chat. Detailed in group-messages.md.                                                         |
