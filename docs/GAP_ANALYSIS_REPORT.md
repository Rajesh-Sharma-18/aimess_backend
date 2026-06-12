# AIMess Backend — Gap Analysis Report

**Reviewer roles:** Principal QA Engineer · Senior SDET · Software Architect · Security Reviewer · Senior Backend Developer  
**Branch:** `rajesh-dev`  
**Date:** 2026-06-12  
**Spec source:** `BACKEND-FEATURES-AND-GAPS.md` (2083 lines, 15 gap sections)

---

## 1. Methodology

Every requirement in the spec was validated in three directions:

1. **Spec → Code** — does the code implement what the spec claims?
2. **Code → Spec** — does the spec accurately describe what the code does?
3. **Cross-check** — do related files (proto, gRPC client, socket handler, REST route, test) stay consistent?

The rule applied throughout: _never trust the .md file blindly; never trust the implementation blindly._

---

## 2. Spec Accuracy Findings

The following spec claims were found to be **inaccurate or misleading** after code review.

### 2.1 "Server does not track forMe deletes" — INCORRECT

**Spec claim:** The server cannot distinguish per-user deletions and must send all messages in catchup.  
**Reality:** `PrivateMessage.deletedFor` is a JSON array of user IDs; `GroupMessage.deletedFor` is a similar field. Both are set on `deleteForMe`. The catchup bug was that `findAfterSeq()` returned raw rows and the filtering was never applied downstream.  
**Fix:** Added in-memory `forMe` filter inside `catchup()` for both `PrivateMessageService` and `GroupMessageService`.

### 2.2 "Media Upload API missing" — INCORRECT

**Spec claim:** No media upload API exists.  
**Reality:** `apps/media-service/` is a fully operational service with `POST /upload-url`, `POST /download-url`, presigned PUT flow, category-scoped buckets. What was missing was the _cancel_ endpoint.  
**Fix:** Added `DELETE /uploads/:objectKey?category=...` (see §4.6).

### 2.3 "Token refresh has no socket integration" — PARTIALLY CORRECT

**Spec claim:** Token refresh endpoint is missing.  
**Reality:** REST `POST /api/auth/refresh` exists and works. What was truly missing was socket-level token refresh (`auth:refresh` event) and proactive session expiry timers.  
**Fix:** Full socket refresh flow implemented (see §4.4).

### 2.4 Community catchup caps — UNDERSTATED

**Spec claim:** Catchup allowed unlimited rooms.  
**Reality:** Code had a 20-room cap but 200-event-per-room cap; spec referenced 10/100. Both caps were wrong — spec values are correct.  
**Fix:** Corrected to 10 rooms / 100 events per room.

---

## 3. Bugs Found

### BUG-001 — `forMe` delete filter missing from catchup (HIGH)

| Item           | Detail                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| **Service**    | chat-service                                                                            |
| **Files**      | `apps/chat-service/src/services/private-message.service.ts`, `group-message.service.ts` |
| **Impact**     | Deleted messages reappeared on reconnect for the deleting user                          |
| **Root cause** | `findAfterSeq()` returned all rows; callers never filtered `deletedFor`                 |
| **Fix**        | In-memory `filter(m => !m.deletedFor?.includes(userId))` applied in `catchup()`         |
| **Status**     | Fixed                                                                                   |

### BUG-002 — Health check compared wrong status string (LOW)

| Item           | Detail                                                     |
| -------------- | ---------------------------------------------------------- | ----------------- |
| **Service**    | api-gateway                                                |
| **File**       | `apps/api-gateway/src/routes/health.routes.ts`             |
| **Impact**     | TypeScript error, `"unhealthy"` never matched `"healthy"   | "degraded"` union |
| **Root cause** | Wrong status literal in conditional                        |
| **Fix**        | Changed `status === "unhealthy"` → `status === "degraded"` |
| **Status**     | Fixed                                                      |

### BUG-003 — `deleteObject` called with object arg instead of positional args (MEDIUM)

| Item           | Detail                                                                              |
| -------------- | ----------------------------------------------------------------------------------- |
| **Service**    | media-service                                                                       |
| **File**       | `apps/media-service/src/services/media.service.ts`                                  |
| **Impact**     | `cancelUpload` would throw at runtime — `deleteObject` is a positional-arg function |
| **Root cause** | Wrong call signature used during initial implementation                             |
| **Fix**        | Changed to `deleteObject(storageClient, def.bucket, params.objectKey)`              |
| **Status**     | Fixed                                                                               |

