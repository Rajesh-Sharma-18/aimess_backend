# USERS — Avatar / Upload URL (presigned)

> ℹ️ **NOTE (2026-06-12).** `POST /api/v1/users/uploads/url` is a supported gateway alias that
> forwards to the centralized **media-service**. The equivalent direct call is
> **`POST /api/v1/media/upload-url`** with **`category: "USER_AVATAR"`** (was `type: "AVATAR"`).
> The response contract and the generated `objectKey` (`avatars/{userId}/{uuid}.ext`) are
> **unchanged**, so the `PATCH /profiles/me { avatarObjectKey }` step still works as-is.
> Canonical executable coverage now lives in `apps/media-service/tests/media/upload.test.ts`.
> The cases below are retained for historical reference; the request field is now `category`.

Source (historical — files deleted): `apps/user-service/src/api/routes/upload.routes.ts`, `controllers/upload.controller.ts`, `validators/upload.validator.ts`, `services/upload.service.ts`, `config/uploads.ts`. Replacement: `apps/media-service/src/{services/media.service.ts, api/controllers/media.controller.ts, api/validators/media.validator.ts, config/uploads.ts}`, `packages/storage/src/*`. Note: actual binary upload goes directly to MinIO via the returned presigned PUT URL; size/ownership is re-checked when the key is attached in `PATCH /profiles/me` (see profile.md TC-USER-019..023).

Endpoints:

- ~~`POST /api/v1/users/uploads/url`~~ → **`POST /api/v1/media/upload-url`** (`category: "USER_AVATAR"`) — create a presigned upload URL + object key for an avatar

---

### TC-USER-067 — Create avatar upload URL (happy path)

| Field                     | Value                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Upload                                                                                                   |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                                                                 |
| **Test Scenario**         | Valid AVATAR upload request                                                                                      |
| **Category**              | Happy Path                                                                                                       |
| **Priority**              | High                                                                                                             |
| **Preconditions**         | Authenticated user; MinIO reachable                                                                              |
| **Request Payload**       | `{ "type": "AVATAR", "contentType": "image/jpeg", "contentLength": 204800 }`                                     |
| **Expected Response**     | `200` `{ data: { uploadUrl, objectKey, uploadExpiresIn, maxBytes, headers: { "Content-Type": "image/jpeg" } } }` |
| **Expected DB Changes**   | None (no DB write; presign only)                                                                                 |
| **Expected Socket/Event** | None                                                                                                             |
| **Notes**                 | objectKey = `avatars/<ownStorage ownerId>/<uuid>.jpg` (ownerId from token).                                      |

### TC-USER-068 — File Upload: unsupported MIME type

| Field                     | Value                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Upload                                                                                              |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                                                            |
| **Test Scenario**         | contentType not in allowed avatar set                                                                       |
| **Category**              | File Upload                                                                                                 |
| **Priority**              | High                                                                                                        |
| **Preconditions**         | Authenticated user                                                                                          |
| **Request Payload**       | `{ "type": "AVATAR", "contentType": "image/gif", "contentLength": 1000 }` / `application/pdf` / `text/html` |
| **Expected Response**     | `415` `UPLOAD_UNSUPPORTED_CONTENT_TYPE`                                                                     |
| **Expected DB Changes**   | None                                                                                                        |
| **Expected Socket/Event** | None                                                                                                        |
| **Notes**                 | Allowed: image/jpeg, image/png, image/webp only. `assertAllowedMime` → StorageValidationError → 415.        |

### TC-USER-069 — File Upload: size exceeds max

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Upload                                                                                     |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                                                   |
| **Test Scenario**         | contentLength > AVATAR_MAX_UPLOAD_BYTES                                                            |
| **Category**              | File Upload                                                                                        |
| **Priority**              | High                                                                                               |
| **Preconditions**         | Authenticated user                                                                                 |
| **Request Payload**       | `{ "type": "AVATAR", "contentType": "image/png", "contentLength": 999999999 }`                     |
| **Expected Response**     | `400` `UPLOAD_FILE_TOO_LARGE`                                                                      |
| **Expected DB Changes**   | None                                                                                               |
| **Expected Socket/Event** | None                                                                                               |
| **Notes**                 | `assertFileSize` → FILE_TOO_LARGE. maxBytes also echoed in success response for client validation. |

### TC-USER-070 — File Upload: empty file (< 1 byte)

| Field                     | Value                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Upload                                                                                                         |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                                                                       |
| **Test Scenario**         | contentLength yields empty file                                                                                        |
| **Category**              | File Upload                                                                                                            |
| **Priority**              | Medium                                                                                                                 |
| **Preconditions**         | Authenticated user                                                                                                     |
| **Request Payload**       | contentLength of 0 (note: schema requires positive, so reaching FILE_EMPTY needs a bypass)                             |
| **Expected Response**     | `400` — Zod rejects 0 (`positive`) before service; if a sub-1 positive reached service it would be `UPLOAD_FILE_EMPTY` |
| **Expected DB Changes**   | None                                                                                                                   |
| **Expected Socket/Event** | None                                                                                                                   |
| **Notes**                 | Validator `coerce.number().int().positive()` already blocks 0/negative; FILE_EMPTY guard is defense-in-depth.          |

### TC-USER-071 — Invalid upload type enum

