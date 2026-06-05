# Private Chat — Attachments

> **Source:** `validators/private-message.validator.ts` (`sendPrivateMessageSchema`,
> `messageFileSchema`), `validators/attachment.validator.ts` (`locationSchema`, `contactSchema`,
> `stickerSchema`), `constants/media-limits.ts` (`MEDIA_LIMITS`, `enforceMediaLimits`,
> `assertAttachmentsValid`), `routes/private-message.routes.ts` (`GET /rooms/:roomId/media`),
> `services/private-message.service.ts#listMedia`, `validators/query.validator.ts#mediaListQuerySchema`.
> Memory: `project_community_chat_attachments`.

> **Attachment kinds:** gallery (IMAGE), files (DOCUMENT), location, GIF, sticker, voice note (VOICE),
> video, contact. Files travel inside `content.files[]` referencing committed `objectKey`s (or `url`).
> Caps (per `MEDIA_LIMITS`): IMAGE maxCount 10; VIDEO 180s; VOICE 300s; size caps from env
> (`CHAT_UPLOAD_MAX_BYTES` generic, `CHAT_VIDEO_MAX_BYTES` video).

---

### TC-PCHAT-095 — Gallery: send IMAGE with multiple files

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Attachments                                                                  |
| **API/Event Name**        | `message:send` (`/chat`)                                                                    |
| **Test Scenario**         | 3 images (within count + size caps)                                                         |
| **Category**              | File Upload / Happy Path                                                                    |
| **Priority**              | High                                                                                        |
| **Preconditions**         | Files committed via presign; A & B friends                                                  |
| **Request Payload**       | `{ contentType:"IMAGE", files:[{objectKey,mime:"image/png",size:1000,width,height}, …x3] }` |
| **Expected Response**     | ack `{ success:true }`                                                                      |
| **Expected DB Changes**   | Message with 3-file content; messageType IMAGE                                              |
| **Expected Socket/Event** | `message:new` (IMAGE), `conv:updated`                                                       |
| **Notes**                 | width/height optional positive numbers                                                      |

### TC-PCHAT-096 — Files: send DOCUMENT (pdf/doc)

| Field                     | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Attachments                                                                      |
| **API/Event Name**        | `message:send` (`/chat`)                                                                        |
| **Test Scenario**         | DOCUMENT with a pdf objectKey                                                                   |
| **Category**              | File Upload                                                                                     |
| **Priority**              | Medium                                                                                          |
| **Preconditions**         | pdf uploaded                                                                                    |
| **Request Payload**       | `{ contentType:"DOCUMENT", files:[{objectKey,mime:"application/pdf",name:"a.pdf",size:1000}] }` |
| **Expected Response**     | ack `{ success:true }`                                                                          |
| **Expected DB Changes**   | DOCUMENT message persisted                                                                      |
| **Expected Socket/Event** | `message:new` (DOCUMENT)                                                                        |
| **Notes**                 | Size cap = generic `CHAT_UPLOAD_MAX_BYTES`                                                      |

### TC-PCHAT-097 — Location attachment (happy path)

| Field                     | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Attachments                                                                     |
| **API/Event Name**        | `message:send` (`/chat`)                                                                       |
| **Test Scenario**         | LOCATION with valid lat/lng + placeName                                                        |
| **Category**              | Happy Path                                                                                     |
| **Priority**              | Medium                                                                                         |
| **Preconditions**         | A & B friends                                                                                  |
| **Request Payload**       | `{ contentType:"LOCATION", location:{ lat:12.9, lng:77.5, placeName:"X", placeAddress:"Y" } }` |
| **Expected Response**     | ack `{ success:true }`                                                                         |
| **Expected DB Changes**   | content.location persisted                                                                     |
| **Expected Socket/Event** | `message:new` (LOCATION)                                                                       |
| **Notes**                 | lat ∈[-90,90], lng∈[-180,180]; placeName ≤200, placeAddress ≤500                               |

