# user-service — Audit Findings

Prioritized list of real issues found while reading the source during test authoring.
Every finding is grounded in a `file:line`. Severity reflects security/correctness impact
in this service's context. No speculative or invented issues are included.

Legend — Type: MissingValidation | Security | Bug | DataIntegrity | Inconsistency

---

## High

### H1 — Call allow-list entries are never validated as real friends (DataIntegrity / MissingValidation)

- **Endpoint:** `PATCH /api/v1/users/settings/me`
- **Where:** `src/services/user-settings.service.ts:98-113`, `:155-180`;
  `src/repositories/user-settings.repository.ts:264-276`.
- **Detail:** `callAllowedFriendIds` is only checked for: valid UUID, ≤500 entries,
  and "not my own id". The ids are written straight into `callAllowedFriend` with
  `createMany(... skipDuplicates)`. There is no check that each id is an **accepted
  friend** of the owner (nor that the profile even exists). A client can populate the
  "selected friends who may call me" list with arbitrary user ids, including strangers
  or blocked users. Combined with `whoCanCallMe="SELECTED_FRIENDS"`, this can grant call
  permission to non-friends and silently bloats the table with dangling references.
- **Recommendation:** Validate each id against `friendshipRepository.findAcceptedFriendIdsForUser(ownerId, ids)`
  (the method already exists, `friendship.repository.ts:181`) and reject ids that are not
  accepted friends with a 400. Also enforce that `whoCanCallMe="SELECTED_FRIENDS"` requires
  a non-empty allow-list.

### H2 — `whoCanCallMe="SELECTED_FRIENDS"` accepted with an empty / unsupplied allow-list (MissingValidation)

- **Endpoint:** `PATCH /api/v1/users/settings/me`
- **Where:** `src/api/validators/settings.validator.ts:50-59`;
  `src/services/user-settings.service.ts:155-167`.
- **Detail:** `whoCanCallMe` and `callAllowedFriendIds` are independent optional fields with
  no cross-field refinement. A caller can set `whoCanCallMe="SELECTED_FRIENDS"` without ever
  supplying a list (or with an empty list), producing a privacy state of "only selected
  friends may call me" while the selected set is empty — i.e. effectively NO_ONE, but
  presented as SELECTED_FRIENDS. The two settings are persisted in separate upserts
  (`whoCanCallMe` to `privacySettings`, the list to `callAllowedFriend`), so they can drift.
- **Recommendation:** Add a Zod `.superRefine` (or service-level guard) requiring a
  non-empty `callAllowedFriendIds` whenever `whoCanCallMe="SELECTED_FRIENDS"`, and clearing
  the list when it changes away from `SELECTED_FRIENDS`.

---

## Medium

### M1 — Block recheck is skipped on the mutual-accept and row-recycle paths (Security / Bug)

- **Endpoint:** `POST /api/v1/users/friends/requests`
- **Where:** `src/services/friendship.service.ts:48-104`.
- **Detail:** Blocks are checked once (`:48-56`) before the existing-pair lookup. That is
  correct for the fresh-create path. However, the block set is fetched only for
  `requesterId`'s relationships via `findAllBlocks(requesterId)` and the check is order-of-
  operations sound for new requests. The subtler issue: when a previously REJECTED /
  CANCELLED / UNFRIENDED row is recycled (`resetToPending`, `:91-103`) the block check has
  already run, but **the recycle path does NOT invalidate the profile cache** for either
  party (contrast the accept path at `:78-81` and `:138-141`, which do). After a recycle the
  cached `friendsCount` / relationship-derived data for both users can be stale until TTL
  expiry. Low data-correctness risk but an inconsistency vs. the other write paths.
- **Recommendation:** Call `userCache.invalidateProfile` for both parties on the recycle
  branch, mirroring the accept/unfriend paths.

### M2 — `GET /api/v1/users?section=all` only excludes users _I_ blocked, not users who blocked _me_ (Security / Inconsistency)

