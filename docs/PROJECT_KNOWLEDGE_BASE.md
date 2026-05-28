# AIMess Backend — Project Knowledge Base

> **Last updated:** 2026-05-21
> **Purpose:** Single source of truth for all project context. Every agent MUST read this file before making changes. Add notes at the bottom when decisions change.

---

## 1. Project Overview

**AIMess** is a social messaging platform backend serving native iOS and Android clients that expect an **offline-first** messaging experience. The backend is the fast, consistent, real-time source of truth.

- **Repository:** `C:\Users\Windows\Documents\Rajesh\aimess_backend`
- **Git branch:** `dev` (main branch: `main`)
- **Type:** TypeScript monorepo (Turborepo + pnpm workspaces)
- **Runtime:** Node.js 20+ LTS
- **Language:** TypeScript 6.0.3 (strict mode, ESM modules)
- **Package manager:** pnpm 11.x
- **Build orchestrator:** Turborepo 2.9.9

---

## 2. Monorepo Structure

```
aimess_backend/
├── apps/                           # Deployable services
│   ├── api-gateway/               # HTTP edge router (port 3000)
│   ├── auth-service/              # Identity & auth (port 3001)
│   ├── user-service/              # Profiles & social (port 3002)
│   ├── chat-service/              # Messaging & real-time (port 3004) ← NEW
│   └── notifications-service/     # Push/email (scaffold)
├── packages/                       # Shared libraries
│   ├── auth-jwt/                  # JWT token utilities
│   ├── constants/                 # i18n, shared message keys
│   ├── errors/                    # AppError, BadRequestError, ConflictError, UnauthorizedError, NotFoundError, ForbiddenError
│   ├── logger/                    # Structured Winston logging
│   ├── redis/                     # Redis client helpers
│   ├── prisma-pg/                 # PostgreSQL Prisma helpers
│   ├── shared-types/              # Cross-service TypeScript types
│   ├── utils/                     # ApiResponse, asyncHandler, locale middleware
│   └── grpc-contracts/            # Future protobuf contracts (placeholder)
├── tooling/service-template/       # Template for `pnpm create-service`
├── scripts/                        # Automation (create-service, format-prisma)
├── docker/                         # Compose init scripts
├── docs/                           # Architecture, Development, THIS FILE
├── docker-compose.yml              # Local infrastructure
├── turbo.json                      # Build orchestration
└── pnpm-workspace.yaml             # Workspace config
```

---

## 3. Services

### 3.1 API Gateway (`@aimess/api-gateway` — port 3000)

| Aspect        | Detail                                                                      |
| ------------- | --------------------------------------------------------------------------- |
| Role          | HTTP entry point for all clients                                            |
| Stack         | Express 5, Helmet, CORS, http-proxy-middleware                              |
| Database      | None                                                                        |
| Features      | Rate limiting, Swagger UI at `/docs/v1`, request ID injection, health check |
| Proxy targets | auth-service, user-service, chat-service                                    |
| Key file      | `apps/api-gateway/src/versioning/registry.ts` — service registry            |

**Chat-service is registered** at segment `"chat"` with downstream prefix `/api/chat`, proxied to `CHAT_SERVICE_URL` (default `http://127.0.0.1:3003`).

### 3.2 Auth Service (`@aimess/auth-service` — port 3001)

| Aspect   | Detail                                               |
| -------- | ---------------------------------------------------- |
| Role     | Identity, credentials, sessions, OTP, OAuth          |
| Stack    | Express 5, Prisma (PostgreSQL), Redis, bcryptjs, JWT |
| Database | PostgreSQL `aimess_auth`                             |
| ORM      | Prisma 7.8                                           |

**Key models:** AuthUser, Session, RefreshToken, OtpCode, PasswordResetToken, LinkedAccount, LoginAttempt

**Auth flow:** Register/Login → bcrypt verify → JWT access (15 min) + refresh (7 day) → refresh token rotation with reuse detection

**Published events:** `user.created` → RabbitMQ → user-service creates UserProfile

### 3.3 User Service (`@aimess/user-service` — port 3002)

| Aspect   | Detail                                                    |
| -------- | --------------------------------------------------------- |
| Role     | Profiles, friendships, blocks, privacy, settings, avatars |
| Stack    | Express 5, Prisma (PostgreSQL), Redis, MinIO/S3           |
| Database | PostgreSQL `aimess_users`                                 |
| ORM      | Prisma 7.8                                                |

**Key models:** UserProfile, Friendship, Block, PrivacySettings, ChatSettings, AppSettings

**Consumes:** `user.created` events from auth-service via RabbitMQ

### 3.4 Chat Service (`@aimess/chat-service` — port 3004) **NEW**

| Aspect           | Detail                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Role             | Private messaging, group chat, community rooms, friendships, notifications, presence, livestream comments |
| Stack            | Express 5, **Prisma (MongoDB)**, Redis, Socket.IO with Redis adapter, Zod                                 |
| Database         | **MongoDB** (`aimess_chat` via `MONGODB_URI`)                                                             |
| ORM              | **Prisma v7 with MongoDB adapter** (NOT Mongoose)                                                         |
| Real-time        | Socket.IO 4.8 on namespace `/z-product`, Redis adapter for horizontal scaling                             |
| Generated client | `src/generated/prisma/` (auto-generated, gitignored)                                                      |

**Architecture pattern:**