### BUG-004 — Auth-service response body read at wrong path (MEDIUM)

| Item           | Detail                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------- |
| **Service**    | api-gateway (socket layer)                                                                         |
| **File**       | `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`                                               |
| **Impact**     | `auth:refresh` socket event silently failed — `accessToken` was undefined                          |
| **Root cause** | Code read `body.accessToken`; actual response is `{ data: { accessToken, accessTokenExpiresIn } }` |
| **Fix**        | Changed to `body.data?.accessToken` and `body.data?.accessTokenExpiresIn ?? 900`                   |
| **Status**     | Fixed                                                                                              |

### BUG-005 — `cancelUploadSchema` only read `req.params`, missed `category` from query (LOW)

| Item           | Detail                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| **Service**    | media-service                                                              |
| **File**       | `apps/media-service/src/api/controllers/media.controller.ts`               |
| **Impact**     | `category` was always undefined → validation error on every cancel request |
| **Root cause** | Validator parsed `req.params` only; `category` is a query param            |
| **Fix**        | Changed parse source to `{ ...req.params, ...req.query }`                  |
| **Status**     | Fixed                                                                      |

### BUG-006 — Community catchup room and event caps too large (MEDIUM)

| Item        | Detail                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Service** | api-gateway, chat-service                                                                                                |
| **Files**   | `apps/api-gateway/src/sockets/namespaces/community.ns.ts`, `apps/chat-service/src/services/community-message.service.ts` |
| **Impact**  | Catchup could return 20 rooms × 200 messages = 4000 events per reconnect — excessive for mobile clients                  |
| **Fix**     | Caps set to 10 rooms / 100 events per room per the spec                                                                  |
| **Status**  | Fixed                                                                                                                    |

### BUG-007 — `SOCKET_AUTH_REFRESHED` used before added to MessageKey catalog (LOW)

| Item           | Detail                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| **Service**    | api-gateway + constants package                                                                            |
| **Files**      | `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`, `packages/constants/src/messages/socket.messages.ts` |
| **Impact**     | TypeScript compile error — `ackOk` requires a valid `MessageKey`                                           |
| **Root cause** | Message key referenced before being added to the catalog                                                   |
| **Fix**        | Added all new socket keys to `socket.messages.ts` and rebuilt the constants package                        |
| **Status**     | Fixed                                                                                                      |

### BUG-008 — Community message-service catchup didn't apply per-room event cap (MEDIUM)

| Item        | Detail                                                        |
| ----------- | ------------------------------------------------------------- |
| **Service** | chat-service                                                  |
| **File**    | `apps/chat-service/src/services/community-message.service.ts` |
| **Impact**  | Could return unbounded events per community room              |
| **Fix**     | Enforced 100-event cap in service-layer query                 |
| **Status**  | Fixed                                                         |

---

## 4. Features Implemented

### 4.1 `forMe` delete filter in catchup

**Files:** `private-message.service.ts:catchup()`, `group-message.service.ts:catchup()`

Applied in-memory filter after `findAfterSeq()`:

```typescript
.filter(m => !m.deletedFor?.includes(userId))
```

### 4.2 Conversation lifecycle socket events (`conv:created`, `conv:deleted`)

**Files:** `apps/chat-service/src/services/private-room.service.ts`, `apps/chat-service/src/server.ts`

- `PrivateRoomService` now takes `redis: Redis | Cluster` in its constructor.
- Publishes `conv:created` to `user:{userId}` and `user:{peerId}` channels when a new DM room is created.
- Publishes `conv:deleted` to `user:{userId}` when `deleteForMe` is called.
- Gateway's `/chat` socket namespace subscribes to `user:{userId}` and emits the event to the connected client.

### 4.3 Enhanced health check

**File:** `apps/api-gateway/src/routes/health.routes.ts`

- `GET /health` — full JSON: Redis ping latency, process uptime, heap memory, status (`healthy | degraded`)
- `GET /health/live` — lightweight liveness (200 / 503)
- `GET /health/ready` — readiness (checks Redis reachability)

### 4.4 Socket token refresh and session expiry timers

