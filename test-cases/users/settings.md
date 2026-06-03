# USERS — Settings

Source: `apps/user-service/src/api/routes/settings.routes.ts`, `controllers/settings.controller.ts`, `validators/settings.validator.ts`, `services/user-settings.service.ts`, `repositories/user-settings.repository.ts`.

Endpoints:

- `GET /api/v1/users/settings/me` — fetch own settings bundle (privacy, chat, app, notifications, liveStream)
- `PATCH /api/v1/users/settings/me` — partial update of any settings group

---

### TC-USER-042 — Get my settings (happy path)

| Field                     | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                                                |
| **API/Event Name**        | `GET /api/v1/users/settings/me`                                                                 |
| **Test Scenario**         | Authenticated user fetches full settings bundle                                                 |
| **Category**              | Happy Path                                                                                      |
| **Priority**              | High                                                                                            |
| **Preconditions**         | Profile exists; settings rows present                                                           |
| **Request Payload**       | None; Bearer token                                                                              |
| **Expected Response**     | `200` `{ data: { privacy, chat, app, notifications:{...,quietHours}, liveStream, updatedAt } }` |
| **Expected DB Changes**   | None (may lazily create default settings if missing)                                            |
| **Expected Socket/Event** | None                                                                                            |
| **Notes**                 | `updatedAt` = max of all five group updatedAt timestamps.                                       |

### TC-USER-043 — Get settings auto-creates defaults when incomplete

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                  |
| **API/Event Name**        | `GET /api/v1/users/settings/me`                                   |
| **Test Scenario**         | One or more settings groups missing → defaults seeded             |
| **Category**              | DB State                                                          |
| **Priority**              | Medium                                                            |
| **Preconditions**         | Profile exists but settings bundle incomplete                     |
| **Request Payload**       | None                                                              |
| **Expected Response**     | `200` complete bundle                                             |
| **Expected DB Changes**   | `ensureDefaultSettings` inserts missing group rows                |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | If still incomplete after ensure → `404 USER_SETTINGS_NOT_FOUND`. |

### TC-USER-044 — Get settings: no profile

| Field                     | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                |
| **API/Event Name**        | `GET /api/v1/users/settings/me`                                 |
| **Test Scenario**         | Profile soft-deleted or missing                                 |
| **Category**              | Error Handling                                                  |
| **Priority**              | Medium                                                          |
| **Preconditions**         | No active profile (deletedAt set)                               |
| **Request Payload**       | None                                                            |
| **Expected Response**     | `404` `USER_PROFILE_NOT_FOUND`                                  |
| **Expected DB Changes**   | None                                                            |
| **Expected Socket/Event** | None                                                            |
| **Notes**                 | `loadSettingsBundle` throws when bundle missing or `deletedAt`. |

### TC-USER-045 — Get settings requires auth

| Field                     | Value                           |
| ------------------------- | ------------------------------- |
| **Feature/Module**        | Users / Settings                |
| **API/Event Name**        | `GET /api/v1/users/settings/me` |
| **Test Scenario**         | No Bearer token                 |
| **Category**              | AuthN                           |
| **Priority**              | High                            |
| **Preconditions**         | None                            |
| **Request Payload**       | None                            |
| **Expected Response**     | `401`                           |
| **Expected DB Changes**   | None                            |
| **Expected Socket/Event** | None                            |
| **Notes**                 | —                               |

### TC-USER-046 — Update privacy scopes (happy path)

| Field                     | Value                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                                          |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                                         |
| **Test Scenario**         | Update whoCanFindMe + whoCanViewProfile                                                   |
| **Category**              | Happy Path                                                                                |
| **Priority**              | High                                                                                      |
| **Preconditions**         | Settings exist                                                                            |
| **Request Payload**       | `{ "privacy": { "whoCanFindMe": "FRIENDS_OF_FRIENDS", "whoCanViewProfile": "FRIENDS" } }` |
| **Expected Response**     | `200` updated bundle                                                                      |
| **Expected DB Changes**   | PrivacySettings columns updated                                                           |
| **Expected Socket/Event** | RabbitMQ `settings.updated` (`publishSettingsUpdatedSafe`) — not socket                   |
| **Notes**                 | Enum sets differ per field — see validator.                                               |