```
HTTP Request → Route → Middleware (auth + validate) → Controller (THIN) → Service → Repository → Prisma Client → MongoDB
Socket Event → Auth Middleware → Handler (THIN) → Service → Repository → Prisma Client → MongoDB
```

### 3.5 Notifications Service (`@aimess/notifications-service` — scaffold)

| Aspect   | Detail                                      |
| -------- | ------------------------------------------- |
| Role     | Email (Nodemailer) + FCM push notifications |
| Status   | Scaffolded, not fully implemented           |
| Consumes | RabbitMQ events from other services         |

---

## 4. Chat Service — Detailed Architecture

### 4.1 File Structure (91 files total)

```
apps/chat-service/
├── prisma/
│   └── schema.prisma              # 15 MongoDB models with indexes
├── src/
│   ├── config/
│   │   ├── env.ts                 # Zod-validated env vars
│   │   ├── db.ts                  # Prisma $connect / $disconnect
│   │   ├── redis.ts               # ioredis client
│   │   ├── prisma.ts              # PrismaClient singleton
│   │   └── socket.ts              # Socket.IO server factory + Redis adapter
│   ├── types/
│   │   ├── enums.ts               # MessageType, GroupRole, SystemEvent, etc.
│   │   └── socket-events.ts       # All event name constants
│   ├── lib/
│   │   ├── response.ts            # ApiResponse helpers
│   │   ├── pagination.ts          # Cursor-based pagination
│   │   └── room-id.ts             # generateRoomId, buildParticipantsKey
│   ├── middleware/
│   │   ├── authenticate.ts        # JWT auth via @aimess/auth-jwt
│   │   ├── error-handler.ts       # Global error handler → { success, error: { code, message } }
│   │   ├── validate-body.ts       # Zod validation middleware
│   │   └── rate-limit.ts          # Redis sliding-window rate limiter
│   ├── infrastructure/
│   │   └── storage.ts             # S3/MinIO pre-signed URL generation
│   ├── repositories/ (15 files)
│   │   ├── private-room.repository.ts
│   │   ├── private-message.repository.ts
│   │   ├── private-message-pin.repository.ts
│   │   ├── group-room.repository.ts
│   │   ├── group-message.repository.ts
│   │   ├── group-member.repository.ts
│   │   ├── group-invite-link.repository.ts
│   │   ├── group-message-pin.repository.ts
│   │   ├── friendship.repository.ts
│   │   ├── general-room.repository.ts
│   │   ├── general-room-message.repository.ts
│   │   ├── room-member.repository.ts
│   │   ├── notification.repository.ts
│   │   ├── livestream-comment.repository.ts
│   │   └── cache.repository.ts           # Redis: presence, user snapshots
│   ├── services/ (15 files)
│   │   ├── private-room.service.ts
│   │   ├── private-message.service.ts     # Has friendship gate
│   │   ├── private-pin.service.ts
│   │   ├── group-room.service.ts
│   │   ├── group-message.service.ts
│   │   ├── group-member.service.ts
│   │   ├── group-invite-link.service.ts
│   │   ├── group-pin.service.ts
│   │   ├── friendship.service.ts
│   │   ├── notification.service.ts
│   │   ├── presence.service.ts
│   │   ├── community-room.service.ts
│   │   ├── community-message.service.ts
│   │   ├── user-snapshot.service.ts
│   │   └── livestream-comment.service.ts
│   ├── validators/ (8 files)
│   │   ├── private-message.validator.ts
│   │   ├── group-room.validator.ts
│   │   ├── group-message.validator.ts
│   │   ├── group-member.validator.ts
│   │   ├── group-invite-link.validator.ts
│   │   ├── friendship.validator.ts
│   │   ├── community.validator.ts
│   │   └── notification.validator.ts
│   ├── controllers/ (11 files)
│   │   ├── private-room.controller.ts
│   │   ├── private-message.controller.ts
│   │   ├── group-room.controller.ts
│   │   ├── group-message.controller.ts
│   │   ├── group-member.controller.ts
│   │   ├── group-invite-link.controller.ts
│   │   ├── friendship.controller.ts
│   │   ├── notification.controller.ts
│   │   ├── community.controller.ts
│   │   ├── community-message.controller.ts
│   │   └── media.controller.ts
│   ├── routes/ (11 files)
│   │   ├── index.ts                       # Barrel mount all routers
│   │   ├── health.routes.ts
│   │   ├── private-message.routes.ts      # Rate: 60/min
│   │   ├── group-room.routes.ts           # Rate: 10 creates/day
│   │   ├── group-message.routes.ts        # Rate: 30/min
│   │   ├── group-member.routes.ts
│   │   ├── group-invite-link.routes.ts
│   │   ├── friendship.routes.ts           # Rate: 20/min
│   │   ├── notification.routes.ts
│   │   ├── community.routes.ts            # Rate: 30/min
│   │   └── media.routes.ts               # Rate: 30/min
│   ├── sockets/
│   │   ├── index.ts                       # Register namespace + handlers
│   │   ├── auth-middleware.ts             # JWT validation (NO guest allowed)
│   │   ├── guards/
│   │   │   └── socket-guard.ts            # requireLoggedIn, validateMember
│   │   ├── helpers/
│   │   │   └── validate-socket.ts         # Zod validation for socket payloads
│   │   └── handlers/
│   │       ├── session.handler.ts         # Connection/disconnect lifecycle
│   │       ├── private-message.handler.ts # 1-1 messaging events
│   │       ├── community-message.handler.ts # Community room events
│   │       ├── group.handler.ts           # Group chat events
│   │       └── livestream.handler.ts      # Livestream comments
│   ├── app.ts                             # Express factory
│   └── server.ts                          # Bootstrap: mongo → redis → http → socket.io
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── Dockerfile
```

