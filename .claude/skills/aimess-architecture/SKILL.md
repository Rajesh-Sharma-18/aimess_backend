---
name: aimess-architecture
description: AIMess backend monorepo — pnpm workspaces + Turborepo, Node 20 + Express 5 + TypeScript, microservices with gRPC sync (@grpc/grpc-js), RabbitMQ async (amqplib), Redis pub/sub + cache (ioredis), Bull job queues, Prisma 7 on PostgreSQL, Mongoose on MongoDB, Socket.IO isolated in delivery-service, MinIO object storage, Firebase Admin FCM, Nodemailer, OSSRS livestream, WebRTC + Coturn, Elasticsearch, opossum circuit breakers. Use when designing features, adding services, choosing sync vs async comms, routing through the gateway, picking a datastore, wiring auth, or asking how the system fits together. ALSO use to orchestrate a multi-agent team (Project Manager, Pro Coder, DRY Reviewer, Contract/Figma Reviewer, Quality Tester) to build, refactor, or ship a backend feature end-to-end — when the user asks to "build", "implement", "ship", or "develop" a feature/service, spin up the team per the Agent Team Mode below.
---

# AIMess backend architecture skill

## Always read first

Open and follow **`docs/ARCHITECTURE.md`** in the repo root for the canonical service map. The sections below are the engineering rulebook; **Agent Team Mode** is how you execute multi-step build/refactor work, and the rest of the document is the shared knowledge base every agent must obey.

## Agent Team Mode (primary workflow for build/implement requests)

When this skill is triggered for any non-trivial development task — "build X", "implement the Y endpoint", "add the Z service", "refactor the messaging pipeline", "ship the call feature" — **do not write all the code yourself**. Act as the **orchestrator**: stand up a team of subagents, give each a role-scoped brief, and manage their work through the task list. For tiny one-line fixes or pure questions, skip the team and answer directly.

### Step 1 — Plan & create the task list

1. Read `docs/ARCHITECTURE.md` and the relevant `apps/<service>/src` so your brief is grounded in real code.
2. Break the request into discrete tasks and register them with **TaskCreate** (one task per deliverable: schema, endpoint, event wiring, tests, review). Mark a chapter with `mark_chapter` when the phase shifts (planning → building → review → verify).
3. Decide which work is independent (can run in parallel) vs sequential (has dependencies).

### Step 2 — Form the team

Launch each role with the **Agent** tool. There are no custom agent types, so use `subagent_type` as noted and put the role identity in the prompt. Launch independent agents **in a single message** (parallel); serialize only when one depends on another's output.

| Role                          | subagent_type     | Mandate                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project Manager**           | `Plan`            | Owns the implementation plan: sequences tasks, defines acceptance criteria per task, flags architectural risks, decides gRPC-vs-RabbitMQ and Postgres-vs-Mongo per §rules. Produces the spec the Pro Coder follows. Runs first.                                                                                            |
| **Pro Coder**                 | `general-purpose` | Implements the feature in `apps/<service>` / `packages/*`. Must follow the controllers→services→repositories layering, Zod env + body validation, `.js` import extensions, and use `@aimess/*` shared packages. Writes code only — no review of its own work.                                                              |
| **Contract / Figma Reviewer** | `general-purpose` | Reviews the _external contract_: OpenAPI/Swagger paths (`apps/api-gateway/src/docs`), gRPC `.proto` definitions (`packages/grpc-contracts/proto`), RabbitMQ event payloads, and request/response shapes against the spec (and any Figma/design spec the user supplies). Confirms the contract matches what clients expect. |
| **Code DRY Reviewer**         | `general-purpose` | Hunts duplication and boundary violations: copy-pasted logger/error/redis logic that belongs in `packages/*`, a service touching another service's DB, missing circuit breakers on outbound gRPC/RMQ, unvalidated env. May invoke the `simplify` skill. Reports concrete file:line fixes.                                  |
| **Quality Tester**            | `general-purpose` | Writes/extends tests and runs `pnpm typecheck`, `pnpm lint`, and the service's `test` script. Verifies happy path + failure path (circuit-open fallback, DLQ on consumer failure, auth rejection). Reports pass/fail with evidence, never just intentions.                                                                 |
| _(add as needed)_             | —                 | e.g. a **Security Reviewer** (`general-purpose`, or the `security-review` skill) for auth/token/upload changes; an **Explore** agent (`Explore`) for fast codebase recon before planning; a **DB Migration** agent for Prisma schema + `migrate dev`.                                                                      |