- **Endpoint:** `GET /api/v1/users` (`section=all`)
- **Where:** `src/services/user-discovery.service.ts:201-214` vs. `_queryOthers` `:154-157`.
- **Detail:** `_queryAll` builds `blockedUserIds` from `b.blockerId` only
  (`for (const b of allBlocks) blockedUserIds.add(b.blockerId)`), so it excludes users the
  viewer blocked but **includes users who blocked the viewer**. `_queryOthers` (the default
  section) correctly excludes both directions by deriving `otherId` from whichever side the
  viewer is on (`:154-157`). A user who blocked me can still appear in my `all` search
  results, leaking their presence/profile to someone they blocked.
- **Recommendation:** In `_queryAll`, exclude the _other_ party regardless of direction:
  `const otherId = b.blockerId === viewerId ? b.blockedId : b.blockerId;` (same pattern as
  `_queryOthers`).

### M3 — Avatar object-key ownership relies solely on the embedded ownerId; orphaned objects on overwrite (DataIntegrity)

- **Endpoint:** `PATCH /api/v1/users/profiles/me` (avatar set)
- **Where:** `src/services/avatar.service.ts:24-46`; `src/services/user-profile.service.ts:388-398`.
- **Detail:** Setting a new avatar validates ownership and existence but does **not** delete
  the previously stored avatar object. Repeatedly updating the avatar leaves orphaned objects
  in the private bucket (storage leak). Clearing the avatar (`avatarObjectKey:null`,
  `:389-390`) also only nulls the DB column without deleting the underlying object.
- **Recommendation:** On successful avatar replace/clear, best-effort `deleteObject` the
  previous `avatarUrl` key (the service already imports `deleteObject` and uses it for the
  too-large cleanup at `avatar.service.ts:42`).

### M4 — Friendship counter transactions can underflow / drift on concurrent or out-of-order writes (DataIntegrity)

- **Endpoint:** `POST .../accept`, `DELETE .../:userId` (unfriend)
- **Where:** `src/repositories/friendship.repository.ts:82-101` (accept, `increment`),
  `:120-148` (unfriend, `decrement`).
- **Detail:** `friendsCount` is mutated with raw `increment`/`decrement` inside a
  `$transaction`, but the status transition and the counter bump are not guarded by an
  optimistic condition on the _current_ status. The service checks `status==="PENDING"`
  (accept) / `findActivePair` (unfriend) **before** the transaction, then performs an
  unconditional `update` by `id`. Two concurrent accepts of the same request, or an
  accept racing an unfriend, can each pass their pre-check and both run their counter
  delta, double-counting or driving `friendsCount` negative. There is no
  `where: { id, status: "PENDING" }` guard inside the update to make the transition atomic.
- **Recommendation:** Make the status flip conditional (`update where id AND status=...`,
  or `updateMany` and assert `count===1`) and only apply the counter delta when the
  conditional update actually transitioned the row.

### M5 — `sendRequest` does not re-check `whoCanSendFriendRequests` privacy scope (MissingValidation)

- **Endpoint:** `POST /api/v1/users/friends/requests`
- **Where:** `src/services/friendship.service.ts:27-117`; privacy field defined at
  `src/api/validators/settings.validator.ts:53` (`whoCanSendFriendRequests`).
- **Detail:** The service enforces self-add, profile existence, and blocks, but never
  consults the **addressee's** `whoCanSendFriendRequests` privacy setting
  (`EVERYONE | FRIENDS_OF_FRIENDS | NO_ONE`). A user who set "no one can send me friend
  requests" can still receive requests. The privacy setting is collected and stored but
  not enforced on this write path.
- **Recommendation:** Load the addressee's privacy scope and reject (e.g. `403`) when the
  scope forbids the request; implement the `FRIENDS_OF_FRIENDS` case via the existing
  friendship graph.

---

## Low

### L1 — Generic Prisma `P2002` is always mapped to "username taken" (Inconsistency)

- **Where:** `src/middleware/error-handler.ts:35-44`.
- **Detail:** Any unique-constraint violation that bubbles to the error handler is reported
  as `409 USER_USERNAME_TAKEN`, regardless of which constraint fired (e.g. a duplicate
  friendship pair or a `callAllowedFriend` unique). This can produce a misleading message
  for non-username conflicts. The profile service handles field-specific P2002 internally
  (`user-profile.service.ts:55-89`), but the global fallback does not.
