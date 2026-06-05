# FRIENDS — Accept Friend Request

**Source:**

- `apps/user-service/src/api/routes/friendship.routes.ts` (`POST /requests/:id/accept`)
- `apps/user-service/src/api/controllers/friendship.controller.ts` (`acceptFriendRequest`)
- `apps/user-service/src/api/validators/friendship.validator.ts` (`friendshipIdParamsSchema`)
- `apps/user-service/src/services/friendship.service.ts` (`acceptRequest`)
- `apps/user-service/src/repositories/friendship.repository.ts` (`findById`, `acceptWithCounters`)

**External path:** `POST /api/v1/users/friends/requests/:id/accept`

**Success response:** `200` `{ message: FRIEND_REQUEST_ACCEPTED, data: <FriendshipRow status=ACCEPTED> }`

> Rule: only the **addressee** of a `PENDING` request may accept. Guard: `friendship.addresseeId === userId && status === "PENDING"`, else `404 FRIEND_REQUEST_NOT_FOUND` (404 used even for authz failure to avoid leaking existence).

---

### TC-FRND-020 — Addressee accepts a pending request

| Field                     | Value                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Accept Request                                                                                                  |
| **API/Event Name**        | `POST /api/v1/users/friends/requests/:id/accept`                                                                          |
| **Test Scenario**         | The addressee accepts a valid PENDING request                                                                             |
| **Category**              | Happy Path                                                                                                                |
| **Priority**              | High                                                                                                                      |
| **Preconditions**         | `friendships` row `addresseeId=me, status=PENDING`                                                                        |
| **Request Payload**       | Path param `:id` = friendship id; empty body                                                                              |
| **Expected Response**     | `200` `{ data: { status: "ACCEPTED", acceptedAt: <ts> } }`, message `FRIEND_REQUEST_ACCEPTED`                             |
| **Expected DB Changes**   | Row → `status=ACCEPTED`, `acceptedAt` set; `friendsCount` +1 on BOTH profiles (`$transaction`)                            |
| **Expected Socket/Event** | RabbitMQ `friend.accepted` `{ friendshipId, requesterId, addresseeId, acceptedAt }`; profile cache invalidated both sides |

### TC-FRND-021 — Requester tries to accept own outgoing request (IDOR / authz)

| Field                     | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Accept Request                                                |
| **API/Event Name**        | `POST /api/v1/users/friends/requests/:id/accept`                        |
| **Test Scenario**         | The requester (not addressee) calls accept on their own PENDING request |
| **Category**              | Security / AuthZ                                                        |
| **Priority**              | High                                                                    |
| **Preconditions**         | Row `requesterId=me, status=PENDING`                                    |
| **Request Payload**       | `:id` of own outgoing request                                           |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`                                        |
| **Expected DB Changes**   | None                                                                    |
| **Expected Socket/Event** | None                                                                    |
| **Notes**                 | Confirms only addressee can accept; existence not leaked                |

### TC-FRND-022 — Unrelated third party tries to accept (IDOR)

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Friends / Accept Request                                     |
| **API/Event Name**        | `POST /api/v1/users/friends/requests/:id/accept`             |
| **Test Scenario**         | User C (neither requester nor addressee) accepts A→B request |
| **Category**              | Security                                                     |
| **Priority**              | High                                                         |
| **Preconditions**         | Row A→B PENDING; caller = C                                  |
| **Request Payload**       | `:id` of A→B request                                         |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`                             |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |

