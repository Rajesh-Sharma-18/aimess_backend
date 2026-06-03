# USERS — Internal (service-to-service)

Source: `apps/user-service/src/api/routes/internal.routes.ts`, `controllers/internal.controller.ts`, `app.ts` (mounted at `/api/internal`), `repositories/user-profile.repository.ts`, `repositories/friendship.repository.ts`, `lib/profile-fields.util.ts`.

> These endpoints are intended for service-to-service calls (e.g. chat-service hydrating user snapshots, friendship gate checks). They are mounted at `/api/internal` and must NOT be exposed publicly through the gateway.

Endpoints:

- `GET /api/internal/bulk-snapshot?userIds=a,b,c` — minimal profile snapshots for many users
- `GET /api/internal/friendship-check?callerId=&candidateIds=a,b` — accepted-friend filtering

---

### TC-USER-094 — Bulk snapshot (happy path)

| Field                     | Value                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Internal                                                                                               |
| **API/Event Name**        | `GET /api/internal/bulk-snapshot`                                                                              |
| **Test Scenario**         | Resolve snapshots for a comma list of userIds                                                                  |
| **Category**              | Happy Path                                                                                                     |
| **Priority**              | High                                                                                                           |
| **Preconditions**         | Some of the requested profiles exist                                                                           |
| **Request Payload**       | `?userIds=<id1>,<id2>,<id3>`                                                                                   |
| **Expected Response**     | `200` `{ data: { users: [{ userId, username, displayName, avatarObjectKey }] } }`                              |
| **Expected DB Changes**   | None                                                                                                           |
| **Expected Socket/Event** | None                                                                                                           |
| **Notes**                 | `displayName = buildDisplayName(firstName,lastName)`; `avatarObjectKey` is the raw stored key (NOT presigned). |

### TC-USER-095 — Bulk snapshot: empty / missing userIds

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Users / Internal                              |
| **API/Event Name**        | `GET /api/internal/bulk-snapshot`             |
| **Test Scenario**         | No userIds param or empty string              |
| **Category**              | Edge Case                                     |
| **Priority**              | Medium                                        |
| **Preconditions**         | None                                          |
| **Request Payload**       | (no query) / `?userIds=`                      |
| **Expected Response**     | `200` `{ data: { users: [] } }`, message "ok" |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | Early return without DB hit.                  |

### TC-USER-096 — Bulk snapshot caps at 500 ids

| Field                     | Value                                |
| ------------------------- | ------------------------------------ |
| **Feature/Module**        | Users / Internal                     |
| **API/Event Name**        | `GET /api/internal/bulk-snapshot`    |
| **Test Scenario**         | More than 500 ids supplied           |
| **Category**              | Pagination/Filter/Sort               |
| **Priority**              | Medium                               |
| **Preconditions**         | 600 ids in the list                  |
| **Request Payload**       | `?userIds=<600 comma-separated ids>` |
| **Expected Response**     | `200`; only first 500 considered     |
| **Expected DB Changes**   | None                                 |
| **Expected Socket/Event** | None                                 |
| **Notes**                 | `.split(",").slice(0,500)`.          |

### TC-USER-097 — Bulk snapshot: unknown ids return no rows

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Internal                                                            |
| **API/Event Name**        | `GET /api/internal/bulk-snapshot`                                           |
| **Test Scenario**         | All ids unknown                                                             |
| **Category**              | Edge Case                                                                   |
| **Priority**              | Low                                                                         |
| **Preconditions**         | Ids not present                                                             |
| **Request Payload**       | `?userIds=00000000-0000-0000-0000-000000000000`                             |
| **Expected Response**     | `200` `{ users: [] }`                                                       |
| **Expected DB Changes**   | None                                                                        |
| **Expected Socket/Event** | None                                                                        |
| **Notes**                 | `findManyByUserIds` returns empty; partial matches return only found users. |

### TC-USER-098 — Friendship-check (happy path)

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Users / Internal                                                 |
| **API/Event Name**        | `GET /api/internal/friendship-check`                             |
| **Test Scenario**         | Filter candidateIds to those who are accepted friends of caller  |
| **Category**              | Happy Path                                                       |
| **Priority**              | High                                                             |
| **Preconditions**         | Some candidates are accepted friends of caller                   |
| **Request Payload**       | `?callerId=<A>&candidateIds=<B>,<C>,<D>`                         |
| **Expected Response**     | `200` `{ data: { friends: [<ids that are accepted friends>] } }` |
| **Expected DB Changes**   | None                                                             |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | `findAcceptedFriendIdsForUser(callerId, candidateIds)`.          |