### 4.2 Prisma MongoDB Models (15 models)

| Model                | Collection                 | Key Fields                                                                                                                                   | Indexes                                            |
| -------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `PrivateRoom`        | `private_rooms`            | roomId (unique), participants[], participantsKey (unique), lastMessage (Json), unreadCountByUser (Json), blockedBy (Json), deletedFor (Json) | participants, lastMessageAt DESC                   |
| `PrivateMessage`     | `private_messages`         | roomId, senderId, receiverId, content (Json), messageType, reactions (Json), parentMessageId, deletedFor (Json), isDeleted                   | roomId+createdAt, roomId+isDeleted+createdAt       |
| `PrivateMessagePin`  | `private_message_pins`     | roomId, messageId, pinnedBy, contentPinned (Json)                                                                                            | unique(roomId+messageId+pinnedBy), roomId+pinnedAt |
| `GroupRoom`          | `group_rooms`              | roomId (unique), type (GROUP\|COMMUNITY), name, status (ACTIVE\|DISBANDED), settings (Json), lastMessagePreview (Json)                       | status+lastMessageAt, createdBy+createdAt          |
| `GroupMessage`       | `group_messages`           | roomId, clientMessageId, senderId, messageType, content (Json), systemEvent, reactions (Json), deletedType                                   | roomId+createdAt, clientMessageId                  |
| `GroupMember`        | `group_members`            | roomId, userId, role (OWNER\|ADMIN\|MODERATOR\|MEMBER), status (ACTIVE\|LEFT\|KICKED\|BANNED)                                                | unique(roomId+userId), userId+status+updatedAt     |
| `GroupInviteLink`    | `group_invite_links`       | roomId, token (unique), status, maxUses, usedCount                                                                                           | roomId+status+createdAt                            |
| `GroupMessagePin`    | `group_message_pins`       | roomId, messageId, pinnedBy, contentPinned (Json)                                                                                            | unique(roomId+messageId), roomId+pinnedAt          |
| `Friendship`         | `friendships`              | requesterId, users[], pairKey (unique), status (ACCEPTED\|PENDING\|REJECTED\|DECLINED)                                                       | pairKey unique, users+status                       |
| `GeneralRoom`        | `general_rooms`            | name, owner, status, listPinedMessage (Json)                                                                                                 | status, tags                                       |
| `GeneralRoomMessage` | `general_room_messages`    | roomId, sentBy, message, reactions (Json), attachments (Json), deletedBy (Json)                                                              | roomId, roomId+sentBy                              |
| `RoomMember`         | `room_members`             | roomId, userId, status, role, banInfo (Json)                                                                                                 | unique(roomId+userId), roomId+status               |
| `Notification`       | `notifications`            | userId, actorId, type, entity (Json), actorSnapshot (Json)                                                                                   | userId+createdAt, userId+type                      |
| `Livestream`         | `livestreams`              | roomId, title, status (SCHEDULED\|LIVE\|ENDED\|CANCELED)                                                                                     | roomId                                             |
| `LivestreamComment`  | `chat_livestream_comments` | livestreamId, sentBy, message, clientCommentId                                                                                               | livestreamId+createdAt                             |

**NOTE:** Complex nested objects (reactions maps, content objects, settings, unread counters) use Prisma's `Json` type since Prisma MongoDB doesn't support embedded composite types well.

### 4.3 HTTP API Routes

All routes are under `/api/chat` prefix, proxied through API Gateway at `/api/v1/chat/`.

| Route Group       | Base Path                 | Key Endpoints                                                                                                                                                                                     |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private messaging | `/api/chat/private`       | GET /rooms/:roomId/messages, POST /rooms/:roomId/messages, PATCH /conversations/delete-for-me, POST /messages/delete-for-me, POST /messages/delete-for-everyone, GET /messages/pins               |
| Group rooms       | `/api/chat/groups`        | POST / (create), GET /:roomId, PATCH /:roomId, DELETE /:roomId                                                                                                                                    |
| Group messages    | `/api/chat/groups`        | GET /:roomId/messages, POST /:roomId/messages, POST /:roomId/read, DELETE /:roomId/messages/:messageId, POST /:roomId/pins, GET /:roomId/pins, POST /:roomId/messages/:messageId/reactions/toggle |
| Group members     | `/api/chat/group-members` | GET /:roomId/available-friends, POST /:roomId/members, POST /:roomId/leave, POST /:roomId/members/:userId/kick, POST /:roomId/members/:userId/role                                                |
| Invite links      | `/api/chat/invite-links`  | GET /:roomId/current, POST /:roomId/revoke, POST /:roomId/share, GET /preview/:token, POST /:token/join                                                                                           |
| Friends           | `/api/chat/friends`       | POST /request, POST /accept, POST /decline, POST /cancel, POST /initialize, GET /receives, GET /, POST /status                                                                                    |
| Notifications     | `/api/chat/notifications` | GET /, POST /read, GET /unread-count                                                                                                                                                              |
| Community         | `/api/chat/community`     | GET /rooms, GET /rooms/search, POST /room/:roomId/join, POST /room/:roomId/leave, POST /room/:roomId/messages, GET /room/:roomId/messages                                                         |
| Media             | `/api/chat/media`         | POST /upload-url                                                                                                                                                                                  |
| Health            | `/health`                 | GET /                                                                                                                                                                                             |

