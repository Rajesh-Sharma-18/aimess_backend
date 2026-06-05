# Notifications — Preferences (Mute / Notification Settings)

**Source:**

- `apps/chat-service/src/api/routes/private-message.routes.ts`
  (`POST /api/chat/private/rooms/:roomId/mute`, `POST /api/chat/private/rooms/:roomId/unmute`)
- `apps/chat-service/src/api/controllers/private-room.controller.ts` (`muteRoom`, `unmuteRoom`)
- `apps/chat-service/src/api/validators/private-message.validator.ts` (`muteRoomSchema`)
- `apps/chat-service/src/services/group-room.service.ts` (`getInboxGroups` — reads `notificationSettings.{ mute, muteUntil }` to derive `isMuted`)

> **Scope / GAP:** The only notification-preference mechanism in the analyzed sources is
> **per-conversation mute** (stored on membership `notificationSettings = { mute?, muteUntil? }`).
> There are **no per-notification-TYPE mute endpoints** and **no global notification-preference
> endpoints** in notifications-service or chat-service notification routes. "Muted types suppressed
> before sending" is **not implemented** in the push path examined (`sendPush` has no preference
> check) — see GAPS in `_index.md`. Cases below cover the mute preference that DOES exist plus the
> intended suppression behavior to verify against any future producer.

Behavior notes:

- `muteRoom(roomId, userId, muteUntil|null)`: `muteUntil` is an optional ISO datetime (Zod
  `.datetime().nullish()`). `null`/absent → mute indefinitely (`mute:true`); a future date → mute
  until that time.
- `isMuted` derivation: `settings.mute === true || (muteUntil != null && new Date(muteUntil) > now)`.

---

### TC-NOTIF-130 — Mute a conversation indefinitely (happy path)

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Notifications / Preferences / Mute                     |
| **API/Event Name**        | `POST /api/chat/private/rooms/:roomId/mute`            |
| **Test Scenario**         | Member mutes a 1:1 room with no `muteUntil`            |
| **Category**              | Happy Path                                             |
| **Priority**              | High                                                   |
| **Preconditions**         | Caller is a member of `roomId`                         |
| **Request Payload**       | `{}` (or `{ "muteUntil": null }`)                      |
| **Expected Response**     | `200` `ApiResponse(result, "CHAT_ROOM_MUTED")`         |
| **Expected DB Changes**   | Membership `notificationSettings.mute=true` for caller |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | Inbox now reports `isMuted:true` for this room         |

---

### TC-NOTIF-131 — Mute until a future timestamp

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Notifications / Preferences / Mute            |
| **API/Event Name**        | `POST /api/chat/private/rooms/:roomId/mute`   |
| **Test Scenario**         | Mute for 8 hours                              |
| **Category**              | Optional Params                               |
| **Priority**              | Medium                                        |
| **Preconditions**         | Caller is a member                            |
| **Request Payload**       | `{ "muteUntil": "2026-06-04T00:00:00.000Z" }` |
| **Expected Response**     | `200` `CHAT_ROOM_MUTED`                       |
| **Expected DB Changes**   | `notificationSettings.muteUntil` stored       |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | `isMuted` true only while `muteUntil > now`   |

---

### TC-NOTIF-132 — Mute with invalid muteUntil format

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Notifications / Preferences / Mute          |
| **API/Event Name**        | `POST /api/chat/private/rooms/:roomId/mute` |
| **Test Scenario**         | `muteUntil` not ISO datetime                |
| **Category**              | Input Validation                            |
| **Priority**              | Medium                                      |
| **Preconditions**         | Caller is a member                          |
| **Request Payload**       | `{ "muteUntil": "tomorrow" }`               |
| **Expected Response**     | `400` (`muteRoomSchema` `.datetime()`)      |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | —                                           |

---

