# Development guide

How to run AiMess locally, configure environment variables, work with Prisma, and extend the monorepo.

## 1. Clone and install

```bash
git clone <your-repo-url>
cd AIMess   # or your checkout folder name
pnpm install
```

Use **pnpm** only; the repo is not set up for npm or yarn workspaces.

## 2. Environment variables

You will normally maintain **two layers** of configuration:

### Root `.env` (Docker Compose)

- Copy **`.env.example`** to **`.env`** at the repository root.
- These variables are consumed by **`docker-compose.yml`** when you run Compose (ports, `POSTGRES_USER`, `POSTGRES_PASSWORD`, Mongo credentials, RabbitMQ, MinIO, pgAdmin, and so on).

### Per-application `.env`

Each app under `apps/` that you start should have its own `.env`, copied from that app’s **`.env.example`**:

| App          | Example path             |
| ------------ | ------------------------ |
| API Gateway  | `apps/api-gateway/.env`  |
| Auth service | `apps/auth-service/.env` |
| User service | `apps/user-service/.env` |

**Database URLs** in auth and user services must point at the correct **database name** and **host port** (see below). Passwords with special characters must be **URL-encoded** inside the connection string.

### PostgreSQL and init scripts

On **first startup** of a new Postgres volume, scripts in `docker/postgres/init/` run once. They execute `CREATE DATABASE` for `aimess_auth`, `aimess_users`, and others.

Therefore:

- Keep the bootstrap database name as **`postgres`**. In Compose this is `POSTGRES_DB` defaulting to `postgres` if unset (`${POSTGRES_DB:-postgres}` in `docker-compose.yml`).
- **Do not** set `POSTGRES_DB` to `aimess_auth` or another app database as the only initial database, or init can fail when creating databases that already exist as the default.

Per-service apps connect with URLs whose path is the logical database, for example:

- `postgresql://USER:PASSWORD@localhost:POSTGRES_PORT/aimess_auth`
- `postgresql://USER:PASSWORD@localhost:POSTGRES_PORT/aimess_users`

### Port clashes (common on Windows)

If something on your machine already uses **5432** or **27017**, set alternate **host** ports in root `.env` (`POSTGRES_PORT`, `MONGODB_PORT`, …) and use the **same** ports in each app’s `DATABASE_URL` / connection strings.

**RabbitMQ on Windows:** A native **Erlang/RabbitMQ** service often listens on **5672** (`erl.exe`). Docker’s `aimess-rabbitmq` would then conflict or your app may connect to the **wrong broker** (login errors like `ACCESS_REFUSED` even after `change_password` in Docker). Set **`RABBITMQ_PORT=5673`** in root `.env`, run `docker compose --env-file .env up -d rabbitmq`, and point app URLs at **`127.0.0.1:5673`** (for example `apps/notifications-service/.env` → `RABBITMQ_URL=amqp://user:pass@127.0.0.1:5673`). Management UI: `http://localhost:15672` (port from `RABBITMQ_MANAGEMENT_PORT`).

## 3. Start infrastructure

From the repo root (with root `.env` present):

```bash
pnpm docker:up
```

This runs `docker compose --env-file .env up -d`, so a root **`.env`** file must exist (copy from `.env.example`).

Equivalent manual command:

```bash
docker compose --env-file .env up -d
```

Check containers:

```bash
pnpm docker:ps
```

Follow **all** service logs (attach):

```bash
pnpm docker:logs
```

Logs for one service only:

```bash
docker compose --env-file .env logs -f postgres
```

More context: **[docker/README.md](../docker/README.md)**.

## 4. Run applications

### All dev tasks (Turborepo)

```bash
pnpm dev
```

This runs every workspace that defines a `dev` script (gateway, auth, user, and any others you add). Ensure each app’s `.env` is valid; missing vars will fail Zod validation on startup where applicable.

### One workspace

Short aliases from the repo root:

```bash
pnpm dev:gateway
pnpm dev:auth
pnpm dev:user
```

Equivalent:

```bash
pnpm --filter @aimess/api-gateway dev
pnpm --filter @aimess/auth-service dev
pnpm --filter @aimess/user-service dev
```

### Sanity checks

- Gateway health: `GET http://localhost:<PORT>/health` (use `PORT` from `apps/api-gateway/.env`).
- Swagger: see `apps/api-gateway/src/docs/swagger.ts` for the mounted path.

## 5. Prisma migrations

Each Prisma app has its **own** `prisma/` directory and migration history.

### Root convenience scripts

These run from the **repository root** and wrap `pnpm --filter …` for common tasks:

| Script                     | What it runs                                                                  |
| -------------------------- | ----------------------------------------------------------------------------- |
| `pnpm db:generate`         | `prisma generate` in **auth-service**, then **user-service**                  |
| `pnpm db:migrate:deploy`   | `prisma migrate deploy` in **auth-service**, then **user-service**            |
| `pnpm db:migrate:dev:auth` | `prisma migrate dev` in **auth-service** (interactive; pass flags after `--`) |
| `pnpm db:migrate:dev:user` | `prisma migrate dev` in **user-service**                                      |
| `pnpm db:studio:auth`      | Prisma Studio for **auth-service**                                            |
| `pnpm db:studio:user`      | Prisma Studio for **user-service**                                            |

Examples with extra Prisma flags:

```bash
pnpm db:migrate:dev:user -- --name add_friend_index
pnpm db:migrate:dev:auth -- --name add_oauth_table
```

### Deploy applied migrations (CI / local after pull)