### TC-USER-047 — Update each group independently

| Field                     | Value                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Users / Settings                                                                                                                                                   |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                                                                                                                  |
| **Test Scenario**         | chat, app, notifications, liveStream updated in separate requests                                                                                                  |
| **Category**              | Happy Path                                                                                                                                                         |
| **Priority**              | Medium                                                                                                                                                             |
| **Preconditions**         | Settings exist                                                                                                                                                     |
| **Request Payload**       | e.g. `{ "chat": { "readReceipts": false } }`, `{ "app": { "theme": "DARK", "language": "vi" } }`, `{ "liveStream": { "defaultVideoQuality": "DATA_SAVER_480P" } }` |
| **Expected Response**     | `200` reflecting change                                                                                                                                            |
| **Expected DB Changes**   | Corresponding group row updated; `settings.updated` published                                                                                                      |
| **Expected Socket/Event** | `settings.updated` (RabbitMQ)                                                                                                                                      |
| **Notes**                 | Notification keys map to DB columns (`chat`→`chatEnabled`, etc.).                                                                                                  |

### TC-USER-048 — Update notifications including quietHours

| Field                     | Value                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Users / Settings                                                                                                               |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                                                                              |
| **Test Scenario**         | Toggle notification categories + set quiet hours window/days                                                                   |
| **Category**              | Happy Path                                                                                                                     |
| **Priority**              | Medium                                                                                                                         |
| **Preconditions**         | Settings exist                                                                                                                 |
| **Request Payload**       | `{ "notifications": { "chat": false, "quietHours": { "enabled": true, "start": "22:00", "end": "07:00", "days": [0,6,6] } } }` |
| **Expected Response**     | `200`; `days` deduped to `[0,6]`                                                                                               |
| **Expected DB Changes**   | NotificationSettings + quiet-hours columns                                                                                     |
| **Expected Socket/Event** | `settings.updated`                                                                                                             |
| **Notes**                 | `days` transform dedupes via Set; max 7 entries; each 0..6.                                                                    |

### TC-USER-049 — Empty update body rejected

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                          |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                         |
| **Test Scenario**         | No settings group present                                 |
| **Category**              | Input Validation                                          |
| **Priority**              | Medium                                                    |
| **Preconditions**         | Authenticated user                                        |
| **Request Payload**       | `{}`                                                      |
| **Expected Response**     | `400` "At least one settings group is required to update" |
| **Expected DB Changes**   | None                                                      |
| **Expected Socket/Event** | None                                                      |
| **Notes**                 | Top-level `.refine`.                                      |

### TC-USER-050 — Empty group object rejected

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                                   |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                                  |
| **Test Scenario**         | A group present but with no fields                                                 |
| **Category**              | Input Validation                                                                   |
| **Priority**              | Medium                                                                             |
| **Preconditions**         | Authenticated user                                                                 |
| **Request Payload**       | `{ "privacy": {} }`                                                                |
| **Expected Response**     | `400` "Privacy settings must include at least one field when provided"             |
| **Expected DB Changes**   | None                                                                               |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | Per-group `hasAtLeastOneKey` refine for privacy/chat/app/notifications/liveStream. |

### TC-USER-051 — Unknown keys rejected (strict schema)

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                                 |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                                |
| **Test Scenario**         | Extra/unknown field at top level or inside a group                               |
| **Category**              | Input Validation                                                                 |
| **Priority**              | Medium                                                                           |
| **Preconditions**         | Authenticated user                                                               |
| **Request Payload**       | `{ "privacy": { "whoCanFindMe": "EVERYONE", "hacked": true } }` / `{ "foo": 1 }` |
| **Expected Response**     | `400` unrecognized key                                                           |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | None                                                                             |
| **Notes**                 | All settings sub-schemas use `.strict()` — unlike profile schema.                |