### 4.4 Socket.IO Events

**Namespace:** `/z-product`
**Auth:** JWT required (no guest connections)
**Transport:** WebSocket with Redis adapter for cross-instance broadcasting

#### Private Messaging Events

| Client → Server                             | Description                            |
| ------------------------------------------- | -------------------------------------- |
| `room:private:home:join`                    | Join conversation list lobby           |
| `room:private:home:leave`                   | Leave conversation list lobby          |
| `room:private:home:conversations:load-more` | Paginate conversations                 |
| `room:private:initiation:join`              | Join personal channel on app start     |
| `room:private:user:join`                    | Join a specific private room           |
| `room:private:messages:load-more`           | Paginate messages in room              |
| `room:private:message:add`                  | Send private message                   |
| `room:private:message:react`                | Add/remove reaction                    |
| `room:private:message:pin`                  | Pin message                            |
| `room:private:message:unpin`                | Unpin message                          |
| `room:private:conversation:read`            | Mark conversation as read              |
| `room:private:presence:heartbeat`           | Heartbeat for online status            |
| `room:private:presence:app_state`           | Update app foreground/background state |
| `room:private:presence:subscribe`           | Subscribe to peer presence             |
| `room:private:presence:unsubscribe`         | Unsubscribe from peer presence         |

| Server → Client                               | Description                     |
| --------------------------------------------- | ------------------------------- |
| `room:private:{roomId}:message:add:new`       | New message in room             |
| `room:private:message:react:new`              | Reaction update                 |
| `room:private:{roomId}:message:pin:new`       | Message pinned                  |
| `room:private:{roomId}:message:read`          | Read receipt                    |
| `room:private:home:conversation:read:updated` | Conversation read state changed |

#### Group Chat Events

| Client → Server                    | Description              |
| ---------------------------------- | ------------------------ |
| `room:group:home:join`             | Join group list lobby    |
| `room:group:user:join`             | Join specific group room |
| `room:group:message:add`           | Send group message       |
| `room:group:message:react`         | Toggle reaction          |
| `room:group:message:pin` / `unpin` | Pin/unpin                |
| `room:group:message:delete`        | Delete message           |
| `room:group:conversation:read`     | Mark group as read       |

#### Community Room Events

| Client → Server                    | Description            |
| ---------------------------------- | ---------------------- |
| `room:general:home:join` / `leave` | Community lobby        |
| `room:general:user:join`           | Join community room    |
| `room:general:message:add`         | Send community message |
| `room:general:message:react`       | React to message       |

#### Livestream Events

| Client → Server                      | Description           |
| ------------------------------------ | --------------------- |
| `room:livestream:join` / `leave`     | Join/leave livestream |
| `room:livestream:comment:add`        | Post comment          |
| `room:livestream:comments:load-more` | Paginate comments     |

### 4.5 Dependency Injection

The `server.ts` manually composes the entire DI graph:

1. **Repositories** receive `PrismaClient` instance (or `Redis` for cache repo)
2. **Services** receive repositories (+ other services where needed)
3. **Controllers** receive services
4. **Routes** receive controllers
5. **Socket handlers** receive services via dependency object

This pattern keeps everything testable — mock the repository interface and the service works in isolation.

### 4.6 Rate Limiting

Redis sliding-window implementation in `middleware/rate-limit.ts`:

| Route                  | Limit  | Key      |
| ---------------------- | ------ | -------- |
| Private message send   | 60/min | per user |
| Group message send     | 30/min | per user |
| Community message send | 30/min | per user |
| Friendship mutations   | 20/min | per user |
| Group creation         | 10/day | per user |
| Media upload URL       | 30/min | per user |

### 4.7 Security Enforcements

- **No guest socket connections** — JWT required on handshake
- **Friendship gate** — private rooms and messages require ACCEPTED friendship between users
- **Socket guard** — `SocketGuard.requireLoggedIn()` on all state-mutating handlers
- **Zod validation** — on all HTTP request bodies and socket payloads
- **Pre-signed URLs** — media uploads use real S3/MinIO pre-signed URLs with content-type allowlist
- **Cross-instance broadcasting** — `io.to()` (not `socket.to()`) for Redis adapter fan-out

---

## 5. Shared Packages

| Package                | Import         | Purpose                                                                                                |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `@aimess/auth-jwt`     | JWT middleware | `createAuthenticateAccessToken(secret)` → populates `req.auth`                                         |
| `@aimess/errors`       | Error classes  | `AppError`, `BadRequestError`, `ConflictError`, `UnauthorizedError`, `NotFoundError`, `ForbiddenError` |
| `@aimess/logger`       | Logging        | `logger.info()`, `logger.error()` — Winston structured JSON                                            |
| `@aimess/constants`    | i18n           | Message keys, locale translations                                                                      |
| `@aimess/redis`        | Redis helpers  | Connection utilities                                                                                   |
| `@aimess/utils`        | API helpers    | `ApiResponse`, `asyncHandler`, locale middleware                                                       |
| `@aimess/shared-types` | Types          | Cross-service TypeScript interfaces                                                                    |
| `@aimess/prisma-pg`    | Prisma PG      | PostgreSQL Prisma utilities (auth/user services only)                                                  |

---

## 6. Infrastructure (Docker Compose)

