# user-service — Test Cases

Audit + documentation of every HTTP endpoint in **user-service**, derived from the
real source (routes, validators, controllers, services, middleware) and cross-checked
against the executed Jest integration suite.

- **Strategy:** supertest drives the real Express app (`src/app.ts`, named export `app`).
  Routing, middleware, Zod validation, controllers, and services run for real; only the
  I/O boundary (Prisma, Redis, RabbitMQ, MinIO/S3, auth gRPC) is mocked.
- **Suite status:** `137 passed, 137 total` across 9 suites (green).
  Run: `node node_modules/jest/bin/jest.js --config apps/user-service/jest.config.cjs`
- **EXECUTED** = a Jest test asserts the case. **DOCUMENTED-ONLY** = derived from code,
  not yet asserted.

## Conventions (verified in code)

- Mount: `app.use("/api/v1/users", userRoutes)` in `src/app.ts:21`. `usersRoutes`
  is mounted at `/` (`src/api/routes/index.ts:22`), so discovery lives at `GET /api/v1/users`.
- Success envelope: `{ success: true, message, data }` via `ApiResponse`.
  `Date` values are serialized to epoch ms by `ApiResponse`; however the profile/settings/
  friends services pre-format dates to ISO strings, so those fields stay strings.
- Error envelope: `{ success: false, message }` (`src/middleware/error-handler.ts:27-33`).
- Status codes from `@aimess/errors`: `BadRequest`→400, `Unauthorized`→401,
  `Forbidden`→403, `NotFound`→404, `Conflict`→409, `UnsupportedMediaType`→415.
- Zod validation failure → **400** (`validate-body/query/params.ts`).
- Auth: every route below is guarded by `authenticateAccessToken`
  (`createAuthenticateAccessToken` from `@aimess/auth-jwt`) + a session-active gate.
  Missing/expired/forged token → **401**. There is **no public mutation route**.
- `req.auth.userId` is always taken from the verified JWT — never from the body/params
  (mass-assignment-safe identity).

---

## 1. GET /api/v1/users/accounts/me

- **Description:** Connected (social) accounts summary. Delegates to
  `resolveAuthAccountSummary` (gRPC to auth-service; degrades gracefully).
- **Controller/Service:** `account.controller.ts:8` → `connectedAccountsService.getConnectedAccounts`.
- **Preconditions:** valid access token.
- **Positive**
  - auth-service live → `200`, `data.providers` array, `data.accountStatus="live"`. **EXECUTED**
  - auth-service unavailable → `200`, `data.providers=null`, `data.accountStatus="unavailable"`. **EXECUTED**
- **Negative / Security**
  - no token → `401`, service not called. **EXECUTED**
  - expired token → `401`. **EXECUTED**
  - forged token (wrong secret) → `401`. **EXECUTED**
- **Status codes:** 200, 401.
- **Response:** `{ success, message, data:{ providers: Provider[]|null, accountStatus } }`.

## 2. GET /api/v1/users/profiles/me

- **Description:** Read caller's own profile (cache-first read, then auth summary).
- **Controller/Service:** `profile.controller.ts:9` → `userProfileService.getMyProfile`.
- **Positive**
  - existing live profile → `200`, `data.userId/username`, `dateOfBirth` as `YYYY-MM-DD`,
    `avatarUrl` null when unset. **EXECUTED**
- **Negative**
  - profile not found → `404`. **EXECUTED**
  - profile soft-deleted (`deletedAt` set) → `404`. **EXECUTED**
- **Security**
  - no token → `401`. **EXECUTED**
  - expired token → `401`. **EXECUTED**
- **Edge (DOCUMENTED-ONLY)**
  - cache hit path returns from cached record without DB read (`loadProfileRecord` `user-profile.service.ts:204`).
- **Status codes:** 200, 401, 404.

## 3. PATCH /api/v1/users/profiles/me

- **Description:** Partial profile update (name, username, bio, DOB, gender, avatar key).
- **Validator:** `updateProfileSchema` (`profile.validator.ts`). At least one field required.
- **Controller/Service:** `profile.controller.ts:19` → `userProfileService.updateProfile`.
- **Positive**
  - update first/last name → `200`. **EXECUTED**
  - change username when available + no cooldown → `200`, `validateAvailability` called. **EXECUTED**
  - clear avatar with `avatarObjectKey:null` → `200`, `updateProfile` called with `avatarUrl:null`. **EXECUTED**
  - bio with emoji at boundary → `200`. **EXECUTED**
