# Docker (local infrastructure)

This repository uses a **single** Compose file at the repo root: **`docker-compose.yml`** (Compose project name **`aimess`**).

It runs PostgreSQL, MongoDB, Redis, RabbitMQ, MinIO, and optional operator tools (**pgAdmin**, **Redis Commander**) for local development.

**`docker compose build`:** this file only uses **`image:`** for every service (pull upstream images). There are **no `build:`** blocks, so Compose reports **“No services to build”** — that is expected. To build **your** Node services, use **`pnpm docker:build:apps`** (runs `docker build` for each `apps/*/Dockerfile` from the repo root) or see [Application images (VPS / registry)](#application-images-vps--registry) below.

## Start and stop

From the repository root, with **`.env`** present (copy from `.env.example`):

```bash
docker compose --env-file .env up -d
docker compose --env-file .env down
```

Or use root package scripts (they all pass **`--env-file .env`**): `pnpm docker:up`, `pnpm docker:down`, `pnpm docker:ps`, `pnpm docker:logs`, `pnpm docker:build`, `pnpm docker:rebuild`.

## Split dev/prod projects (optional pattern)

If you later introduce separate compose files (for example `docker-compose.dev.yml` / `docker-compose.prod.yml`), use **different Compose project names** (`name:` or `-p`) so **volume names** do not collide between environments. For the current single-file setup, one project (`aimess`) is enough for local work.

## Fresh databases

- **First run:** empty Docker volumes get new data directories; Postgres init scripts under `docker/postgres/init` run once.
- **Destructive reset:** `docker compose down`, remove the relevant volumes (`docker volume ls`, `docker volume rm …`), then `up` again. This deletes all local data in those volumes.

In real production you would typically replace these containers with managed services (RDS, Atlas, ElastiCache, and so on) but keep the **same logical database names** in connection strings where applicable.

## PostgreSQL: multiple databases, one server

`docker/postgres/init` creates separate databases on the **same** Postgres container.

- Set **`POSTGRES_DB=postgres`** in `.env`, or **omit** `POSTGRES_DB` so Compose defaults to `postgres` (see `docker-compose.yml`).
- Do **not** set `POSTGRES_DB` to `aimess_auth` (or another app DB) as the only initial database, or `CREATE DATABASE` in init can fail on first boot.

Applications use different URLs pointing at `/aimess_auth`, `/aimess_users`, and so on.

## MongoDB: multiple logical databases

MongoDB does not need init scripts for extra DB names. Use the database name in the connection string, for example:

`mongodb://user:pass@localhost:MONGODB_PORT/some_db_name?authSource=admin`

Use a non-default **host** port in `.env` if another `mongod` already uses **27017** on your machine.

## Application images (VPS / registry)

Service Dockerfiles live under **`apps/*/Dockerfile`**. They are **multi-stage**: build the app with Turborepo inside a full monorepo context, then **`pnpm deploy --prod --legacy`** into a minimal runtime layer (non-root user, **`NODE_ENV=production`**). **HTTP health checks** are not baked into those Dockerfiles (no hard-coded URLs); define **`healthcheck`** in **Docker Compose** or your orchestrator using the same **`PORT`** / **`AUTH_SERVICE_PORT`** / **`USER_SERVICE_PORT`** and path **`/health`** you use at runtime.

Build **always** from the repository root (context `.`), for example:

```bash
docker build -f apps/api-gateway/Dockerfile -t aimess-api-gateway:latest .
docker build -f apps/auth-service/Dockerfile -t aimess-auth-service:latest .
docker build -f apps/user-service/Dockerfile -t aimess-user-service:latest .
```

- **api-gateway** does **not** embed database credentials; configure **PORT**, **gRPC URLs**, **Redis**, **CORS** at runtime.
- **auth-service** / **user-service** use a **`PRISMA_BUILD_DATABASE_URL` build-arg** only so **`prisma generate`** can run during the image build. That URL is **not** your production database and is **never** required to accept connections. Supply real **`AUTH_DATABASE_URL`** / **`USER_DATABASE_URL`** (and Redis, JWT, etc.) when you **run** the container.
- **auth-service** / **user-service** images do **not** set listen ports in `ENV` in the Dockerfile. Pass **`AUTH_SERVICE_PORT`** / **`USER_SERVICE_PORT`** at **`docker run`** / Compose. Add a **`healthcheck`** in Compose that hits **`http://127.0.0.1:<port>/health`** (or your probe) using those env vars.

### Continuous delivery (GitLab CI/CD)

Pipeline **`.gitlab-ci.yml`** publishes three images to the **GitLab Container Registry** (`$CI_REGISTRY_IMAGE`, typically `registry.gitlab.com/<namespace>/<project>/…`):

| Image name (example)                     | Dockerfile                     |
| ---------------------------------------- | ------------------------------ |
| `$CI_REGISTRY_IMAGE/aimess-api-gateway`  | `apps/api-gateway/Dockerfile`  |
| `$CI_REGISTRY_IMAGE/aimess-auth-service` | `apps/auth-service/Dockerfile` |
| `$CI_REGISTRY_IMAGE/aimess-user-service` | `apps/user-service/Dockerfile` |

**Triggers:** merge requests targeting the default branch, pushes to **`main`** / **`master`**, and **`v*`** tags. **Publish** runs only on **`main`**, **`master`**, or **`v*`** tag pipelines. The project must have the **Container Registry** enabled; **`docker login`** uses **`CI_JOB_TOKEN`** (no extra deploy token required for the same project).

**Optional manual VPS deploy:** job **`deploy:vps`** (manual) after the three **`publish:*`** jobs. Configure **masked** CI/CD **variables** (GitLab → **Settings** → **CI/CD** → **Variables**): **`VPS_HOST`**, **`VPS_USER`**, **`VPS_SSH_PRIVATE_KEY`**, **`VPS_DEPLOY_PATH`**. Optional: **`VPS_HEALTH_URL`**, **`VPS_SSH_PORT`** (default **22**). The script runs **`docker compose pull`**, **`docker compose up -d`**, **`docker compose ps`**, then **`curl`** the health URL.

**Production Compose** should use **`image: $CI_REGISTRY_IMAGE/…`** (see **`docker/compose.deploy.example.yml`**), not **`build:`** — deploy only pulls pre-built images.

**Example compose for the server:** **`docker/compose.deploy.example.yml`** (replace the **`registry.gitlab.com/YOUR_GROUP/YOUR_PROJECT`** prefix with your real registry path, add **`.env.production`**).

Typical VPS flow: push to GitLab → **CI** validates → **publish** pushes images → on the server **`docker compose pull`** with production **env** → **`docker compose up -d`** → run **`pnpm db:migrate:deploy`** from a trusted environment with production database URLs **before** or as part of rollout (production images do not ship the Prisma CLI).
