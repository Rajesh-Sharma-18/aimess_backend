# FRIENDS — Remove Friend (Unfriend)

**Source:**

- `apps/user-service/src/api/routes/friendship.routes.ts` (`DELETE /:userId`)
- `apps/user-service/src/api/controllers/friendship.controller.ts` (`unfriend`)
- `apps/user-service/src/api/validators/friendship.validator.ts` (`unfriendParamsSchema`)
- `apps/user-service/src/services/friendship.service.ts` (`unfriend`)
- `apps/user-service/src/repositories/friendship.repository.ts` (`findActivePair`, `unfriendWithCounters`)

**External path:** `DELETE /api/v1/users/friends/:userId`

**Success response:** `200` `{ message: FRIEND_REMOVED, data: undefined }`

> Rules:
>
> - `:userId` is the **other user's** userId (NOT the friendship id).
> - Requires an existing `ACCEPTED` friendship (`findActivePair`, either direction).
> - On success: row → `status=UNFRIENDED`, `unfriendedAt` set, `unfriendedBy=callerId`; `friendsCount` −1 on BOTH profiles (`$transaction`); cache invalidated both sides; emits `friend.unfriended`.

---

### TC-FRND-050 — Unfriend an accepted friend

| Field                     | Value                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Unfriend                                                                                                          |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId`                                                                                      |
| **Test Scenario**         | Caller removes an existing accepted friend                                                                                  |
| **Category**              | Happy Path                                                                                                                  |
| **Priority**              | High                                                                                                                        |
| **Preconditions**         | `friendships` row for pair `status=ACCEPTED`                                                                                |
| **Request Payload**       | `:userId = <friend-uuid>`                                                                                                   |
| **Expected Response**     | `200` `FRIEND_REMOVED`                                                                                                      |
| **Expected DB Changes**   | Row → `status=UNFRIENDED`, `unfriendedAt` set, `unfriendedBy=me`; `friendsCount` −1 on both                                 |
| **Expected Socket/Event** | RabbitMQ `friend.unfriended` `{ friendshipId, unfriendedById:me, otherUserId, unfriendedAt }`; cache invalidated both sides |
| **Notes**                 | Works regardless of who originally sent the request (`findActivePair` is direction-agnostic)                                |

### TC-FRND-051 — Unfriend works from the addressee side too

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Friends / Unfriend                                        |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId`                    |
| **Test Scenario**         | Original addressee (not requester) initiates the unfriend |
| **Category**              | Business Rule                                             |
| **Priority**              | Medium                                                    |
| **Preconditions**         | Row `requesterId=other, addresseeId=me, status=ACCEPTED`  |
| **Request Payload**       | `:userId = <other-uuid>`                                  |
| **Expected Response**     | `200` `FRIEND_REMOVED`                                    |
| **Expected DB Changes**   | `unfriendedBy=me`; `otherUserId` in event = the requester |
| **Expected Socket/Event** | `friend.unfriended` with correct `otherUserId`            |