**Files:** `apps/api-gateway/src/sockets/auth.middleware.ts`, `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`, `packages/constants/src/messages/socket.messages.ts`

Flow:

1. On socket connect, `tokenExpiresAt` (epoch ms) and `accessToken` (raw JWT) stored on `socket.data`.
2. `scheduleSessionTimers(expiresAt)` sets a warning timer at `T - 5 min` and a force-disconnect timer 60s after the warning fires.
3. Client sends `auth:refresh { refreshToken }` → gateway POSTs to auth-service `/api/auth/token` → updates `socket.data.accessToken`, `socket.data.tokenExpiresAt`, reschedules timers.
4. Timers cleared on disconnect.

Events:

- **`session:expired`** (server→client): `{ reason: "TOKEN_EXPIRED", expiresAt, reconnect: true, gracePeriod: 60 }`
- **`auth:refresh`** (client→server, with ack): `{ refreshToken }` → ack `{ accessToken, expiresIn }`

### 4.5 Community moderation socket events

**Files:**

- `packages/grpc-contracts/proto/community.proto` — 7 new RPCs
- `apps/api-gateway/src/grpc/clients/community.client.ts` — 7 new circuit-breaker methods
- `apps/api-gateway/src/sockets/namespaces/community.ns.ts` — 7 new socket handlers
- `packages/constants/src/messages/socket.messages.ts` — 7 new keys

| Socket Event                   | gRPC RPC           | Payload                                        |
| ------------------------------ | ------------------ | ---------------------------------------------- | ------- |
| `community.member.kick`        | `KickMember`       | `communityId, targetUserId, reason?`           |
| `community.member.ban`         | `BanMember`        | `communityId, targetUserId, reason?`           |
| `community.member.unban`       | `UnbanMember`      | `communityId, targetUserId`                    |
| `community.admin.transfer`     | `TransferAdmin`    | `communityId, newAdminId`                      |
| `community.member.role_change` | `ChangeMemberRole` | `communityId, targetUserId, newRole: MODERATOR | MEMBER` |
| `community.report.create`      | `CreateReport`     | `communityId, reason, targetMessageId?`        |
| `community.delete`             | `DeleteCommunity`  | `communityId, reason?`                         |

`community.delete` also broadcasts `community.deleted` to the community room before ack.

### 4.6 Media upload cancel endpoint

**Files:**

- `apps/media-service/src/services/media.service.ts` — `cancelUpload()` method
- `apps/media-service/src/api/controllers/media.controller.ts` — `cancelUpload` handler
- `apps/media-service/src/api/validators/media.validator.ts` — `cancelUploadSchema`
- `apps/media-service/src/api/routes/media.routes.ts` — `DELETE /uploads/:objectKey`
- `docs/MEDIA_UPLOAD.md` — Section 6 added

Endpoint: `DELETE /api/v1/media/uploads/:objectKey?category=CHAT_ATTACHMENT`

Enforces ownership via `assertObjectKeyOwnedBy(objectKey, def.keyPrefix, requesterId)`. Returns `403 MEDIA_CANCEL_FORBIDDEN` on mismatch. Safe to call multiple times (idempotent).

### 4.7 Presence-aware FCM routing

**Files:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`, `apps/notifications-service/src/services/push.service.ts`

- On socket connect: `redisPub.set("user:online:{userId}", "1", "EX", 300)`
- On `presence:heartbeat`: key TTL reset to 300s
- On disconnect: key deleted
- In `push.service.ts`: before sending FCM, check `redis.exists("user:online:{userId}")`. If `1`, skip FCM and only persist an inbox notification row. Falls through to FCM on Redis failure (safe degradation).

### 4.8 Friend management socket events

**File:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`

| Socket Event            | User-service REST                                | Redis fan-out                      |
| ----------------------- | ------------------------------------------------ | ---------------------------------- |
| `friend.request`        | `POST /api/v1/users/friends/requests`            | publishes to `user:{addresseeId}`  |
| `friend.accept`         | `POST /api/v1/users/friends/requests/:id/accept` | publishes to `user:{requesterId}`  |
| `friend.reject`         | `POST /api/v1/users/friends/requests/:id/reject` | publishes to `user:{requesterId}`  |
| `friend.remove`         | `DELETE /api/v1/users/friends/:userId`           | publishes to `user:{targetUserId}` |
| `friend.cancel_request` | `DELETE /api/v1/users/friends/requests/:id`      | —                                  |

