# notifications-service — TEST_CASES

Audit + test-case catalogue for **notifications-service**. Generated test suite:
**46/46 passing, green=true** (`node node_modules/jest/bin/jest.js --config apps/notifications-service/jest.config.cjs`).

Strategy = integration tests against the REAL Express app (`src/app.ts`) via supertest,
with only the I/O boundary (Prisma repo, Redis, gRPC clients, Firebase, mail transporter)
mocked. Routing, helmet/cors, `express.json`, shared JWT middleware, Zod validation,
controllers and the service layer all execute for real.

## HTTP surface (what `src/app.ts` actually mounts)

| Mount                       | Router                | Auth       | Exposed                                |
| --------------------------- | --------------------- | ---------- | -------------------------------------- |
| `GET /health`               | `health.routes.ts`    | none       | yes                                    |
| `POST /v1/devices`          | `device.routes.ts`    | JWT access | yes (via gateway)                      |
| `DELETE /v1/devices/:token` | `device.routes.ts`    | JWT access | yes (via gateway)                      |
| `POST /test/push`           | `test-push.routes.ts` | **none**   | only when `NODE_ENV === "development"` |

There are **no list / read / update endpoints** for notifications over HTTP. Notification
fan-out is entirely async (RabbitMQ consumers → `push.service` → FCM + chat-service gRPC
inbox write). gRPC `getNotifications` / `markNotificationsRead` are stub no-ops
(`src/grpc/server.ts:13-29`). Mail/OTP delivery is consumer-driven (`notification.consumer.ts`).

Legend: **[E]** = executed (has a Jest test) · **[D]** = documented-only (no test).

---

## 1. `GET /health`

- **Method:** GET · **Description:** Public liveness/identity probe. `src/routes/health.routes.ts:8`.
- **Preconditions:** none. Mounted unconditionally in `src/app.ts:26`.
- **Expected status codes:** 200 (always); 404 for any sub-path.
- **Expected response structure:**
  `{ success: true, service: "notifications-service", title: "Notifications Service", environment, timestamp(ISO-8601) }`.
  NOTE: this is **not** the standard `{ success, message, data }` envelope — health is a
  bespoke shape (no `message`/`data`).

| #   | Case                                   | Type     | Expected                   | Status  |
| --- | -------------------------------------- | -------- | -------------------------- | ------- |
| 1   | Returns full identity envelope         | Positive | 200, envelope fields match | **[E]** |
| 2   | Reachable with no Authorization header | Security | 200 (public)               | **[E]** |
| 3   | `GET /health/nope` (unknown sub-path)  | Negative | 404                        | **[E]** |
| 4   | `GET /does-not-exist` (unmounted path) | Negative | 404                        | **[E]** |
| 5   | `timestamp` parses as a valid date     | Edge     | `Date.parse` not NaN       | **[E]** |
| 6   | HEAD/POST on `/health`                 | Edge     | 404 (only GET registered)  | [D]     |

---

## 2. `POST /v1/devices` — register / upsert the caller's FCM token

- **Method:** POST · **Description:** Upsert the caller's device token keyed by globally-unique
  `token`. `src/api/controllers/device.controller.ts:13` → `device-token.service.ts:7` →
  `device-token.repository.ts:17` (`prisma.deviceToken.upsert`).
- **Preconditions:** valid Bearer access token (shared `createAuthenticateAccessToken(JWT_ACCESS_SECRET)`,
  `device.routes.ts:13-15`). `userId` is taken from the JWT (`req.auth.userId`), never the body.
- **Body schema** (`device.validator.ts:3`): `token` string 1..4096 (required);
  `platform` enum `ANDROID|IOS|WEB` (required); `deviceId` string 1..256 (optional).
- **Expected status codes:** 200 success; 400 validation; 401 auth; 500 repo throw.
- **Expected response structure:** success `{ success: true }` (NOTE: **no `data` key**, no `message`);
  error `{ success: false, message }`.

### Positive

| #   | Case                                                      | Expected                                                            | Status  |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------- | ------- |
| 1   | Valid body registers → upsert scoped to caller's `userId` | 200 `{ success: true }`, `upsert({userId,token,platform,deviceId})` | **[E]** |
| 2   | `deviceId` omitted → coerced to `null`                    | 200; `upsert(deviceId:null)`                                        | **[E]** |
| 3   | Each platform enum value `ANDROID`/`IOS`/`WEB`            | 200                                                                 | **[E]** |

