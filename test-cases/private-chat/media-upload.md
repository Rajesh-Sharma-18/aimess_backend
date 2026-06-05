# Private Chat — Media Upload (presign / download)

> **Source:** `routes/media.routes.ts` (`POST /upload-url`, `POST /download-url`),
> `controllers/media.controller.ts`, `config/uploads.ts` (`UPLOAD_TYPES.CHAT_ATTACHMENT`),
> `@aimess/storage` (`createPresignedUploadUrl`, `createPresignedViewUrl`, `buildObjectKey`).
> Base path: media routes mounted under the chat-service media prefix (e.g. `/api/v1/chat/media`).

> **Flow:** client requests a presigned **upload URL** for an allowed MIME → PUTs bytes to MinIO →
> sends the returned `objectKey` inside `message:send.files[]`. To view, client requests a presigned
> **download URL** for an `objectKey` under the `chat-uploads/` prefix.

---

### TC-PCHAT-110 — Get upload URL (happy path)

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Media Upload                                                          |
| **API/Event Name**        | `POST /media/upload-url`                                                             |
| **Test Scenario**         | Request presigned PUT URL for image/png                                              |
| **Category**              | Happy Path                                                                           |
| **Priority**              | High                                                                                 |
| **Preconditions**         | Authenticated                                                                        |
| **Request Payload**       | `{ filename:"a.png", contentType:"image/png" }`                                      |
| **Expected Response**     | `200` `{ data:{ objectKey:"chat-uploads/<ownerId>/…png", uploadUrl, contentType } }` |
| **Expected DB Changes**   | None (object created on PUT, not here)                                               |
| **Expected Socket/Event** | None                                                                                 |
| **Notes**                 | objectKey scoped to caller via `buildObjectKey(ownerId)`                             |

### TC-PCHAT-111 — Upload URL disallowed MIME

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Media Upload                                           |
| **API/Event Name**        | `POST /media/upload-url`                                              |
| **Test Scenario**         | contentType not in allow-list (e.g. application/x-msdownload)         |
| **Category**              | Input Validation / Security                                           |
| **Priority**              | High                                                                  |
| **Preconditions**         | —                                                                     |
| **Request Payload**       | `{ filename:"x.exe", contentType:"application/x-msdownload" }`        |
| **Expected Response**     | `400` `CHAT_UPLOAD_REQUEST_INVALID`                                   |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | None                                                                  |
| **Notes**                 | Allowed: jpeg/png/webp/gif, mp4/quicktime, mpeg/ogg/wav, pdf/doc/docx |

### TC-PCHAT-112 — Upload URL missing filename

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Private Chat / Media Upload         |
| **API/Event Name**        | `POST /media/upload-url`            |
| **Test Scenario**         | Empty/missing filename              |
| **Category**              | Required Params                     |
| **Priority**              | Medium                              |
| **Preconditions**         | —                                   |
| **Request Payload**       | `{ contentType:"image/png" }`       |
| **Expected Response**     | `400` `CHAT_UPLOAD_REQUEST_INVALID` |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | filename 1–255                      |

### TC-PCHAT-113 — Upload URL filename without extension

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Private Chat / Media Upload                     |
| **API/Event Name**        | `POST /media/upload-url`                        |
| **Test Scenario**         | filename has no dot                             |
| **Category**              | Edge Case                                       |
| **Priority**              | Low                                             |
| **Preconditions**         | —                                               |
| **Request Payload**       | `{ filename:"noext", contentType:"image/png" }` |
| **Expected Response**     | `200` objectKey ends in `.bin` (fallback ext)   |
| **Expected DB Changes**   | None                                            |
| **Expected Socket/Event** | None                                            |
| **Notes**                 | ext defaults to "bin"                           |

### TC-PCHAT-114 — Upload URL unauthenticated

| Field                     | Value                       |
| ------------------------- | --------------------------- |
| **Feature/Module**        | Private Chat / Media Upload |
| **API/Event Name**        | `POST /media/upload-url`    |
| **Test Scenario**         | No token                    |
| **Category**              | AuthN                       |
| **Priority**              | High                        |
| **Preconditions**         | —                           |
| **Request Payload**       | —                           |
| **Expected Response**     | `401`                       |
| **Expected DB Changes**   | None                        |
| **Expected Socket/Event** | None                        |
| **Notes**                 | —                           |