### TC-USER-052 — Enum validation per scope field

| Field                     | Value                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                                                                                                                                   |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                                                                                                                                  |
| **Test Scenario**         | Invalid enum values per field's distinct option set                                                                                                                                |
| **Category**              | Input Validation                                                                                                                                                                   |
| **Priority**              | Medium                                                                                                                                                                             |
| **Preconditions**         | Authenticated user                                                                                                                                                                 |
| **Request Payload**       | `{ "privacy": { "whoCanSeeOnlineStatus": "FRIENDS_OF_FRIENDS" } }` (not allowed for this field)                                                                                    |
| **Expected Response**     | `400` invalid enum                                                                                                                                                                 |
| **Expected DB Changes**   | None                                                                                                                                                                               |
| **Expected Socket/Event** | None                                                                                                                                                                               |
| **Notes**                 | onlineStatus allows EVERYONE/FRIENDS/NO_ONE only; whoCanCallMe allows FRIENDS/SELECTED_FRIENDS/NO_ONE; language en/vi/th; theme LIGHT/DARK/AUTO; autoDeleteTimer OFF/DAYS_7/15/30. |

### TC-USER-053 — quietHours time format validation

| Field                     | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- | ------------------ |
| **Feature/Module**        | Users / Settings                                                        |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                       |
| **Test Scenario**         | start/end not HH:mm 24h                                                 |
| **Category**              | Input Validation                                                        |
| **Priority**              | Low                                                                     |
| **Preconditions**         | Authenticated user                                                      |
| **Request Payload**       | `{ "notifications": { "quietHours": { "start": "25:00" } } }` / `"7:5"` |
| **Expected Response**     | `400` "Time must be in HH:mm 24-hour format"                            |
| **Expected DB Changes**   | None                                                                    |
| **Expected Socket/Event** | None                                                                    |
| **Notes**                 | Regex `^([01]\d                                                         | 2[0-3]):[0-5]\d$`. |

### TC-USER-054 — quietHours days bounds

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                     |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                    |
| **Test Scenario**         | day value out of 0..6 or > 7 entries                                 |
| **Category**              | Input Validation                                                     |
| **Priority**              | Low                                                                  |
| **Preconditions**         | Authenticated user                                                   |
| **Request Payload**       | `{ "notifications": { "quietHours": { "days": [7] } } }` / 8 entries |
| **Expected Response**     | `400`                                                                |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | int min 0 max 6; array max 7 (before dedupe).                        |

### TC-USER-055 — callAllowedFriendIds UUID + max validation

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                      |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                     |
| **Test Scenario**         | Non-UUID entry or > 500 ids                                           |
| **Category**              | Input Validation                                                      |
| **Priority**              | Medium                                                                |
| **Preconditions**         | Authenticated user                                                    |
| **Request Payload**       | `{ "privacy": { "callAllowedFriendIds": ["not-a-uuid"] } }` / 501 ids |
| **Expected Response**     | `400` "Invalid user id" / array max                                   |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | None                                                                  |
| **Notes**                 | `z.array(uuid).max(500)`.                                             |

### TC-USER-056 — Business rule: cannot put self in callAllowedFriendIds

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                    |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                   |
| **Test Scenario**         | callAllowedFriendIds contains caller's own userId                   |
| **Category**              | Business Rule                                                       |
| **Priority**              | Medium                                                              |
| **Preconditions**         | Authenticated as A                                                  |
| **Request Payload**       | `{ "privacy": { "callAllowedFriendIds": ["<A's userId>"] } }`       |
| **Expected Response**     | `400` `USER_SETTINGS_INVALID_CALL_ALLOW_LIST`                       |
| **Expected DB Changes**   | None                                                                |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | `normalizeCallAllowedFriendIds` dedupes and rejects self-inclusion. |

