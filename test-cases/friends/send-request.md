# FRIENDS — Send Friend Request

**Source:**

- `apps/user-service/src/api/routes/friendship.routes.ts` (`POST /requests`)
- `apps/user-service/src/api/controllers/friendship.controller.ts` (`sendFriendRequest`)
- `apps/user-service/src/api/validators/friendship.validator.ts` (`sendFriendRequestSchema`)
- `apps/user-service/src/services/friendship.service.ts` (`sendRequest`)
- `apps/user-service/src/repositories/friendship.repository.ts` (`findByPair`, `findAllBlocks`, `create`, `resetToPending`, `acceptWithCounters`)
- `apps/user-service/src/messaging/publish-friendship.ts`
- `apps/user-service/prisma/schema.prisma` (`Friendship`, `Block`, `FriendshipStatus`)

**External path (via gateway):** `POST /api/v1/users/friends/requests`

**Request body:** `{ "addresseeId": "<uuid>" }`

**Success response:** `201` `{ success, message: FRIEND_REQUEST_SENT, data: <FriendshipRow> }`
where `FriendshipRow = { id, requesterId, addresseeId, status, acceptedAt, rejectedAt, cancelledAt, unfriendedAt, unfriendedBy, createdAt, updatedAt }`.

> Business-rule recap (state machine on the single `Friendship` row per pair, `@@unique([requesterId, addresseeId])`):
>
> - No existing row → create `PENDING`, emit `friend.requested`.
> - Existing `ACCEPTED` → `409 FRIEND_ALREADY_FRIENDS`.
> - Existing `PENDING`, I am requester → `409 FRIEND_REQUEST_ALREADY_SENT`.
> - Existing `PENDING`, they are requester → **auto-accept** mutual request → `201` `ACCEPTED`, emit `friend.accepted`, bump `friendsCount` on both.
> - Existing `REJECTED`/`CANCELLED`/`UNFRIENDED` → `resetToPending` recycles the row with new direction, emit `friend.requested`.
> - Either side has a `Block` row for the pair → `400 FRIEND_BLOCKED`.

---

### TC-FRND-001 — Send request to a valid user (no prior relationship)

| Field                     | Value                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                                                                                                                              |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                                                                                               |
| **Test Scenario**         | Authenticated user sends a first-time friend request to another existing user                                                                       |
| **Category**              | Happy Path                                                                                                                                          |
| **Priority**              | High                                                                                                                                                |
| **Preconditions**         | Both requester & addressee have active (non-deleted) `UserProfile`; no `Friendship` row for the pair; no `Block` between them                       |
| **Request Payload**       | `{ "addresseeId": "<other-user-uuid>" }`                                                                                                            |
| **Expected Response**     | `201` `{ data: { status: "PENDING", requesterId: <me>, addresseeId: <other>, acceptedAt: null } }`, message `FRIEND_REQUEST_SENT`                   |
| **Expected DB Changes**   | New `friendships` row, `status=PENDING`, all timestamp columns null except `createdAt`                                                              |
| **Expected Socket/Event** | RabbitMQ `friend.requested` on `friendship.queue` `{ friendshipId, requesterId, addresseeId, createdAt }` → notifications-service push to addressee |
| **Notes**                 | `friendsCount` NOT incremented at PENDING                                                                                                           |

### TC-FRND-002 — Auto-accept when addressee already sent me a pending request

