# community-service — Code Audit

Findings discovered while reading the real source against the generated test suite
(`224 passing / 1 skipped`, green). Every finding is grounded in a `file:line`. No issues are
invented — each is what the code actually shows. Paths are relative to
`apps/community-service/`.

Severity legend: **High** = security/auth or data loss · **Medium** = real bug or integrity
gap with a realistic trigger · **Low** = inconsistency / hardening.

---

## High

### H1 — Admin category CRUD has NO authorization (any authenticated user can mutate the global taxonomy)

- **Type:** Security (authz gap / missing role check)
- **Endpoints:** `POST /categories`, `PATCH /categories/:categoryId`, `DELETE /categories/:categoryId`,
  `GET /categories/admin`
- **Evidence:** `src/api/routes/community.routes.ts:135-158` wires these to
  `adminCreateCategory`/`adminUpdateCategory`/`adminDeleteCategory`/`adminListCategories` with only
  `validateBody`/`validateParams` — no role middleware. The controllers
  (`src/api/controllers/community.controller.ts:1035-1081`) call the service directly, and the
  service methods `createCategory`/`updateCategory`/`deleteCategory`/`listCategoriesAdmin`
  (`src/services/community.service.ts:597-699`) take **no caller/role argument** and perform no
  authz check. The whole chain is gated only by `authenticateAccessToken`
  (`community.routes.ts:126`). The test file even states it: "these admin routes are guarded only
  by the access-token middleware (no role gate at the route layer in this service)"
  (`tests/categories/admin-categories.test.ts:8-10`).
- **Impact:** Any logged-in end user can create, rename, hide/unhide, or delete community
  categories — global platform data shared across all communities. `DELETE` is blocked only when a
  category is in use (`CATEGORY_IN_USE`), so unused categories can be freely destroyed and arbitrary
  ones created.
- **Recommendation:** Gate these four routes behind a platform-admin check (the service is meant to
  be reachable for admin CRUD only via the backoffice/api-gateway admin path, or a dedicated
  `requirePlatformAdmin` middleware / gRPC-only handler). At minimum, verify a platform-admin claim
  on the token before mutating categories.

### H2 — Friend-validation gate is commented out in `addMembers` (inconsistent with `create`)

