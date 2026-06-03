# Calls — Call History / Log (REST)

Source: `apps/chat-service/src/api/routes/call.routes.ts` (`GET /api/chat/calls`, `GET /api/chat/calls/:callId`) → `apps/chat-service/src/api/controllers/call.controller.ts` → `apps/chat-service/src/services/call.service.ts` (`getCallHistory`, `getCallByCallId`) → `apps/chat-service/src/repositories/call.repository.ts` (`findByParticipant`, `findByCallId`).

These are the **only REST endpoints** in the calls module (chat-service base `/api/chat`, proxied via the gateway `downstreamPrefix:"/api/chat"`). Both require `authenticate`.

- `GET /api/chat/calls` — cursor-paged history (caller OR callee = me), `orderBy initiatedAt desc`. Query: `cursor?` (max 100), `limit?` (coerced int, 1..50, default 20). Cursor = ISO `initiatedAt` of the last row (`lt` filter). Returns `{ calls, nextCursor, hasMore }`.
- `GET /api/chat/calls/:callId` — single call by `callId`; `404 CALL_NOT_FOUND` if absent.

---

### TC-CALL-038 — Get call history (happy path)

| Field                     | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / History                                                              |
| **API/Event Name**        | `GET /api/chat/calls`                                                        |
| **Test Scenario**         | Authenticated user lists their calls (as caller or callee)                   |
| **Category**              | Happy Path                                                                   |
| **Priority**              | High                                                                         |
| **Preconditions**         | Several `Call` rows where user is caller or callee                           |
| **Request Payload**       | `GET /api/chat/calls` (Bearer token)                                         |
| **Expected Response**     | `200 { success:true, data:{ calls:[…], nextCursor, hasMore } }` newest-first |
| **Expected DB Changes**   | None (read)                                                                  |
| **Expected Socket/Event** | None                                                                         |
| **Notes**                 | `OR: [{callerId:me},{calleeId:me}]`, `orderBy initiatedAt desc`.             |

### TC-CALL-039 — History pagination via cursor

| Field                     | Value                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / History                                                                                     |
| **API/Event Name**        | `GET /api/chat/calls?cursor=<iso>&limit=10`                                                         |
| **Test Scenario**         | Page through history with `nextCursor`                                                              |
| **Category**              | Pagination/Filter/Sort                                                                              |
| **Priority**              | Medium                                                                                              |
| **Preconditions**         | >10 call rows                                                                                       |
| **Request Payload**       | `?limit=10`, then `?cursor=<nextCursor>&limit=10`                                                   |
| **Expected Response**     | First page: 10 rows + `hasMore:true` + `nextCursor`; next page continues                            |
| **Expected DB Changes**   | None                                                                                                |
| **Expected Socket/Event** | None                                                                                                |
| **Notes**                 | Service fetches `limit+1` to compute `hasMore`; `nextCursor = page.last.initiatedAt.toISOString()`. |

### TC-CALL-040 — History last page → hasMore false, nextCursor null

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Calls / History                                       |
| **API/Event Name**        | `GET /api/chat/calls`                                 |
| **Test Scenario**         | Final page returns no more                            |
| **Category**              | Pagination/Filter/Sort                                |
| **Priority**              | Low                                                   |
| **Preconditions**         | Fewer rows than `limit` remaining                     |
| **Request Payload**       | `?cursor=<lastCursor>`                                |
| **Expected Response**     | `{ calls:[…≤limit], nextCursor:null, hasMore:false }` |
| **Expected DB Changes**   | None                                                  |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | —                                                     |

### TC-CALL-041 — Empty history

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Calls / History                                    |
| **API/Event Name**        | `GET /api/chat/calls`                              |
| **Test Scenario**         | User has no calls                                  |
| **Category**              | Edge Case                                          |
| **Priority**              | Low                                                |
| **Preconditions**         | No `Call` rows for the user                        |
| **Request Payload**       | `GET /api/chat/calls`                              |
| **Expected Response**     | `200 { calls:[], nextCursor:null, hasMore:false }` |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | —                                                  |

### TC-CALL-042 — limit above max rejected

| Field                     | Value                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- | --- | -------------------------- |
| **Feature/Module**        | Calls / History                                                                          |
| **API/Event Name**        | `GET /api/chat/calls?limit=500`                                                          |
| **Test Scenario**         | `limit` exceeds `max(50)`                                                                |
| **Category**              | Input Validation                                                                         |
| **Priority**              | Medium                                                                                   |
| **Preconditions**         | Authenticated                                                                            |
| **Request Payload**       | `?limit=500`                                                                             |
| **Expected Response**     | `400` validation error (`callHistoryQuerySchema` max 50)                                 |
| **Expected DB Changes**   | None                                                                                     |
| **Expected Socket/Event** | None                                                                                     |
| **Notes**                 | `validateQuery(callHistoryQuerySchema)`. Note: controller separately does `Number(limit) |     | 20` but Zod rejects first. |

### TC-CALL-043 — limit below min / non-numeric rejected

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Calls / History                              |
| **API/Event Name**        | `GET /api/chat/calls?limit=0` / `?limit=abc` |
| **Test Scenario**         | `limit=0` (<min 1) or non-coercible          |
| **Category**              | Input Validation                             |
| **Priority**              | Medium                                       |
| **Preconditions**         | Authenticated                                |
| **Request Payload**       | `?limit=0`                                   |
| **Expected Response**     | `400` validation error                       |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | `z.coerce.number().int().min(1).max(50)`.    |