| Field                     | Value                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Friends / Send Request                                                                                                         |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                                                                          |
| **Test Scenario**         | User B sends a request to A while A already has a PENDING outgoing request to B → mutual request auto-accepts                  |
| **Category**              | Business Rule                                                                                                                  |
| **Priority**              | High                                                                                                                           |
| **Preconditions**         | A `friendships` row exists with `requesterId=A, addresseeId=B, status=PENDING`; current user is B sending to A                 |
| **Request Payload**       | `{ "addresseeId": "<A-uuid>" }`                                                                                                |
| **Expected Response**     | `201` `{ data: { status: "ACCEPTED", acceptedAt: <ts> } }`, message `FRIEND_REQUEST_SENT`                                      |
| **Expected DB Changes**   | Existing row → `status=ACCEPTED`, `acceptedAt` set; `friendsCount` +1 on BOTH profiles (single `$transaction`)                 |
| **Expected Socket/Event** | RabbitMQ `friend.accepted` `{ friendshipId, requesterId:A, addresseeId:B, acceptedAt }`; profile cache invalidated for A and B |
| **Notes**                 | Message key is still `FRIEND_REQUEST_SENT` even though it accepted — possible UX wording gap                                   |

### TC-FRND-003 — Re-send after a previously REJECTED/CANCELLED/UNFRIENDED relationship

| Field                     | Value                                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                                                                                                                                                                                            |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                                                                                                                                                             |
| **Test Scenario**         | A row exists in REJECTED (or CANCELLED / UNFRIENDED); requester sends a new request → row recycled to PENDING                                                                                                     |
| **Category**              | Business Rule / DB State                                                                                                                                                                                          |
| **Priority**              | High                                                                                                                                                                                                              |
| **Preconditions**         | `friendships` row exists for the pair with `status ∈ {REJECTED, CANCELLED, UNFRIENDED}`                                                                                                                           |
| **Request Payload**       | `{ "addresseeId": "<other-uuid>" }`                                                                                                                                                                               |
| **Expected Response**     | `201` `{ data: { status: "PENDING" } }`                                                                                                                                                                           |
| **Expected DB Changes**   | SAME row id reused via `resetToPending`: `requesterId`/`addresseeId` overwritten to new direction, `status=PENDING`, `acceptedAt/rejectedAt/cancelledAt/unfriendedAt/unfriendedBy=null`, `createdAt` reset to now |
| **Expected Socket/Event** | RabbitMQ `friend.requested`                                                                                                                                                                                       |
| **Notes**                 | Run 3 variants (REJECTED, CANCELLED, UNFRIENDED) — all recycle. Direction may flip vs. original                                                                                                                   |

### TC-FRND-004 — Cannot send a friend request to yourself

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                       |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`        |
| **Test Scenario**         | `addresseeId` equals the caller's own userId |
| **Category**              | Business Rule                                |
| **Priority**              | High                                         |
| **Preconditions**         | Authenticated user                           |
| **Request Payload**       | `{ "addresseeId": "<my-own-uuid>" }`         |
| **Expected Response**     | `400` `FRIEND_CANNOT_ADD_SELF`               |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | Self-check runs BEFORE any DB lookup         |

### TC-FRND-005 — Duplicate outgoing request (already PENDING, I am requester)

| Field                     | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                                                  |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                   |
| **Test Scenario**         | Requester re-sends while their own PENDING request is still outstanding |
| **Category**              | Business Rule                                                           |
| **Priority**              | High                                                                    |
| **Preconditions**         | `friendships` row `requesterId=me, addresseeId=other, status=PENDING`   |
| **Request Payload**       | `{ "addresseeId": "<other-uuid>" }`                                     |
| **Expected Response**     | `409` `FRIEND_REQUEST_ALREADY_SENT`                                     |
| **Expected DB Changes**   | None                                                                    |
| **Expected Socket/Event** | None                                                                    |

### TC-FRND-006 — Already friends → conflict

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                        |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`         |
| **Test Scenario**         | Sending a request to someone already ACCEPTED |
| **Category**              | Business Rule                                 |
| **Priority**              | Medium                                        |
| **Preconditions**         | `friendships` row for pair `status=ACCEPTED`  |
| **Request Payload**       | `{ "addresseeId": "<friend-uuid>" }`          |
| **Expected Response**     | `409` `FRIEND_ALREADY_FRIENDS`                |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |

