# Livestream Comments — Test Cases

> Module: **chat-service** livestream comment feature (PARTIALLY implemented).
>
> **Implementation status (read first):**
>
> - `LivestreamComment` Mongo model (`chat_livestream_comments`) — IMPLEMENTED (`apps/chat-service/prisma/schema.prisma`).
> - `LivestreamCommentRepository` — `createComment`, `findByClientCommentId`, `findByLivestreamId` (cursor pagination) — IMPLEMENTED (`apps/chat-service/src/repositories/livestream-comment.repository.ts`).
> - `LivestreamCommentService` — `addComment` (with client-id idempotency), `getComments` — IMPLEMENTED (`apps/chat-service/src/services/livestream-comment.service.ts`).
> - **NOT wired:** No socket handler, controller, route, or gRPC method invokes this service today. There is **no** `livestream.handler.ts`, no `room:livestream:*` socket events in `apps/api-gateway/src/sockets/`, and no validation/auth/rate-limit layer in front of the service. The `Livestream` model exists in schema but has **no** repository/service.
>
> The cases below are written against the **current code surface** (the service + repository + Mongo model). Cases that describe an HTTP/socket transport, rate limiting, moderation, or auth are labeled **`[transport pending]`** in Notes because the grounding logic exists but no entry point is wired. They are intentionally included because they assert real, shipped service/repository/DB behavior once a thin transport is added; assertions on DB rows, idempotency, ordering, and pagination are testable today by calling the service directly.

---

## 1. Happy Path

### TC-LIVE-001 — Add a comment to a livestream

| Field                     | Value                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Livestream / Comments                                                                                                          |
| **API/Event Name**        | `LivestreamCommentService.addComment` (target event: `room:livestream:comment:add`)                                            |
| **Test Scenario**         | A viewer posts a valid text comment; it is persisted and returned                                                              |
| **Category**              | Happy Path                                                                                                                     |
| **Priority**              | High                                                                                                                           |
| **Preconditions**         | A `Livestream` row exists with `status = "LIVE"`; caller is an authenticated viewer joined to `room:livestream:<livestreamId>` |
| **Request Payload**       | `{ livestreamId, roomId, userId, userName, userAvatar, message: "Great stream!", clientCommentId: "c-uuid-1" }`                |
| **Expected Response**     | The created `LivestreamComment` with generated `id`, `createdAt`, `updatedAt`, `senderName`, `senderAvatar` echoed back        |
| **Expected DB Changes**   | One new row in `chat_livestream_comments` (`livestreamId`, `roomId`, `sentBy=userId`, `message`, `clientCommentId`)            |
| **Expected Socket/Event** | Broadcast `room:livestream:comment:new` to the livestream room _(broadcast not yet wired — see Notes)_                         |
| **Notes**                 | `[transport pending]` — service persists correctly today; broadcast/auth layer not yet built.                                  |

### TC-LIVE-002 — List comments for a livestream (default page)

| Field                     | Value                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                   |
| **API/Event Name**        | `LivestreamCommentService.getComments` (target event: `room:livestream:comments:load-more`)                             |
| **Test Scenario**         | Fetch the most recent comments for a stream with only `limit` set                                                       |
| **Category**              | Happy Path                                                                                                              |
| **Priority**              | High                                                                                                                    |
| **Preconditions**         | 5 comments exist for `livestreamId`                                                                                     |
| **Request Payload**       | `getComments(livestreamId, { limit: 20 })`                                                                              |
| **Expected Response**     | Up to 20 comments ordered by `id` **descending** (newest first)                                                         |
| **Expected DB Changes**   | None (read)                                                                                                             |
| **Expected Socket/Event** | None                                                                                                                    |
| **Notes**                 | Ordering is `orderBy: { id: "desc" }` — Mongo ObjectId is monotonic so this is effectively newest-first by insert time. |

### TC-LIVE-003 — Comment persisted with sender denormalized fields