### TC-CALL-044 — cursor over max length rejected

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Calls / History                           |
| **API/Event Name**        | `GET /api/chat/calls?cursor=<long>`       |
| **Test Scenario**         | `cursor` longer than 100 chars            |
| **Category**              | Input Validation                          |
| **Priority**              | Low                                       |
| **Preconditions**         | Authenticated                             |
| **Request Payload**       | `?cursor=<101 chars>`                     |
| **Expected Response**     | `400` validation error                    |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | `cursor: z.string().max(100).optional()`. |

### TC-CALL-045 — Malformed cursor (not a date) — edge case

| Field                     | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / History                                                                                 |
| **API/Event Name**        | `GET /api/chat/calls?cursor=not-a-date`                                                         |
| **Test Scenario**         | Cursor passes length check but is not a parseable ISO date                                      |
| **Category**              | Edge Case                                                                                       |
| **Priority**              | Low                                                                                             |
| **Preconditions**         | Authenticated                                                                                   |
| **Request Payload**       | `?cursor=not-a-date`                                                                            |
| **Expected Response**     | Likely `500`/empty — `new Date("not-a-date")` is Invalid Date, Prisma `lt` comparison undefined |
| **Expected DB Changes**   | None                                                                                            |
| **Expected Socket/Event** | None                                                                                            |
| **Notes**                 | GAP: cursor is not validated as a date before `new Date(cursor)`.                               |

### TC-CALL-046 — Unauthenticated history request → 401

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Calls / History                     |
| **API/Event Name**        | `GET /api/chat/calls`               |
| **Test Scenario**         | No / invalid Bearer token           |
| **Category**              | AuthN                               |
| **Priority**              | High                                |
| **Preconditions**         | None                                |
| **Request Payload**       | `GET /api/chat/calls` without token |
| **Expected Response**     | `401` (authenticate middleware)     |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | `userId` derived from `req.auth`.   |

### TC-CALL-047 — Get call by id (happy path)

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Detail                                                                              |
| **API/Event Name**        | `GET /api/chat/calls/:callId`                                                               |
| **Test Scenario**         | Fetch a single call record                                                                  |
| **Category**              | Happy Path                                                                                  |
| **Priority**              | Medium                                                                                      |
| **Preconditions**         | `Call{ callId }` exists                                                                     |
| **Request Payload**       | `GET /api/chat/calls/<callId>`                                                              |
| **Expected Response**     | `200 { success:true, data:{ callId, callerId, calleeId, type, status, durationSec, ... } }` |
| **Expected DB Changes**   | None                                                                                        |
| **Expected Socket/Event** | None                                                                                        |
| **Notes**                 | `findByCallId` (unique lookup).                                                             |

### TC-CALL-048 — Get call by id — not found

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Calls / Detail                                       |
| **API/Event Name**        | `GET /api/chat/calls/:callId`                        |
| **Test Scenario**         | Unknown `callId`                                     |
| **Category**              | Error Handling                                       |
| **Priority**              | Medium                                               |
| **Preconditions**         | None                                                 |
| **Request Payload**       | `GET /api/chat/calls/missing`                        |
| **Expected Response**     | `404 CALL_NOT_FOUND`                                 |
| **Expected DB Changes**   | None                                                 |
| **Expected Socket/Event** | None                                                 |
| **Notes**                 | Controller throws `NotFoundError("CALL_NOT_FOUND")`. |

### TC-CALL-049 — Get call by id — any authed user can read any call (AuthZ gap)

| Field                     | Value                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Detail                                                                                                                                                                                                                                              |
| **API/Event Name**        | `GET /api/chat/calls/:callId`                                                                                                                                                                                                                               |
| **Test Scenario**         | User C requests A↔B's `callId`                                                                                                                                                                                                                              |
| **Category**              | AuthZ                                                                                                                                                                                                                                                       |
| **Priority**              | High                                                                                                                                                                                                                                                        |
| **Preconditions**         | `Call{ callerId:A, calleeId:B }`; C authenticated                                                                                                                                                                                                           |
| **Request Payload**       | `GET /api/chat/calls/<callId>` (by C)                                                                                                                                                                                                                       |
| **Expected Response**     | `200` with the full call record (no participant check)                                                                                                                                                                                                      |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                        |
| **Expected Socket/Event** | None                                                                                                                                                                                                                                                        |
| **Notes**                 | GAP/security: `getCallById` does **not** verify the requester is a participant — any authenticated user can read any call's metadata (callerId, calleeId, duration) by guessing/knowing a UUID. Expected behavior _should_ be 403/404 for non-participants. |

### TC-CALL-050 — History scoping is correct (only my calls)

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Calls / History                                            |
| **API/Event Name**        | `GET /api/chat/calls`                                      |
| **Test Scenario**         | History never leaks other users' calls                     |
| **Category**              | Security                                                   |
| **Priority**              | High                                                       |
| **Preconditions**         | Calls exist for other users not involving me               |
| **Request Payload**       | `GET /api/chat/calls`                                      |
| **Expected Response**     | `200` — only rows where I am callerId or calleeId          |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | Unlike `:callId`, the list IS scoped to `req.auth.userId`. |