| Service         | Image                   | Port            | Purpose                                           |
| --------------- | ----------------------- | --------------- | ------------------------------------------------- |
| postgres        | postgres:16             | `POSTGRES_PORT` | Auth + User databases                             |
| mongodb         | mongo:7                 | `MONGODB_PORT`  | **Chat service database**                         |
| redis           | redis:7                 | `REDIS_PORT`    | Sessions, cache, rate limiting, Socket.IO adapter |
| rabbitmq        | rabbitmq:3 (management) | 5672 / 15672    | Event bus (user.created, etc.)                    |
| minio           | minio                   | 9000 / 9001     | S3-compatible file storage                        |
| pgadmin         | pgadmin4                | 5050            | PostgreSQL UI                                     |
| redis-commander | redis-commander         | 8081            | Redis UI                                          |

**PostgreSQL databases:** `aimess_auth`, `aimess_users`, `aimess_communities` (reserved), `aimess_moderation` (reserved)

**MongoDB database:** `aimess_chat` (via `MONGODB_URI` in chat-service `.env`)

---

## 7. Environment Variables

### Chat Service (`apps/chat-service/.env`)

| Variable                 | Default     | Description                      |
| ------------------------ | ----------- | -------------------------------- |
| `NODE_ENV`               | —           | development / production / test  |
| `CHAT_SERVICE_PORT`      | 3003        | HTTP port                        |
| `MONGODB_URI`            | —           | MongoDB connection string        |
| `REDIS_HOST`             | —           | Redis hostname                   |
| `REDIS_PORT`             | —           | Redis port                       |
| `JWT_ACCESS_SECRET`      | —           | Must match auth-service secret   |
| `RABBITMQ_URL`           | —           | (optional) RabbitMQ connection   |
| `MINIO_ENDPOINT`         | localhost   | MinIO host                       |
| `MINIO_PORT`             | 9000        | MinIO port                       |
| `MINIO_ACCESS_KEY`       | minioadmin  | MinIO access key                 |
| `MINIO_SECRET_KEY`       | minioadmin  | MinIO secret key                 |
| `MINIO_BUCKET`           | aimess-chat | Bucket name                      |
| `MINIO_USE_SSL`          | false       | Use HTTPS for MinIO              |
| `MESSAGE_PAGE_SIZE`      | 30          | Messages per page                |
| `CONVERSATION_PAGE_SIZE` | 20          | Conversations per page           |
| `PIN_LIMIT_PER_ROOM`     | 50          | Max pinned messages              |
| `USER_SERVICE_URL`       | —           | (optional) User service base URL |

---

## 8. Key Architectural Rules

### ALWAYS follow these:

1. **Controllers are THIN** — parse request, call service, return response. No business logic.
2. **Services own ALL business logic** — friendship checks, role checks, rate enforcement, permission validation.
3. **Repositories own database queries** — Prisma Client calls only. No business rules.
4. **Socket handlers are THIN** — validate payload, call service, emit result. No direct DB access.
5. **Services are transport-agnostic** — callable from HTTP controllers, socket handlers, AND background jobs identically.
6. **No `console.log` in `src/`** — use `@aimess/logger` (except env.ts which uses `process.stderr.write`).
7. **Cursor-based pagination** for all list endpoints (not offset).
8. **Zod validation** on every request body and socket payload.
9. **JWT auth** on every non-health endpoint.
10. **`io.to()` not `socket.to()`** for broadcasting — ensures Redis adapter fan-out to all instances.
11. **Field names must match reference** for mobile client compatibility.
12. **Prisma `Json` type** for complex nested structures (reactions, content, settings, Maps).

### NEVER do these:

- Import Prisma/Mongoose models in controllers or socket handlers
- Put business logic in middleware or controllers
- Use offset pagination for chat history
- Allow guest/anonymous socket connections
- Spread `req.body` directly into Prisma queries
- Store refresh tokens unhashed
- Log tokens, OTPs, secrets, or message bodies
- Use `socket.to()` for cross-instance broadcasts

---

## 9. Service Communication

```
┌─────────────┐    HTTP proxy     ┌──────────────┐
│ API Gateway  │ ────────────────→ │ auth-service  │ (PostgreSQL)
│  port 3000   │ ────────────────→ │ user-service  │ (PostgreSQL)
│              │ ────────────────→ │ chat-service  │ (MongoDB)
└─────────────┘                   └──────┬───────┘
                                         │
                    ┌────────────────────┘
                    ↓
              ┌──────────┐    events     ┌─────────────────────┐
              │ RabbitMQ  │ ───────────→ │ notifications-svc   │
              └──────────┘               └─────────────────────┘

auth-service  ──(user.created)──→  RabbitMQ  ──→  user-service (creates UserProfile)
chat-service  ──(future events)──→  RabbitMQ  ──→  notifications-service (push/email)
```

- **HTTP:** API Gateway proxies to downstream services
- **RabbitMQ:** Async events (user.created, future message events for push)
- **Redis:** Shared cache, Socket.IO adapter for cross-instance pub/sub
- **gRPC:** Planned (env placeholders exist, not implemented)

---

## 10. Development Commands

