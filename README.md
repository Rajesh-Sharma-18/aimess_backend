# AiMess

Monorepo for AiMess backend services: **pnpm workspaces**, **Turborepo**, **TypeScript**, **Express**, and **Docker Compose** for local data stores (PostgreSQL, MongoDB, Redis, RabbitMQ, MinIO) plus optional admin UIs.

New developers should read this file once, then **[Architecture](./docs/ARCHITECTURE.md)** and **[Development guide](./docs/DEVELOPMENT.md)** for day-to-day work.

## Architecture (short)

- **`apps/api-gateway`** — HTTP edge: security headers, CORS, rate limiting, request IDs, Swagger. Env expects gRPC URLs to downstream services (wiring can grow over time).
- **`apps/auth-service`** — Identity and auth (Prisma on PostgreSQL database **`aimess_auth`**). Uses shared **`@aimess/redis`** and JWT-related config.
- **`apps/user-service`** — Profiles and social graph (Prisma on PostgreSQL database **`aimess_users`**). **`userId`** matches **`AuthUser.id`** from auth-service (no cross-database foreign keys).

Shared libraries live under **`packages/`** (logger, errors, Prisma helpers, Redis, types, and so on). See **[Architecture](./docs/ARCHITECTURE.md)** for the full platform map (9 microservices, ports, databases, gRPC, monorepo, and Turborepo).

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **pnpm** 11.x (repo pins `packageManager` in root `package.json`; use `corepack enable` if you rely on Corepack)
- **Docker Desktop** (or Docker Engine + Compose v2) for infrastructure containers

## Quick start

1. **Clone** the repository and open the repo root in your terminal.

2. **Environment files**
   - Copy **`.env.example`** → **`.env`** at the repo root and fill values used by Docker Compose (ports, DB users/passwords, and so on).
   - For each app you run, copy that app’s **`.env.example`** → **`.env`** (for example `apps/api-gateway/.env`, `apps/auth-service/.env`, `apps/user-service/.env`).

   Important for Postgres: keep the default maintenance database name **`postgres`** (either omit `POSTGRES_DB` or set `POSTGRES_DB=postgres`) so first-time Docker init can create the per-service databases. Details in [Development](./docs/DEVELOPMENT.md#postgresql-and-init-scripts).

3. **Start infrastructure**

   ```bash
   pnpm docker:up
   ```

   Or: `docker compose --env-file .env up -d` from the repo root.

4. **Install dependencies and build shared packages**

   ```bash
   pnpm install
   pnpm build:packages
   ```

5. **Apply database migrations** (each Prisma app has its own schema)

   From repo root:

   ```bash
   pnpm db:migrate:deploy
   ```

   That runs `prisma migrate deploy` for **auth-service** and **user-service** in order. For creating new migrations locally, see [Development](./docs/DEVELOPMENT.md#prisma-migrations).

6. **Run apps in dev**

   ```bash
   pnpm dev
   ```

   Or run one workspace: `pnpm --filter @aimess/api-gateway dev`.

## Useful scripts (root)

Docker commands use **`--env-file .env`** — keep a root `.env` (from `.env.example`) before running them.

| Script                          | Purpose                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm dev`                      | Turborepo: all workspaces that define `dev`                                                   |
| `pnpm dev:gateway`              | Run only **api-gateway**                                                                      |
| `pnpm dev:auth`                 | Run only **auth-service**                                                                     |
| `pnpm dev:user`                 | Run only **user-service**                                                                     |
| `pnpm build`                    | Build across the monorepo                                                                     |
| `pnpm lint`                     | ESLint via Turborepo                                                                          |
| `pnpm test`                     | Tests via Turborepo (where defined)                                                           |
| `pnpm format`                   | Prettier + Prisma formatting helper                                                           |
| `pnpm db:generate`              | `prisma generate` in **auth** and **user** services                                           |
| `pnpm db:migrate:deploy`        | `prisma migrate deploy` in **auth** then **user** (CI / after `git pull`)                     |
| `pnpm db:migrate:dev:auth`      | Interactive `prisma migrate dev` for **auth-service**                                         |
| `pnpm db:migrate:dev:user`      | Interactive `prisma migrate dev` for **user-service**                                         |
| `pnpm db:studio:auth`           | Open Prisma Studio for **auth-service**                                                       |
| `pnpm db:studio:user`           | Open Prisma Studio for **user-service**                                                       |
| `pnpm docker:up`                | `docker compose --env-file .env up -d`                                                        |
| `pnpm docker:down`              | `docker compose --env-file .env down`                                                         |
| `pnpm docker:build`             | `docker compose --env-file .env build` (no `build:` in compose → usually nothing to build)    |
| `pnpm docker:build:apps`        | Build **api-gateway**, **auth-service**, **user-service** images (`docker build -f apps/...`) |
| `pnpm docker:rebuild`           | down → build → up (same env file)                                                             |
| `pnpm docker:ps`                | `docker compose --env-file .env ps`                                                           |
| `pnpm docker:logs`              | Follow logs for all Compose services                                                          |
| `pnpm create-service -- <slug>` | Scaffold a new app from `tooling/service-template`                                            |

More detail: [Development guide](./docs/DEVELOPMENT.md#5-prisma-migrations).

## Documentation index

| Document                                       | Contents                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Services, packages, infrastructure, boundaries                                                                                   |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)   | Env layout, Docker, Prisma, adding services, troubleshooting                                                                     |
| [docker/README.md](./docker/README.md)         | Compose stack, volumes, Postgres/Mongo notes, **production app images**                                                          |
| [.gitlab-ci.yml](./.gitlab-ci.yml)             | CI/CD: quality gate, Prisma migrate smoke, Docker image builds, publish to GitLab Container Registry, optional manual VPS deploy |

## License

ISC (see root `package.json`).
