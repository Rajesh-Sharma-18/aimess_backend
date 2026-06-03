# FRIENDS — Friendship Status / Check (a,b)

This covers the **friendship-gate** "are A and B friends?" check. The memory note about a
pending "friendship gate rewire to a user-service `check(a,b)` endpoint" resolves here: the
endpoint **exists** in two forms — an internal HTTP route and a gRPC RPC. Both are
**batch/pair lookups over `ACCEPTED` friendships only** and are NOT exposed to end users with
JWT auth.

**Source:**

- HTTP: `apps/user-service/src/api/routes/internal.routes.ts` (`GET /friendship-check`), `apps/user-service/src/api/controllers/internal.controller.ts` (`getFriendshipCheck`)
- gRPC: `apps/user-service/src/grpc/server.ts` (`checkFriendship` RPC), proto `packages/grpc-contracts/proto/user.proto` (`UserService.CheckFriendship`)
- Repo: `apps/user-service/src/repositories/friendship.repository.ts` (`findAcceptedFriendIdsForUser`, `findActivePair`)

**External paths:**

- `GET /api/v1/users/internal/friendship-check?callerId=<uuid>&candidateIds=<csv>` (returns subset of `candidateIds` that are accepted friends of `callerId`)
- gRPC `UserService.CheckFriendship({ userA, userB }) → { areFriends: boolean }`

> ⚠️ **AuthN GAP:** the `internalRoutes` are mounted with **no `authenticateAccessToken`
> middleware**. `/api/v1/users/internal/*` is callable by anyone who can reach the route unless
> the gateway blocks the `/internal` prefix. Must be verified at the gateway/network layer.

---

### TC-FRND-090 — Internal check returns accepted-friend subset

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Friendship Check (internal HTTP)                                       |
| **API/Event Name**        | `GET /api/v1/users/internal/friendship-check`                                    |
| **Test Scenario**         | `callerId` + CSV `candidateIds`; some are accepted friends, some not             |
| **Category**              | Happy Path                                                                       |
| **Priority**              | High                                                                             |
| **Preconditions**         | Some `friendships` rows ACCEPTED between caller and a subset of candidates       |
| **Request Payload**       | `?callerId=<A>&candidateIds=<B>,<C>,<D>` (B,D are friends; C is not)             |
| **Expected Response**     | `200` `{ data: { friends: ["<B>","<D>"] } }` (only ACCEPTED, direction-agnostic) |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | None                                                                             |
| **Notes**                 | Used by community-service when validating friend-only add-members                |

### TC-FRND-091 — Internal check: missing callerId or empty candidates

| Field                     | Value                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Friendship Check (internal HTTP)                                                                 |
| **API/Event Name**        | `GET /api/v1/users/internal/friendship-check`                                                              |
| **Test Scenario**         | No `callerId`, or `candidateIds` missing/empty                                                             |
| **Category**              | Input Validation                                                                                           |
| **Priority**              | Medium                                                                                                     |
| **Preconditions**         | None                                                                                                       |
| **Request Payload**       | `?candidateIds=<B>` (no caller) / `?callerId=<A>` (no candidates)                                          |
| **Expected Response**     | `200` `{ data: { friends: [] } }` (graceful empty, no 400)                                                 |
| **Expected DB Changes**   | None                                                                                                       |
| **Expected Socket/Event** | None                                                                                                       |
| **Notes**                 | Inputs are raw query strings, NOT zod-validated — non-UUID values are passed through to Prisma `in` filter |

### TC-FRND-092 — Internal check: candidateIds capped at 500

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Friends / Friendship Check (internal HTTP)        |
| **API/Event Name**        | `GET /api/v1/users/internal/friendship-check`     |
| **Test Scenario**         | More than 500 candidate ids supplied              |
| **Category**              | Edge Case                                         |
| **Priority**              | Low                                               |
| **Preconditions**         | None                                              |
| **Request Payload**       | `?callerId=<A>&candidateIds=<600 csv ids>`        |
| **Expected Response**     | `200`; only first 500 evaluated (`.slice(0,500)`) |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |

### TC-FRND-093 — Internal check: malformed (non-UUID) ids

| Field                     | Value                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Friendship Check (internal HTTP)                                                                                      |
| **API/Event Name**        | `GET /api/v1/users/internal/friendship-check`                                                                                   |
| **Test Scenario**         | `callerId`/`candidateIds` contain non-UUID strings                                                                              |
| **Category**              | Error Handling                                                                                                                  |
| **Priority**              | Medium                                                                                                                          |
| **Preconditions**         | None                                                                                                                            |
| **Request Payload**       | `?callerId=foo&candidateIds=bar,baz`                                                                                            |
| **Expected Response**     | Verify behavior — Prisma `@db.Uuid` column may throw on invalid UUID → `500`. Document actual (no validation layer guards this) |
| **Expected DB Changes**   | None                                                                                                                            |
| **Expected Socket/Event** | None                                                                                                                            |
| **Notes**                 | **Robustness gap** — internal endpoint trusts caller; consider UUID validation                                                  |