- **Negative**
  - username taken → `409`, no DB write. **EXECUTED**
  - username change within 30-day cooldown → `400`, no DB write
    (`USERNAME_CHANGE_COOLDOWN_MS`, `user-profile.service.ts:404-411`). **EXECUTED**
  - profile missing → `404`. **EXECUTED**
  - validation matrix → `400`: empty body, firstName>50, blank firstName, bio>280,
    bad date format, underage DOB (<13), invalid gender enum, username<3, username
    illegal chars. **EXECUTED**
- **Security**
  - mass-assignment guard: extra/privileged fields (`userId`, `friendsCount`, `isOnline`)
    are stripped; `userId` always taken from token. **EXECUTED**
  - no token → `401`. **EXECUTED**
- **Edge (DOCUMENTED-ONLY)**
  - same-handle different-casing → stored canonical lowercase, no cooldown
    (`user-profile.service.ts:424-427`).
  - no-op PATCH where all provided fields equal current (e.g. only same username) →
    returns current profile without DB write (`updateData` empty, `:433-436`).
  - `avatarObjectKey` non-null → ownership check via `assertObjectKeyOwnedBy` then
    `headObject`; wrong owner → `400 INVALID_AVATAR_OBJECT_KEY`; not uploaded →
    `400 AVATAR_NOT_UPLOADED`; too large → `400 AVATAR_FILE_TOO_LARGE`
    (`avatar.service.ts:24-46`).
  - max age (>120 years) DOB rejected (`profile-fields.util.ts:54-62`).
- **Status codes:** 200, 400, 401, 404, 409.

## 4. GET /api/v1/users/settings/me

- **Description:** Full settings bundle (privacy/chat/app/notifications/liveStream).
- **Controller/Service:** `settings.controller.ts:9` → `userSettingsService.getMySettings`.
- **Positive**
  - full bundle → `200`, mapped API shape. **EXECUTED**
  - incomplete sub-settings → lazily `ensureDefaultSettings(userId)` then return `200`. **EXECUTED**
- **Negative**
  - owner profile missing → `404`. **EXECUTED**
  - owner profile soft-deleted → `404`. **EXECUTED**
  - settings still incomplete after ensure → `404 USER_SETTINGS_NOT_FOUND` (DOCUMENTED-ONLY, `user-settings.service.ts:81-83`).
- **Security**
  - no token → `401`. **EXECUTED**
- **Status codes:** 200, 401, 404.

## 5. PATCH /api/v1/users/settings/me

- **Description:** Partial update of one or more settings groups (`.strict()` schemas).
- **Validator:** `updateSettingsSchema` — at least one non-empty group required.
- **Controller/Service:** `settings.controller.ts:19` → `userSettingsService.updateMySettings`.
- **Positive**
  - update a privacy field → `200` + publishes `settings.updated`. **EXECUTED**
  - nested quiet-hours notification update → `200`. **EXECUTED**
  - update call allow-list → `200`, repo called with the id array. **EXECUTED**
- **Negative**
  - call allow-list containing caller's own id → `400`
    (`USER_SETTINGS_INVALID_CALL_ALLOW_LIST`, `user-settings.service.ts:108-110`). **EXECUTED**
  - missing profile → `404`, no write. **EXECUTED**
  - validation matrix → `400`: empty body, empty privacy group, empty chat group,
    unknown top-level key (strict), unknown privacy key (strict), invalid privacy enum,
    invalid theme enum, invalid language enum, non-boolean typingIndicators, bad time
    format, non-uuid in allow-list. **EXECUTED**
- **Security**
  - no token → `401`. **EXECUTED**
- **Edge (DOCUMENTED-ONLY)**
  - quiet-hours `days` deduped + capped at 7 (`settings.validator.ts:81-85`).
  - allow-list capped at 500 ids (`settings.validator.ts:57`).
  - allow-list deduped server-side (`normalizeCallAllowedFriendIds`).
  - **GAP:** `whoCanCallMe="SELECTED_FRIENDS"` does not require a non-empty allow-list,
    and allow-list ids are not validated as actual friends (see AUDIT).
- **Status codes:** 200, 400, 401, 404.

## 6. GET /api/v1/users/friends

