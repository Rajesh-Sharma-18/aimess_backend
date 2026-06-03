# FRIENDS — List Requests (Incoming / Outgoing) — GAP

**Source:** `apps/user-service/src/api/routes/friendship.routes.ts`, `friends.routes.ts` (searched whole `apps/user-service/src`)

## Status: NOT IMPLEMENTED as REST endpoints

There is **no** REST endpoint to list a user's incoming (received, PENDING where addressee=me)
or outgoing (sent, PENDING where requester=me) friend requests in the user-service today.

Evidence:

- `friendship.routes.ts` exposes only: `POST /requests`, `POST /requests/:id/accept`,
  `POST /requests/:id/reject`, `DELETE /requests/:id`, `DELETE /:userId`. **No `GET /requests`.**
- `friends.routes.ts` exposes only `GET /` (accepted friends).
- The Prisma schema DOES carry the supporting indexes (`@@index([addresseeId, status])` "incoming-request inbox",
  `@@index([requesterId, status])` "outgoing-request list"), and the repo has
  `findAllForUser(userId)` returning all rows (any status) — but it is used only by
  discovery/relationship-labelling (`user-discovery.service.ts`), **not** by a request-list route.

The cases below are written as the **expected contract for the missing endpoints** so they can
be enabled once implemented. Mark them **BLOCKED / not-yet-implemented** in the test run.

---

### TC-FRND-110 — [BLOCKED] List incoming friend requests

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Friends / List Requests (incoming)                                                               |
| **API/Event Name**        | `GET /api/v1/users/friends/requests?direction=incoming` _(proposed)_                             |
| **Test Scenario**         | Caller lists PENDING requests where they are the addressee                                       |
| **Category**              | Happy Path                                                                                       |
| **Priority**              | High                                                                                             |
| **Preconditions**         | ≥1 row `addresseeId=me, status=PENDING`                                                          |
| **Request Payload**       | n/a                                                                                              |
| **Expected Response**     | `404`/route-not-found today. _(Future: `200` list of incoming requests with requester profiles)_ |
| **Expected DB Changes**   | None                                                                                             |
| **Expected Socket/Event** | None                                                                                             |
| **Notes**                 | GAP — no endpoint. Backed by `@@index([addresseeId, status])`                                    |

### TC-FRND-111 — [BLOCKED] List outgoing friend requests

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Friends / List Requests (outgoing)                                                               |
| **API/Event Name**        | `GET /api/v1/users/friends/requests?direction=outgoing` _(proposed)_                             |
| **Test Scenario**         | Caller lists PENDING requests where they are the requester                                       |
| **Category**              | Happy Path                                                                                       |
| **Priority**              | High                                                                                             |
| **Preconditions**         | ≥1 row `requesterId=me, status=PENDING`                                                          |
| **Request Payload**       | n/a                                                                                              |
| **Expected Response**     | `404`/route-not-found today. _(Future: `200` list of outgoing requests with addressee profiles)_ |
| **Expected DB Changes**   | None                                                                                             |
| **Expected Socket/Event** | None                                                                                             |
| **Notes**                 | GAP — no endpoint. Backed by `@@index([requesterId, status])`                                    |

### TC-FRND-112 — [BLOCKED] Pagination/filter for request lists

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Friends / List Requests                           |
| **API/Event Name**        | `GET /api/v1/users/friends/requests` _(proposed)_ |
| **Test Scenario**         | Cursor pagination + count of pending requests     |
| **Category**              | Pagination/Filter/Sort                            |
| **Priority**              | Medium                                            |
| **Preconditions**         | Many PENDING requests                             |
| **Request Payload**       | n/a                                               |
| **Expected Response**     | n/a today                                         |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | GAP — define when endpoint ships                  |