### TC-USER-099 — Friendship-check: missing callerId or candidates

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Users / Internal                                                    |
| **API/Event Name**        | `GET /api/internal/friendship-check`                                |
| **Test Scenario**         | No callerId, or empty candidateIds                                  |
| **Category**              | Edge Case                                                           |
| **Priority**              | Medium                                                              |
| **Preconditions**         | None                                                                |
| **Request Payload**       | `?candidateIds=<B>` (no callerId) / `?callerId=<A>` (no candidates) |
| **Expected Response**     | `200` `{ data: { friends: [] } }`                                   |
| **Expected DB Changes**   | None                                                                |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | Guard returns empty without DB hit.                                 |

### TC-USER-100 — Friendship-check caps candidates at 500

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Users / Internal                       |
| **API/Event Name**        | `GET /api/internal/friendship-check`   |
| **Test Scenario**         | More than 500 candidateIds             |
| **Category**              | Pagination/Filter/Sort                 |
| **Priority**              | Low                                    |
| **Preconditions**         | 600 candidate ids                      |
| **Request Payload**       | `?callerId=<A>&candidateIds=<600 ids>` |
| **Expected Response**     | `200`; only first 500 checked          |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | `.slice(0,500)`.                       |

### TC-USER-101 — Security/AuthZ: internal endpoints have NO authentication

| Field                     | Value                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Internal                                                                                                                                                                                                                                                                                                                  |
| **API/Event Name**        | `GET /api/internal/bulk-snapshot`, `GET /api/internal/friendship-check`                                                                                                                                                                                                                                                           |
| **Test Scenario**         | Call internal endpoints with no token / from outside the mesh                                                                                                                                                                                                                                                                     |
| **Category**              | Security                                                                                                                                                                                                                                                                                                                          |
| **Priority**              | High                                                                                                                                                                                                                                                                                                                              |
| **Preconditions**         | Direct network access to user-service `/api/internal`                                                                                                                                                                                                                                                                             |
| **Request Payload**       | `?userIds=<any id>` with no auth header                                                                                                                                                                                                                                                                                           |
| **Expected Response**     | `200` data returned (NO auth middleware on `internalRoutes`)                                                                                                                                                                                                                                                                      |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                                                                                              |
| **Expected Socket/Event** | None                                                                                                                                                                                                                                                                                                                              |
| **Notes**                 | GAP/RISK: `internal.routes.ts` applies no `authenticateAccessToken` and no shared-secret/mTLS check. friendship-check accepts an arbitrary `callerId` from the query — a caller can enumerate any user's friends and any users' profile snapshots. Must be locked down to the internal network or a service token. HIGH priority. |

### TC-USER-102 — IDOR via callerId spoofing in friendship-check

| Field                     | Value                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Internal                                                                         |
| **API/Event Name**        | `GET /api/internal/friendship-check`                                                     |
| **Test Scenario**         | Pass an arbitrary callerId not belonging to the requester                                |
| **Category**              | Security                                                                                 |
| **Priority**              | High                                                                                     |
| **Preconditions**         | Reachable endpoint                                                                       |
| **Request Payload**       | `?callerId=<victim>&candidateIds=<someone>`                                              |
| **Expected Response**     | `200` reveals victim's friendship relationships                                          |
| **Expected DB Changes**   | None                                                                                     |
| **Expected Socket/Event** | None                                                                                     |
| **Notes**                 | Trust boundary relies entirely on network isolation. Flag for service-token enforcement. |

### TC-USER-103 — Malformed userIds parsing (trailing commas / spaces)

| Field                     | Value                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Internal                                                                                                 |
| **API/Event Name**        | `GET /api/internal/bulk-snapshot`                                                                                |
| **Test Scenario**         | Empty segments from `,,` or whitespace                                                                           |
| **Category**              | Edge Case                                                                                                        |
| **Priority**              | Low                                                                                                              |
| **Preconditions**         | None                                                                                                             |
| **Request Payload**       | `?userIds=<id1>,,<id2>, `                                                                                        |
| **Expected Response**     | `200`; empty/blank segments passed to repo (may be ignored by query)                                             |
| **Expected DB Changes**   | None                                                                                                             |
| **Expected Socket/Event** | None                                                                                                             |
| **Notes**                 | No trimming/filtering of blank segments before repo call — verify repo tolerates empty-string ids without error. |
