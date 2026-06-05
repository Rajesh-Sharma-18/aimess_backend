# Notifications — Device Token Registration

**Source:**

- `apps/notifications-service/src/routes/device.routes.ts`
- `apps/notifications-service/src/api/controllers/device.controller.ts`
- `apps/notifications-service/src/api/validators/device.validator.ts`
- `apps/notifications-service/src/services/device-token.service.ts`
- `apps/notifications-service/src/repositories/device-token.repository.ts`
- `apps/notifications-service/prisma/schema.prisma` (`DeviceToken`)

Endpoints:

- `POST /v1/devices` — upsert the caller's FCM token (auth required)
- `DELETE /v1/devices/:token` — unregister one of the caller's tokens (auth required)

Notes on behavior:

- `DeviceToken.token` is **globally unique**. Upsert keys on `token`; re-registering an
  existing token **moves ownership** to the new `userId` and refreshes `platform`/`deviceId`/`lastSeenAt`.
- `registerDevice` always returns `{ success: true }` on success; controller catches errors → `500`.
- `unregisterDevice` is **scoped to the caller** (`deleteByUserAndToken(userId, token)`), returns
  `{ success: true, removed: <bool> }`. `removed:false` when no matching row for that user.

---

### TC-NOTIF-001 — Register a new device token (happy path)

| Field                     | Value                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Notifications / Device Registration                                                                    |
| **API/Event Name**        | `POST /v1/devices`                                                                                     |
| **Test Scenario**         | Authenticated user registers a new FCM token                                                           |
| **Category**              | Happy Path                                                                                             |
| **Priority**              | High                                                                                                   |
| **Preconditions**         | Valid access token; `token` not already in `device_tokens`                                             |
| **Request Payload**       | `{ "token": "fcm-tok-abc123", "platform": "ANDROID", "deviceId": "pixel-7" }`                          |
| **Expected Response**     | `200` `{ "success": true }`                                                                            |
| **Expected DB Changes**   | New `DeviceToken` row: `{ userId=<caller>, token, platform, deviceId, lastSeenAt=now, createdAt=now }` |
| **Expected Socket/Event** | None                                                                                                   |
| **Notes**                 | `deviceId` optional; absent → stored as `null`                                                         |

---

### TC-NOTIF-002 — Register without optional deviceId

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration             |
| **API/Event Name**        | `POST /v1/devices`                              |
| **Test Scenario**         | Register with only required fields              |
| **Category**              | Optional Params                                 |
| **Priority**              | Medium                                          |
| **Preconditions**         | Valid access token                              |
| **Request Payload**       | `{ "token": "fcm-tok-xyz", "platform": "IOS" }` |
| **Expected Response**     | `200` `{ "success": true }`                     |
| **Expected DB Changes**   | New row with `deviceId = null`                  |
| **Expected Socket/Event** | None                                            |
| **Notes**                 | Validator marks `deviceId` `.optional()`        |

---

### TC-NOTIF-003 — Re-register existing token (idempotent upsert / token refresh)

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                                           |
| **API/Event Name**        | `POST /v1/devices`                                                            |
| **Test Scenario**         | Same user re-registers an already-stored token                                |
| **Category**              | Business Rule                                                                 |
| **Priority**              | High                                                                          |
| **Preconditions**         | `token` already exists for this user (from TC-NOTIF-001)                      |
| **Request Payload**       | `{ "token": "fcm-tok-abc123", "platform": "ANDROID", "deviceId": "pixel-7" }` |
| **Expected Response**     | `200` `{ "success": true }`                                                   |
| **Expected DB Changes**   | **No new row**; existing row updated, `lastSeenAt` bumped to now              |
| **Expected Socket/Event** | None                                                                          |
| **Notes**                 | Upsert on unique `token`; dedupe by design — no duplicate tokens              |

---

### TC-NOTIF-004 — Re-register a token owned by another user (ownership move)

| Field                     | Value                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                                                                                                               |
| **API/Event Name**        | `POST /v1/devices`                                                                                                                                |
| **Test Scenario**         | User B registers a token currently owned by User A                                                                                                |
| **Category**              | Business Rule                                                                                                                                     |
| **Priority**              | High                                                                                                                                              |
| **Preconditions**         | Token `fcm-tok-abc123` currently owned by User A                                                                                                  |
| **Request Payload**       | (as User B) `{ "token": "fcm-tok-abc123", "platform": "ANDROID" }`                                                                                |
| **Expected Response**     | `200` `{ "success": true }`                                                                                                                       |
| **Expected DB Changes**   | Row `userId` changes from A → B; A loses that token                                                                                               |
| **Expected Socket/Event** | None                                                                                                                                              |
| **Notes**                 | Intentional: a physical device handed off / re-logged-in moves the token. See TC-NOTIF-005 for the upstream concern (device handoff after logout) |

---