- **Description:** Paginated, searchable accepted-friends list (cursor-based).
- **Validator:** `listFriendsQuerySchema` (`limit` default 30, max 100; uuid cursor).
- **Controller/Service:** `friends.controller.ts:9` → `friendsService.listFriends`.
- **Positive**
  - no friends → `200`, empty list, `totalCount:0`, `nextCursor:null`, profiles not queried. **EXECUTED**
  - page of friends with computed section header (`A`, …, `#`) → `200`. **EXECUTED**
  - more rows than limit → `nextCursor` set to last item's userId. **EXECUTED**
  - search filter passed through to repo. **EXECUTED**
- **Negative (validation matrix → 400)**
  - limit>100, limit=0, negative limit, non-numeric limit, non-uuid cursor, empty search,
    search>100 chars. **EXECUTED**
- **Security**
  - no token → `401`. **EXECUTED**
  - expired token → `401`. **EXECUTED**
- **Status codes:** 200, 400, 401.

## 7. GET /api/v1/users (discovery / search)

- **Description:** User discovery across `friends|others|all` sections with relationship
  labelling and friend/block/self exclusion.
- **Validator:** `searchUsersQuerySchema` (`section` default `others`; `page` default 1;
  `limit` default 20, max 50; `q` max 100).
- **Controller/Service:** `user-discovery.controller.ts:9` → `userDiscoveryService.searchUsers`.
- **Positive**
  - default `others` section excludes self + accepted friend. **EXECUTED**
  - labels pending-out relationship (`PENDING_OUT`, friendshipId). **EXECUTED**
  - `section=friends` returns `FRIEND` relationship status. **EXECUTED**
  - empty friends section when no friends → `200`, profiles not queried. **EXECUTED**
  - `section=all` with `q`, `page`, `limit` → correct skip math. **EXECUTED**
  - no matches → empty list. **EXECUTED**
- **Negative (validation matrix → 400)**
  - invalid section enum, page=0, negative page, limit>50, limit=0, non-numeric page,
    q>100 chars. **EXECUTED**
- **Security**
  - NoSQL-injection-shaped `q` (`{"$ne":null}`) coerced to a literal string. **EXECUTED**
  - no token → `401`; expired token → `401`. **EXECUTED**
- **Edge (DOCUMENTED-ONLY)**
  - `others` excludes blocked users (both directions, `_queryOthers` `:154-157`).
  - `all` excludes only users **I** blocked, not users who blocked me — see AUDIT.
  - `PENDING_IN` labelling when peer is requester (`:176-180`).
- **Status codes:** 200, 400, 401.

## 8. POST /api/v1/users/friends/requests

- **Description:** Send a friend request (with mutual-request auto-accept and row recycle).
- **Validator:** `sendFriendRequestSchema` (`addresseeId` uuid).
- **Controller/Service:** `friendship.controller.ts:13` → `friendshipService.sendRequest`.
- **Positive**
  - send request → `201`, publishes `friend.requested`, repo `create(ME, OTHER)`. **EXECUTED**
  - mutual pending (they already requested me) → auto-accept → `201`, status `ACCEPTED`,
    publishes `friend.accepted`. **EXECUTED**
  - recycle a previously REJECTED row back to PENDING → `201`. **EXECUTED**
- **Negative**
  - add yourself → `400` (`FRIEND_CANNOT_ADD_SELF`). **EXECUTED**
  - addressee profile missing/deleted → `404`. **EXECUTED**
  - either party blocked the other → `400` (`FRIEND_BLOCKED`). **EXECUTED**
  - already friends (ACCEPTED) → `409`. **EXECUTED**
  - request already sent by me (PENDING, I am requester) → `409`. **EXECUTED**
  - validation: missing/non-uuid/numeric addresseeId → `400`. **EXECUTED**
- **Security**
  - no token → `401`. **EXECUTED**
- **Edge (DOCUMENTED-ONLY)**
  - requester profile missing/deleted → `404` (`:40-42`).
  - recycle of CANCELLED / UNFRIENDED rows → `201` (same `resetToPending` branch).
- **Status codes:** 201, 400, 401, 404, 409.

## 9. POST /api/v1/users/friends/requests/:id/accept

- **Description:** Accept an incoming pending request (must be addressee).
- **Validator:** `friendshipIdParamsSchema` (`id` uuid).
- **Controller/Service:** `friendship.controller.ts:27` → `friendshipService.acceptRequest`.
- **Positive**
  - accept incoming pending → `200`, status `ACCEPTED`, publishes `friend.accepted`. **EXECUTED**
