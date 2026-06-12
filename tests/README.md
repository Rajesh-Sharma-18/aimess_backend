# AIMess Backend — API Test Suite

Production-grade, CI-ready **integration test suite** for all 7 backend services.
Built with **Jest + supertest** against each service's real Express app, with the
I/O boundary (Prisma, Redis, RabbitMQ, gRPC, storage, external OAuth/JWKS) mocked.

> Status (2026-06-11): **72 suites · 1,070 passing · 1 skipped** (the skipped case
> pins a real route-ordering bug in community-service — see the audit). `exit 0`.

---

## 1. How to run

All commands run from the repo root. Jest is invoked by explicit path so it works
regardless of pnpm hoisting and never triggers a workspace reinstall.

```bash
# Everything (single process, all 7 services)
pnpm test:all                 #  node node_modules/jest/bin/jest.js
pnpm test:ci                  #  --ci --runInBand   (use this in CI)
pnpm test:coverage            #  with coverage report
pnpm test:watch               #  watch mode

# One service
node node_modules/jest/bin/jest.js --selectProjects auth-service
node node_modules/jest/bin/jest.js --config apps/auth-service/jest.config.cjs

# One module / file / test name
node node_modules/jest/bin/jest.js --config apps/auth-service/jest.config.cjs tests/auth/login.test.ts
node node_modules/jest/bin/jest.js --selectProjects chat-service -t "IDOR"

# Per-service via the package script (works in a TTY/CI)
pnpm --filter @aimess/auth-service test
turbo run test                # runs every service's `test` script
```

> **CI note:** prefer `pnpm test:ci` (or `pnpm test:all`). The `turbo run test` /
> `pnpm --filter` paths shell out through pnpm; on a CI runner set `CI=true` so pnpm
> never tries to interactively purge `node_modules`.

No database, broker, Redis, or running services are required — the suite is fully
hermetic and runs on a clean checkout after `pnpm install`.

---

## 2. Architecture — "integration tests with mocked deps"

```
supertest ──▶ real Express app (src/app.ts)
                 │  routing · helmet/cors · locale · Zod validation
                 │  controllers · services · business logic   ← all run for real
                 ▼
            mocked I/O boundary (per test / global)
            repositories · Prisma · Redis · RabbitMQ · gRPC · storage · OAuth verifiers
```

What this buys us: every test exercises the **actual** route wiring, middleware,
validation schemas, controllers and service logic — so a commented-out validator,
a wrong status code, or a missing authz check is caught — while staying fast,
deterministic and infra-free. JWT auth is exercised **for real** (tokens are minted
with the same `@aimess/auth-jwt` signer the middleware verifies).

### Module strategy (the important part)

The repo is **pure ESM** (`"type":"module"`, `NodeNext`, `.js` import specifiers) and
Prisma 7 generates an **ESM** client that uses top-level `import.meta`. Jest's reliable
`jest.mock()` hoisting wants CommonJS. The preset reconciles this:

- **ts-jest transpiles** TS (including `.js`-suffixed ESM specifiers) to **CommonJS**,
  so classic `jest.mock()` works. Use the Jest **global** `jest` (don't import it).
- **`moduleNameMapper`** maps `@aimess/*` → package **source** (`packages/*/src`, no build
  needed), strips the `.js` extension from relative imports, and redirects every
  generated Prisma client to a **universal stub** (`tooling/jest/prisma-client.stub.cjs`)
  that solves the `import.meta` problem and echoes string-enum members
  (`AccountStatus.ACTIVE === "ACTIVE"`) so it needs zero per-schema knowledge.

See [`tooling/jest/jest.preset.cjs`](../tooling/jest/jest.preset.cjs) and
[`tooling/jest/prisma-client.stub.cjs`](../tooling/jest/prisma-client.stub.cjs).

---

## 3. Layout

```
tooling/jest/
  jest.preset.cjs            # shared preset (DO NOT edit per-service)
  prisma-client.stub.cjs     # universal Prisma-7 client stub
jest.config.cjs              # root: `projects` over all services
apps/<service>/
  jest.config.cjs            # service project (spreads the preset)
  tests/
    setup/env.ts             # sets NODE_ENV=test + every env var the service validates
    setup/global-mocks.ts    # always-off I/O seams (prisma, redis, messaging, gRPC, ESM libs)
    helpers/                 # auth.ts (JWT minting) + per-service factories/fixtures
    <module>/*.test.ts       # one file per logical module, grouped by feature
    _inventory.md            # discovered API surface for the service
    TEST_CASES.md            # per-service case documentation
    AUDIT.md                 # per-service findings
tests/                       # this folder — aggregate docs
  README.md  ·  TEST_CASES.md  ·  AUDIT_REPORT.md
```

---

## 4. Conventions for writing a new test

1. **Drive the app, mock the edge.** `import app from "../../src/app.js"`, hit it with
   supertest. Mock the **repository** the endpoint uses per-test to control data; mock
   wider infra in `tests/setup/global-mocks.ts`.
2. **Hoisted mocks.** Put `jest.mock("../../src/repositories/x.repository.js", …)` at the
   top of the file (above imports). Use the global `jest`.
3. **Auth.** `import { makeAccessToken, bearer } from "../helpers/auth.js"`. For 401 cases
   use `makeExpiredAccessToken()` / `makeForgedAccessToken()`.
4. **Assert the envelope.** Success → `{ success:true, message, data }` (Dates are epoch ms).
   Error → `{ success:false, message }`. Validation→400, auth→401, forbidden→403,
   not-found→404, conflict→409, rate-limit→429.
5. **One concern per test, descriptive names**, no shared mutable state (the preset
   `clearMocks` + `restoreMocks` between tests).
6. **Found a real bug?** Write the test that _should_ pass, mark it `test.skip` with a
   `// BUG:` note, and record it in the service `AUDIT.md` — don't delete it.

### Adding a brand-new service

Copy `apps/auth-service/jest.config.cjs` + `tests/setup/*` + `tests/helpers/auth.ts`,
adapt `env.ts` (to the service's `src/config/env.ts`) and `global-mocks.ts` (to its I/O
seams), add the service to the root `jest.config.cjs` `projects`, and point its
`package.json` `test` script at `node ../../node_modules/jest/bin/jest.js --config jest.config.cjs`.

---

## 5. Documentation

- **[TEST_CASES.md](TEST_CASES.md)** — master index + per-service case catalogs.
- **[AUDIT_REPORT.md](AUDIT_REPORT.md)** — consolidated bugs / security / data-integrity
  findings discovered while reading the code to derive these tests.