### TC-NOTIF-005 — Platform updated when re-registering with different platform

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                                                         |
| **API/Event Name**        | `POST /v1/devices`                                                                          |
| **Test Scenario**         | Existing token re-sent with a changed platform value                                        |
| **Category**              | DB State                                                                                    |
| **Priority**              | Low                                                                                         |
| **Preconditions**         | Token exists with `platform=ANDROID`                                                        |
| **Request Payload**       | `{ "token": "fcm-tok-abc123", "platform": "WEB" }`                                          |
| **Expected Response**     | `200` `{ "success": true }`                                                                 |
| **Expected DB Changes**   | `platform` updated to `WEB`; `deviceId` set to `null` (not sent)                            |
| **Expected Socket/Event** | None                                                                                        |
| **Notes**                 | Upsert `update` block overwrites `deviceId` with `null` when omitted — known data-loss edge |

---

### TC-NOTIF-006 — Missing token field

| Field                     | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| **Feature/Module**        | Notifications / Device Registration                                      |
| **API/Event Name**        | `POST /v1/devices`                                                       |
| **Test Scenario**         | Body omits `token`                                                       |
| **Category**              | Input Validation                                                         |
| **Priority**              | High                                                                     |
| **Preconditions**         | Valid access token                                                       |
| **Request Payload**       | `{ "platform": "ANDROID" }`                                              |
| **Expected Response**     | `400` `{ "success": false, "message": "Invalid body", "issues": [...] }` |
| **Expected DB Changes**   | None                                                                     |
| **Expected Socket/Event** | None                                                                     |
| **Notes**                 | Zod `token: z.string().min(1)`                                           |

---

### TC-NOTIF-007 — Empty token string

| Field                     | Value                                |
| ------------------------- | ------------------------------------ |
| **Feature/Module**        | Notifications / Device Registration  |
| **API/Event Name**        | `POST /v1/devices`                   |
| **Test Scenario**         | `token` is `""`                      |
| **Category**              | Input Validation                     |
| **Priority**              | Medium                               |
| **Preconditions**         | Valid access token                   |
| **Request Payload**       | `{ "token": "", "platform": "IOS" }` |
| **Expected Response**     | `400` Invalid body (min(1) violated) |
| **Expected DB Changes**   | None                                 |
| **Expected Socket/Event** | None                                 |
| **Notes**                 | —                                    |

---

### TC-NOTIF-008 — Token exceeds max length (4096)

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Notifications / Device Registration              |
| **API/Event Name**        | `POST /v1/devices`                               |
| **Test Scenario**         | `token` length 4097                              |
| **Category**              | Input Validation                                 |
| **Priority**              | Low                                              |
| **Preconditions**         | Valid access token                               |
| **Request Payload**       | `{ "token": "<4097 chars>", "platform": "WEB" }` |
| **Expected Response**     | `400` Invalid body (`max(4096)`)                 |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | —                                                |

---

### TC-NOTIF-009 — Invalid platform enum value

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                     |
| **API/Event Name**        | `POST /v1/devices`                                      |
| **Test Scenario**         | `platform` not in `ANDROID\|IOS\|WEB`                   |
| **Category**              | Input Validation                                        |
| **Priority**              | High                                                    |
| **Preconditions**         | Valid access token                                      |
| **Request Payload**       | `{ "token": "tok", "platform": "android" }` (lowercase) |
| **Expected Response**     | `400` Invalid body (enum mismatch — case-sensitive)     |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | Enum is uppercase only                                  |

---

### TC-NOTIF-010 — deviceId exceeds max length (256)

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Notifications / Device Registration                                |
| **API/Event Name**        | `POST /v1/devices`                                                 |
| **Test Scenario**         | `deviceId` length 257                                              |
| **Category**              | Input Validation                                                   |
| **Priority**              | Low                                                                |
| **Preconditions**         | Valid access token                                                 |
| **Request Payload**       | `{ "token": "tok", "platform": "IOS", "deviceId": "<257 chars>" }` |
| **Expected Response**     | `400` Invalid body (`max(256)`)                                    |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | —                                                                  |

---

### TC-NOTIF-011 — Register without auth token

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                                  |
| **API/Event Name**        | `POST /v1/devices`                                                   |
| **Test Scenario**         | No `Authorization` header                                            |
| **Category**              | AuthN                                                                |
| **Priority**              | High                                                                 |
| **Preconditions**         | None                                                                 |
| **Request Payload**       | `{ "token": "tok", "platform": "ANDROID" }`                          |
| **Expected Response**     | `401` Unauthorized                                                   |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | `createAuthenticateAccessToken` middleware rejects before controller |

---

### TC-NOTIF-012 — Register with expired/invalid access token

| Field                     | Value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                                             |
| **API/Event Name**        | `POST /v1/devices`                                                              |
| **Test Scenario**         | Tampered or expired JWT                                                         |
| **Category**              | AuthN                                                                           |
| **Priority**              | High                                                                            |
| **Preconditions**         | None                                                                            |
| **Request Payload**       | `{ "token": "tok", "platform": "ANDROID" }` + `Authorization: Bearer <expired>` |
| **Expected Response**     | `401` Unauthorized                                                              |
| **Expected DB Changes**   | None                                                                            |
| **Expected Socket/Event** | None                                                                            |
| **Notes**                 | —                                                                               |

---