| Field                     | Value                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                                    |
| **API/Event Name**        | `LivestreamCommentService.addComment`                                                                                                    |
| **Test Scenario**         | `senderName` and `senderAvatar` are stored alongside the comment (denormalized snapshot)                                                 |
| **Category**              | DB State                                                                                                                                 |
| **Priority**              | Medium                                                                                                                                   |
| **Preconditions**         | Authenticated viewer with profile name + avatar                                                                                          |
| **Request Payload**       | `{ ..., userName: "Alice", userAvatar: "https://cdn/a.png", message: "hi" }`                                                             |
| **Expected Response**     | Returned row has `senderName="Alice"`, `senderAvatar="https://cdn/a.png"`                                                                |
| **Expected DB Changes**   | Row stores name/avatar at post time; later profile changes do NOT retro-update the comment                                               |
| **Expected Socket/Event** | None                                                                                                                                     |
| **Notes**                 | Snapshot semantics — confirms model defaults (`senderName @default("")`, `senderAvatar @default("")`) are overridden by supplied values. |

---

## 2. Input Validation

### TC-LIVE-010 — Empty message string

| Field                     | Value                                                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                                                                                                                       |
| **API/Event Name**        | `room:livestream:comment:add`                                                                                                                                                                                               |
| **Test Scenario**         | Posting `message: ""` should be rejected                                                                                                                                                                                    |
| **Category**              | Input Validation                                                                                                                                                                                                            |
| **Priority**              | High                                                                                                                                                                                                                        |
| **Preconditions**         | Joined to livestream room                                                                                                                                                                                                   |
| **Request Payload**       | `{ ..., message: "" }`                                                                                                                                                                                                      |
| **Expected Response**     | Validation error (e.g. `VALIDATION_ERROR` / "message required")                                                                                                                                                             |
| **Expected DB Changes**   | None                                                                                                                                                                                                                        |
| **Expected Socket/Event** | Error ack to sender only                                                                                                                                                                                                    |
| **Notes**                 | `[transport pending]` — **GAP:** the current service does NOT validate empty/whitespace messages; the repository would happily insert `""`. Validation must be added at the handler. This case documents required behavior. |

### TC-LIVE-011 — Message exceeds max length

| Field                     | Value                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                           |
| **API/Event Name**        | `room:livestream:comment:add`                                                                                                   |
| **Test Scenario**         | A message far above the allowed limit (e.g. > 500 chars) is rejected                                                            |
| **Category**              | Input Validation                                                                                                                |
| **Priority**              | Medium                                                                                                                          |
| **Preconditions**         | Joined to livestream room                                                                                                       |
| **Request Payload**       | `{ ..., message: "<501-char string>" }`                                                                                         |
| **Expected Response**     | Validation error                                                                                                                |
| **Expected DB Changes**   | None                                                                                                                            |
| **Expected Socket/Event** | Error ack                                                                                                                       |
| **Notes**                 | `[transport pending]` — **GAP:** no length cap exists in service today. Pick a limit consistent with chat messages when wiring. |

### TC-LIVE-012 — Missing required `livestreamId`

| Field                     | Value                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                   |
| **API/Event Name**        | `room:livestream:comment:add`                                                                                           |
| **Test Scenario**         | Request without `livestreamId` is rejected                                                                              |
| **Category**              | Required Params                                                                                                         |
| **Priority**              | High                                                                                                                    |
| **Preconditions**         | Joined to a room                                                                                                        |
| **Request Payload**       | `{ roomId, userId, message: "hi" }` (no `livestreamId`)                                                                 |
| **Expected Response**     | Validation error                                                                                                        |
| **Expected DB Changes**   | None                                                                                                                    |
| **Expected Socket/Event** | Error ack                                                                                                               |
| **Notes**                 | `[transport pending]` — service requires `livestreamId` (TS-typed) but no runtime guard; add zod validation at handler. |

### TC-LIVE-013 — `clientCommentId` is optional