### TC-FRND-023 — Accept an already-ACCEPTED request

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Friends / Accept Request                                |
| **API/Event Name**        | `POST /api/v1/users/friends/requests/:id/accept`        |
| **Test Scenario**         | Re-accepting a request that is already ACCEPTED         |
| **Category**              | Business Rule / DB State                                |
| **Priority**              | Medium                                                  |
| **Preconditions**         | Row `status=ACCEPTED`                                   |
| **Request Payload**       | `:id`                                                   |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND` (status guard fails)   |
| **Expected DB Changes**   | None — protects against double `friendsCount` increment |
| **Expected Socket/Event** | None                                                    |

### TC-FRND-024 — Accept a REJECTED/CANCELLED/UNFRIENDED request

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Friends / Accept Request                             |
| **API/Event Name**        | `POST /api/v1/users/friends/requests/:id/accept`     |
| **Test Scenario**         | Accept attempted on a non-PENDING terminal-state row |
| **Category**              | DB State                                             |
| **Priority**              | Medium                                               |
| **Preconditions**         | Row `status ∈ {REJECTED, CANCELLED, UNFRIENDED}`     |
| **Request Payload**       | `:id`                                                |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`                     |
| **Expected DB Changes**   | None                                                 |
| **Expected Socket/Event** | None                                                 |

### TC-FRND-025 — Accept with non-existent friendship id

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Friends / Accept Request                         |
| **API/Event Name**        | `POST /api/v1/users/friends/requests/:id/accept` |
| **Test Scenario**         | Valid UUID with no matching row                  |
| **Category**              | Error Handling                                   |
| **Priority**              | Medium                                           |
| **Preconditions**         | No `friendships` row with that id                |
| **Request Payload**       | `:id = <random uuid>`                            |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`                 |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |

### TC-FRND-026 — Accept with malformed (non-UUID) id

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Friends / Accept Request                         |
| **API/Event Name**        | `POST /api/v1/users/friends/requests/:id/accept` |
| **Test Scenario**         | `:id` is not a UUID                              |
| **Category**              | Input Validation                                 |
| **Priority**              | Medium                                           |
| **Preconditions**         | Authenticated                                    |
| **Request Payload**       | `:id = abc123`                                   |
| **Expected Response**     | `400` "Invalid friendship ID"                    |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |

### TC-FRND-027 — Accept unauthenticated

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Friends / Accept Request                         |
| **API/Event Name**        | `POST /api/v1/users/friends/requests/:id/accept` |
| **Test Scenario**         | No/invalid token                                 |
| **Category**              | AuthN                                            |
| **Priority**              | High                                             |
| **Preconditions**         | None                                             |
| **Request Payload**       | `:id`                                            |
| **Expected Response**     | `401`                                            |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |

### TC-FRND-028 — Concurrency: accept + cancel race on same request

| Field                     | Value                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Accept Request                                                                                                                |
| **API/Event Name**        | `POST .../accept` vs `DELETE .../requests/:id`                                                                                          |
| **Test Scenario**         | Addressee accepts while requester cancels the same PENDING request concurrently                                                         |
| **Category**              | Concurrency                                                                                                                             |
| **Priority**              | High                                                                                                                                    |
| **Preconditions**         | Row PENDING                                                                                                                             |
| **Request Payload**       | Parallel accept (addressee) + cancel (requester)                                                                                        |
| **Expected Response**     | Exactly one wins; final status is ACCEPTED or CANCELLED, never both. Verify `friendsCount` only incremented if ACCEPTED won             |
| **Expected DB Changes**   | Single terminal status; counters consistent                                                                                             |
| **Expected Socket/Event** | Either `friend.accepted` or none                                                                                                        |
| **Notes**                 | No row-level lock between `findById` and the update → potential lost-update; both ops read PENDING then write. Document observed result |

### TC-FRND-029 — Concurrency: double-accept by addressee

| Field                     | Value                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Accept Request                                                                                |
| **API/Event Name**        | `POST .../requests/:id/accept`                                                                          |
| **Test Scenario**         | Addressee fires accept twice in parallel                                                                |
| **Category**              | Concurrency                                                                                             |
| **Priority**              | Medium                                                                                                  |
| **Preconditions**         | Row PENDING                                                                                             |
| **Request Payload**       | Two parallel accepts                                                                                    |
| **Expected Response**     | `friendsCount` must be +1 not +2                                                                        |
| **Expected DB Changes**   | Verify no double-increment (both reads see PENDING before either writes ACCEPTED) — **possible defect** |
| **Expected Socket/Event** | Possibly duplicate `friend.accepted`                                                                    |