### Negative — validation (400)

| #   | Case                                                         | Status  |
| --- | ------------------------------------------------------------ | ------- |
| 4   | Empty body / missing `token` / missing `platform`            | **[E]** |
| 5   | Empty `token` string                                         | **[E]** |
| 6   | `token` wrong type (number / null)                           | **[E]** |
| 7   | `platform` not in enum / wrong case (`android`) / wrong type | **[E]** |
| 8   | `deviceId` empty string / wrong type                         | **[E]** |
| 9   | `token` > 4096 chars; `deviceId` > 256 chars                 | **[E]** |

### Negative — auth (401)

| #   | Case                                  | Status  |
| --- | ------------------------------------- | ------- |
| 10  | No Authorization header               | **[E]** |
| 11  | Malformed header (no `Bearer` scheme) | **[E]** |
| 12  | Expired access token                  | **[E]** |
| 13  | Forged token (wrong signing secret)   | **[E]** |
| 14  | Structurally broken bearer token      | **[E]** |

### Negative — downstream (500)

| #   | Case                                                                                  | Status  |
| --- | ------------------------------------------------------------------------------------- | ------- |
| 15  | Repository `upsert` throws → `{ success:false, message:"Failed to register device" }` | **[E]** |

### Edge

| #   | Case                                                       | Status  |
| --- | ---------------------------------------------------------- | ------- |
| 16  | `token` at max length 4096                                 | **[E]** |
| 17  | `deviceId` at max length 256                               | **[E]** |
| 18  | Unicode/emoji `deviceId`                                   | **[E]** |
| 19  | Body > 1MB (express.json limit, `app.ts:23`) → 413         | [D]     |
| 20  | Non-JSON / malformed JSON body → 400 (express body-parser) | [D]     |

### Security

| #   | Case                                                                                               | Status  |
| --- | -------------------------------------------------------------------------------------------------- | ------- |
| 21  | `userId`/`id`/`role` in body are ignored; persisted `userId` = JWT subject (mass-assignment guard) | **[E]** |
| 22  | A different caller's `userId` scopes their own row, no impersonation                               | **[E]** |
| 23  | Injection-shaped token `{"$ne":null}` stored verbatim as opaque string                             | **[E]** |
| 24  | Revoked-session token still accepted (no `assertSessionActive`) — see AUDIT N-1                    | [D]     |
| 25  | Unbounded token rows per user (no per-user device cap) — see AUDIT N-3                             | [D]     |

---

## 3. `DELETE /v1/devices/:token` — unregister one of the caller's tokens

- **Method:** DELETE · **Description:** Scoped delete by `(userId, token)`. `device.controller.ts:42`
  → `device-token.service.ts:17` → `repository.deleteByUserAndToken` (`repository.ts:50`,
  `prisma.deviceToken.deleteMany({ where:{ userId, token } })`).
- **Preconditions:** valid Bearer access token. `userId` from JWT; `token` from URL path.
- **Params schema** (`device.validator.ts:11`): `token` string 1..4096.
- **Expected status codes:** 200 success; 404 when `:token` empty (no route match); 401 auth; 500 repo throw.
  NOTE: the params Zod schema's 400 branch is **effectively unreachable** — an empty/oversized
  segment is handled by Express routing (404) before validation; any non-empty path segment
  passes `min(1)`. See AUDIT L-2.
- **Expected response structure:** `{ success: true, removed: boolean }` (`removed` = delete count > 0).

### Positive

| #   | Case                                             | Expected                                                                   | Status  |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------- | ------- |
| 1   | Owned token removed                              | 200 `{ success:true, removed:true }`, `deleteByUserAndToken(userId,token)` | **[E]** |
| 2   | Nothing matched (already gone / not owned)       | 200 `{ removed:false }`                                                    | **[E]** |
| 3   | Percent-encoded token url-decoded before scoping | 200; decoded token passed                                                  | **[E]** |

### Negative

| #   | Case                                                     | Status  |
| --- | -------------------------------------------------------- | ------- |
| 4   | Empty `:token` segment (`/v1/devices/`) → 404 (no route) | **[E]** |
| 5   | No Authorization header → 401                            | **[E]** |
| 6   | Expired token → 401                                      | **[E]** |
| 7   | Forged token → 401                                       | **[E]** |
| 8   | Non-Bearer scheme (`Basic …`) → 401                      | **[E]** |
| 9   | Repository throws → 500 `"Failed to unregister device"`  | **[E]** |