### Step 3 — Manage the pipeline

Default flow (adapt to the task graph):

```
PM (Plan)  ──►  Pro Coder (implement)  ──►  ┌─ DRY Reviewer ─┐
                                            ├─ Contract Rev. ─┤  (parallel review)
                                            └─ Quality Tester ┘
                                                   │
                              orchestrator triages findings ──► Pro Coder fixes ──► re-verify
```

- Update each **TaskUpdate** to `in_progress` when an agent starts it and `completed` only after a reviewer/tester confirms — not when the coder _claims_ done.
- **Trust but verify:** an agent's summary is intent, not fact. After the Pro Coder reports, read the actual diff before handing it to reviewers. After reviewers report, confirm the fixes landed.
- Run the three reviewers **in parallel** (single message, multiple Agent calls) once code exists — they're independent.
- Loop: if any reviewer/tester fails, feed concrete findings back to the Pro Coder, then re-run only the failed check. Do not close the task until typecheck + lint + tests are green and reviews pass.
- Brief every agent with: the goal, the exact files/paths in scope, the relevant architecture rules from this skill, and what form of report you want. Never tell an agent to "implement based on your findings" — hand it the synthesized decision.

### Step 4 — Report

Summarize for the user: what each agent produced, the final task-list state, test/lint/typecheck results, and any deferred follow-ups (use `spawn_task` for out-of-scope items the reviewers surfaced).

> Every agent operates under the rules in the rest of this document. Paste the relevant slice (DB-per-service, gRPC vs RabbitMQ, stateless, shared packages, `.js` imports, layering) into each agent's prompt so it cannot drift.

## Monorepo shape

- **pnpm** workspaces: `apps/*`, `packages/*`, `tooling/service-template`
- **Turborepo** orchestrates `dev`, `build`, `lint`, `typecheck`, `test`
- Shared packages compile to **`dist/`** (gitignored) — run `pnpm build:packages` after every clone or after editing a package
- Scaffold new services with `pnpm create-service <name>` (copies `tooling/service-template` into `apps/`)
- TypeScript ESM (`"type": "module"`) — use the **`.js`** import extension in `.ts` sources

## Tech stack (locked)