### TC-NOTIF-133 — Mute a room the caller is not a member of (AuthZ)

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Notifications / Preferences / Mute                                 |
| **API/Event Name**        | `POST /api/chat/private/rooms/:roomId/mute`                        |
| **Test Scenario**         | Non-member tries to mute                                           |
| **Category**              | AuthZ                                                              |
| **Priority**              | High                                                               |
| **Preconditions**         | Caller not in `roomId`                                             |
| **Request Payload**       | `{}`                                                               |
| **Expected Response**     | `403`/`404` (verify `muteRoom` service membership guard)           |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | Confirm service rejects non-members rather than silently upserting |

---

### TC-NOTIF-134 — Mute without auth

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Notifications / Preferences / Mute          |
| **API/Event Name**        | `POST /api/chat/private/rooms/:roomId/mute` |
| **Test Scenario**         | No auth header                              |
| **Category**              | AuthN                                       |
| **Priority**              | High                                        |
| **Preconditions**         | None                                        |
| **Request Payload**       | `{}`                                        |
| **Expected Response**     | `401` Unauthorized                          |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | —                                           |

---

### TC-NOTIF-135 — Unmute a conversation (happy path)

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Notifications / Preferences / Mute                      |
| **API/Event Name**        | `POST /api/chat/private/rooms/:roomId/unmute`           |
| **Test Scenario**         | Member unmutes a previously muted room                  |
| **Category**              | Happy Path                                              |
| **Priority**              | High                                                    |
| **Preconditions**         | Room muted by caller                                    |
| **Request Payload**       | (empty body)                                            |
| **Expected Response**     | `200` `CHAT_ROOM_UNMUTED`                               |
| **Expected DB Changes**   | `notificationSettings.mute=false` / `muteUntil` cleared |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | Inbox `isMuted:false` afterward                         |

---

### TC-NOTIF-136 — Unmute an already-unmuted room (idempotent)

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Notifications / Preferences / Mute            |
| **API/Event Name**        | `POST /api/chat/private/rooms/:roomId/unmute` |
| **Test Scenario**         | Unmute when not muted                         |
| **Category**              | Edge Case                                     |
| **Priority**              | Low                                           |
| **Preconditions**         | Room not muted                                |
| **Request Payload**       | (empty)                                       |
| **Expected Response**     | `200` `CHAT_ROOM_UNMUTED` (no-op)             |
| **Expected DB Changes**   | None / settings already cleared               |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |

---

### TC-NOTIF-137 — Muted room suppresses push (business rule — to verify)

| Field                     | Value                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Preferences / Suppression                                                                   |
| **API/Event Name**        | (producer) push fan-out honoring mute                                                                       |
| **Test Scenario**         | A message arrives in a muted room; no push to muting user                                                   |
| **Category**              | Business Rule                                                                                               |
| **Priority**              | High                                                                                                        |
| **Preconditions**         | User muted `roomId`; a new message is sent there                                                            |
| **Request Payload**       | message:send into muted room                                                                                |
| **Expected Response**     | No FCM push to that user for that room while muted                                                          |
| **Expected DB Changes**   | Notification row may still be created (in-app feed) — verify intended behavior                              |
| **Expected Socket/Event** | In-app `notify:<userId>` forward may still fire; push suppressed                                            |
| **Notes**                 | GAP: no push consumer currently reads `notificationSettings` before `sendPush`. Document expected vs actual |

---

### TC-NOTIF-138 — Expired muteUntil no longer suppresses

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Notifications / Preferences / Suppression                  |
| **API/Event Name**        | inbox `isMuted` derivation                                 |
| **Test Scenario**         | `muteUntil` is in the past                                 |
| **Category**              | Business Rule                                              |
| **Priority**              | Medium                                                     |
| **Preconditions**         | `muteUntil` < now, `mute` not explicitly true              |
| **Request Payload**       | `GET` inbox                                                |
| **Expected Response**     | `isMuted:false` (time window elapsed)                      |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | `new Date(muteUntil).getTime() > now` is false → not muted |