### Security

| #   | Case                                                                                                                                                  | Status  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 10  | IDOR guard: delete scoped to caller's JWT id, not the URL — attacker deleting a victim token gets `removed:false` and repo is called with attacker id | **[E]** |
| 11  | Injection-shaped path `{"$gt":""}` treated as literal string                                                                                          | **[E]** |
| 12  | Revoked-session token still accepted — see AUDIT N-1                                                                                                  | [D]     |

---

## 4. `POST /test/push` — DEV-ONLY blast (documented-only, not exercised)

- **Method:** POST · **Description:** Dev helper that fires `sendPush` per token. `src/routes/test-push.routes.ts:20`.
- **Preconditions:** mounted **only when `NODE_ENV === "development"`** (`app.ts:32`). Under the test
  harness `NODE_ENV === "test"`, so this route is **absent** — hitting `/test/push` returns 404.
  That is why it is documented-only.
- **Auth:** **NONE.** No JWT middleware on this router. See AUDIT H-1.
- **Body schema:** `tokens: string[] (min 1, each min 1)`, `title: 1..120`, `body: 1..500`.
- **Expected status codes:** 200 (even when all sends fail — per-token errors are captured);
  400 on Zod failure.
- **Expected response structure:** `{ success:true, sent, total, results:[{token,ok,messageId|error}] }`.

| #   | Case                                                | Type     | Expected                               | Status |
| --- | --------------------------------------------------- | -------- | -------------------------------------- | ------ |
| 1   | Route absent in `test`/`production` env (404)       | Security | 404                                    | [D]    |
| 2   | In `development`: valid body fans pushes            | Positive | 200, `results` per token               | [D]    |
| 3   | Empty `tokens` array / missing `title`/`body`       | Negative | 400                                    | [D]    |
| 4   | `title` > 120 / `body` > 500                        | Negative | 400                                    | [D]    |
| 5   | Unauthenticated arbitrary-token push (no auth gate) | Security | 200 — **abuse surface**, see AUDIT H-1 | [D]    |

---

## 5. Async / non-HTTP surface (documented-only — no HTTP entrypoint, not unit-tested here)

These have no route; they are RabbitMQ consumers and providers. Listed for completeness and
because most AUDIT findings live here.

| Component                        | File                                        | Behaviour                                                                     | Status |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| Notification (OTP/mail) consumer | `consumers/notification.consumer.ts`        | DLX/DLQ topology + recovery; `nack(no requeue)` on any error                  | [D]    |
| Chat push consumer               | `consumers/chat.consumer.ts`                | `chat.message_sent` → `pushToUsers`                                           | [D]    |
| Community consumer               | `consumers/community.consumer.ts`           | maps 11 `CommunityEvents` to pushes                                           | [D]    |
| Friend consumer                  | `consumers/friend.consumer.ts`              | friend requested/accepted pushes                                              | [D]    |
| Settings cache-bust consumer     | `consumers/settings.consumer.ts`            | invalidates Redis settings cache                                              | [D]    |
| Push service                     | `services/push.service.ts`                  | settings gate → inbox write → device fan-out → dead-token prune; never throws | [D]    |
| Settings service                 | `services/notification-settings.service.ts` | cached gRPC fetch + quiet-hours; allow-on-failure                             | [D]    |
| FCM provider                     | `providers/firebase/sendPush.ts`            | maps invalid-token codes for pruning                                          | [D]    |
| Mail provider/templates          | `providers/mail/*`                          | OTP HTML emails (raw interpolation)                                           | [D]    |
| gRPC server                      | `grpc/server.ts`                            | `getNotifications`/`markNotificationsRead` are **stubs returning empty**      | [D]    |

---

## Coverage summary

- **Executed (Jest):** all HTTP cases for `GET /health`, `POST /v1/devices`,
  `DELETE /v1/devices/:token` — positive, validation, auth, downstream-failure, edge and
  security (mass-assignment, IDOR, injection-as-data). 46 tests, green.
- **Documented-only:** `POST /test/push` (route absent in `test` env), every RabbitMQ consumer
  path, `push.service`/settings/quiet-hours logic, FCM/mail providers, the stub gRPC server,
  and the security/integrity gaps catalogued in `AUDIT.md`.

See **`AUDIT.md`** for prioritized real findings grounded in file:line.