### TC-FRND-007 — Blocked pair (I blocked them) → rejected

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                            |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`             |
| **Test Scenario**         | Requester has a `Block` row against the addressee |
| **Category**              | Business Rule                                     |
| **Priority**              | High                                              |
| **Preconditions**         | `blocks` row `blockerId=me, blockedId=other`      |
| **Request Payload**       | `{ "addresseeId": "<blocked-uuid>" }`             |
| **Expected Response**     | `400` `FRIEND_BLOCKED`                            |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |

### TC-FRND-008 — Blocked pair (they blocked me) → rejected

| Field                     | Value                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                                                                                     |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                                                      |
| **Test Scenario**         | Addressee has a `Block` row against the requester (reverse direction)                                      |
| **Category**              | Business Rule / Security                                                                                   |
| **Priority**              | High                                                                                                       |
| **Preconditions**         | `blocks` row `blockerId=other, blockedId=me`                                                               |
| **Request Payload**       | `{ "addresseeId": "<blocker-uuid>" }`                                                                      |
| **Expected Response**     | `400` `FRIEND_BLOCKED`                                                                                     |
| **Expected DB Changes**   | None                                                                                                       |
| **Expected Socket/Event** | None                                                                                                       |
| **Notes**                 | `findAllBlocks(requesterId)` returns blocks where requester is blocker OR blocked; both directions covered |

### TC-FRND-009 — Addressee profile does not exist

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Friends / Send Request                                       |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                        |
| **Test Scenario**         | `addresseeId` is a well-formed UUID but has no `UserProfile` |
| **Category**              | Error Handling                                               |
| **Priority**              | Medium                                                       |
| **Preconditions**         | No `UserProfile` with that userId                            |
| **Request Payload**       | `{ "addresseeId": "<random-but-valid-uuid>" }`               |
| **Expected Response**     | `404` `USER_PROFILE_NOT_FOUND`                               |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |

### TC-FRND-010 — Addressee profile soft-deleted

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                          |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`           |
| **Test Scenario**         | Addressee profile exists but `deletedAt` is set |
| **Category**              | Edge Case                                       |
| **Priority**              | Medium                                          |
| **Preconditions**         | Addressee `UserProfile.deletedAt != null`       |
| **Request Payload**       | `{ "addresseeId": "<deleted-user-uuid>" }`      |
| **Expected Response**     | `404` `USER_PROFILE_NOT_FOUND`                  |
| **Expected DB Changes**   | None                                            |
| **Expected Socket/Event** | None                                            |

### TC-FRND-011 — Requester's own profile soft-deleted/missing

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                                               |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                |
| **Test Scenario**         | Caller has a valid token but no live `UserProfile` (or soft-deleted) |
| **Category**              | Edge Case                                                            |
| **Priority**              | Low                                                                  |
| **Preconditions**         | Requester `UserProfile` missing or `deletedAt != null`               |
| **Request Payload**       | `{ "addresseeId": "<valid-uuid>" }`                                  |
| **Expected Response**     | `404` `USER_PROFILE_NOT_FOUND`                                       |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |

### TC-FRND-012 — Missing `addresseeId`

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Friends / Send Request                |
| **API/Event Name**        | `POST /api/v1/users/friends/requests` |
| **Test Scenario**         | Body has no `addresseeId`             |
| **Category**              | Input Validation                      |
| **Priority**              | Medium                                |
| **Preconditions**         | Authenticated                         |
| **Request Payload**       | `{}`                                  |
| **Expected Response**     | `400` validation error (zod)          |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |

### TC-FRND-013 — `addresseeId` not a UUID

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Friends / Send Request                |
| **API/Event Name**        | `POST /api/v1/users/friends/requests` |
| **Test Scenario**         | `addresseeId` is a non-UUID string    |
| **Category**              | Input Validation                      |
| **Priority**              | Medium                                |
| **Preconditions**         | Authenticated                         |
| **Request Payload**       | `{ "addresseeId": "not-a-uuid" }`     |
| **Expected Response**     | `400` "Invalid user ID"               |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |

