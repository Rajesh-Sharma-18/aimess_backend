# Communities — Mute settings, Notification preferences & Uploads

**Source:** `apps/community-service/src/api/routes/community.routes.ts` (`GET|PUT|DELETE /:id/mute`, `GET|PUT /:id/notification-preferences`, `POST /uploads/url`), `controllers/community.controller.ts`, `controllers/upload.controller.ts`, `validators/community.validator.ts` (`setMuteSchema`, `setNotificationPrefsSchema`), `validators/upload.validator.ts` (`uploadUrlSchema`), `services/community.service.ts`.

> **Service:** community-service. Mute = per-user, per-community **notification** mute (distinct from moderator member-mute in `moderation.md`). Notification preferences are toggles on the same mute-setting row. All require an **ACTIVE membership**.

---

### TC-COMM-131 — Set community mute (indefinite)

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Communities / Mute                             |
| **API/Event Name**        | `PUT /api/v1/communities/:id/mute`             |
| **Test Scenario**         | Member mutes notifications indefinitely        |
| **Category**              | Happy Path                                     |
| **Priority**              | Medium                                         |
| **Preconditions**         | Caller ACTIVE member                           |
| **Request Payload**       | `{}` or `{ "durationMinutes": null }`          |
| **Expected Response**     | `200` `{ communityId, mutedUntil: null, ... }` |
| **Expected DB Changes**   | mute-setting row upserted (mutedUntil null)    |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | —                                              |

### TC-COMM-132 — Set community mute (timed)

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Communities / Mute                      |
| **API/Event Name**        | `PUT /api/v1/communities/:id/mute`      |
| **Test Scenario**         | Mute for N minutes                      |
| **Category**              | Happy Path                              |
| **Priority**              | Low                                     |
| **Preconditions**         | ACTIVE member                           |
| **Request Payload**       | `{ "durationMinutes": 120 }` (1–525600) |
| **Expected Response**     | `200`; `mutedUntil` = now + N min       |
| **Expected DB Changes**   | row upserted                            |
| **Expected Socket/Event** | None                                    |
| **Notes**                 | Out of range → `400`.                   |

### TC-COMM-133 — Get community mute (not muted)

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Communities / Mute                 |
| **API/Event Name**        | `GET /api/v1/communities/:id/mute` |
| **Test Scenario**         | No mute row exists                 |
| **Category**              | Error Handling                     |
| **Priority**              | Low                                |
| **Preconditions**         | ACTIVE member, no mute set         |
| **Request Payload**       | —                                  |
| **Expected Response**     | `404` `COMMUNITY_NOT_MUTED`        |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | —                                  |

### TC-COMM-134 — Clear community mute

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Communities / Mute                    |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/mute` |
| **Test Scenario**         | Member unmutes notifications          |
| **Category**              | Happy Path                            |
| **Priority**              | Low                                   |
| **Preconditions**         | ACTIVE member                         |
| **Request Payload**       | —                                     |
| **Expected Response**     | `200` (idempotent if no row)          |
| **Expected DB Changes**   | mutedUntil cleared                    |
| **Expected Socket/Event** | None                                  |
| **Notes**                 | —                                     |

### TC-COMM-135 — Mute endpoints require ACTIVE membership

| Field                     | Value                             |
| ------------------------- | --------------------------------- | --- | ------------------------------------ |
| **Feature/Module**        | Communities / Mute                |
| **API/Event Name**        | `GET                              | PUT | DELETE /api/v1/communities/:id/mute` |
| **Test Scenario**         | Non-member / LEFT / BANNED caller |
| **Category**              | RBAC / Security                   |
| **Priority**              | High                              |
| **Preconditions**         | No ACTIVE membership              |
| **Request Payload**       | —                                 |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`       |
| **Expected DB Changes**   | None                              |
| **Expected Socket/Event** | None                              |
| **Notes**                 | Missing community → `404`.        |

### TC-COMM-136 — Get notification preferences (defaults)

| Field                     | Value                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Notification prefs                                                                            |
| **API/Event Name**        | `GET /api/v1/communities/:id/notification-preferences`                                                      |
| **Test Scenario**         | Member with no row gets implicit defaults                                                                   |
| **Category**              | Happy Path                                                                                                  |
| **Priority**              | Medium                                                                                                      |
| **Preconditions**         | ACTIVE member, no prefs row                                                                                 |
| **Request Payload**       | —                                                                                                           |
| **Expected Response**     | `200` `{ mutedUntil:null, streamEnabled:true, chatEnabled:true, announcementEnabled:true, createdAt:null }` |
| **Expected DB Changes**   | None                                                                                                        |
| **Expected Socket/Event** | None                                                                                                        |
| **Notes**                 | —                                                                                                           |

### TC-COMM-137 — Set notification preferences

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Communities / Notification prefs                                                                 |
| **API/Event Name**        | `PUT /api/v1/communities/:id/notification-preferences`                                           |
| **Test Scenario**         | Member toggles chat/stream/announcement                                                          |
| **Category**              | Happy Path                                                                                       |
| **Priority**              | Medium                                                                                           |
| **Preconditions**         | ACTIVE member                                                                                    |
| **Request Payload**       | `{ "chatEnabled": false }`                                                                       |
| **Expected Response**     | `200` updated prefs                                                                              |
| **Expected DB Changes**   | prefs upserted on mute-setting row                                                               |
| **Expected Socket/Event** | None                                                                                             |
| **Notes**                 | Empty body (no field) → `400` ("At least one preference field is required"). Non-member → `403`. |

### TC-COMM-138 — Create upload URL (presigned)

| Field                     | Value                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Uploads                                                                                                               |
| **API/Event Name**        | `POST /api/v1/communities/uploads/url`                                                                                              |
| **Test Scenario**         | Request presigned URL for a community avatar before create/update                                                                   |
| **Category**              | File Upload                                                                                                                         |
| **Priority**              | Medium                                                                                                                              |
| **Preconditions**         | Authenticated                                                                                                                       |
| **Request Payload**       | per `uploadUrlSchema` (e.g. contentType/size)                                                                                       |
| **Expected Response**     | `200`/`201` presigned upload URL + objectKey                                                                                        |
| **Expected DB Changes**   | None (object lands in storage; bound on create/update)                                                                              |
| **Expected Socket/Event** | None                                                                                                                                |
| **Notes**                 | Returned objectKey used as `avatarObjectKey`; ownership validated at create/update (TC-COMM-012). Invalid contentType/size → `400`. |

### TC-COMM-139 — Upload URL invalid payload

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Communities / Uploads                               |
| **API/Event Name**        | `POST /api/v1/communities/uploads/url`              |
| **Test Scenario**         | Bad/missing fields per `uploadUrlSchema`            |
| **Category**              | Input Validation                                    |
| **Priority**              | Low                                                 |
| **Preconditions**         | Authenticated                                       |
| **Request Payload**       | malformed body                                      |
| **Expected Response**     | `400`                                               |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | Confirm exact constraints in `upload.validator.ts`. |