```bash
# Infrastructure
pnpm docker:up                    # Start all Docker services
pnpm docker:down                  # Stop all
pnpm docker:logs                  # Follow logs

# Install
pnpm install                      # Install all workspace deps

# Development
pnpm dev                          # All services in watch mode
pnpm dev:gateway                  # API Gateway only
pnpm dev:auth                     # Auth service only
pnpm dev:user                     # User service only
pnpm dev:chat                     # Chat service only

# Build & Check
pnpm build                        # Build all
pnpm typecheck                    # TypeScript check all
pnpm lint                         # Lint all

# Chat Service Prisma
pnpm --filter @aimess/chat-service db:generate    # Generate Prisma client
pnpm --filter @aimess/chat-service db:push        # Push schema to MongoDB

# Auth/User Prisma
pnpm db:generate                  # Generate all Prisma clients
pnpm db:migrate:deploy            # Deploy migrations
pnpm db:studio:auth               # Prisma Studio for auth DB
pnpm db:studio:user               # Prisma Studio for user DB

# Docker Build
pnpm docker:build:apps            # Build all service Docker images
```

---

## 11. Reference Implementation

The chat service was built by referencing `C:\Users\Windows\Desktop\chat-service` (a JavaScript/Mongoose/Socket.IO app). Key adaptations made:

| Aspect         | Reference (JS)        | AIMess (TS)                                       |
| -------------- | --------------------- | ------------------------------------------------- |
| Language       | JavaScript (CommonJS) | TypeScript (ESM, strict)                          |
| ORM            | Mongoose 8.19         | **Prisma v7 + MongoDB**                           |
| Validation     | Joi 17                | Zod 4                                             |
| Framework      | Express 4             | Express 5                                         |
| Architecture   | Mixed layers          | Strict layers (routes→controllers→services→repos) |
| Auth           | Custom JWT middleware | `@aimess/auth-jwt` package                        |
| Error handling | Custom                | `@aimess/errors` package                          |
| File upload    | Busboy + MinIO direct | S3 pre-signed URLs                                |

---

## 12. Code Review Results & Fixes Applied

### Fixed Issues (2026-05-21)

| ID  | Severity | Issue                                        | Fix                                                                      |
| --- | -------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| C1  | Critical | Guest socket connections allowed             | Removed guest logic, JWT required                                        |
| C2  | Critical | Livestream handler bypasses layers           | Created LivestreamCommentService + Repository                            |
| C3  | Critical | No rate limiting                             | Added Redis sliding-window rate limiter on all routes                    |
| M2  | Major    | No friendship gate for DMs                   | Added `areFriends()` check in PrivateRoomService + PrivateMessageService |
| M3  | Major    | Fake pre-signed URLs                         | Created `infrastructure/storage.ts` with real S3 pre-signed URLs         |
| M5  | Major    | console.error in env.ts                      | Changed to `process.stderr.write`                                        |
| M6  | Major    | Error response missing codes                 | Updated to `{ success, error: { code, message } }`                       |
| M7  | Major    | Socket guard never called                    | Added `SocketGuard.requireLoggedIn()` to all mutating handlers           |
| m1  | Minor    | socket.to() doesn't broadcast cross-instance | Changed to `io.to()` everywhere                                          |

### Known Remaining Items (Minor)

| ID  | Issue                                                                     | Status                           |
| --- | ------------------------------------------------------------------------- | -------------------------------- |
| m2  | `getMessagesSchema` declared but not applied on GET route                 | Pending                          |
| m3  | Notification `markRead` doesn't verify ownership                          | Pending                          |
| m4  | Socket.IO CORS set to `origin: "*"`                                       | Pending (restrict in production) |
| m5  | `connectionStateRecovery` enabled (contradicts fresh-handshake rule)      | Pending                          |
| m6  | No requestId middleware for log correlation                               | Pending                          |
| m7  | Health endpoint returns `{ success }` not `{ ok }`                        | Pending                          |
| m8  | `clientInfor` typo (should be `clientInfo`) — locked in Prisma schema now | Pending (breaking change)        |

---

## 13. Decision Log

| Date       | Decision                                              | Rationale                                                                                                     |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-05-21 | Use MongoDB (not PostgreSQL) for chat service         | Chat data (messages, reactions, nested content) fits document model better; MongoDB already in docker-compose |
| 2026-05-21 | Use Prisma v7 with MongoDB adapter (not Mongoose)     | User requirement — consistency with auth/user services ORM choice; type-safe queries                          |
| 2026-05-21 | Use `Json` type for Maps and nested objects in Prisma | Prisma MongoDB doesn't support embedded composite types well; Json is the pragmatic choice                    |
| 2026-05-21 | Single Socket.IO namespace `/z-product`               | Matches reference implementation; mobile clients already built against this                                   |
| 2026-05-21 | No guest connections                                  | Security requirement from architecture skill; all socket connections require JWT                              |
| 2026-05-21 | Added `ForbiddenError` to `@aimess/errors` package    | Needed for friendship gate; was missing from error hierarchy                                                  |

---

## 14. Notes

> Add timestamped notes here when decisions change or new context is learned.