### TC-PCHAT-098 — Contact attachment (happy path)

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Attachments                                                     |
| **API/Event Name**        | `message:send` (`/chat`)                                                       |
| **Test Scenario**         | CONTACT with name + phone                                                      |
| **Category**              | Happy Path                                                                     |
| **Priority**              | Low                                                                            |
| **Preconditions**         | —                                                                              |
| **Request Payload**       | `{ contentType:"CONTACT", content:{ contact:{ name:"Bob", phone:"+1555" } } }` |
| **Expected Response**     | ack `{ success:true }`                                                         |
| **Expected DB Changes**   | content.contact persisted                                                      |
| **Expected Socket/Event** | `message:new` (CONTACT)                                                        |
| **Notes**                 | name 1–200, phone 1–50, avatar ≤3000                                           |

### TC-PCHAT-099 — Contact missing required name/phone

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Private Chat / Attachments                       |
| **API/Event Name**        | `message:send` (`/chat`)                         |
| **Test Scenario**         | CONTACT without phone                            |
| **Category**              | Input Validation                                 |
| **Priority**              | Low                                              |
| **Preconditions**         | —                                                |
| **Request Payload**       | `{ contact:{ name:"Bob" } }`                     |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }` |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | `contactSchema` requires name + phone            |

### TC-PCHAT-100 — GIF attachment within size cap

| Field                     | Value                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Attachments                                                                                                                                                                      |
| **API/Event Name**        | `message:send` (`/chat`)                                                                                                                                                                        |
| **Test Scenario**         | GIF file within generic cap                                                                                                                                                                     |
| **Category**              | File Upload                                                                                                                                                                                     |
| **Priority**              | Low                                                                                                                                                                                             |
| **Preconditions**         | gif uploaded                                                                                                                                                                                    |
| **Request Payload**       | `{ contentType:"GIF"?, files:[{objectKey,mime:"image/gif",size:1000}] }`                                                                                                                        |
| **Expected Response**     | ack `{ success:true }` (GIF handled by generic limits path)                                                                                                                                     |
| **Expected DB Changes**   | message persisted                                                                                                                                                                               |
| **Expected Socket/Event** | `message:new`                                                                                                                                                                                   |
| **Notes**                 | NOTE/GAP: GIF is in `MEDIA_LIMITS`/media-list enum but **not** in `sendPrivateMessageSchema.messageType` enum — confirm how GIF is sent (likely as IMAGE with gif mime). File the enum mismatch |

### TC-PCHAT-101 — Sticker with objectKey (happy path)

| Field                     | Value                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Attachments                                                                                 |
| **API/Event Name**        | `message:send` (`/chat`)                                                                                   |
| **Test Scenario**         | STICKER carrying packId/stickerId + objectKey                                                              |
| **Category**              | Happy Path                                                                                                 |
| **Priority**              | Low                                                                                                        |
| **Preconditions**         | —                                                                                                          |
| **Request Payload**       | `{ contentType:"STICKER", content:{ sticker:{ packId:"p", stickerId:"s", objectKey:"chat-uploads/…" } } }` |
| **Expected Response**     | ack `{ success:true }`                                                                                     |
| **Expected DB Changes**   | content.sticker persisted                                                                                  |
| **Expected Socket/Event** | `message:new` (STICKER)                                                                                    |
| **Notes**                 | STICKER has no file array → size guard is a no-op                                                          |

### TC-PCHAT-102 — Voice note within duration cap

| Field                     | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Private Chat / Attachments                                                                 |
| **API/Event Name**        | `message:send` (`/chat`)                                                                   |
| **Test Scenario**         | VOICE 60s within 300s cap                                                                  |
| **Category**              | File Upload / Happy Path                                                                   |
| **Priority**              | Medium                                                                                     |
| **Preconditions**         | audio uploaded (ogg/mp3/wav)                                                               |
| **Request Payload**       | `{ contentType:"VOICE", files:[{objectKey,mime:"audio/ogg",size:1000,durationMs:60000}] }` |
| **Expected Response**     | ack `{ success:true }`                                                                     |
| **Expected DB Changes**   | VOICE message persisted                                                                    |
| **Expected Socket/Event** | `message:new` (VOICE)                                                                      |
| **Notes**                 | duration cap 300_000 ms                                                                    |

### TC-PCHAT-103 — Voice note over duration cap

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Attachments                                       |
| **API/Event Name**        | `message:send` (`/chat`)                                         |
| **Test Scenario**         | VOICE > 300s                                                     |
| **Category**              | File Upload                                                      |
| **Priority**              | Medium                                                           |
| **Preconditions**         | —                                                                |
| **Request Payload**       | `{ contentType:"VOICE", files:[{durationMs:301000,size:1000}] }` |
| **Expected Response**     | ack `{ success:false }` (`CHAT_VOICE_TOO_LONG`)                  |
| **Expected DB Changes**   | None                                                             |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | Mirrors TC-PCHAT-009                                             |

### TC-PCHAT-104 — List room media (happy path)

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Private Chat / Attachments                      |
| **API/Event Name**        | `GET /rooms/:roomId/media`                      |
| **Test Scenario**         | A lists shared media in a room                  |
| **Category**              | Happy Path                                      |
| **Priority**              | Medium                                          |
| **Preconditions**         | A participant; room has media messages          |
| **Request Payload**       | query optional `type`, `cursor`, `limit`        |
| **Expected Response**     | `200` cursor-paginated enriched media messages  |
| **Expected DB Changes**   | None                                            |
| **Expected Socket/Event** | None                                            |
| **Notes**                 | Participation enforced (`CHAT_NOT_PARTICIPANT`) |

### TC-PCHAT-105 — List room media with type filter

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Private Chat / Attachments                       |
| **API/Event Name**        | `GET /rooms/:roomId/media?type=IMAGE`            |
| **Test Scenario**         | Filter by media type                             |
| **Category**              | Pagination/Filter/Sort                           |
| **Priority**              | Medium                                           |
| **Preconditions**         | A participant                                    |
| **Request Payload**       | `type=IMAGE&limit=30`                            |
| **Expected Response**     | `200` only IMAGE items                           |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | type enum IMAGE/VIDEO/GIF/VOICE/DOCUMENT/STICKER |

### TC-PCHAT-106 — List room media invalid type

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Private Chat / Attachments          |
| **API/Event Name**        | `GET /rooms/:roomId/media?type=FOO` |
| **Test Scenario**         | type outside enum                   |
| **Category**              | Input Validation                    |
| **Priority**              | Low                                 |
| **Preconditions**         | —                                   |
| **Request Payload**       | `type=FOO`                          |
| **Expected Response**     | `400`                               |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | `mediaListQuerySchema`              |

### TC-PCHAT-107 — List room media as non-participant (IDOR)

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Attachments                                  |
| **API/Event Name**        | `GET /rooms/:roomId/media`                                  |
| **Test Scenario**         | C not in room lists media                                   |
| **Category**              | Security / AuthZ                                            |
| **Priority**              | High                                                        |
| **Preconditions**         | C authed, not participant                                   |
| **Request Payload**       | path roomId                                                 |
| **Expected Response**     | `403` `CHAT_NOT_PARTICIPANT`                                |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | `listMedia` enforces `participants.includes(userId)` (good) |

### TC-PCHAT-108 — List room media on missing room

| Field                     | Value                       |
| ------------------------- | --------------------------- |
| **Feature/Module**        | Private Chat / Attachments  |
| **API/Event Name**        | `GET /rooms/:roomId/media`  |
| **Test Scenario**         | Unknown roomId              |
| **Category**              | Error Handling              |
| **Priority**              | Low                         |
| **Preconditions**         | —                           |
| **Request Payload**       | bad roomId                  |
| **Expected Response**     | `404` `CHAT_ROOM_NOT_FOUND` |
| **Expected DB Changes**   | None                        |
| **Expected Socket/Event** | None                        |
| **Notes**                 | —                           |

### TC-PCHAT-109 — Huge attachments array (payload bound)

| Field                     | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Private Chat / Attachments                                                                   |
| **API/Event Name**        | `message:send` (`/chat`)                                                                     |
| **Test Scenario**         | Send with a very large files array / payload near 1 MB                                       |
| **Category**              | Edge Case                                                                                    |
| **Priority**              | Low                                                                                          |
| **Preconditions**         | —                                                                                            |
| **Request Payload**       | oversized payload                                                                            |
| **Expected Response**     | rejected — socket `maxHttpBufferSize` is 1 MB; IMAGE count >10 → `CHAT_IMAGE_COUNT_EXCEEDED` |
| **Expected DB Changes**   | None                                                                                         |
| **Expected Socket/Event** | None                                                                                         |
| **Notes**                 | Connection-level cap + per-type count cap                                                    |