- **Type:** Security (broken access control) / MissingValidation
- **Endpoint:** `POST /:id/members`
- **Evidence:** `src/services/community.service.ts:1575` (`// const friendSet = await fetchAcceptedFriendIds(...)`)
  and `:1604-1607` (the `if (!friendSet.has(userId)) { skipped.push({reason:"NOT_FRIEND"}) }` block is
  fully commented out). The surrounding comments still describe the intended behavior ("Server-side
  friend validation BEFORE existing-row partitioning… skipped as NOT_FRIEND"). By contrast,
  community **creation** still enforces it: `create` filters `memberIds` to accepted friends at
  `:793-797`.
- **Impact:** A MODERATOR/ADMIN can add **any** userId to a community regardless of friendship,
  bypassing the platform's friends-only invite policy. The `NOT_FRIEND` skip reason is now dead code,
  and the behavior diverges from `create` (friend-checked) for the same effective operation.
- **Recommendation:** Re-enable the friend check (uncomment `:1575` + `:1604-1607`) or, if the policy
  was intentionally dropped, also remove it from `create` and delete the now-misleading comments and
  the `NOT_FRIEND` skip-reason type so the two paths are consistent and the contract is honest.

### H3 — `GET /liked` is unreachable due to route ordering (dead endpoint)

- **Type:** Bug (routing) — also affects API contract
- **Endpoint:** `GET /liked`
- **Evidence:** `GET /:id` is registered at `src/api/routes/community.routes.ts:251`, while the static
  `GET /liked` is registered later at `:306`. Express matches in registration order, so `/liked` is
  captured by `/:id`; `communityIdParamsSchema` (`community.validator.ts:85-87`) rejects `"liked"`
  (not 24-hex) and the request returns **400** instead of ever reaching `listLikedCommunities`. The
  suite documents this with the only skipped test (`tests/mute/mute.test.ts:226-239`).
- **Impact:** The "liked/favorite communities" list feature is completely non-functional via this
  route; clients always get 400. (`POST /:id/like` / `DELETE /:id/like` work because their paths
  don't collide.)
- **Recommendation:** Move the `GET /liked` registration above `GET /:id` (alongside the other static
  routes `/mine`, `/discover`, `/reports/mine` that are correctly ordered before `/:id`).

---

## Medium

### M1 — `GET /liked` has no query validation (unbounded `limit`)

- **Type:** MissingValidation
- **Endpoint:** `GET /liked`
- **Evidence:** The route has no `validateQuery` middleware (`community.routes.ts:306-307`), and the
  controller reads `cursor`/`limit` straight from `req.query` and casts with `Number(limit)` with a
  default of 20 but **no upper bound or integer check**
  (`src/api/controllers/community.controller.ts:1106-1117`). Every other list endpoint caps `limit`
  at 50 via `limitSchema` (`community.validator.ts:47`).
- **Impact:** Once H3 is fixed, a caller could pass `?limit=100000` (or a non-numeric value coerced by
  `Number`) and trigger an oversized DB fetch / inconsistent behavior. `cursor` is also unvalidated.
- **Recommendation:** Add a `likedCommunitiesQuerySchema` (`cursor` optional string, `limit` int 1–50)
  and a `validateQuery` on the route; have the controller read from the validated query.

### M2 — `redeemInviteLink` increments usage before adding the member, with no compensation on failure

- **Type:** DataIntegrity
- **Endpoint:** `POST /invite-links/:code/redeem`
- **Evidence:** `src/services/community.service.ts:4255-4260` atomically increments `usedCount`
  (`incrementInviteLinkUsageIfUnder`) **before** the member is created/reactivated at `:4279-4300`
  (autoApprove) or the join request is created at `:4324`. There is no `$transaction` (standalone
  Mongo, by design) and no rollback if the subsequent `createMember`/`reactivate`/`createJoinRequest`
  throws.
- **Impact:** A failure after the increment burns a use of a capacity-limited (`maxUses`) link without
  actually joining the user — a limited link can be silently exhausted below its real join count.
- **Recommendation:** Either increment usage only after the member/join-request write succeeds, or add
  a compensating decrement on failure (mirroring the `cleanupFailedCreate` pattern at `:887`).

### M3 — `POST /:id/like` allows liking a community you are not a member of (and PRIVATE communities)

- **Type:** Inconsistency / possible info exposure
- **Endpoint:** `POST /:id/like`
- **Evidence:** `likeCommunity` (`src/services/community.service.ts:2244-2258`) checks only existence
  and `assertCommunityNotSuspended` — it does **not** check membership or community type. Contrast
  with mute/notification-prefs which require an ACTIVE membership (`:3670-3672` etc.).
- **Impact:** A user can favorite a PRIVATE community they have no relationship with (by guessing/
  knowing its ObjectId), and the favorites list (`listFavoriteCommunities`, `:2267`) will then surface
  that PRIVATE community's summary (name/handle/avatar) to them via `toDiscoverItem`. Minor, but it
  leaks a PRIVATE community's existence/metadata to a non-member.
- **Recommendation:** Decide the intended policy. If "like" is meant for discoverable/public or joined
  communities only, gate on `type === PUBLIC || isMember`. If liking any community is intended, ensure
  the favorites listing does not expose PRIVATE metadata to non-members.

### M4 — Defensive 500-fallback error handler hard-codes `COMMUNITY_NAME_TAKEN` for any P2002

- **Type:** Bug (wrong error message) / Inconsistency
- **Scope:** `src/middleware/error-handler.ts:37-45`
- **Evidence:** If a `PrismaClientKnownRequestError` with code `P2002` reaches the global handler
  (i.e. the service did not translate it), it is unconditionally mapped to
  `ConflictError("COMMUNITY_NAME_TAKEN")` — even for unique-constraint violations on `handle`, invite
  `code`, or member rows. The service's own `uniqueViolationToConflict` (`community.service.ts:126-139`)
  correctly inspects the `meta.target` to distinguish name vs handle, but the fallback does not.
- **Impact:** Any un-translated unique violation surfaces to the client as "community name is taken,"
  which is misleading for handle/code/member collisions.
- **Recommendation:** Reuse the `meta.target` inspection (or a generic `CONFLICT` message) in the
  handler instead of hard-coding the name conflict.

---

## Low

### L1 — `/mine` does not enforce "at least one of before_ts/after_ts/q/categoryId"

- **Type:** MissingValidation / Inconsistency (doc vs behavior)
- **Endpoint:** `GET /mine`
- **Evidence:** The schema doc comment requires "At least one of `before_ts`, `after_ts`, `q`, or
  `categoryId` must be present" (`community.validator.ts:114-115`), but `myCommunitiesQuerySchema`
  (`:130-146`) only `.refine()`s that both timestamps aren't sent together — it does not require any
  field. A param-less `/mine` passes validation and falls into search mode
  (`community.controller.ts:158-168`), returning all PUBLIC communities.
- **Recommendation:** Add a `.refine` requiring ≥1 of the four fields, or update the doc comment to
  reflect that a bare `/mine` browses all public communities.

### L2 — `listLikedCommunities` membership lookup is N+1 (one `findMembership` per favorite)

- **Type:** Bug (performance)
- **Endpoint:** `GET /liked`
- **Evidence:** `src/services/community.service.ts:2300-2306` issues one `findMembership(cid, callerId)`
  per favorited community in a `Promise.all` map, with a comment acknowledging "Resolve membership in
  bulk via findMemberships if available, else serial." Other list paths batch via
  `findActiveMembershipsByCommunityIds` (`:1822`).
- **Recommendation:** Replace the per-row lookup with a single batched membership query (the
  repository already has batched membership helpers).

### L3 — `unbanMember` / `setMemberCount` recompute happens outside any transaction (drift window)

- **Type:** DataIntegrity (acknowledged design trade-off)
- **Scope:** e.g. `banMember` `:1500-1512`, `kickMember` `:1407-1414`, `unbanMember` `:1954-1962`,
  `leaveCommunity` `:1778-1785`
- **Evidence:** Every membership mutation does a single-document status update followed by a separate
  `countActiveMembers` + `setMemberCount`, explicitly without `$transaction` (standalone Mongo).
  Comments call recount "robust against drift," but a crash between the two writes leaves `memberCount`
  stale until the next recompute.
- **Recommendation:** This is a documented constraint; if/when Mongo runs as a replica set, wrap the
  status-change + recount in a transaction. Until then, treat `memberCount` as eventually-consistent
  and ensure all mutation paths recompute (they currently do).

### L4 — `addMembers` snapshot map uses non-null assertions that can throw on partial user-service data

- **Type:** Bug (unhandled null) — low likelihood
- **Endpoint:** `POST /:id/members` (also `create`, `approveJoinRequest`, `acceptInvite`)
- **Evidence:** `snapshotMap.get(userId)!` is asserted non-null in several places
  (`community.service.ts:827`, `:1630`, `:1645`, `:2632`, `:2755`, `:3030`, `:3138`). If
  `fetchUserSnapshots` returns fewer rows than requested (a user-service gap / deleted user), the `!`
  yields `undefined` and the next property access throws → 500 rather than a graceful skip.
- **Recommendation:** Guard the lookup (skip + record a `skipped` reason, or throw a typed
  `BadRequestError`) instead of asserting non-null, so a missing snapshot degrades gracefully.

---

## Uncovered areas (no executed test exercises these)

These are the largest gaps; every one is **DOCUMENTED-ONLY** in `TEST_CASES.md` because the
generated suite mocks the entire `communityService`, so the real service logic never runs.

1. **All service-layer authz role gates** (`assertCommunityRole` MODERATOR/ADMIN ladder,
   strict-rank `_assertCanModerateMember`, ACTIVE-membership gates for mute/prefs/report-create).
   Tests assert 403 only by making the mock reject — the actual gate is unverified.
2. **Report state machine** (`_resolveReport` transition table at `:3475-3491`) — OPEN→REVIEWED→
   ACTIONED/DISMISSED, terminal-state rejection, owner-only withdraw, OPEN-only withdraw.
3. **Join-request & invite status lifecycles** — idempotent re-return on PENDING, recycle of
   non-pending rows, BANNED-race closing, mutual-want auto-accept removal.
4. **Admin-set moderation status / suspension gating** — `assertCommunityNotSuspended` on join /
   update / add-members / invite / like / redeem; the `adminSetModerationStatus` gRPC path.
5. **Member-count recompute & no-transaction compensating writes** — `cleanupFailedCreate`,
   `markAllActiveMembersLeft`, admin-sole-member auto-delete on leave.
6. **Friend validation in `create`** (and the now-disabled one in `addMembers`).
7. **Invite-link capacity/expiry/revocation** — `incrementInviteLinkUsageIfUnder`, GoneError for
   expired/revoked/exhausted, autoApprove vs join-request branch, bulk-send fan-out + self-skip.
8. **Event publishing** — every `publish*Safe` call (member added/kicked/banned/muted/warned,
   role-changed, admin-transferred, join-requested, invite-sent/accepted, report-created/actioned,
   chat-room provisioning, status-changed). None are asserted.
9. **DTO serialization & media resolution** — ISO-vs-epoch date fields, presigned avatar/cover URL
   building (`toCommunityData`, `toDiscoverItem`, `toMemberData`, `buildLastActivity`).
10. **Cursor & offset pagination correctness** — `listMine` over-fetch/`hasMore`/`nextCursor`,
    inclusive-boundary de-dup, `buildPaginatedResponse` totals.
11. **`GET /liked` happy path** — cannot be tested until H3 is fixed (the route is unreachable).
12. **gRPC server handlers** (`src/grpc/server.ts`) and **RabbitMQ consumers**
    (`user-profile-updated`, `community-activity`) — entirely outside the HTTP suite.
13. **Upload service MIME/size enforcement** — the real `@aimess/storage` `createUploadUrl`
    (415 UNSUPPORTED_CONTENT_TYPE, 400 FILE_TOO_LARGE/FILE_EMPTY) is mocked; only the controller
    mapping is tested.