| Field                     | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Upload                                                             |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                           |
| **Test Scenario**         | type not a known UPLOAD_TYPES key                                          |
| **Category**              | Input Validation                                                           |
| **Priority**              | Medium                                                                     |
| **Preconditions**         | Authenticated user                                                         |
| **Request Payload**       | `{ "type": "DOCUMENT", "contentType": "image/png", "contentLength": 100 }` |
| **Expected Response**     | `400` invalid enum                                                         |
| **Expected DB Changes**   | None                                                                       |
| **Expected Socket/Event** | None                                                                       |
| **Notes**                 | Only `AVATAR` is registered today.                                         |

### TC-USER-072 — Missing / invalid contentLength

| Field                     | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Users / Upload                                                                             |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                                           |
| **Test Scenario**         | Missing, non-numeric, float, or non-positive contentLength                                 |
| **Category**              | Input Validation                                                                           |
| **Priority**              | Medium                                                                                     |
| **Preconditions**         | Authenticated user                                                                         |
| **Request Payload**       | `{ "type": "AVATAR", "contentType": "image/png" }` / `contentLength: -5` / `1.5` / `"abc"` |
| **Expected Response**     | `400`                                                                                      |
| **Expected DB Changes**   | None                                                                                       |
| **Expected Socket/Event** | None                                                                                       |
| **Notes**                 | `coerce.number().int().positive()`; "abc" coerces to NaN → invalid.                        |

### TC-USER-073 — Missing / empty contentType

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Users / Upload                                                   |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                 |
| **Test Scenario**         | contentType absent or empty                                      |
| **Category**              | Input Validation                                                 |
| **Priority**              | Low                                                              |
| **Preconditions**         | Authenticated user                                               |
| **Request Payload**       | `{ "type": "AVATAR", "contentLength": 100 }` / `contentType: ""` |
| **Expected Response**     | `400` (`min(1)`)                                                 |
| **Expected DB Changes**   | None                                                             |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | —                                                                |

### TC-USER-074 — Security: malicious content-type spoofing (extension mapping)

| Field                     | Value                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Upload                                                                                                                                                                                          |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                                                                                                                                                        |
| **Test Scenario**         | Disguised executable claims image MIME                                                                                                                                                                  |
| **Category**              | Security                                                                                                                                                                                                |
| **Priority**              | High                                                                                                                                                                                                    |
| **Preconditions**         | Authenticated user                                                                                                                                                                                      |
| **Request Payload**       | `{ "type": "AVATAR", "contentType": "image/png", "contentLength": 1000 }` then PUT a PHP/EXE payload to presigned URL                                                                                   |
| **Expected Response**     | `200` for the URL request (server can't see bytes). Key extension comes from MIME map → `.png`                                                                                                          |
| **Expected DB Changes**   | None                                                                                                                                                                                                    |
| **Expected Socket/Event** | None                                                                                                                                                                                                    |
| **Notes**                 | GAP: no magic-byte / image-dimension validation server-side; only MIME string + size are checked. Bucket is private (presigned GET only) which limits direct-execution risk. Flag for content sniffing. |

### TC-USER-075 — Upload URL requires auth

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Users / Upload                                               |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                             |
| **Test Scenario**         | No Bearer token                                              |
| **Category**              | AuthN                                                        |
| **Priority**              | High                                                         |
| **Preconditions**         | None                                                         |
| **Request Payload**       | Valid AVATAR body without token                              |
| **Expected Response**     | `401`                                                        |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | ownerId comes from token; unauthenticated cannot mint a key. |

### TC-USER-076 — Object key is scoped to caller (no cross-user upload target)

| Field                     | Value                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Upload                                                                                                                     |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                                                                                   |
| **Test Scenario**         | Verify returned objectKey is always under caller's ownerId                                                                         |
| **Category**              | Security                                                                                                                           |
| **Priority**              | High                                                                                                                               |
| **Preconditions**         | Authenticated as A                                                                                                                 |
| **Request Payload**       | Valid AVATAR body (no userId field accepted)                                                                                       |
| **Expected Response**     | `200`; objectKey starts `avatars/<A's userId>/`                                                                                    |
| **Expected DB Changes**   | None                                                                                                                               |
| **Expected Socket/Event** | None                                                                                                                               |
| **Notes**                 | ownerId = `req.auth.userId`. Combined with `assertObjectKeyOwnedBy` on attach, prevents writing into another user's avatar prefix. |

### TC-USER-077 — Presigned URL expiry honored

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Upload                                                                                     |
| **API/Event Name**        | `POST /api/v1/users/uploads/url`                                                                   |
| **Test Scenario**         | uploadExpiresIn returned; PUT after expiry fails at MinIO                                          |
| **Category**              | Edge Case                                                                                          |
| **Priority**              | Low                                                                                                |
| **Preconditions**         | Authenticated user                                                                                 |
| **Request Payload**       | Valid AVATAR body                                                                                  |
| **Expected Response**     | `200` with `uploadExpiresIn = MINIO_PRESIGN_EXPIRES_IN`; later PUT past expiry rejected by storage |
| **Expected DB Changes**   | None                                                                                               |
| **Expected Socket/Event** | None                                                                                               |
| **Notes**                 | Expiry enforced by MinIO, not user-service.                                                        |