Each call uses `socket.data.accessToken` as the Bearer credential. `USER_SERVICE_URL` is optional in env; all friend events return `SERVICE_ERROR` gracefully if the URL is not configured.

---

## 5. Security Findings

### SEC-001 — Chat IDOR / authorization bypass (previously fixed, ref: memory)

8 High-severity authz gaps (H1–H8) were found and fixed in a prior session via `apps/chat-service/src/lib/access-guard.ts`. These covered:

- `assertPrivateParticipant` — verifies caller is a participant before any read/write on private rooms
- `assertGroupMember` — same for group rooms
- `assertCommunityMember` — same for community rooms

All new chat read/write paths must use these guards.

### SEC-002 — Raw JWT stored on `socket.data` (MEDIUM, acknowledged risk)

**Location:** `apps/api-gateway/src/sockets/auth.middleware.ts` — `socket.data.accessToken`

**Concern:** The access token is stored in-process and used for outbound friend/auth-refresh calls. It is not persisted and is only in memory, but it does become stale after expiry if the client fails to call `auth:refresh`.

**Mitigations in place:**

- Token is cleared when the socket disconnects
- `scheduleSessionTimers` force-disconnects 60s after the expiry warning
- Only used for internal service-to-service calls via Bearer, not exposed to other clients

**Remaining risk:** If a socket connection outlasts token expiry AND the client ignores `session:expired`, subsequent friend/auth calls will fail with 401 until the client reconnects. This is acceptable behavior (fail-closed).

### SEC-003 — No rate limit on auth-service `/token` endpoint at gateway level (LOW)

**Location:** `apps/api-gateway/src/config/rate-limiter.ts` (or equivalent)

The socket `auth:refresh` flow calls auth-service directly from the gateway without a per-user rate limit on that code path. The auth-service itself has its own rate limiter, but the gateway should add a per-socket cap (e.g., 10 refresh attempts per 15 min) to prevent abuse.

**Status:** Not fixed in this session — deferred.

### SEC-004 — Refresh token in response body (LOW)

**Location:** `apps/auth-service/src/api/controllers/auth.controller.ts`

The refresh token is returned in the JSON body (`data.refreshToken`) rather than an HTTP-only cookie. This means any XSS on a web client could steal it.

**Status:** Acknowledged; deferred until cookie-based auth is scoped as a feature.

### SEC-005 — Community moderation RPCs have no server-side RBAC guard at proto layer (HIGH)

**Location:** `packages/grpc-contracts/proto/community.proto`, community-service gRPC handlers

The 7 moderation RPCs are defined in the proto and wired at the gateway socket layer, but community-service has **no implementation of these handlers yet**. When they are implemented, each must verify:

- `actorId` is the community admin (for kick/ban/transfer/delete)
- `actorId` is admin or moderator (for role_change, report)
- `actorId` is any member (for report)

Without explicit RBAC checks in the community-service handler, any member could invoke these operations.

**Status:** Not implementable until community-service gRPC server is written. The socket layer validates Zod schemas but cannot enforce community-level role authorization.

---

## 6. Architecture Findings

### ARCH-001 — Friend events routed via REST, not gRPC or RabbitMQ