- **Negative / Security**
  - request not addressed to me (IDOR guard) → `404`, accept not called. **EXECUTED**
  - friendship not found → `404`. **EXECUTED**
  - non-uuid id → `400`. **EXECUTED**
  - non-PENDING status → `404` (DOCUMENTED-ONLY, `:124-130`).
- **Status codes:** 200, 400, 401, 404.

## 10. POST /api/v1/users/friends/requests/:id/reject

- **Description:** Reject an incoming pending request (must be addressee).
- **Controller/Service:** `friendship.controller.ts:44` → `friendshipService.rejectRequest`.
- **Positive**
  - reject incoming pending → `200`, repo `reject(id)`. **EXECUTED**
- **Negative / Security**
  - I am requester, not addressee → `404` (IDOR guard). **EXECUTED**
  - not found / non-PENDING → `404` (DOCUMENTED-ONLY).
  - non-uuid id → `400` (DOCUMENTED-ONLY, same params validator as accept).
- **Status codes:** 200, 400, 401, 404.

## 11. DELETE /api/v1/users/friends/requests/:id (cancel)

- **Description:** Cancel my own outgoing pending request (must be requester).
- **Controller/Service:** `friendship.controller.ts:61` → `friendshipService.cancelRequest`.
- **Positive**
  - cancel my own outgoing pending → `200`, repo `cancel(id)`. **EXECUTED**
- **Negative / Security**
  - cancel a request I did not send (IDOR guard) → `404`, cancel not called. **EXECUTED**
  - not found / non-PENDING → `404` (DOCUMENTED-ONLY).
- **Status codes:** 200, 400, 401, 404.

## 12. DELETE /api/v1/users/friends/:userId (unfriend)

- **Description:** Remove an active (ACCEPTED) friendship; decrements counters; publishes event.
- **Validator:** `unfriendParamsSchema` (`userId` uuid).
- **Controller/Service:** `friendship.controller.ts:78` → `friendshipService.unfriend`.
- **Positive**
  - unfriend active friend → `200`, publishes `friend.unfriended`. **EXECUTED**
- **Negative / Security**
  - unfriend yourself → `400`. **EXECUTED**
  - no active friendship → `404`. **EXECUTED**
  - non-uuid userId → `400`. **EXECUTED**
  - forged token → `401`. **EXECUTED**
- **Status codes:** 200, 400, 401, 404.
- **Note:** route order — `DELETE /:userId` is registered after `DELETE /requests/:id`,
  so `/requests/...` is matched first (no shadowing).

## 13. POST /api/v1/users/usernames/generate

- **Description:** Generate an available username from an account string.
- **Validator:** `generateUsernameSchema` (`account` 1..128 chars).
- **Controller/Service:** `username.controller.ts:12` → `usernameService.generateFromAccount`.
- **Positive**
  - generate from account (`John.Doe` → `john_doe`) → `200`. **EXECUTED**
  - base taken → numeric suffix appended (`johndoe_2`) → `200`. **EXECUTED**
- **Negative (validation → 400)**
  - missing account, empty account, account>128 chars. **EXECUTED**
  - base too malformed to be a valid handle → `400 INVALID_USERNAME_FORMAT`
    (DOCUMENTED-ONLY, `username.service.ts:22-24`).
  - all 9998 suffix candidates taken → `400 USERNAME_GENERATION_FAILED`
    (DOCUMENTED-ONLY, `username.service.ts:117`).
- **Security**
  - no token → `401`. **EXECUTED**
- **Status codes:** 200, 400, 401.

## 14. POST /api/v1/users/usernames/validate