- **Recommendation:** Inspect `error.meta.target` in the handler and choose a constraint-
  appropriate message, or fall through to a generic `409 CONFLICT` when the field is unknown.

### L2 — Event publishing is fire-and-forget with no outbox / DLQ on the producer side (DataIntegrity)

- **Where:** `src/messaging/publish-friendship.ts:37-42` (`publishSafe` swallows errors);
  similarly `publish-profile-updated.ts`, `publish-settings-updated.ts`.
- **Detail:** Friendship/profile/settings mutations commit to Postgres, then `*Safe`
  publishers emit to RabbitMQ in a detached promise that only logs on failure
  (`void publish(...).catch(...)`). If the broker is down at that instant, the DB write
  succeeds but the event is permanently lost — downstream services (notifications, chat
  list bumps) silently miss the update. No transactional outbox or producer-side retry.
- **Recommendation:** Adopt a transactional outbox (persist the event in the same tx, relay
  asynchronously) or at minimum a bounded producer retry, for at-least-once delivery.

### L3 — `bio` length validated by JS `.max(280)` counts UTF-16 code units, not grapheme/codepoints (MissingValidation / Edge)

- **Where:** `src/api/validators/profile.validator.ts:51-56`.
- **Detail:** `z.string().max(280)` counts `String.length` (UTF-16 code units). Emoji and
  astral-plane characters count as 2 units, so a bio of 140 such emoji is rejected, while
  the intent ("280 characters") is ambiguous and inconsistent with how a client renders
  character count. The test even asserts an emoji bio at the boundary works, but only
  because it is short. Not a security issue; a UX/contract inconsistency.
- **Recommendation:** Decide the canonical unit (codepoints via `[...str].length` or
  grapheme clusters) and apply it consistently with the client's counter.

### L4 — `findAllBlocks(requesterId)` is used to gate `addresseeId` blocks but is named/scoped to the requester only (Inconsistency)

- **Where:** `src/services/friendship.service.ts:48-56`; `friendship.repository.ts:204-211`.
- **Detail:** `findAllBlocks(requesterId)` returns rows where requester is blocker **or**
  blocked, so the `isBlocked` check at `:49-53` does correctly cover both directions for the
  requester↔addressee pair. This is functionally correct, but the variable/method naming
  (`findAllBlocks(requesterId)` then matching against `addresseeId`) makes the bidirectional
  intent non-obvious and easy to break in a future edit. Documentation/readability risk only.
- **Recommendation:** Add a focused `isBlockedBetween(a, b)` repository helper or a comment
  clarifying the bidirectional semantics.

---

## Uncovered areas (no automated HTTP coverage; carry verification risk)

- **gRPC surface** — `friendshipRepository.findAcceptedFriendIdsForUser` and
  `src/grpc/server.ts` (`CheckFriendship`, friend-id validation for community-service):
  no test exercises the gRPC handlers; correctness depends on manual/integration checks.
- **Event consumers / handlers** — `src/consumers/user-created.consumer.ts`,
  `user-deleted.consumer.ts`, `src/handlers/user-created.handler.ts`,
  `user-deleted.handler.ts`, and the username-race + stale-account-collision retry loop
  in `user-profile.service.ts:227-316` are untested. The reclaim-stale-account path
  (`:291-308`) deliberately frees an account across `deletedAt`/status — high-blast-radius
  logic with no regression test.
- **Avatar MinIO branches** — ownership/head/size validation and presigned view-URL
  generation (`avatar.service.ts`) are mocked away; only the null-avatar path runs E2E.
- **Redis cache** — `src/lib/user-cache.ts` warm-cache reads, TTLs, and username-
  availability caching are forced cold in tests; cache-hit correctness is unverified.
- **Notification-settings gRPC read** — `userSettingsRepository.findNotificationSettings`
  (consumed by notifications-service) has no test path.