### TC-NOTIF-013 — token owner derived from JWT, not body (no userId injection)

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                                                                |
| **API/Event Name**        | `POST /v1/devices`                                                                                 |
| **Test Scenario**         | Body includes a spoofed `userId` for another user                                                  |
| **Category**              | Security                                                                                           |
| **Priority**              | High                                                                                               |
| **Preconditions**         | Valid access token for User A                                                                      |
| **Request Payload**       | `{ "token": "tok", "platform": "IOS", "userId": "<User B id>" }`                                   |
| **Expected Response**     | `200` `{ "success": true }`                                                                        |
| **Expected DB Changes**   | Row created with `userId = User A` (from `req.auth.userId`); body `userId` ignored (not in schema) |
| **Expected Socket/Event** | None                                                                                               |
| **Notes**                 | Controller uses `req.auth.userId`; extra body keys stripped by Zod object                          |

---

### TC-NOTIF-014 — Unregister own token (happy path)

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration          |
| **API/Event Name**        | `DELETE /v1/devices/:token`                  |
| **Test Scenario**         | Caller deletes a token they own              |
| **Category**              | Happy Path                                   |
| **Priority**              | High                                         |
| **Preconditions**         | Token `fcm-tok-abc123` exists for caller     |
| **Request Payload**       | `DELETE /v1/devices/fcm-tok-abc123`          |
| **Expected Response**     | `200` `{ "success": true, "removed": true }` |
| **Expected DB Changes**   | Row deleted                                  |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | —                                            |

---

### TC-NOTIF-015 — Unregister a non-existent token

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                       |
| **API/Event Name**        | `DELETE /v1/devices/:token`                               |
| **Test Scenario**         | Token not present for caller                              |
| **Category**              | Edge Case                                                 |
| **Priority**              | Medium                                                    |
| **Preconditions**         | Valid access token; token absent                          |
| **Request Payload**       | `DELETE /v1/devices/does-not-exist`                       |
| **Expected Response**     | `200` `{ "success": true, "removed": false }`             |
| **Expected DB Changes**   | None                                                      |
| **Expected Socket/Event** | None                                                      |
| **Notes**                 | Idempotent delete; `removed:false` signals no row matched |

---

### TC-NOTIF-016 — Cannot unregister another user's token (AuthZ / IDOR)

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                           |
| **API/Event Name**        | `DELETE /v1/devices/:token`                                   |
| **Test Scenario**         | User B tries to delete User A's token                         |
| **Category**              | AuthZ                                                         |
| **Priority**              | High                                                          |
| **Preconditions**         | Token `fcm-tok-A` owned by User A                             |
| **Request Payload**       | (as User B) `DELETE /v1/devices/fcm-tok-A`                    |
| **Expected Response**     | `200` `{ "success": true, "removed": false }`                 |
| **Expected DB Changes**   | None — A's row untouched (`deleteByUserAndToken` scoped to B) |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | No 403; scoping silently prevents cross-user deletion         |

---

### TC-NOTIF-017 — Unregister without auth

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Notifications / Device Registration |
| **API/Event Name**        | `DELETE /v1/devices/:token`         |
| **Test Scenario**         | No auth header                      |
| **Category**              | AuthN                               |
| **Priority**              | High                                |
| **Preconditions**         | None                                |
| **Request Payload**       | `DELETE /v1/devices/tok`            |
| **Expected Response**     | `401` Unauthorized                  |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | —                                   |

---

### TC-NOTIF-018 — Multi-device registration (same user, distinct tokens)

| Field                     | Value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                                                     |
| **API/Event Name**        | `POST /v1/devices`                                                                      |
| **Test Scenario**         | One user registers 3 different device tokens                                            |
| **Category**              | Concurrency                                                                             |
| **Priority**              | Medium                                                                                  |
| **Preconditions**         | Valid access token                                                                      |
| **Request Payload**       | 3 parallel POSTs with distinct tokens (`tok-a1`, `tok-a2`, `tok-a3`)                    |
| **Expected Response**     | `200` each                                                                              |
| **Expected DB Changes**   | 3 rows for same `userId`; `findTokensByUserId` returns all 3 → push fans to all devices |
| **Expected Socket/Event** | None                                                                                    |
| **Notes**                 | `@@index([userId])` supports fan-out lookup                                             |

---

### TC-NOTIF-019 — Concurrent re-register of same token (race)

| Field                     | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| **Feature/Module**        | Notifications / Device Registration                                        |
| **API/Event Name**        | `POST /v1/devices`                                                         |
| **Test Scenario**         | Two simultaneous upserts of the same brand-new token                       |
| **Category**              | Concurrency                                                                |
| **Priority**              | Medium                                                                     |
| **Preconditions**         | Token does not yet exist                                                   |
| **Request Payload**       | 2 parallel POSTs, same `token`                                             |
| **Expected Response**     | `200` for both (or one `500` if a unique-constraint race surfaces)         |
| **Expected DB Changes**   | Exactly **one** row (unique `token`); no duplicate                         |
| **Expected Socket/Event** | None                                                                       |
| **Notes**                 | Verify Prisma upsert handles the create/create race without leaving 2 rows |
