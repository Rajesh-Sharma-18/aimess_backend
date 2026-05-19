# Architecture

This document explains how the AiMess backend monorepo is structured, what each part owns, and how local infrastructure fits in.

## Big picture

```text
                    ┌─────────────────────┐
                    │   HTTP clients      │
                    │ (web, mobile, etc.) │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   api-gateway       │
                    │ Express · CORS ·    │
                    │ rate limit · Swagger│
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼────────┐ ┌─────▼─────┐   (future / async)
     │  auth-service   │ │user-service│        …
     │  Express+Prisma │ │Express+Prisma      RabbitMQ, etc.
     │  aimess_auth    │ │aimess_users
     └────────┬────────┘ └─────┬─────┘
              │                │
     ┌────────▼────────────────▼────────┐
     │  PostgreSQL (single instance,    │
     │   multiple databases)           │
     └──────────────────────────────────┘

     Redis, MongoDB, RabbitMQ, MinIO — available via Docker for
     features as they are implemented (connection strings in .env).
```

The gateway is the natural **HTTP entry point**. Service-to-service calls may use **gRPC** (the gateway env schema already includes `AUTH_GRPC_URL` and `USER_GRPC_URL`); evolve routing and clients as features land.

## Monorepo layout

| Path                       | Role                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `apps/*`                   | Deployable Node services (Express, own `package.json`, own env).      |
| `packages/*`               | Shared libraries consumed via `workspace:*`.                          |
| `tooling/service-template` | Template copied by `pnpm create-service` into `apps/`.                |
| `scripts/`                 | Repo automation (for example `create-service.ts`, Prisma formatting). |
| `docker/`                  | Compose-related assets (for example Postgres `init` SQL).             |
| `docker-compose.yml`       | Local stack: databases, cache, queue, object store, optional UIs.     |

**Turborepo** (`turbo.json`) orchestrates `dev`, `build`, `lint`, and `test` tasks. **pnpm** (`pnpm-workspace.yaml`) links workspaces. Common **root** commands (`pnpm docker:up`, `pnpm db:migrate:deploy`, `pnpm dev:auth`, and so on) are listed in the [README](../README.md#useful-scripts-root).

## Applications (`apps/`)

### api-gateway (`@aimess/api-gateway`)

- **Responsibility:** Public HTTP surface: Helmet, CORS, JSON body limits, per-request ID, global rate limit, Swagger UI, health route.
- **Config:** See `apps/api-gateway/.env.example` (`PORT`, gRPC URLs, `REDIS_URL`, `CORS_ALLOWED_ORIGINS`).
- **Stack:** Express 5, Zod for env validation, workspace packages `@aimess/logger`, `@aimess/errors`, `@aimess/utils`.

### auth-service (`@aimess/auth-service`)

- **Responsibility:** Identity and authentication domain: accounts, credentials, sessions/refresh patterns, verification, and related data **as defined in its Prisma schema** (`apps/auth-service/prisma/schema.prisma`).
- **Data store:** PostgreSQL database **`aimess_auth`** (created on first Postgres container init; see `docker/postgres/init`).
- **Stack:** Express, Prisma (client generated under `src/generated/prisma`), Redis usage via `@aimess/redis`, shared constants/types.

**Boundary (from schema comments):** owns identity and auth mechanics; does **not** own rich profile or social graph (that is user-service).

### user-service (`@aimess/user-service`)

- **Responsibility:** Profiles, friendships, blocks, settings, and related user-facing data **as defined in its Prisma schema**.
- **Data store:** PostgreSQL database **`aimess_users`**.
- **Stack:** Express, Prisma, `@aimess/logger`, `@aimess/errors`, `@aimess/prisma-pg`.

**Boundary:** **`userId`** in user-service is the same UUID as **`AuthUser.id`** in auth-service. There is **no** foreign key across databases; consistency is maintained by application flows and events.

## Shared packages (`packages/`)

| Package                | Typical use                                             |
| ---------------------- | ------------------------------------------------------- |
| `@aimess/logger`       | Structured logging across services.                     |
| `@aimess/errors`       | Shared error types / HTTP mapping patterns.             |
| `@aimess/constants`    | Shared constants (for example auth-related).            |
| `@aimess/shared-types` | Cross-service TypeScript types.                         |
| `@aimess/redis`        | Redis connection helpers for services that need them.   |
| `@aimess/prisma-pg`    | Shared Prisma/Postgres utilities for Prisma-based apps. |
| `@aimess/utils`        | Small shared helpers (gateway and others).              |

The directory `packages/grpc-contracts` may exist as a placeholder for future **protobuf / gRPC** contract sharing; wire it into apps when you add generated clients and server stubs.

## Local infrastructure (Docker Compose)

Single file: **`docker-compose.yml`** (project name `aimess`).

Services include:

- **postgres** — one server, multiple databases (see init SQL).
- **mongodb** — for future or parallel features using MongoDB.
- **redis** — caching, sessions, rate-limit backends, and so on.
- **rabbitmq** — message broker (management plugin image).
- **minio** — S3-compatible object storage for local dev.
- **pgadmin**, **redis-commander** — optional operator UIs (guarded by env / compose).

Connection **hostnames** from **inside** other containers are service names (`postgres`, `redis`, …). From **your machine** (Node apps running outside Docker), use **`localhost`** and the **published ports** from `.env` (`POSTGRES_PORT`, `REDIS_PORT`, …).

## PostgreSQL database names

Init script `docker/postgres/init/01-create-databases.sql` creates (on first volume init):

- `aimess_auth`
- `aimess_users`
- `aimess_communities`
- `aimess_moderation`

Auth and user services use the first two today; the others are reserved for upcoming services.

## Design principles (for contributors)

1. **One bounded context per service** — avoid reaching into another service’s tables; use APIs, events, or shared IDs.
2. **Shared code in `packages/`** — do not copy-paste logger or error helpers into each app.
3. **Explicit configuration** — each app loads its own `.env`; root `.env` is primarily for Docker Compose variable substitution.

For commands, env file layout, and migrations, continue to **[Development](./DEVELOPMENT.md)**.