| Layer                      | Choice                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime / framework        | Node 20 + **Express 5** (every service)                                                                                                                                                                                                                          |
| Sync inter-service         | **gRPC** via `@grpc/grpc-js` + `@grpc/proto-loader`; protos in `packages/grpc-contracts/proto`                                                                                                                                                                   |
| Async inter-service        | **RabbitMQ** via `amqplib`, topic exchange `aimess.events`, durable queues, manual ACK, DLQ + retry exchange                                                                                                                                                     |
| Real-time push             | **Socket.IO 4** — only in `delivery-service`; cross-instance via `@socket.io/redis-adapter`                                                                                                                                                                      |
| Job queue                  | **Bull** (Redis-backed) for batch persistence, delayed jobs, exponential retry                                                                                                                                                                                   |
| Relational ORM             | **Prisma 7** — _not_ Sequelize. Each Prisma app owns its own schema under `apps/<svc>/prisma/`                                                                                                                                                                   |
| Postgres driver            | `pg` + `@aimess/prisma-pg` for shared utilities                                                                                                                                                                                                                  |
| Document store             | **MongoDB**. **community-service uses Prisma 7's MongoDB connector** (`provider = "mongodb"`) to keep tooling identical to auth/user-service. Other Mongo services (messaging/stream/call/notification) may use Mongoose 9 unless decided otherwise per-service. |
| Cache / pub-sub / sessions | **Redis 7** via `ioredis` (also Socket.IO adapter, rate-limit store, Bull broker)                                                                                                                                                                                |
| Object storage             | **MinIO** (S3-compatible) via `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — clients PUT directly with presigned URLs                                                                                                                                  |
| Validation                 | **Zod 4** for env schemas and request bodies                                                                                                                                                                                                                     |
| Auth                       | JWT access + refresh (`jsonwebtoken`); Google / Apple ID tokens (`google-auth-library`, `jwks-rsa`); `@aimess/auth-jwt` middleware                                                                                                                               |
| Security headers / CORS    | `helmet` + `cors` on every Express app                                                                                                                                                                                                                           |
| Rate limiting              | `express-rate-limit` backed by Redis (gateway is primary, per-route caps on sensitive endpoints)                                                                                                                                                                 |
| Email                      | **Nodemailer** in `notifications-service` (MailHog locally on SMTP `1025`)                                                                                                                                                                                       |
| Push                       | **Firebase Admin SDK 13** in `notifications-service`                                                                                                                                                                                                             |
| Circuit breaker            | **opossum** on every outbound gRPC + RabbitMQ consumer                                                                                                                                                                                                           |
| Logging                    | `@aimess/logger` — structured JSON, `requestId` propagated via `X-Request-Id`                                                                                                                                                                                    |
| Containers                 | Docker Compose (`docker-compose.yml`, project name `aimess`) for local infra; per-service `Dockerfile` for image builds                                                                                                                                          |

Do **not** introduce alternative libraries (axios for internal calls, Sequelize, NestJS, plain `node-amqp`, etc.) — match what is already in the stack.

## Service catalogue

Current apps are starred. Unstarred rows are the planned services from the architecture spec — scaffold with `pnpm create-service` when work begins.

| HTTP | gRPC | Service                     | Primary store                                                          | Status                                                                                                                                              |
| ---- | ---- | --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8000 | —    | **api-gateway\***           | —                                                                      | Edge HTTP, Helmet, CORS, rate limit, request ID, Swagger, JWT validate, proxy to downstreams                                                        |
| 3001 | 4001 | **auth-service\***          | Postgres `aimess_auth` (Prisma) + Redis + RabbitMQ                     | Identity, JWT, OTP, social login, sessions; publishes `user.registered`, OTP mail events                                                            |
| 3002 | 4002 | **user-service\***          | Postgres `aimess_users` (Prisma) + Redis + RabbitMQ + MinIO            | Profile, friendships, blocks, avatar presigned uploads, settings                                                                                    |
| 3003 | 4003 | community-service           | MongoDB `community_db` (**Prisma 7 mongodb connector**)                | Community CRUD, RBAC (admin/mod/member), invite links, community chat, global mute                                                                  |
| 3004 | 4004 | messaging-service           | MongoDB `messaging_db` (Mongoose, sharded `conversationId+_id`) + Bull | Private/group chat, batch persist via Bull, 9 media types, read receipts, reactions, pin, TTL                                                       |
| 3005 | —    | delivery-service            | stateless (Redis adapter only)                                         | **Only** holds Socket.IO connections; subscribes to Redis pub/sub channels (`conv:<id>`, `user:<id>`, `stream:<id>`, `community:<id>`) and fans out |
| 3006 | 4006 | **notifications-service\*** | MongoDB + RabbitMQ consumer + Firebase + Nodemailer                    | FCM push, in-app inbox, transactional mail (currently consumes `notification.queue`)                                                                |
| 3007 | 4007 | stream-service              | MongoDB `stream_db` + OSSRS Auth API                                   | Livestream lifecycle, ≤5 concurrent per community, stream comments, RTMP key issuance                                                               |
| 3008 | 4008 | call-service                | MongoDB `call_db` + Redis (TTL for missed-call) + Coturn               | WebRTC signalling, state machine, call history, mute sync                                                                                           |
| 3010 | 4010 | backoffice-service          | Postgres `admin_db` (Prisma) + read-only Mongo                         | Admin panel, RBAC, moderation queue, audit logs, TOTP 2FA, IP whitelist                                                                             |

Reserved Postgres databases (already created by `docker/postgres/init/01-create-databases.sql`): `aimess_auth`, `aimess_users`, `aimess_communities`, `aimess_moderation`.

## Communication rules

**gRPC (sync)** — use only when the caller needs the answer to continue:

- `api-gateway` → `auth-service` `ValidateToken` on every protected request
- `messaging-service` → `user-service` `GetFriendship` / `GetBlockStatus`
- `community-service` → `user-service` `GetProfile`
- `stream-service` → `community-service` `ValidateMembership`
- `backoffice-service` → read-only RPCs on user/community/stream services

Every gRPC client wraps the call in **opossum** with `timeout: 2000`, `errorThresholdPercentage: 50`, `resetTimeout: 10000`, `volumeThreshold: 5`, and a graceful fallback.

**RabbitMQ (async, topic exchange `aimess.events`)** — use whenever the caller does not need a response:

- `auth-service` → `user.registered`, `mail.send_otp`, `mail.welcome`, `user.locked`
- `user-service` → `user.profile_updated`, `friend.*`, `user.blocked`, `user.unfriended`
- `messaging-service` → `message.sent` (consumer: notifications)
- `community-service` → `community.*`
- `stream-service` → `stream.started|ended|cancelled`
- `call-service` → `call.initiated|accepted|ended|missed|rejected`
- `backoffice-service` → `admin.user_suspended|banned`, `admin.content_deleted`

Conventions: routing key is `domain.event`, messages are `persistent: true`, consumers `prefetch(10)`, manual ACK, 3 retries via `aimess.retry` (TTL 1s→2s→4s) then `aimess.dlq` (alert in Grafana).

**Redis pub/sub** — only the messaging/stream/call hot path uses it, and only to talk to `delivery-service`. Channels: `conv:<id>`, `user:<id>`, `stream:<id>`, `community:<id>`. Never use it to reach a business-logic service.

**HTTP between services** — avoided. The only legitimate HTTP-internal hop today is `user-service` → `auth-service` for full profile aggregation (configured via `AUTH_SERVICE_URL` until that path moves to gRPC).

## Hard rules when implementing

1. **One service, one database.** Never read another service's tables or collections directly — go through gRPC, RabbitMQ events, or shared IDs (e.g. `userId` is the same UUID in `auth-service` and `user-service`, with no cross-DB FK).
2. **Gateway is the only public HTTP entry.** Bind services to `127.0.0.1` for local dev and rely on the gateway for CORS, rate limits, JWT validation, request IDs, Swagger.
3. **JWT validation at the edge.** Downstream services trust the propagated `X-User-Id` / `X-User-Roles` headers (or a thin local re-verify with `@aimess/auth-jwt`).
4. **`delivery-service` has no business logic.** It receives via Redis pub/sub and emits via Socket.IO — that is it. Persistence, validation, fan-out decisions live in `messaging-service` / `stream-service` / `call-service`.
5. **Shard before you need to.** Mongo collections that will grow (messages, community_messages) must define their shard key (`conversationId + _id`) from day one.
6. **Async by default.** Anything that does not need an immediate answer (FCM push, mail send, search index sync, moderation fan-out) goes through RabbitMQ — never block the request thread on it.
7. **Stateless services.** All state in Postgres / Mongo / Redis. Never keep per-user data in process memory — pods scale horizontally and rotate freely.
8. **Use the shared packages** — `@aimess/logger`, `@aimess/errors`, `@aimess/constants`, `@aimess/shared-types`, `@aimess/auth-jwt`, `@aimess/redis`, `@aimess/prisma-pg`, `@aimess/utils`. Do not duplicate them inside an app.
9. **Validate env with Zod** on boot in `src/config/env.ts`; fail fast if anything is missing. Each app loads its own `.env`; root `.env` is for Docker Compose substitution only.
10. **Match existing patterns.** Express 5, controllers → services → repositories layering (see `apps/auth-service/src`), Zod validators in `api/validators/`, repositories in `repositories/`, `@aimess/auth-jwt` middleware. Imports keep the `.js` extension.

## File storage

- All uploads use **MinIO presigned PUT** — clients upload directly, binaries never traverse Node services
- Presigned URL endpoint lives on the owning service (`user-service` for avatars, `messaging-service` for chat media)
- Public buckets (avatars, community covers, sticker packs, stream thumbnails) → served via CDN URL
- Private buckets (chat media, community media, admin exports) → presigned GET on read, expiry ≤ 1 hour
- MIME whitelist enforced by Multer; images re-encoded to **WebP** via Sharp (also strips EXIF/embedded malware)

## Auth quick reference

- Access JWT: 15 min — `Authorization: Bearer …` header
- Refresh JWT: 30 days — HTTP-only `Secure` `SameSite=Strict` cookie, hashed per device in `device_sessions`
- Socket.IO handshake: token in query at connect time, validated once via gRPC, then `socket.data.userId` set
- Admin JWT: 8 hours, separate secret (`JWT_ADMIN_SECRET`), TOTP 2FA mandatory, IP whitelist at gateway
- Token revocation: `jti` in Redis blacklist on logout; checked at the gateway

## Local setup pointer

For clone, install, Docker, Prisma, env layout, Turbo concurrency, or the Windows RabbitMQ port clash, see skill **`aimess-dev-setup`** or **`docs/DEVELOPMENT.md`**.