### TC-FRND-014 — Unauthenticated (no token)

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Friends / Send Request                |
| **API/Event Name**        | `POST /api/v1/users/friends/requests` |
| **Test Scenario**         | No `Authorization` header             |
| **Category**              | AuthN                                 |
| **Priority**              | High                                  |
| **Preconditions**         | None                                  |
| **Request Payload**       | `{ "addresseeId": "<uuid>" }`         |
| **Expected Response**     | `401` `AUTH_UNAUTHORIZED`             |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |

### TC-FRND-015 — Expired/invalid access token

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                            |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`             |
| **Test Scenario**         | Bearer token expired or tampered                  |
| **Category**              | AuthN                                             |
| **Priority**              | High                                              |
| **Preconditions**         | None                                              |
| **Request Payload**       | `{ "addresseeId": "<uuid>" }`                     |
| **Expected Response**     | `401` `AUTH_TOKEN_EXPIRED` / `AUTH_INVALID_TOKEN` |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |

### TC-FRND-016 — Revoked session (session no longer active)

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                                                |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                 |
| **Test Scenario**         | Token valid but its session was revoked (`assertSessionActive` fails) |
| **Category**              | AuthN                                                                 |
| **Priority**              | High                                                                  |
| **Preconditions**         | Session revoked in auth-service / session-active cache                |
| **Request Payload**       | `{ "addresseeId": "<uuid>" }`                                         |
| **Expected Response**     | `401` `AUTH_SESSION_ENDED`                                            |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | None                                                                  |

### TC-FRND-017 — Concurrency: both users send to each other simultaneously

| Field                     | Value                                                                                                                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                                                                                                                                                                                                                                                           |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                                                                                                                                                                                                                            |
| **Test Scenario**         | A→B and B→A POST race with no pre-existing row                                                                                                                                                                                                                                   |
| **Category**              | Concurrency                                                                                                                                                                                                                                                                      |
| **Priority**              | High                                                                                                                                                                                                                                                                             |
| **Preconditions**         | No `friendships` row for pair                                                                                                                                                                                                                                                    |
| **Request Payload**       | Both call with each other's id                                                                                                                                                                                                                                                   |
| **Expected Response**     | Exactly one `friendships` row must survive; the second create should hit `@@unique([requesterId, addresseeId])`. NOTE: the unique constraint is directional (requesterId,addresseeId), so two opposite-direction inserts can BOTH succeed → 2 rows. **Likely defect to verify.** |
| **Expected DB Changes**   | Ideally ONE row; verify whether duplicate (A,B)+(B,A) rows are created                                                                                                                                                                                                           |
| **Expected Socket/Event** | Up to two `friend.requested` events                                                                                                                                                                                                                                              |
| **Notes**                 | `findByPair` checks both directions but there is no transaction/lock around check-then-create → TOCTOU. Document actual observed behavior                                                                                                                                        |

### TC-FRND-018 — Concurrency: duplicate auto-accept race

| Field                     | Value                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Send Request                                                                                                                                |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                                                                                                 |
| **Test Scenario**         | B sends to A twice concurrently while A's PENDING request to B exists → two auto-accept paths                                                         |
| **Category**              | Concurrency                                                                                                                                           |
| **Priority**              | Medium                                                                                                                                                |
| **Preconditions**         | Row `A→B PENDING`                                                                                                                                     |
| **Request Payload**       | Two parallel `{ addresseeId: A }` from B                                                                                                              |
| **Expected Response**     | `friendsCount` must end at +1 (not +2) on each side                                                                                                   |
| **Expected DB Changes**   | Verify `acceptWithCounters` doesn't double-increment (it updates by `id` and increments unconditionally) — **possible double-count defect to verify** |
| **Expected Socket/Event** | Possibly duplicate `friend.accepted`                                                                                                                  |
