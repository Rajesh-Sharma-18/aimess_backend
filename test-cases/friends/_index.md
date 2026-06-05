# FRIENDS — Test Case Index

Module: **user-service** friend / friendship system. ID prefix: `TC-FRND-NNN`.
Base path (via gateway): `/api/v1/users/friends` (plus internal `/api/v1/users/internal/*` and a gRPC RPC).

## Files

| File                                                     | Endpoint(s)                                                         | Cases | IDs             |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ----- | --------------- |
| [`send-request.md`](send-request.md)                     | `POST /friends/requests`                                            | 18    | TC-FRND-001…018 |
| [`accept-request.md`](accept-request.md)                 | `POST /friends/requests/:id/accept`                                 | 9     | TC-FRND-020…029 |
| [`decline-cancel-request.md`](decline-cancel-request.md) | `POST /friends/requests/:id/reject`, `DELETE /friends/requests/:id` | 11    | TC-FRND-030…040 |
| [`remove-friend.md`](remove-friend.md)                   | `DELETE /friends/:userId`                                           | 10    | TC-FRND-050…059 |
| [`list-friends.md`](list-friends.md)                     | `GET /friends`                                                      | 14    | TC-FRND-070…083 |
| [`friendship-status.md`](friendship-status.md)           | `GET /internal/friendship-check`, gRPC `CheckFriendship`            | 10    | TC-FRND-090…099 |
| [`list-requests.md`](list-requests.md)                   | _(GAP — incoming/outgoing list not implemented)_                    | 3     | TC-FRND-110…112 |
| [`block-unblock.md`](block-unblock.md)                   | _(GAP — block/unblock writes not implemented)_                      | 5     | TC-FRND-120…124 |

**Total: 80 test cases** (8 are BLOCKED placeholders for not-yet-implemented endpoints).

## Implemented endpoints (full path)

| Method | Path                                        | Handler               | Auth               |
| ------ | ------------------------------------------- | --------------------- | ------------------ |
| GET    | `/api/v1/users/friends`                     | `listFriends`         | JWT                |
| POST   | `/api/v1/users/friends/requests`            | `sendFriendRequest`   | JWT                |
| POST   | `/api/v1/users/friends/requests/:id/accept` | `acceptFriendRequest` | JWT                |
| POST   | `/api/v1/users/friends/requests/:id/reject` | `rejectFriendRequest` | JWT                |
| DELETE | `/api/v1/users/friends/requests/:id`        | `cancelFriendRequest` | JWT                |
| DELETE | `/api/v1/users/friends/:userId`             | `unfriend`            | JWT                |
| GET    | `/api/v1/users/internal/friendship-check`   | `getFriendshipCheck`  | **none**           |
| gRPC   | `UserService.CheckFriendship`               | `checkFriendship`     | service-to-service |

## State machine (single `Friendship` row per pair)

```
(none) --send--> PENDING --accept--> ACCEPTED --unfriend--> UNFRIENDED
                   |  |                                          |
            reject |  | cancel                                   | re-send
                   v  v                                          v
              REJECTED CANCELLED  <----- resetToPending (recycle row) -----
```

- `acceptWithCounters` / `unfriendWithCounters` adjust `friendsCount ±1` on both profiles inside a `$transaction`.
- Mutual-pending send auto-accepts. REJECTED/CANCELLED/UNFRIENDED rows are recycled to PENDING on re-send (same row id, direction may flip).

## Emitted events (RabbitMQ `friendship.queue`, durable)

| Event               | Emitted by           | Payload                                                       |
| ------------------- | -------------------- | ------------------------------------------------------------- |
| `friend.requested`  | send (new / recycle) | `{ friendshipId, requesterId, addresseeId, createdAt }`       |
| `friend.accepted`   | accept / auto-accept | `{ friendshipId, requesterId, addresseeId, acceptedAt }`      |
| `friend.unfriended` | unfriend             | `{ friendshipId, unfriendedById, otherUserId, unfriendedAt }` |

Note: **reject** and **cancel** emit NO event and do not touch cache/counters.
Profile cache (`userCache.invalidateProfile`) is invalidated on accept & unfriend only.

## Category coverage

Happy Path · Input Validation · AuthN · AuthZ · Business Rule (self-friend, duplicate,
already-friends, blocked, state transitions) · DB State (state-machine + counters) ·
Error Handling · Edge Case · Pagination/Filter/Sort (friends list) · Concurrency
(mutual send, accept+cancel race, double-accept, double-unfriend) · Security (IDOR on
accept/reject/cancel, internal-route exposure).

## GAPS / ambiguities (for reviewers)

1. **Friendship-gate / `check(a,b)` — RESOLVED.** The memory note's pending "rewire to a
   user-service `check(a,b)` endpoint" is satisfied by **two** existing mechanisms:
   - HTTP `GET /api/v1/users/internal/friendship-check?callerId=&candidateIds=` (batch subset).
   - gRPC `UserService.CheckFriendship({userA,userB}) → {areFriends}` (single pair).
     Both consider only `ACCEPTED`. Consumers (chat-service / community-service) should use these.

2. **Internal route has NO auth middleware.** `internalRoutes` mounts `/internal/friendship-check`
   and `/internal/bulk-snapshot` with no `authenticateAccessToken`. `callerId` is caller-supplied,
   so anyone reaching the route can probe arbitrary friend graphs. Security depends entirely on the
   gateway blocking `/internal/*`. **Verify the gateway boundary.** Inputs are also un-validated
   (raw query strings → Prisma `@db.Uuid`); non-UUID input may 500.

3. **No incoming/outgoing request-list endpoints.** Schema has the indexes and the repo has
   `findAllForUser`, but there is no `GET /friends/requests`. Clients cannot enumerate pending
   requests. (TC-FRND-110…112 are BLOCKED placeholders.)

4. **No block/unblock write endpoints in FRIENDS.** `Block` is read-only here (enforced on send).
   Creating/removing/listing blocks is not exposed by this module. (TC-FRND-120…124 partly BLOCKED.)

5. **Block does not auto-unfriend.** Blocking after an ACCEPTED friendship leaves the friendship
   intact; `list-friends` and `friendship-check` ignore blocks, so a blocked pair can still read as
   friends. Confirm whether this is intended (TC-FRND-121).

6. **Concurrency / TOCTOU on check-then-write.** `sendRequest`, `accept`, `cancel`, `unfriend` all
   read the row then write without a row lock or guarded `updateMany(where status=...)`. Races may
   (a) create duplicate opposite-direction rows on simultaneous mutual send (unique constraint is
   directional `[requesterId, addresseeId]`), or (b) double-increment/double-decrement `friendsCount`.
   TC-FRND-017/018/028/029/058 are written to surface and document actual behavior — likely defects.

7. **Misleading success message.** Mutual-send auto-accept returns message key `FRIEND_REQUEST_SENT`
   despite producing an ACCEPTED friendship (TC-FRND-002) — minor UX inconsistency.

8. **`friendsCount` drift.** Counter is not adjusted when a friend's profile is soft-deleted, so the
   stored count can exceed the number of listable friends (TC-FRND-079).