### TC-USER-057 — callAllowedFriendIds deduped before persist

| Field                     | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| **Feature/Module**        | Users / Settings                                                         |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                        |
| **Test Scenario**         | Duplicate friend ids supplied                                            |
| **Category**              | Edge Case                                                                |
| **Priority**              | Low                                                                      |
| **Preconditions**         | Valid friend ids                                                         |
| **Request Payload**       | `{ "privacy": { "callAllowedFriendIds": ["<id1>", "<id1>", "<id2>"] } }` |
| **Expected Response**     | `200`; allow list stored as unique set                                   |
| **Expected DB Changes**   | CallPrivacyAllowList rows reflect unique ids                             |
| **Expected Socket/Event** | `settings.updated`                                                       |
| **Notes**                 | Set dedupe in `normalizeCallAllowedFriendIds`.                           |

### TC-USER-058 — Privacy update with only callAllowedFriendIds

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                  |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                 |
| **Test Scenario**         | privacy group contains only the allow list (no scalar scopes)     |
| **Category**              | Edge Case                                                         |
| **Priority**              | Low                                                               |
| **Preconditions**         | Settings exist                                                    |
| **Request Payload**       | `{ "privacy": { "callAllowedFriendIds": ["<id>"] } }`             |
| **Expected Response**     | `200`; only allow list changes, no scalar privacy columns touched |
| **Expected DB Changes**   | Allow list updated; `privacyFields` is undefined (rest empty)     |
| **Expected Socket/Event** | `settings.updated`                                                |
| **Notes**                 | Service separates allow list from scalar privacy fields.          |

### TC-USER-059 — Settings update requires auth

| Field                     | Value                             |
| ------------------------- | --------------------------------- |
| **Feature/Module**        | Users / Settings                  |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me` |
| **Test Scenario**         | No token                          |
| **Category**              | AuthN                             |
| **Priority**              | High                              |
| **Preconditions**         | None                              |
| **Request Payload**       | `{ "app": { "theme": "DARK" } }`  |
| **Expected Response**     | `401`                             |
| **Expected DB Changes**   | None                              |
| **Expected Socket/Event** | None                              |
| **Notes**                 | —                                 |

### TC-USER-060 — Security: settings scoped to caller only

| Field                     | Value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                                        |
| **API/Event Name**        | `GET/PATCH /api/v1/users/settings/me`                                                   |
| **Test Scenario**         | userId always from `req.auth.userId`, never body                                        |
| **Category**              | Security                                                                                |
| **Priority**              | High                                                                                    |
| **Preconditions**         | Authenticated as A                                                                      |
| **Request Payload**       | Body attempts `{ "userId": "<B>", "app": { "theme": "DARK" } }`                         |
| **Expected Response**     | `400` (strict schema rejects unknown `userId`)                                          |
| **Expected DB Changes**   | None                                                                                    |
| **Expected Socket/Event** | None                                                                                    |
| **Notes**                 | Strict schema actually rejects the extra key — stronger than profile. No IDOR possible. |

### TC-USER-061 — Concurrency: simultaneous settings PATCH on different groups

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Settings                                                            |
| **API/Event Name**        | `PATCH /api/v1/users/settings/me`                                           |
| **Test Scenario**         | Two requests update app and chat groups concurrently                        |
| **Category**              | Concurrency                                                                 |
| **Priority**              | Low                                                                         |
| **Preconditions**         | Settings exist                                                              |
| **Request Payload**       | Req1 `{ "app": {...} }`, Req2 `{ "chat": {...} }`                           |
| **Expected Response**     | Both `200`; both changes persisted                                          |
| **Expected DB Changes**   | Distinct rows updated; no lost update across groups                         |
| **Expected Socket/Event** | `settings.updated` x2                                                       |
| **Notes**                 | Verify same-group concurrent writes are last-write-wins without corruption. |
