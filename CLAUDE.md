# AIMess Backend — Claude Code context

Read **`docs/ARCHITECTURE.md`** for the full platform design (all 9 microservices, ports, databases, gRPC, monorepo, Turborepo).

Read **`docs/IMPLEMENTATION-NOTES.md`** for the current implementation status of auth-service & user-service, key decisions/conventions (session revocation model, DLQ naming, cache-first auth lookup, username cooldown), known gaps/TODOs, and the latest review record. **Keep it updated when you ship or change a feature.**

## Quick facts

- **Monorepo:** pnpm workspaces + Turborepo. Use **pnpm only**.
- **Apps (today):** `api-gateway`, `auth-service`, `user-service`, `notifications-service`
- **Planned apps:** `community-service`, `messaging-service`, `delivery-service`, `stream-service`, `call-service`
- **Shared libs:** `packages/*` (`@aimess/logger`, `errors`, `constants`, `auth-jwt`, `redis`, …)
- **After clone:** `pnpm install` → `pnpm build:packages` → copy `.env` files → `pnpm docker:up` → `pnpm db:generate` → `pnpm db:migrate:deploy` → `pnpm db:setup:community` (Mongo: db push + seed categories — required, not auto) → `pnpm dev`
- **TypeScript ESM:** imports use `.js` extension (e.g. `./config/env.js`); `module: NodeNext`
- **Postgres DBs:** `aimess_auth`, `aimess_users` (logical: auth_db, user_db)
- **Target ports:** gateway **8000**; services **3001–3008**; gRPC **4001–4008**; delivery **3005** stateless
- **Docs:** `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`

## Service ports (target)

| Service              | HTTP | gRPC | Database   |
| -------------------- | ---- | ---- | ---------- |
| api-gateway          | 8000 | —    | —          |
| auth-service         | 3001 | 4001 | PostgreSQL |
| user-service         | 3002 | 4002 | PostgreSQL |
| community-service    | 3003 | 4003 | MongoDB    |
| messaging-service    | 3004 | 4004 | MongoDB    |
| delivery-service     | 3005 | —    | —          |
| notification-service | 3006 | 4006 | MongoDB    |
| stream-service       | 3007 | 4007 | MongoDB    |
| call-service         | 3008 | 4008 | MongoDB    |

## Conventions

- One bounded context per service; no cross-service DB access.
- `userId` in user-service = `AuthUser.id` from auth-service (UUID, no cross-DB FK).
- Put shared code in `packages/`, not duplicated in apps.
- Do not commit `.env` or `dist/`.
- Husky pre-commit runs lint-staged (`lint-staged.config.mjs`).

## Workflow (standing instruction)

- For any non-trivial **build / implement / fix / refactor** task, use the **`aimess-architecture` skill's Agent Team Mode** — orchestrate the team (Project Manager → Pro Coder → DRY Reviewer + Contract/Figma Reviewer + Quality Tester) rather than doing it all solo. Reviewers + Quality Tester must run before a task is considered done; "typecheck + lint passed" alone is not sufficient sign-off. Only skip the team for tiny one-line fixes or pure questions.