| Field                     | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                          |
| **API/Event Name**        | `LivestreamCommentService.addComment`                                                          |
| **Test Scenario**         | Omitting `clientCommentId` still creates the comment                                           |
| **Category**              | Optional Params                                                                                |
| **Priority**              | Medium                                                                                         |
| **Preconditions**         | Joined to livestream room                                                                      |
| **Request Payload**       | `{ livestreamId, roomId, userId, userName, userAvatar, message: "hi" }` (no `clientCommentId`) |
| **Expected Response**     | Comment created with `clientCommentId = null`                                                  |
| **Expected DB Changes**   | Row stored with `clientCommentId: null`; idempotency check skipped                             |
| **Expected Socket/Event** | Broadcast comment _(pending)_                                                                  |
| **Notes**                 | Service code: idempotency branch only runs when `params.clientCommentId` is truthy.            |

---

## 3. AuthN / AuthZ

### TC-LIVE-020 — Unauthenticated user cannot comment

| Field                     | Value                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Livestream / Comments                                                                                                                |
| **API/Event Name**        | `room:livestream:comment:add`                                                                                                        |
| **Test Scenario**         | A socket without a valid JWT cannot post a comment                                                                                   |
| **Category**              | AuthN                                                                                                                                |
| **Priority**              | High                                                                                                                                 |
| **Preconditions**         | Socket not authenticated (gateway `auth.middleware.ts` rejects)                                                                      |
| **Request Payload**       | Any comment payload                                                                                                                  |
| **Expected Response**     | Connection/handshake rejected or `UNAUTHORIZED` ack                                                                                  |
| **Expected DB Changes**   | None                                                                                                                                 |
| **Expected Socket/Event** | Disconnect / error ack                                                                                                               |
| **Notes**                 | `[transport pending]` — gateway already enforces socket JWT auth for `/chat`; livestream events must run under that same middleware. |

### TC-LIVE-021 — `sentBy` is derived from auth, not client-supplied

| Field                     | Value                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                                                                                     |
| **API/Event Name**        | `room:livestream:comment:add`                                                                                                                                                             |
| **Test Scenario**         | A client supplying a forged `userId` must not be able to post as another user                                                                                                             |
| **Category**              | Security / AuthZ                                                                                                                                                                          |
| **Priority**              | High                                                                                                                                                                                      |
| **Preconditions**         | Authenticated as user A; payload claims `userId = B`                                                                                                                                      |
| **Request Payload**       | `{ ..., userId: "B", message: "spoofed" }`                                                                                                                                                |
| **Expected Response**     | Comment stored with `sentBy = A` (token identity), OR request rejected                                                                                                                    |
| **Expected DB Changes**   | Row `sentBy` = authenticated user, never the client value                                                                                                                                 |
| **Expected Socket/Event** | Broadcast shows real author                                                                                                                                                               |
| **Notes**                 | `[transport pending]` — **GAP:** service currently trusts `params.userId` from caller. Handler MUST override `userId`/`userName`/`userAvatar` from the authenticated socket/gRPC context. |

### TC-LIVE-022 — Non-member of community cannot comment on its livestream

| Field                     | Value                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                        |
| **API/Event Name**        | `room:livestream:comment:add`                                                                                                |
| **Test Scenario**         | A user who is not a member of the community owning the stream is blocked                                                     |
| **Category**              | AuthZ                                                                                                                        |
| **Priority**              | High                                                                                                                         |
| **Preconditions**         | Livestream belongs to a community; caller is not a member                                                                    |
| **Request Payload**       | Valid comment payload                                                                                                        |
| **Expected Response**     | `FORBIDDEN` ack                                                                                                              |
| **Expected DB Changes**   | None                                                                                                                         |
| **Expected Socket/Event** | Error ack                                                                                                                    |
| **Notes**                 | `[transport pending]` — **GAP:** no membership/room-join authorization exists yet. Needs a join-gate check against `roomId`. |

---

## 4. Business Rules

### TC-LIVE-030 — Idempotent re-send with same `clientCommentId`

