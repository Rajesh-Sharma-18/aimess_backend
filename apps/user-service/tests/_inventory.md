# user-service test harness inventory

Service kind: **rest + grpc**. App entrypoint: `src/app.ts` exports a NAMED `app`
(and `createApp()`) — there is no default export. Import as `import { app } from "../src/app.js"`.

## Public route used by smoke test

- `GET /health` → 200 `{ success, service: "user-service", title, environment, timestamp }`
  (router in `src/routes/health.routes.ts`).

## API surface (mounted at `/api/v1/users`, see `src/api/routes/index.ts`)

- `/accounts`, `/friends` (+ `/friends` friendship routes), `/settings`, `/uploads`,
  `/usernames`, `/profiles`, and `/` (users discovery). Most non-validation routes
  are guarded by `authenticateAccessToken` (shared `@aimess/auth-jwt` middleware).

## I/O seams mocked in `tests/setup/global-mocks.ts`

| Seam (source module)              | Why it must be mocked                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/config/prisma.js`            | Real Postgres pool via `@aimess/prisma-pg`. Stubbed `{prisma:{}}`.                                     |
| `src/config/redis.js`             | ioredis client; cache forced not-ready so reads hit mocked repos.                                      |
| `src/lib/session-active-cache.js` | Auth gate → resolve `active=true` so authed routes are reachable.                                      |
| `src/grpc/auth.client.js`         | `protoLoader.loadSync` off `import.meta.url` + native @grpc/grpc-js at import (breaks under CJS Jest). |
| `src/config/storage.js`           | Constructs `@aws-sdk/client-s3` S3 clients + media-URL strategy.                                       |

## Seams that DO NOT need mocking (verified)

- RabbitMQ publishers (`src/messaging/publish-*.ts`) — `amqp.connect` is lazy
  (first publish only); importing `amqplib` does not connect.
- `src/grpc/server.ts`, `src/consumers/*.ts` — started by `server.ts`, NOT imported by `app.ts`.

## env vars required by `src/config/env.ts` (set in `tests/setup/env.ts`)

NODE_ENV, USER_SERVICE_PORT, USER_GRPC_PORT, USER_DATABASE_URL, REDIS_HOST,
REDIS_PORT, REDIS_CACHE_ENABLED, RABBITMQ_URL, JWT_ACCESS_SECRET, AUTH_GRPC_URL,
MINIO_ENDPOINT (URL), MINIO_PUBLIC_ENDPOINT (URL), MINIO_ACCESS_KEY,
MINIO_SECRET_KEY, MINIO_BUCKET_AVATARS (or legacy MINIO_BUCKET), MINIO_REGION.

## Status

Smoke test (`tests/smoke.test.ts`) GREEN: `Tests: 1 passed, 1 total`.