### TC-PCHAT-115 — Upload URL rate limit (30/60s)

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| **Feature/Module**        | Private Chat / Media Upload                |
| **API/Event Name**        | `POST /media/upload-url`                   |
| **Test Scenario**         | >30 requests in 60s                        |
| **Category**              | Rate Limit                                 |
| **Priority**              | Medium                                     |
| **Preconditions**         | —                                          |
| **Request Payload**       | repeated                                   |
| **Expected Response**     | `429` after limit (`media:upload`, 30/60s) |
| **Expected DB Changes**   | None                                       |
| **Expected Socket/Event** | None                                       |
| **Notes**                 | —                                          |

### TC-PCHAT-116 — Get download URL (happy path)

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Private Chat / Media Upload                        |
| **API/Event Name**        | `POST /media/download-url`                         |
| **Test Scenario**         | Request presigned GET for a chat-uploads objectKey |
| **Category**              | Happy Path                                         |
| **Priority**              | High                                               |
| **Preconditions**         | objectKey under `chat-uploads/` exists             |
| **Request Payload**       | `{ objectKey:"chat-uploads/<id>/file.png" }`       |
| **Expected Response**     | `200` `{ data:{ objectKey, downloadUrl } }`        |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | View URL expiry `MINIO_VIEW_EXPIRES_IN`            |

### TC-PCHAT-117 — Download URL with foreign/invalid prefix

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Media Upload                                        |
| **API/Event Name**        | `POST /media/download-url`                                         |
| **Test Scenario**         | objectKey not under `chat-uploads/` (e.g. `avatars/x`)             |
| **Category**              | Security                                                           |
| **Priority**              | High                                                               |
| **Preconditions**         | —                                                                  |
| **Request Payload**       | `{ objectKey:"avatars/victim.png" }`                               |
| **Expected Response**     | `400` `CHAT_INVALID_OBJECT_KEY`                                    |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | Prefix guard prevents cross-bucket/path traversal to other modules |

### TC-PCHAT-118 — Download URL for another user's chat object (IDOR)

| Field                     | Value                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Media Upload                                                                                                                                                                                                |
| **API/Event Name**        | `POST /media/download-url`                                                                                                                                                                                                 |
| **Test Scenario**         | C requests download URL for an objectKey owned by A (`chat-uploads/<A>/…`)                                                                                                                                                 |
| **Category**              | Security                                                                                                                                                                                                                   |
| **Priority**              | High                                                                                                                                                                                                                       |
| **Preconditions**         | C authed; knows/guesses A's objectKey                                                                                                                                                                                      |
| **Request Payload**       | `{ objectKey:"chat-uploads/<A>/secret.png" }`                                                                                                                                                                              |
| **Expected Response**     | **GAP:** only the `chat-uploads/` prefix is checked — **no per-user ownership or room-participation check**. Any authed user can mint a view URL for any chat object whose key they know. Returns `200`. **File as IDOR.** |
| **Expected DB Changes**   | None                                                                                                                                                                                                                       |
| **Expected Socket/Event** | None                                                                                                                                                                                                                       |
| **Notes**                 | High-priority security gap; recommend scoping by ownerId/room membership                                                                                                                                                   |

### TC-PCHAT-119 — Download URL missing objectKey

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Private Chat / Media Upload           |
| **API/Event Name**        | `POST /media/download-url`            |
| **Test Scenario**         | empty body                            |
| **Category**              | Required Params                       |
| **Priority**              | Medium                                |
| **Preconditions**         | —                                     |
| **Request Payload**       | `{}`                                  |
| **Expected Response**     | `400` `CHAT_DOWNLOAD_REQUEST_INVALID` |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |
| **Notes**                 | objectKey 1–500                       |

### TC-PCHAT-120 — Download URL rate limit (120/60s)

| Field                     | Value                             |
| ------------------------- | --------------------------------- |
| **Feature/Module**        | Private Chat / Media Upload       |
| **API/Event Name**        | `POST /media/download-url`        |
| **Test Scenario**         | >120 in 60s                       |
| **Category**              | Rate Limit                        |
| **Priority**              | Low                               |
| **Preconditions**         | —                                 |
| **Request Payload**       | repeated                          |
| **Expected Response**     | `429` (`media:download`, 120/60s) |
| **Expected DB Changes**   | None                              |
| **Expected Socket/Event** | None                              |
| **Notes**                 | —                                 |