Preferred:

```bash
pnpm db:migrate:deploy
```

Equivalent explicit commands:

```bash
pnpm --filter @aimess/auth-service exec prisma migrate deploy
pnpm --filter @aimess/user-service exec prisma migrate deploy
```

### Create or update schema in development

From repo root (shortcuts):

```bash
pnpm db:migrate:dev:user
pnpm db:migrate:dev:auth
```

Or with a migration name in one shot:

```bash
pnpm --filter @aimess/user-service exec prisma migrate dev -- --name describe_change
pnpm --filter @aimess/auth-service exec prisma migrate dev -- --name describe_change
```

After schema changes, regenerate clients in both apps:

```bash
pnpm db:generate
```

## 6. Build and quality

```bash
pnpm build
pnpm lint
pnpm test
pnpm format:check
pnpm format
```

**Continuous integration / delivery:** [`.gitlab-ci.yml`](../.gitlab-ci.yml) runs on merge requests and on pushes to **`main`** / **`master`** or **`v*`** tags.

| Stage     | Job(s)           | Purpose                                                                                         |
| --------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `test`    | `quality`        | `pnpm install`, `prisma:generate`, lint, format, typecheck, build, test                         |
| `migrate` | `prisma-migrate` | Postgres service → `pnpm db:migrate:deploy`                                                     |
| `docker`  | `docker-build`   | Build three app images (no push)                                                                |
| `publish` | `publish:*`      | Push to **GitLab Container Registry** (`$CI_REGISTRY_IMAGE/…`) on `main` / `master` / `v*` only |
| `deploy`  | `deploy:vps`     | **Manual** SSH deploy after publish (optional)                                                  |

**GitLab CI/CD variables and tokens (where to configure):**

- **`CI_JOB_TOKEN`:** Injected automatically on every job. Used to **`docker login`** and **`docker push`** to this project’s **Container Registry** (no manual token for publish jobs in the same project).
- **VPS deploy (optional):** GitLab → your **project** → **Settings** → **CI/CD** → **Variables** → **Add variable** (mark secrets **Masked** and **Protected** if you use protected branches). Set **`VPS_HOST`**, **`VPS_USER`**, **`VPS_SSH_PRIVATE_KEY`**, **`VPS_DEPLOY_PATH`**. Optional: **`VPS_HEALTH_URL`**, **`VPS_SSH_PORT`** (default `22` in the job).
- **Deploy token / PAT:** Only if the VPS must pull from a **private** registry and `docker login` on the server is required. Create a **Deploy token** (Settings → Repository → Deploy tokens, scope `read_registry`) or a **Personal access token** with `read_registry`, store it on the VPS (not in `.gitlab-ci.yml` unless you inject it via a variable), and run `docker login registry.gitlab.com` once during server setup.
- **Runners:** Use GitLab.com shared runners or register your own. **Publish** and **docker-build** need **Docker-in-Docker** (`docker:24-dind` service) — enable it for your runner if self-hosted.

**Merge request settings (recommended):** **Settings** → **Merge requests** → enable **Pipelines must succeed** for the default branch; **Protected branches** on **`main`** to block force-push and require approvals when the team is ready.

Registry paths and VPS compose: [`docker/README.md`](../docker/README.md) (section _Continuous delivery_).

**Windows note:** Root script `pnpm clean` runs `rm -rf node_modules` after Turbo clean. That shell command is Unix-oriented; on native Windows cmd/PowerShell it may fail. Options: run from Git Bash, use WSL, or delete `node_modules` manually if needed.

## 7. Add a new HTTP service

```bash
pnpm create-service -- your-service-name
```

This copies `tooling/service-template` into `apps/your-service-name`, rewrites package names, and runs `pnpm install` unless you pass `--skip-install`.

Then:

1. Register any new databases in `docker/postgres/init` **before** teammates rely on new DB names (or document external DBs).
2. Add the service to Turborepo implicitly (workspace already includes `apps/*`).
3. Wire the gateway or other callers as needed.

## 8. Adding API surface on the gateway

1. Add a router under `apps/api-gateway/src/routes/`.
2. Mount it in `apps/api-gateway/src/app.ts`.
3. Document routes in Swagger if the project uses OpenAPI annotations for this gateway.

Keep gateway logic thin: validate input, call domain services (HTTP or gRPC clients), map errors consistently.

## 9. Troubleshooting

| Symptom                                                                     | Things to check                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres “database does not exist”                                          | URL database segment matches `aimess_*`; init ran on a fresh volume; user has rights.                                                                                                                                                                                                                                                                                   |
| Port already allocated                                                      | Change host port in root `.env` and in app URLs.                                                                                                                                                                                                                                                                                                                        |
| Zod env parse error on startup                                              | Compare `.env` with `.env.example` for that app; no missing keys.                                                                                                                                                                                                                                                                                                       |
| Prisma migrate conflicts                                                    | Ensure you target the correct service filter and `DATABASE_URL` / `AUTH_DATABASE_URL` / `USER_DATABASE_URL` as required by that app’s `prisma.config.ts` / schema.                                                                                                                                                                                                      |
| `pnpm` wants to drop devDependencies / `husky` or `prettier` not recognized | The workspace may be stuck in **production** mode (see `node_modules/.pnpm-workspace-state-v1.json` with `"production": true`). From the repo root run **`pnpm deps:fix`** (clears that state and runs **`pnpm install`**) or delete **`node_modules`** and run **`pnpm install`** — always use a **full** dev install for local work, not `pnpm install --production`. |

---