- **2026-05-21:** Project initialized with 4-agent workflow (PM → Coder → Tester → Reviewer). Chat service fully implemented and reviewed. Migrated from Mongoose to Prisma MongoDB. All critical/major review issues fixed.
- **2026-05-21 (post-pull):** Pulled commit `9cc7832` which added: `apps/community-service/` (port 3004, Prisma+PostgreSQL), Firebase social login in auth-service, device-link & account deletion, `@aimess/storage` shared package, `TooManyRequestsError` + `UnsupportedMediaTypeError` to `@aimess/errors`, app-version system in gateway. **Port conflict resolved:** chat-service moved from **3003 → 3004**. Gateway integration re-applied (CHAT_SERVICE_URL env + registry entry). `ForbiddenError` already existed in the pulled code — our import is compatible. Note: chat-service storage cleanup done (see next note).
- **2026-05-22 (i18n message catalog for chat-service):** Created `packages/constants/src/messages/chat.messages.ts` (`CHAT_MESSAGES`, vi/en, `ChatMessageKey`) covering all chat success + error strings; registered in `messages/index.ts` (spread into `MESSAGES` + re-exported). Rebuilt the constants package. Wired chat-service to the catalog following the auth/user/community pattern:
  - All service/guard/media error throws now pass a **catalog KEY** (e.g. `NotFoundError("CHAT_ROOM_NOT_FOUND")`, `ForbiddenError("CHAT_FRIENDSHIP_REQUIRED")`).
  - `error-handler.ts` localizes via `t(messageKey, req.locale)` (locale from `localeMiddleware`, already mounted in app.ts) and keeps the stable `code`; Prisma/JSON/internal errors also localized via catalog keys.
  - Controllers' success messages use `t("CHAT_*", req.locale)` in `ApiResponse`.
  - Socket errors localized in `handleSocketAction` via `t(key, DEFAULT_LOCALE)` (no per-request locale on sockets).
  - Response shape unchanged (`{success:false, error:{code, message}}`); only the message is now localized. This also fixed the earlier message==code issue (e.g. FRIENDSHIP_REQUIRED now returns a human, localized message with a stable code). Verified live: malformed id → en "Invalid ID format" / vi "Định dạng ID không hợp lệ"; friendship gate en/vi; success read-all en/vi. Typecheck + lint clean.
- **2026-05-22 (validation + error-message hardening):** (1) **Prisma error mapping** in `error-handler.ts` — replaced the dead Mongoose `CastError`/`ValidationError` branches with Prisma mapping: `P2023`→400 `INVALID_ID_FORMAT` "Invalid ID format", `P2025`→404 `NOT_FOUND`, `P2002`→409 `CONFLICT`, `P2003`→400 `INVALID_REFERENCE`, other known→400, `PrismaClientValidationError`→400 `INVALID_REQUEST`. Detected by `error.name`/`.code` (no import from generated client); never leaks Prisma's verbose message. Fixes malformed-ObjectId leaking as 500 → now clean 400. (2) **Stable error codes** — `error-handler` now derives `code`: keeps UPPER_SNAKE messageKeys (e.g. `FRIENDSHIP_REQUIRED`) but maps human-sentence messages to a status-based code (`BAD_REQUEST`, etc.) so validation errors return `{code:"BAD_REQUEST", message:"limit: Too big…"}` instead of code==message. (3) **Query validation** — new `validateQuery` middleware + `query.validator.ts` (`messageListQuerySchema`, `messageSearchQuerySchema`: cursor string, limit int 1–100, q ≤100) wired into the message list + search routes for all 3 surfaces (Express 5 makes req.query read-only, so it validates without reassigning — closes review item m2). Verified live: malformed id→400, limit=99999→400, limit=abc→400, non-friend DM→403 FRIENDSHIP_REQUIRED, no token→401. Lint + typecheck clean. **Minor remaining:** `FRIENDSHIP_REQUIRED`/`AUTH_UNAUTHORIZED` still have message==code (the shared @aimess/errors classes conflate message+messageKey); humanizing those messages would need a code→message map or a shared-package change.
- **2026-05-22 (comprehensive scenario test — 2 real bugs found & fixed):** Ran a full positive+negative matrix (54 scenarios: REST + Socket.IO) → now **54/54 pass**. Two real bugs surfaced and were fixed:
  1. **Private messaging broken** (`Unknown argument clientInfo`): the schema/repo were renamed `clientInfor`→`clientInfo` but `prisma generate` hadn't been re-run, so the generated client was stale. Fix: regenerated the client. (Also had to restore `url = env("MONGO_DATABASE_URL")` in the datasource + recreate `prisma.config.ts` — both had been removed; **Prisma v6 CLI requires the schema `url`**, the v7 editor squiggle is cosmetic. Do not remove them.)
  2. **Real-time broadcasts never delivered** (all surfaces): the 4 socket handlers received the **root `io` server** and called `io.to(room).emit()`, which targets the default `/` namespace — but clients connect to **`/z-product`**. Acks worked (so message _creation_ looked fine) but no room broadcast ever reached other clients. Fix: pass the namespace (`xProduct = io.of("/z-product")`) into the 4 message handlers (`registerSocketHandlers`) and change their first param type `Server`→`Namespace`. All `io.to(...)` calls now broadcast on `/z-product`. Verified: a second client (B) now receives `room:private:<roomId>:message:add:new`.