### TC-FRND-094 — Internal check: no friendship (empty result)

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Friends / Friendship Check (internal HTTP)    |
| **API/Event Name**        | `GET /api/v1/users/internal/friendship-check` |
| **Test Scenario**         | None of the candidates are accepted friends   |
| **Category**              | Happy Path                                    |
| **Priority**              | Medium                                        |
| **Preconditions**         | No ACCEPTED rows for the pairs                |
| **Request Payload**       | `?callerId=<A>&candidateIds=<X>,<Y>`          |
| **Expected Response**     | `200` `{ data: { friends: [] } }`             |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |

### TC-FRND-095 — Internal check ignores non-ACCEPTED states

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Friends / Friendship Check (internal HTTP)                 |
| **API/Event Name**        | `GET /api/v1/users/internal/friendship-check`              |
| **Test Scenario**         | Candidate has a PENDING/UNFRIENDED row with caller         |
| **Category**              | Business Rule                                              |
| **Priority**              | Medium                                                     |
| **Preconditions**         | Row exists but `status != ACCEPTED`                        |
| **Request Payload**       | `?callerId=<A>&candidateIds=<B>`                           |
| **Expected Response**     | `200` `{ friends: [] }` — only ACCEPTED counts as "friend" |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |

### TC-FRND-096 — gRPC CheckFriendship: true for accepted pair

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Feature/Module**        | Friends / Friendship Check (gRPC)                                              |
| **API/Event Name**        | `UserService.CheckFriendship`                                                  |
| **Test Scenario**         | A and B are ACCEPTED friends                                                   |
| **Category**              | Happy Path                                                                     |
| **Priority**              | High                                                                           |
| **Preconditions**         | Row ACCEPTED                                                                   |
| **Request Payload**       | `{ userA: <A>, userB: <B> }`                                                   |
| **Expected Response**     | `{ areFriends: true }` (uses `findActivePair`, direction-agnostic)             |
| **Expected DB Changes**   | None                                                                           |
| **Expected Socket/Event** | None                                                                           |
| **Notes**                 | This is the per-pair friendship gate consumed by chat-service / other services |

### TC-FRND-097 — gRPC CheckFriendship: false for non-friends or pending

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Friends / Friendship Check (gRPC)              |
| **API/Event Name**        | `UserService.CheckFriendship`                  |
| **Test Scenario**         | No ACCEPTED row (none, PENDING, or UNFRIENDED) |
| **Category**              | Business Rule                                  |
| **Priority**              | High                                           |
| **Preconditions**         | No ACCEPTED row                                |
| **Request Payload**       | `{ userA, userB }`                             |
| **Expected Response**     | `{ areFriends: false }`                        |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |

### TC-FRND-098 — gRPC CheckFriendship: internal error path

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Friends / Friendship Check (gRPC)                       |
| **API/Event Name**        | `UserService.CheckFriendship`                           |
| **Test Scenario**         | DB/Prisma error during lookup (e.g. invalid UUID input) |
| **Category**              | Error Handling                                          |
| **Priority**              | Low                                                     |
| **Preconditions**         | Force a repo error                                      |
| **Request Payload**       | `{ userA: "bad", userB: "bad" }`                        |
| **Expected Response**     | gRPC status `INTERNAL`                                  |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |

### TC-FRND-099 — Internal route AuthN exposure check

| Field                     | Value                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Friendship Check (internal HTTP)                                                                                                         |
| **API/Event Name**        | `GET /api/v1/users/internal/friendship-check`                                                                                                      |
| **Test Scenario**         | Call the internal route directly without a JWT                                                                                                     |
| **Category**              | Security                                                                                                                                           |
| **Priority**              | High                                                                                                                                               |
| **Preconditions**         | None                                                                                                                                               |
| **Request Payload**       | `?callerId=<A>&candidateIds=<B>` with no Authorization header                                                                                      |
| **Expected Response**     | Route has NO auth middleware → would return `200` if reachable. Verify gateway blocks `/internal/*` from public traffic. **Document the boundary** |
| **Expected DB Changes**   | None                                                                                                                                               |
| **Expected Socket/Event** | None                                                                                                                                               |
| **Notes**                 | Caller-supplied `callerId` means anyone reaching this route can probe arbitrary users' friend graphs — gateway must gate `/internal`               |