- **Description:** Check whether a username is available (caller's own handle counts as available).
- **Validator:** `validateUsernameSchema` (normalized; 3..32; `[a-z0-9_]`).
- **Controller/Service:** `username.controller.ts:23` → `usernameService.validateAvailability`.
- **Positive**
  - available username → `200`, `data.available=true`. **EXECUTED**
  - taken by someone else → `200`, `data.available=false`. **EXECUTED**
  - caller's own current username → `200`, `available=true` (excludeUserId match). **EXECUTED**
  - uppercase normalized to canonical lowercase. **EXECUTED**
- **Negative / Security**
  - validation matrix → `400`: missing, too short, too long, illegal chars. **EXECUTED**
  - injection-shaped username (`' OR '1'='1`) → `400`, repo never called. **EXECUTED**
  - expired / forged token → `401`. **EXECUTED**
- **Status codes:** 200, 400, 401.

## 15. POST /api/v1/users/uploads/url

- **Description:** Create a presigned avatar upload URL (private bucket).
- **Validator:** `uploadUrlSchema` (`type` enum `AVATAR`; `contentType` non-empty; positive int `contentLength`).
- **Controller/Service:** `upload.controller.ts:10` → `uploadService.createUploadUrl`.
- **Positive**
  - valid avatar request → `200`, `data.uploadUrl`, `objectKey`, `headers`, `media`. **EXECUTED**
- **Negative**
  - unsupported content type (`application/zip`) → `415`. **EXECUTED**
  - file larger than avatar max (5 MB + 1) → `400`. **EXECUTED**
  - empty file → `400 UPLOAD_FILE_EMPTY` (DOCUMENTED-ONLY, `upload.service.ts:58-59`).
  - validation matrix → `400`: missing type, invalid type enum, missing/empty contentType,
    missing/zero/negative/non-numeric contentLength, empty body. **EXECUTED**
- **Security**
  - no token / expired / forged → `401`. **EXECUTED**
  - object key embeds `ownerId` so a presigned URL is scoped to the caller (`createUploadUrl`/`buildObjectKey`).
- **Status codes:** 200, 400, 401, 415.

## 16. GET /health

- **Description:** Service identity / liveness (public, no auth).
- **Positive**
  - `200`, `{ success:true, service:"user-service", environment }`. **EXECUTED** (smoke).
- **Status codes:** 200.

---

## Coverage summary

| Endpoint                       | Method | Executed | Documented-only highlights                                   |
| ------------------------------ | ------ | -------- | ------------------------------------------------------------ |
| /accounts/me                   | GET    | yes      | —                                                            |
| /profiles/me                   | GET    | yes      | cache-hit path                                               |
| /profiles/me                   | PATCH  | yes      | avatar ownership branches, same-handle recasing, max-age DOB |
| /settings/me                   | GET    | yes      | settings-still-incomplete 404                                |
| /settings/me                   | PATCH  | yes      | SELECTED_FRIENDS empty allow-list (gap)                      |
| /friends                       | GET    | yes      | —                                                            |
| / (discovery)                  | GET    | yes      | `all` one-directional block exclusion                        |
| /friends/requests              | POST   | yes      | requester-missing 404, recycle CANCELLED/UNFRIENDED          |
| /friends/requests/:id/accept   | POST   | yes      | non-PENDING 404                                              |
| /friends/requests/:id/reject   | POST   | yes      | not-found / non-uuid                                         |
| /friends/requests/:id (cancel) | DELETE | yes      | not-found / non-PENDING                                      |
| /friends/:userId (unfriend)    | DELETE | yes      | —                                                            |
| /usernames/generate            | POST   | yes      | INVALID_USERNAME_FORMAT, generation-exhausted                |
| /usernames/validate            | POST   | yes      | —                                                            |
| /uploads/url                   | POST   | yes      | empty-file 400                                               |
| /health                        | GET    | yes      | —                                                            |

All 16 HTTP surfaces have at least one EXECUTED assertion. The DOCUMENTED-ONLY column
lists branches that are reachable in code but not yet asserted by a Jest test.

## Uncovered areas (no HTTP test path)

- **gRPC server** (`src/grpc/server.ts`, `friendshipRepository.findAcceptedFriendIdsForUser`)
  — `CheckFriendship` / friend-id validation consumed by community-service; not exercised
  by the HTTP suite.
- **RabbitMQ consumers / handlers** (`src/consumers/*`, `src/handlers/user-created.handler.ts`,
  `user-deleted.handler.ts`) — profile create-on-registration (incl. username-race and
  stale-account-collision retry loop in `user-profile.service.ts:227-316`) and
  soft-delete-on-user-deleted are event-driven, not HTTP-driven.
- **Avatar MinIO branches** (`avatar.service.ts`) — `resolveAvatarObjectKeyForProfile`
  ownership/head/size paths and presigned view-URL generation are mocked away in the
  profile suite; only the null-avatar path is exercised end-to-end.
- **Redis cache layer** (`src/lib/user-cache.ts`, `src/config/redis.ts`) — forced cold in
  tests; warm-cache reads, TTLs, and username-availability caching are not asserted.
- **Notification settings gRPC read** (`userSettingsRepository.findNotificationSettings`)
  — consumed by notifications-service over gRPC; no HTTP route.