- **2026-05-22 (lint cleanup):** Cleared all 12 chat-service ESLint errors (`@typescript-eslint/no-unused-vars`): removed unused `logger` imports across 5 service/handler files, removed unused `BadRequestError`/`NotFoundError` from community-message.service, removed unused `getMessagesSchema` import from private-message.routes, and dropped two unused destructured deps (`roomMemberRepo` in community-message.handler, `userSnapshotService` in private-message.handler — kept in the `deps` type so server.ts wiring is untouched). chat-service lint now CLEAN (0 problems); typecheck passes. Repo-wide lint state: chat-service + notifications-service CLEAN; api-gateway/auth-service/user-service/community-service have 2 **warnings** each (no errors). Also note: `clientInfor`→`clientInfo` was renamed in private-message.repository.ts (schema field rename still pending — breaking). **Still open:** review item m2 — `getMessagesSchema` is not applied as query validation (needs a `validateQuery` middleware; `validateBody` only covers `req.body` and GET has no body).
- **2026-05-21 (friends management removed from chat-service):** Removed the friends **management** surface from chat-service because friendships are owned by **user-service**. Deleted `friendship.controller.ts`, `friendship.service.ts`, `friendship.validator.ts`, `friendship.routes.ts`; unwired `/api/chat/friends` + `FriendshipController` from `server.ts`/`routes/index.ts`; removed the `FRIENDLIST_JOIN` socket event + handler and the unused `NotificationType` enum (FRIEND*REQUEST*\* — only the deleted service created them). Removed the Chat — Friends paths/schemas/tag from gateway swagger and the Friends folder from the Postman collection.
  - **KEPT (intentionally):** the `Friendship` Prisma model (`friendships` collection), `FriendshipRepository`, and the **friendship gate** — `PrivateRoomService.getOrCreateRoom()` and `PrivateMessageService.sendMessage()` still call `friendshipRepo.areFriends()` and throw `FORBIDDEN: FRIENDSHIP_REQUIRED` for non-friends.
  - **⚠️ Caveat (decision: "keep gate, defer rewire"):** chat-service no longer has any way to _create_ friendships, so the gate now blocks all DMs until the `friendships` collection is populated externally (future: sync from user-service, or re-wire the gate to a user-service `check(a,b)` endpoint — which does NOT exist yet; user-service only has `GET /api/v1/friends/` listing the caller's friends, and there's no chat→user service-to-service auth/HTTP client). Revisit when friendship ownership is consolidated.
- **2026-05-21 (attachments + search + downloads):** Added across **all three chat surfaces** (private, group, community): **Location** and **Contact** attachments, **in-chat message search**, and a **media download (presigned GET)** endpoint. GIFs + Stickers deferred (need provider/API key + sticker asset source).
  - **No Prisma migration** — location/contact ride inside the existing Json columns: `content.location`/`content.contact` for private+group; community pushes typed items `{type:"location"|"contact", ...}` into the `attachments` Json array (threaded in `community-message.handler.ts`).
  - New message types: `LOCATION`/`CONTACT` (private/group) and `location`/`contact` (community) added to `enums.ts` + each send-message validator. Shared shapes in new `validators/attachment.validator.ts`.
  - **Search:** `GET /private/rooms/:roomId/messages/search`, `GET /groups/:roomId/messages/search`, `GET /community/rooms/:roomId/messages/search` (all `?q=&limit=`). Private/group search `content.text` via Prisma `findRaw` regex (escaped) then re-fetch by id for clean shape; community searches the `message` String field with `contains` + `mode:"insensitive"`.
  - **Media download:** `POST /chat/media/download-url {objectKey}` → `createPresignedViewUrl` from `@aimess/storage`; rejects keys not under `chat-uploads/`. Read limit 120/min.
  - Swagger updated (gateway `chat.paths.ts` + `schemas.ts`): search paths, download-url path, `ChatLocationAttachment`/`ChatContactAttachment`/`ChatDownloadUrl*` schemas, content location/contact + LOCATION/CONTACT enums.
  - **Env/Mongo:** `env.ts` composes the Mongo URL from `MONGO_ROOT_USERNAME/PASSWORD`, `MONGODB_PORT`, `MONGO_HOST` (default localhost), `MONGO_DB_NAME` (default aimess_chat), `authSource`=`MONGO_DATABASE`, `directConnection=true` (optional complete `MONGO_DATABASE_URL` from `process.env` overrides). PrismaClient gets the URL via `datasourceUrl`. **Mongo now requires auth** (root creds). Replica set ⇒ `directConnection=true` mandatory from host.
  - **Prisma CLI (`prisma.config.ts`):** the Prisma CLI does NOT run `src/config/env.ts`, so `prisma.config.ts` composes the same `MONGO_DATABASE_URL` from the `MONGO_*` parts (via `dotenv` + `process.env`) so `generate`/`db push`/`studio` resolve `env("MONGO_DATABASE_URL")` in the schema. When `prisma.config.ts` exists Prisma stops auto-loading `.env`, hence the explicit `dotenv.config()` there.
  - **Known cosmetic editor issue:** the VS Code Prisma extension ships a **v7** language server that flags `url` in the schema datasource ("`url` no longer supported"). The project is on **Prisma v6**, which _requires_ `url` in the datasource (removing it fails `prisma validate`). The squiggle is a version mismatch only — the v6 CLI validates/generates fine. To silence it, pin the Prisma VS Code extension to a v6 release.
  - **Verified during the session** with a temporary E2E harness (Socket.IO client + Mongo seed + REST tests): location+contact across all 3 surfaces, search ×3, download-url + foreign-key reject all passed; existing endpoints regression-passed. **The harness (`apps/chat-service/scripts/`) was removed afterward** — it was a throwaway verification artifact, not part of the service. Pre-existing lint debt (44 unused-var errors in handler files) left untouched; newly edited files are lint-clean.
- **2026-05-21 (storage cleanup):** Replaced chat-service's local `infrastructure/storage.ts` with `@aimess/storage` shared package. Deleted `src/infrastructure/` directory. Media controller now uses `createPresignedUploadUrl` and `buildObjectKey` from `@aimess/storage`. Removed direct `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` deps. Added `config/storage.ts` for the shared client (matches community-service pattern). Env simplified: `MINIO_ENDPOINT` is now a full URL, removed `MINIO_PORT`/`MINIO_USE_SSL`, added `MINIO_REGION`/`MINIO_PRESIGN_EXPIRES_IN`.