| Field                     | Value                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Livestream / Comments                                                                                                                      |
| **API/Event Name**        | `LivestreamCommentService.addComment`                                                                                                      |
| **Test Scenario**         | Posting twice with the same `(livestreamId, userId, clientCommentId)` returns the existing comment, no duplicate row                       |
| **Category**              | Business Rule                                                                                                                              |
| **Priority**              | High                                                                                                                                       |
| **Preconditions**         | First `addComment` already persisted with `clientCommentId="c-1"`                                                                          |
| **Request Payload**       | Second call: `{ livestreamId, userId, clientCommentId: "c-1", message: "..." }`                                                            |
| **Expected Response**     | The **same** original comment (same `id`) is returned                                                                                      |
| **Expected DB Changes**   | **No** second row inserted                                                                                                                 |
| **Expected Socket/Event** | No duplicate broadcast                                                                                                                     |
| **Notes**                 | Grounded: `findByClientCommentId(livestreamId, userId, clientCommentId)` → early return. Verifiable today by calling the service directly. |

### TC-LIVE-031 — Same `clientCommentId` from a different user creates a new comment

| Field                     | Value                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                            |
| **API/Event Name**        | `LivestreamCommentService.addComment`                                                                            |
| **Test Scenario**         | Idempotency is scoped per user — two users using the same client id both get rows                                |
| **Category**              | Business Rule                                                                                                    |
| **Priority**              | Medium                                                                                                           |
| **Preconditions**         | User A posted with `clientCommentId="c-1"`                                                                       |
| **Request Payload**       | User B posts `{ livestreamId, userId: B, clientCommentId: "c-1", message: "..." }`                               |
| **Expected Response**     | A new comment authored by B                                                                                      |
| **Expected DB Changes**   | Second row inserted (idempotency key includes `sentBy`)                                                          |
| **Expected Socket/Event** | Broadcast B's comment                                                                                            |
| **Notes**                 | Grounded: idempotency lookup filters on `sentBy` too — index `@@index([livestreamId, sentBy, clientCommentId])`. |

### TC-LIVE-032 — Same `clientCommentId` across different livestreams is independent

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                    |
| **API/Event Name**        | `LivestreamCommentService.addComment`                    |
| **Test Scenario**         | Reusing a client id in a different stream is not deduped |
| **Category**              | Business Rule                                            |
| **Priority**              | Low                                                      |
| **Preconditions**         | User A posted `clientCommentId="c-1"` in stream S1       |
| **Request Payload**       | User A posts the same `clientCommentId` in stream S2     |
| **Expected Response**     | New comment in S2                                        |
| **Expected DB Changes**   | Distinct row scoped to S2                                |
| **Expected Socket/Event** | Broadcast to S2 only                                     |
| **Notes**                 | Grounded: idempotency key includes `livestreamId`.       |

### TC-LIVE-033 — Comments on an ENDED stream

| Field                     | Value                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Livestream / Comments                                                                                                                |
| **API/Event Name**        | `room:livestream:comment:add`                                                                                                        |
| **Test Scenario**         | Posting a comment after the stream `status = "ENDED"` should be rejected                                                             |
| **Category**              | Business Rule                                                                                                                        |
| **Priority**              | Medium                                                                                                                               |
| **Preconditions**         | `Livestream.status = "ENDED"`                                                                                                        |
| **Request Payload**       | Valid comment payload                                                                                                                |
| **Expected Response**     | `STREAM_NOT_LIVE` / rejected                                                                                                         |
| **Expected DB Changes**   | None                                                                                                                                 |
| **Expected Socket/Event** | Error ack                                                                                                                            |
| **Notes**                 | `[transport pending]` — **GAP:** service never checks stream status (no `Livestream` lookup at all). Add a status guard when wiring. |

---

## 5. Pagination / Filter / Sort