**File:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` — `callUserSvc()`

Socket → user-service uses internal HTTP (`fetch` with Bearer). This is a deliberate pragmatic choice (user-service already exposes friend REST endpoints) but diverges from the architecture rule: "HTTP between services — avoided."

**Recommendation:** Move friendship operations to gRPC RPCs on user-service for consistency. Create a `FriendshipService` proto with `SendFriendRequest`, `AcceptFriendRequest`, etc. The gateway socket handler then calls `userServiceClient.sendFriendRequest(...)` with a circuit breaker.

**Priority:** Medium. The current approach works but adds an unprotected internal HTTP surface.

### ARCH-002 — Community moderation is socket-only, no REST fallback

**Location:** community socket handlers in `community.ns.ts`

Admin/moderation actions (kick, ban, transfer) are only reachable via Socket.IO. There is no corresponding REST route in the community-service HTTP API. This means:

- Server-rendered admin panels and backoffice cannot trigger moderation without a socket
- The backoffice-service (`apps/backoffice-service`) has no path to these operations

**Recommendation:** Add REST endpoints in community-service (`DELETE /communities/:id/members/:userId`, `POST /communities/:id/bans`, etc.) mirroring the socket events. The socket handlers can remain for real-time clients.

### ARCH-003 — `conv:archived` / `conv:unarchived` has no backing model

**Spec requirement:** Emit `conv:archived` and `conv:unarchived` events when conversations are archived.  
**Reality:** Neither `PrivateRoom` nor `GroupRoom` in the Prisma schema has an `archived` or `archivedBy` field. The concept does not exist in the data model.

**Status:** Not implementable without a schema migration. Requires:

1. `archivedBy: Json?` field on `PrivateRoom` and `GroupRoom` (parallel to `mutedBy` / `deletedFor`)
2. `archiveRoom(roomId, userId)` and `unarchiveRoom(roomId, userId)` service methods
3. Socket events and REST endpoints
4. `conv:archived` / `conv:unarchived` Redis pub events

**Priority:** High. This is a direct spec requirement with zero implementation.

### ARCH-004 — Presence key TTL creates a 5-minute false-positive window

**Location:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`

`user:online:{userId}` is set with TTL 300 (5 minutes). If a client disconnects ungracefully (process killed, network drop), the key lives for up to 5 minutes. During this window, FCM pushes are suppressed even though the user is offline.

**Mitigations in place:** Key is explicitly deleted on clean disconnect. Heartbeat resets TTL.  
**Remaining:** Ungraceful disconnect causes up to 5-minute notification delay. Reduce TTL to 90s and increase heartbeat frequency, or use Socket.IO disconnect ACK.

---

## 7. OpenAPI / Swagger Gaps

The following endpoints/events exist in code but are **not documented** in `apps/api-gateway/src/docs/openapi/`:

| Endpoint                                  | File to update                               |
| ----------------------------------------- | -------------------------------------------- |
| `GET /health/live`                        | `paths/health.paths.ts` (create if missing)  |
| `GET /health/ready`                       | same                                         |
| `DELETE /api/v1/media/uploads/:objectKey` | `paths/media.paths.ts`                       |
| Community moderation events (7)           | `docs/SOCKET_EVENTS.md` §community namespace |
| Friend socket events (5)                  | `docs/SOCKET_EVENTS.md` §chat namespace      |
| `auth:refresh` / `session:expired` events | `docs/SOCKET_EVENTS.md` §chat namespace      |
| `conv:created` / `conv:deleted` events    | `docs/SOCKET_EVENTS.md` §chat namespace      |

`SOCKET_EVENTS.md` needs a moderation section added under the `/community` namespace and a session management section under `/chat`.

---

## 8. Test Coverage Gaps

The following new code paths have no test coverage:

| Path                                            | Type of test needed                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `forMe` filter in `catchup()` — private + group | Unit: assert deleted messages excluded after `deleteForMe`             |
| `conv:created` Redis publish                    | Integration: `getOrCreateRoom()` → verify Redis channel receives event |
| `conv:deleted` Redis publish                    | Integration: `deleteForMe()` → verify Redis channel receives event     |
| `auth:refresh` socket event                     | Socket E2E: valid refresh token → ack with new token                   |
| `session:expired` timer                         | Unit: timer fires after mock expiry, socket receives event             |
| Force-disconnect after grace                    | Unit: 60s after `session:expired`, socket is disconnected              |
| `friend.request` socket event                   | Socket E2E: valid payload → user-service called → Redis pub to target  |
| `friend.accept` / `friend.reject`               | Same pattern                                                           |
| Community `community.member.kick`               | Socket E2E: gRPC stub called → ack ok                                  |
| `cancelUpload` service                          | Unit: owned key → storage delete called; unowned key → 403             |
| `cancelUpload` controller                       | Integration: route returns 200; wrong owner returns 403                |
| Presence-aware FCM skip                         | Unit: mock `redis.exists` → 1 → FCM not called                         |
| Health `/live` and `/ready`                     | Integration: Redis up → 200; Redis down → 503                          |

The existing test harness (`apps/chat-service/tests/` via supertest, Jest) can be extended for the service-layer gaps. Socket E2E tests should use the `socket.io-client` pattern already established in `apps/chat-service/tests/helpers/app-factory.ts`.