### TC-FRND-052 — Unfriend yourself

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Friends / Unfriend                     |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId` |
| **Test Scenario**         | `:userId` equals caller's own id       |
| **Category**              | Business Rule                          |
| **Priority**              | Medium                                 |
| **Preconditions**         | Authenticated                          |
| **Request Payload**       | `:userId = <my-own-uuid>`              |
| **Expected Response**     | `400` `FRIEND_CANNOT_ADD_SELF`         |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |

### TC-FRND-053 — Unfriend a non-friend (no accepted friendship)

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | Friends / Unfriend                                        |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId`                    |
| **Test Scenario**         | No ACCEPTED friendship between the two users              |
| **Category**              | Error Handling                                            |
| **Priority**              | Medium                                                    |
| **Preconditions**         | No row, or row only PENDING/REJECTED/CANCELLED/UNFRIENDED |
| **Request Payload**       | `:userId = <stranger-uuid>`                               |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`                          |
| **Expected DB Changes**   | None; `friendsCount` unchanged                            |
| **Expected Socket/Event** | None                                                      |

### TC-FRND-054 — Unfriend when only a PENDING request exists

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Friends / Unfriend                                      |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId`                  |
| **Test Scenario**         | A PENDING request exists but no acceptance              |
| **Category**              | DB State                                                |
| **Priority**              | Medium                                                  |
| **Preconditions**         | Row `status=PENDING`                                    |
| **Request Payload**       | `:userId = <other-uuid>`                                |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND` (only ACCEPTED counts) |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |

### TC-FRND-055 — Unfriend an already-unfriended pair (idempotency)

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Unfriend                                                                 |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId`                                             |
| **Test Scenario**         | Call unfriend twice; second call has no ACCEPTED row                               |
| **Category**              | Edge Case                                                                          |
| **Priority**              | Medium                                                                             |
| **Preconditions**         | Row already `UNFRIENDED`                                                           |
| **Request Payload**       | `:userId = <ex-friend-uuid>`                                                       |
| **Expected Response**     | Second call `404` `FRIEND_REQUEST_NOT_FOUND`; `friendsCount` decremented only once |
| **Expected DB Changes**   | None on second call (protects counter from going negative)                         |
| **Expected Socket/Event** | None on second call                                                                |

### TC-FRND-056 — Unfriend with malformed `:userId`

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Friends / Unfriend                     |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId` |
| **Test Scenario**         | `:userId` not a UUID                   |
| **Category**              | Input Validation                       |
| **Priority**              | Medium                                 |
| **Preconditions**         | Authenticated                          |
| **Request Payload**       | `:userId = nope`                       |
| **Expected Response**     | `400` "Invalid user ID"                |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |

### TC-FRND-057 — Unfriend unauthenticated

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Friends / Unfriend                     |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId` |
| **Test Scenario**         | No token                               |
| **Category**              | AuthN                                  |
| **Priority**              | High                                   |
| **Preconditions**         | None                                   |
| **Request Payload**       | `:userId`                              |
| **Expected Response**     | `401`                                  |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |

### TC-FRND-058 — Concurrency: both friends unfriend simultaneously

| Field                     | Value                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Unfriend                                                                                                                                                                 |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId`                                                                                                                                             |
| **Test Scenario**         | A and B both call unfriend on the same ACCEPTED row concurrently                                                                                                                   |
| **Category**              | Concurrency                                                                                                                                                                        |
| **Priority**              | High                                                                                                                                                                               |
| **Preconditions**         | Row ACCEPTED                                                                                                                                                                       |
| **Request Payload**       | Parallel DELETE from A→B and B→A                                                                                                                                                   |
| **Expected Response**     | `friendsCount` must decrement by exactly 1 on each side (not 2). Verify whether both `findActivePair` reads see ACCEPTED and both decrement — **possible double-decrement defect** |
| **Expected DB Changes**   | Single transition to UNFRIENDED; counters consistent                                                                                                                               |
| **Expected Socket/Event** | One or two `friend.unfriended`                                                                                                                                                     |
| **Notes**                 | No lock between `findActivePair` and `unfriendWithCounters`; document observed behavior. Counter could underflow                                                                   |

### TC-FRND-059 — DB-state verification: full lifecycle round-trip

| Field                     | Value                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Lifecycle                                                                                                          |
| **API/Event Name**        | send → accept → unfriend → re-send → accept                                                                                  |
| **Test Scenario**         | Drive the single row through PENDING→ACCEPTED→UNFRIENDED→PENDING(recycled)→ACCEPTED and assert counters/timestamps each step |
| **Category**              | DB State                                                                                                                     |
| **Priority**              | High                                                                                                                         |
| **Preconditions**         | Clean pair                                                                                                                   |
| **Request Payload**       | Sequence of calls                                                                                                            |
| **Expected Response**     | Each step succeeds; row id stable across recycle; `friendsCount` ends at +1 net per profile                                  |
| **Expected DB Changes**   | Timestamps set/cleared per state; `unfriendedBy` cleared on recycle                                                          |
| **Expected Socket/Event** | `friend.requested`, `friend.accepted`, `friend.unfriended`, `friend.requested`, `friend.accepted` in order                   |