### TC-LIVE-040 — `before` cursor returns older comments

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                         |
| **API/Event Name**        | `LivestreamCommentService.getComments`                                        |
| **Test Scenario**         | Passing `before=<commentId>` returns comments with `id < before` (older page) |
| **Category**              | Pagination/Filter/Sort                                                        |
| **Priority**              | High                                                                          |
| **Preconditions**         | 30 comments exist; client already has the newest 10                           |
| **Request Payload**       | `getComments(livestreamId, { limit: 10, before: oldestSeenId })`              |
| **Expected Response**     | Next 10 older comments, `id` descending                                       |
| **Expected DB Changes**   | None                                                                          |
| **Expected Socket/Event** | None                                                                          |
| **Notes**                 | Grounded: repo applies `id: { lt: options.before }` when `before` is set.     |

### TC-LIVE-041 — `limit` caps the page size

| Field                     | Value                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                                                |
| **API/Event Name**        | `LivestreamCommentService.getComments`                                                                                                               |
| **Test Scenario**         | `limit` controls `take`                                                                                                                              |
| **Category**              | Pagination/Filter/Sort                                                                                                                               |
| **Priority**              | Medium                                                                                                                                               |
| **Preconditions**         | 50 comments exist                                                                                                                                    |
| **Request Payload**       | `{ limit: 5 }`                                                                                                                                       |
| **Expected Response**     | Exactly 5 comments                                                                                                                                   |
| **Expected DB Changes**   | None                                                                                                                                                 |
| **Expected Socket/Event** | None                                                                                                                                                 |
| **Notes**                 | `[partial]` — **GAP:** service does NOT clamp `limit` to a max; a caller could request `limit: 100000`. Add an upper bound (e.g. 50) at the handler. |

### TC-LIVE-042 — Empty stream returns empty list

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Livestream / Comments                  |
| **API/Event Name**        | `LivestreamCommentService.getComments` |
| **Test Scenario**         | A stream with no comments returns `[]` |
| **Category**              | Edge Case                              |
| **Priority**              | Low                                    |
| **Preconditions**         | No comments for `livestreamId`         |
| **Request Payload**       | `{ limit: 20 }`                        |
| **Expected Response**     | `[]`                                   |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | Grounded.                              |

### TC-LIVE-043 — `before` pointing past the oldest comment

| Field                     | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| **Feature/Module**        | Livestream / Comments                                                    |
| **API/Event Name**        | `LivestreamCommentService.getComments`                                   |
| **Test Scenario**         | A `before` cursor older than every comment returns `[]` (end of history) |
| **Category**              | Edge Case                                                                |
| **Priority**              | Low                                                                      |
| **Preconditions**         | Comments exist; cursor < smallest id                                     |
| **Request Payload**       | `{ limit: 10, before: "<id smaller than all>" }`                         |
| **Expected Response**     | `[]`                                                                     |
| **Expected DB Changes**   | None                                                                     |
| **Expected Socket/Event** | None                                                                     |
| **Notes**                 | Signals client to stop paginating (`hasMore=false`).                     |

---

## 6. Concurrency

### TC-LIVE-050 — Comment flood from one viewer (rate limit)

| Field                     | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                    |
| **API/Event Name**        | `room:livestream:comment:add`                                                                            |
| **Test Scenario**         | A single viewer fires many comments per second; excess is throttled                                      |
| **Category**              | Rate Limit / Concurrency                                                                                 |
| **Priority**              | High                                                                                                     |
| **Preconditions**         | Authenticated viewer                                                                                     |
| **Request Payload**       | 50 `comment:add` events in 1 second                                                                      |
| **Expected Response**     | First N within limit succeed; rest get `RATE_LIMITED`                                                    |
| **Expected DB Changes**   | Only the allowed comments persisted                                                                      |
| **Expected Socket/Event** | Rate-limit error acks for throttled events                                                               |
| **Notes**                 | `[transport pending]` — **GAP:** no rate limiting in service/repo. Add per-user token bucket at handler. |

### TC-LIVE-051 — Simultaneous comments from many viewers