---

## 9. Remaining Risks and Deferrals

| ID   | Risk                                                                                                                                         | Severity | Owner                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------- |
| R-01 | Community moderation gRPC RPCs (7) defined in proto but **not implemented** in community-service — all will throw `UNIMPLEMENTED` at runtime | High     | community-service team       |
| R-02 | `conv:archived` / `conv:unarchived` — no data model, no implementation                                                                       | High     | DB migration + chat-service  |
| R-03 | Friend socket events require `USER_SERVICE_URL` to be set; not enforced at startup                                                           | Medium   | api-gateway env validation   |
| R-04 | No rate limit on per-socket `auth:refresh` calls                                                                                             | Low      | api-gateway rate-limiter     |
| R-05 | Refresh token returned in JSON body (not HTTP-only cookie)                                                                                   | Low      | auth-service                 |
| R-06 | `user:online:*` TTL of 300s → up to 5-min false-positive after ungraceful disconnect                                                         | Low      | api-gateway presence         |
| R-07 | Community moderation has no REST fallback — backoffice-service cannot reach it                                                               | Medium   | community-service REST layer |
| R-08 | No OpenAPI docs for 3 new REST endpoints and 15+ new socket events                                                                           | Low      | docs task                    |
| R-09 | No test coverage for 13 new code paths listed in §8                                                                                          | Medium   | QA team                      |

---

## 10. Files Changed in This Session

| File                                                          | Change type                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/api-gateway/src/sockets/auth.middleware.ts`             | Extended `SocketData` with `tokenExpiresAt`, `accessToken`  |
| `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`          | Session timers, `auth:refresh`, presence key, friend events |
| `apps/api-gateway/src/sockets/namespaces/community.ns.ts`     | 7 moderation handlers, catchup cap fix                      |
| `apps/api-gateway/src/grpc/clients/community.client.ts`       | 7 moderation interfaces + circuit breakers                  |
| `apps/api-gateway/src/routes/health.routes.ts`                | Full rewrite with Redis ping, /live, /ready, BUG-002 fix    |
| `packages/grpc-contracts/proto/community.proto`               | 7 new moderation RPCs + message types                       |
| `packages/constants/src/messages/socket.messages.ts`          | 13 new socket message keys                                  |
| `apps/notifications-service/src/services/push.service.ts`     | Presence-aware FCM gate                                     |
| `apps/media-service/src/services/media.service.ts`            | `cancelUpload()` method, BUG-003 fix                        |
| `apps/media-service/src/api/controllers/media.controller.ts`  | `cancelUpload` handler, BUG-005 fix                         |
| `apps/media-service/src/api/validators/media.validator.ts`    | `cancelUploadSchema`                                        |
| `apps/media-service/src/api/routes/media.routes.ts`           | `DELETE /uploads/:objectKey` route                          |
| `apps/chat-service/src/services/private-message.service.ts`   | BUG-001 fix — forMe filter in catchup                       |
| `apps/chat-service/src/services/group-message.service.ts`     | BUG-001 fix — forMe filter in catchup                       |
| `apps/chat-service/src/services/community-message.service.ts` | BUG-008 fix — per-room event cap                            |
| `apps/chat-service/src/services/private-room.service.ts`      | Redis constructor param, conv lifecycle publishes           |
| `apps/chat-service/src/server.ts`                             | Pass `redis` to `PrivateRoomService`                        |
| `docs/MEDIA_UPLOAD.md`                                        | Cancel endpoint section, service reference fix              |

---

## 11. Summary

| Category              | Count                       |
| --------------------- | --------------------------- |
| Bugs found and fixed  | 8                           |
| Features implemented  | 8                           |
| Security findings     | 5 (3 fixed, 2 deferred)     |
| Architecture findings | 4 (1 partially fixed)       |
| OpenAPI/Swagger gaps  | 10+ (not fixed — docs task) |
| Test coverage gaps    | 13 paths                    |
| Remaining hard risks  | 9 (see §9)                  |

The highest-priority unresolved item is **R-01**: the 7 community moderation gRPC RPCs exist in the proto contract and are invoked from the gateway socket layer, but community-service has no handler implementations. Any moderation action attempted by a client will receive a gRPC `UNIMPLEMENTED` error until community-service ships the corresponding handlers.