| Field                     | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Livestream / Comments                                                                      |
| **API/Event Name**        | `LivestreamCommentService.addComment`                                                      |
| **Test Scenario**         | 200 viewers each post one comment concurrently to the same stream                          |
| **Category**              | Concurrency                                                                                |
| **Priority**              | High                                                                                       |
| **Preconditions**         | 200 authenticated viewers in the room                                                      |
| **Request Payload**       | 200 concurrent `addComment` calls                                                          |
| **Expected Response**     | All 200 succeed, each returns its own row                                                  |
| **Expected DB Changes**   | Exactly 200 distinct rows; no lost writes                                                  |
| **Expected Socket/Event** | Each broadcast once _(pending)_                                                            |
| **Notes**                 | Verifiable today by parallel service calls; Mongo insert is per-document so no contention. |

### TC-LIVE-052 — Concurrent duplicate idempotent sends race

| Field                     | Value                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Livestream / Comments                                                                                                                                                          |
| **API/Event Name**        | `LivestreamCommentService.addComment`                                                                                                                                          |
| **Test Scenario**         | The same `(livestreamId, userId, clientCommentId)` sent twice nearly simultaneously                                                                                            |
| **Category**              | Concurrency                                                                                                                                                                    |
| **Priority**              | Medium                                                                                                                                                                         |
| **Preconditions**         | Two parallel calls with identical client id                                                                                                                                    |
| **Request Payload**       | 2x `addComment({ ..., clientCommentId: "c-1" })` in parallel                                                                                                                   |
| **Expected Response**     | Ideally one row; both callers get a comment back                                                                                                                               |
| **Expected DB Changes**   | **Risk:** because the check-then-insert is not atomic and there is **no unique index** on `(livestreamId, sentBy, clientCommentId)`, a race can create 2 rows                  |
| **Expected Socket/Event** | Possible duplicate broadcast                                                                                                                                                   |
| **Notes**                 | `[known gap]` — **GAP:** idempotency is read-then-write without a DB unique constraint. Recommend a partial unique index to make it race-safe. Document as a defect to verify. |

---

## 7. Security

### TC-LIVE-060 — XSS / HTML payload in message is stored raw

| Field                     | Value                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                 |
| **API/Event Name**        | `room:livestream:comment:add`                                                                                         |
| **Test Scenario**         | A comment containing `<script>` is not executed when rendered                                                         |
| **Category**              | Security                                                                                                              |
| **Priority**              | High                                                                                                                  |
| **Preconditions**         | Authenticated viewer                                                                                                  |
| **Request Payload**       | `{ ..., message: "<script>alert(1)</script>" }`                                                                       |
| **Expected Response**     | Stored as-is; clients must escape on render                                                                           |
| **Expected DB Changes**   | Raw string persisted (no server sanitization today)                                                                   |
| **Expected Socket/Event** | Broadcast carries raw text                                                                                            |
| **Notes**                 | Server stores verbatim — confirm client-side escaping contract; consider server-side sanitization/limits when wiring. |

### TC-LIVE-061 — NoSQL operator injection via fields

| Field                     | Value                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                                                                                                    |
| **API/Event Name**        | `LivestreamCommentService.getComments`                                                                                                   |
| **Test Scenario**         | A `before` value that is an object (`{ "$gt": "" }`) must not bypass the cursor filter                                                   |
| **Category**              | Security                                                                                                                                 |
| **Priority**              | High                                                                                                                                     |
| **Preconditions**         | Comments exist                                                                                                                           |
| **Request Payload**       | `getComments(livestreamId, { limit: 10, before: { "$gt": "" } })`                                                                        |
| **Expected Response**     | Rejected by validation (string-typed cursor)                                                                                             |
| **Expected DB Changes**   | None                                                                                                                                     |
| **Expected Socket/Event** | None                                                                                                                                     |
| **Notes**                 | `[transport pending]` — Prisma typing expects a string, but add explicit zod string validation at the handler to block object injection. |

### TC-LIVE-062 — Cross-stream read isolation

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments                                       |
| **API/Event Name**        | `LivestreamCommentService.getComments`                      |
| **Test Scenario**         | Fetching comments for stream S1 never returns S2's comments |
| **Category**              | Security / DB State                                         |
| **Priority**              | High                                                        |
| **Preconditions**         | Comments exist in both S1 and S2                            |
| **Request Payload**       | `getComments(S1, { limit: 50 })`                            |
| **Expected Response**     | Only S1 comments                                            |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | Grounded: query is always scoped by `livestreamId`.         |

---

## 8. Realtime / Socket Emission (target contract — pending wiring)

### TC-LIVE-070 — New comment broadcast to livestream room

| Field                     | Value                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments (realtime)                                                                                                                                                |
| **API/Event Name**        | `room:livestream:comment:add` → `room:livestream:comment:new`                                                                                                                   |
| **Test Scenario**         | A persisted comment is broadcast to all viewers in the livestream room                                                                                                          |
| **Category**              | Concurrency / Realtime                                                                                                                                                          |
| **Priority**              | High                                                                                                                                                                            |
| **Preconditions**         | 3 viewers joined `room:livestream:<id>`                                                                                                                                         |
| **Request Payload**       | One viewer posts a comment                                                                                                                                                      |
| **Expected Response**     | Sender gets ack with the stored comment                                                                                                                                         |
| **Expected DB Changes**   | One row inserted                                                                                                                                                                |
| **Expected Socket/Event** | `room:livestream:comment:new` delivered to the other 2 viewers (Redis adapter fan-out across gateway instances)                                                                 |
| **Notes**                 | `[transport pending]` — broadcast event + room semantics defined in `docs/PROJECT_KNOWLEDGE_BASE.md §Livestream Events` but not implemented in `apps/api-gateway/src/sockets/`. |

### TC-LIVE-071 — Join / leave livestream room

| Field                     | Value                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments (realtime)                                                                                            |
| **API/Event Name**        | `room:livestream:join` / `room:livestream:leave`                                                                            |
| **Test Scenario**         | Viewer joins the room to receive comment broadcasts, then leaves                                                            |
| **Category**              | Realtime                                                                                                                    |
| **Priority**              | Medium                                                                                                                      |
| **Preconditions**         | Authenticated socket                                                                                                        |
| **Request Payload**       | `room:livestream:join { livestreamId }`                                                                                     |
| **Expected Response**     | Joined ack; subsequent `comment:new` events delivered until `leave`                                                         |
| **Expected DB Changes**   | None                                                                                                                        |
| **Expected Socket/Event** | After `leave`, no further `comment:new` for that socket                                                                     |
| **Notes**                 | `[transport pending]` — events listed in knowledge base; no handler exists. Cross-reference `websocket-events/` once built. |

### TC-LIVE-072 — Idempotent send does not double-broadcast

| Field                     | Value                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Livestream / Comments (realtime)                                                                                                                                |
| **API/Event Name**        | `room:livestream:comment:add`                                                                                                                                   |
| **Test Scenario**         | Re-sending with the same `clientCommentId` returns the existing comment without a second broadcast                                                              |
| **Category**              | Business Rule / Realtime                                                                                                                                        |
| **Priority**              | Medium                                                                                                                                                          |
| **Preconditions**         | TC-LIVE-030 setup (first send already broadcast)                                                                                                                |
| **Request Payload**       | Duplicate `comment:add` with same `clientCommentId`                                                                                                             |
| **Expected Response**     | Sender gets the original comment in ack                                                                                                                         |
| **Expected DB Changes**   | None (no new row)                                                                                                                                               |
| **Expected Socket/Event** | **No** new `room:livestream:comment:new` broadcast                                                                                                              |
| **Notes**                 | `[transport pending]` — depends on handler only broadcasting when a row is newly created (service returns existing on dup; handler must detect "was-existing"). |
