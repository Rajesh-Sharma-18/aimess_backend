# AIMess Backend — Implementation Notes & Review Record

> Living record of what is implemented, key decisions, gotchas, and known gaps.
> Update this whenever you ship or change a feature. Last reviewed: **2026-05-25**.
> Scope of this record: **auth-service**, **user-service** (incl. **friendship / social graph**), **community-service** (create + **member management & moderation** + **user snapshot denormalization**), **chat-service** (private/group/community messaging + scalability hardening).

---

## 0. community-service (MongoDB `community_db` · **Prisma 6** · Redis · MinIO)

New service (port 3003). Verified: boot reaches "listening on 3003" (Mongo+Redis+MinIO connected), live replica-set write smoke passed (no P2031), typecheck/lint green.

- **ORM = Prisma 6.19.x**, NOT Prisma 7 — **Prisma 7 dropped MongoDB support entirely**. community-service pins prisma/@prisma/client `^6.19`; generator `provider="prisma-client-js"`; generated client imported from `src/generated/prisma/index.js`. auth/user stay on Prisma 7 (pnpm isolates per-package). Mongo `createMany` has **no** `skipDuplicates`.
- **Mongo MUST be a replica set** (Prisma wraps `@unique`-model writes in transactions → `P2031` without one). Local `mongodb` container now runs `--replSet rs0 --bind_ip_all`, **no auth** (auth+replSet needs a keyfile, painful on Windows). Connection: `mongodb://localhost:27018/community_db?directConnection=true`. Production = managed Mongo (Atlas) with RS+auth. See aimess-dev-setup.
- **Endpoints** (all bearer-auth, mounted so downstream = `/api/v1/communities/...`): `POST /communities` (create — creator=ADMIN, selected friends → ACTIVE members, sequential writes + `createMany` + compensating cleanup, NO `$transaction`), `PATCH /communities/:id` (edit — **ACTIVE ADMIN only**), `GET /communities/:id` (+ `myRole`, ACTIVE membership only), `GET /communities/mine` (cursor), `GET /communities/categories`, `GET /communities/name-available`, `GET /communities/handle-available` (Redis dual-TTL cache), `POST /communities/images/upload-url` (MinIO presign, mirrors avatars). Routes ordered specific-before-`/:id`. Categories seeded (10) via `db:seed`.
- **Decisions:** Community has `name @unique` + `handle @unique` (the `@Community Name`), `type PUBLIC|PRIVATE`, category ref, avatar/cover. Selected members added directly as ACTIVE. `ForbiddenError` (403) added to `@aimess/errors`.
- **Known gaps:** `memberIds` (create) and `userIds` (add-members) are NOT server-validated as the caller's friends (trusts client selection — TODO before GA). **Member management + moderation now DONE** (see next subsection); **chat / invites / join-requests / reports / livestreams still DEFERRED**. Community events (RabbitMQ) still deferred — member-mgmt emits **nothing** yet. Full HTTP-through-gateway + presigned-upload round-trip not runtime-tested.

### community-service — user snapshot denormalization (shipped 2026-05-22)

`CommunityMember` now stores a user profile snapshot at write time so `GET /:id/members` requires zero cross-service reads.

- **Schema:** three new fields on `CommunityMember` — `snapshotUsername String`, `snapshotDisplayName String`, `snapshotAvatarKey String?` (the raw MinIO object key, stored in DB).
- **Avatar URL:** the member DTO exposes `snapshotAvatarUrl` (presigned GET) + `snapshotAvatarUrlExpiresIn`, NOT the raw key. `toMemberData` is **async** and resolves the URL via `member-avatar.service.ts`, which presigns the key against user-service's avatars bucket (`MINIO_BUCKET_AVATARS=aimess-avatars`, shared MinIO). It presigns **without** a HEAD check — a roster resolves many avatars and per-row HEADs would dominate; the key is validated at upload + kept fresh via events. Mirrors `CommunityData.avatarUrl`/`avatarUrlExpiresIn`.
- **Join-time fetch:** when `addMembers()` or `create()` writes a member row, community-service calls `GET /api/v1/users/internal/bulk-snapshot?userIds=...` on user-service (HTTP, same pattern as user-service → auth-service). On failure, a fallback snapshot (`username=userId, displayName="Unknown"`) is stored so the write always succeeds.
- **Sync on profile update:** user-service publishes `user.profile_updated` (queue `user.profile_updated.queue`, DLX pair) fire-and-forget after `updateProfile` succeeds. Community-service consumes it and runs `updateMany` on all `CommunityMember` rows for that `userId`.
- **Internal endpoint added to user-service:** `GET /api/v1/users/internal/bulk-snapshot` — no auth, internal only. Returns `{ users: [{ userId, username, displayName, avatarObjectKey }] }`.
- **`buildDisplayName` helper:** extracted to `user-service/src/lib/profile-fields.util.ts` — computes `(firstName + " " + lastName).trim()`. Used by both the internal controller and the profile-updated publisher.
- **`softDelete` restored** to `user-profile.repository.ts` (was accidentally missing).
- **RabbitMQ topology:** `user.profile_updated.queue` / DLX `user.profile_updated.queue.dlx` / routing key `user.profile_updated.queue.dead`. Community-service consumer starts at boot with warn-and-continue if RabbitMQ is unavailable.
- **Verification (2026-05-22):** `pnpm --filter @aimess/user-service typecheck` — PASS; `pnpm --filter @aimess/user-service lint` — 0 errors; `npx tsc --noEmit` (community-service) — PASS; `pnpm --filter @aimess/community-service lint` — 0 errors.
- **Before using:** run `pnpm db:push:community` then `pnpm db:seed:community` to reset Mongo with the new schema.

### community-service — member management & moderation (shipped 2026-05-21)

Built on the existing `CommunityMember` model (`role ADMIN|MODERATOR|MEMBER`, `status ACTIVE|PENDING|BANNED|LEFT`) — **no schema change** (the `MODERATOR` enum value already existed, previously unused/unassigned). All bearer-auth, mounted under `/api/v1/communities`. Authz is centralised in **`lib/community-authz.ts`**: `COMMUNITY_ROLE_RANK = { MEMBER:0, MODERATOR:1, ADMIN:2 }` + `assertCommunityRole(membership, minRole)` (throws `ForbiddenError("COMMUNITY_FORBIDDEN")` when membership is missing / not ACTIVE / below rank). The pre-existing `update` (edit community) was refactored to use it. Member rows → API DTO via the `toMemberData` mapper; cursor pagination via `lib/cursor-pagination.ts` `paginateByCursor(rows, limit)`.

- `GET /:id/members?status=&limit=&cursor=` — list members (any **ACTIVE member** may view), cursor on member `id`. Returns `{ members:[{userId,role,status,joinedAt}], nextCursor }`.
- `PUT /:id/members/:userId/role` `{ role: MODERATOR|MEMBER }` — **ADMIN only** promote/demote. Can't target self; can't touch the admin (by `adminId` or role ADMIN); the request enum **excludes ADMIN** (ownership transfer is a separate, unbuilt flow); idempotent on same role.
- `DELETE /:id/members/:userId` — **kick** (MODERATOR+ADMIN). **Strict rank**: caller must outrank target (`RANK[caller] > RANK[target]`), so a mod can't kick a peer mod or the admin. Can't target self/admin; target must be ACTIVE. status → LEFT.
- `POST /:id/members/:userId/ban` — **ban** (**ADMIN only**). Target must exist, not admin/self; idempotent if already BANNED. status → BANNED.
- `POST /:id/members` `{ userIds:[] }` (≤100, deduped) — **add members** (MODERATOR+ADMIN). One read partitions the ids: ACTIVE→skip `ALREADY_MEMBER`, BANNED→skip `BANNED`, LEFT→reactivate (→ACTIVE/MEMBER via `reactivateMembers` updateMany, guarded `status:LEFT`), missing→`createMany` (only truly-missing ids, no unique-constraint risk). Returns `{ added:[...], skipped:[{userId,reason}] }`. **Direct add (no consent)** — mirrors create-time `memberIds` seeding.
- `POST /:id/leave` — **leave** (any ACTIVE member). status → LEFT. The admin is **BLOCKED** (`COMMUNITY_ADMIN_CANNOT_LEAVE`) until ownership-transfer exists.
- `DELETE /:id/members/:userId/ban` — **unban** (**ADMIN only**). Target must be currently BANNED (else `COMMUNITY_MEMBER_NOT_BANNED`). status BANNED → LEFT (NOT auto-re-added — must be re-added or rejoin).

**`memberCount` is always RECOMPUTED** (`countActiveMembers` → `setMemberCount`) after any status change — never a blind ±1 — and there is **NO `$transaction`** (standalone-Mongo rule still applies; sequential single-collection writes). New message keys (vi+en): `COMMUNITY_MEMBERS_FETCHED / MEMBER_ROLE_UPDATED / MEMBER_NOT_FOUND / MEMBER_CANNOT_MODIFY_SELF / MEMBER_CANNOT_MODIFY_ADMIN / MEMBER_KICKED / MEMBER_BANNED / MEMBERS_ADDED / LEFT / MEMBER_UNBANNED / ADMIN_CANNOT_LEAVE / MEMBER_NOT_BANNED`. Gateway OpenAPI paths + component schemas added (`api-gateway/.../paths/community.paths.ts` + `components/schemas.ts`). Shipped via the `docs/` agent pipeline (implementer → reviewer → optimiser → tester → READY); typecheck + lint clean.

### user-service — friends list

- `GET /users/friends?search=&cursor=&limit=` — accepted friends only (both requester/addressee sides), alphabetical (`firstName,lastName,userId`), each item has a `section` letter for the A/B/C "Select Members" UI, presigned avatar. Cursor on `userId`. This is the cursor-based **"Select Members" roster** (`friendsRoutes`) — **distinct** from the `/users` discovery feed in the friendship subsection below. (It now returns real data, since friendships exist.)

### user-service — friendship / social graph (shipped 2026-05-21)

The friend-request feature (previously "not built") is now implemented on the existing Postgres `Friendship` model: **one row per pair** keyed `(requesterId, addresseeId)`, status `PENDING|ACCEPTED|REJECTED|CANCELLED|UNFRIENDED`, per-transition timestamps + `unfriendedBy`, denormalized `UserProfile.friendsCount`. All bearer-auth, mounted under `/api/v1`. `friendship.repository.ts` is the only Prisma layer; `friendship.service.ts` holds the rules; `friendship.controller.ts`/`.routes.ts`/`.validator.ts` are thin.

- `POST /friends/requests` `{ addresseeId }` — send. Pre-flight in order: not self (`FRIEND_CANNOT_ADD_SELF`); both profiles exist; **block check** either direction (`FRIEND_BLOCKED`). Then on the existing pair-row: ACCEPTED → `FRIEND_ALREADY_FRIENDS`; my own PENDING → `FRIEND_REQUEST_ALREADY_SENT`; **their PENDING → AUTO-ACCEPT** (mutual request becomes a friendship, emits `friend.accepted`); a prior REJECTED/CANCELLED/UNFRIENDED row → **recycled** (reset to PENDING with the new direction, timestamps cleared) so re-sending is allowed immediately. No row → create PENDING.
- `POST /friends/requests/:id/accept` — addressee only, PENDING only. → ACCEPTED + `acceptedAt`; **bumps `friendsCount` on BOTH profiles inside `prisma.$transaction`**.
- `POST /friends/requests/:id/reject` — addressee only, PENDING only. → REJECTED.
- `DELETE /friends/requests/:id` — requester cancels their own outgoing PENDING. → CANCELLED.
- `DELETE /friends/:userId` — unfriend an ACCEPTED pair (either side). → UNFRIENDED + `unfriendedBy`; **decrements `friendsCount` on both (transactional)**.
- `GET /users?section=friends|others&q=&page=&limit=` — **user discovery** (`user-discovery.service.ts`). `friends` = my ACCEPTED friends; `others` = everyone else excluding me, my accepted friends, and anyone blocked (either direction). Each row carries `relationshipStatus FRIEND|PENDING_IN|PENDING_OUT|NONE` + `friendshipId`. **page/limit** pagination (NOT cursor — this is the search screen); `q` matches username + firstName + lastName (case-insensitive). The profile-search queries live in `user-profile.repository.ts` (`findUsersInList` / `findUsersNotInList` + count variants).

**Decisions (v1):** the privacy gate (`PrivacySettings.whoCanSendFriendRequests`) is **deliberately skipped** for v1 (TODO before GA). Events `friend.requested` / `friend.accepted` / `friend.unfriended` publish **fire-and-forget** to a new durable **`friendship.queue`** (`messaging/publish-friendship.ts`; payload types in `@aimess/shared-types` `events/friendship.ts`) — but **nothing consumes it yet** (notifications wiring deferred, same pattern as `user.created`; messages currently accumulate unconsumed). **Two routers share the `/friends` mount**: the pre-existing `friendsRoutes` (`GET /friends` roster) and the new `friendshipRoutes` (the request endpoints) — they coexist because their method+path combos are disjoint (Express falls through).

### Shared `@aimess/storage` + generic uploads (cross-service)

- `@aimess/storage` (`packages/storage`) owns ALL MinIO/S3 mechanics: `createStorageClient`, `createPresignedUploadUrl`/`createPresignedViewUrl`, `headObject`, `deleteObject`, `ensureBuckets`, `buildObjectKey`, `assertObjectKeyOwnedBy`, `assertAllowedMime`/`assertFileSize`, and the high-level `createUploadUrl(def,…)`. Package is dependency-light (only `@aws-sdk/*`) — no service env, no `@aimess/*` runtime dep; throws package-local `StorageValidationError`, services translate.
- **One generic endpoint per service:** `POST /users/uploads/url` (type `AVATAR`) and `POST /communities/uploads/url` (type `COMMUNITY_AVATAR`). Body `{ type, contentType, contentLength }` → `{ uploadUrl, objectKey, uploadExpiresIn, maxBytes, headers }`. Per-service upload-type registry in `config/uploads.ts` (type → bucket/keyPrefix/maxBytes/allowedMime). The old per-resource endpoints (`/profiles/me/avatar/upload-url`, `/communities/images/upload-url`) were removed. **Convention: new upload kinds = a new registry entry, NOT a new endpoint.**
- Errors: `@aimess/errors` gained `UnsupportedMediaTypeError` (415); generic message keys `UPLOAD_UNSUPPORTED_CONTENT_TYPE` (415) / `UPLOAD_FILE_TOO_LARGE` / `UPLOAD_FILE_EMPTY` (400). Presigned PUT signs **only** Content-Type (clients PUT with that one header) — keep it that way.
- **Community cover dropped from the create/edit flow** (not in Figma) — the `coverUrl` Prisma field is kept (always null, future community-page banner); responses still include `coverUrl`/`coverUrlExpiresIn`.

### Cross-cutting gotcha — Prisma + MongoDB soft-delete (`deletedAt`)

Prisma omits **unset optional fields** on Mongo, and `where: { deletedAt: null }` does **NOT** match a _missing_ field (only an explicitly-null one). So communities created normally (no `deletedAt` written) were invisible to every `deletedAt: null` query → `GET /communities/:id`, `/mine`, and name/handle availability all silently returned nothing. **Fix/convention for Mongo soft-delete: filter active rows with `deletedAt: { isSet: false }`** (soft-delete sets a Date; never store explicit null — a restore should `unset` the field). Applied in `community.repository.ts` (findById/findByName/findByHandle + the `community` relation filter in listMyMemberships). Use `isSet:false`, not `null`, for any future Mongo soft-deletable model.

### Cross-cutting gotcha — Express 5 `req.query` is immutable per-access

`req.query` is a getter that **re-parses on every access**, so `Object.assign(req.query, parsed)` is silently lost (coerced/defaulted Zod values never reach controllers). All `validate-query` middlewares (auth/user/community) now do `Object.defineProperty(req,"query",{value:parsed.data,...})` instead. (Duplicated in 3 services — consolidating the `validate-*` family into `@aimess/utils` is a noted follow-up.)

---

## 1. Current implementation status

### auth-service (Postgres `aimess_auth` + Redis + RabbitMQ)

Implemented and verified (compiles + lints; **not** runtime/integration-tested):

- **Registration** (`POST /auth/register`) — bcrypt hash (cost 12), creates `AuthUser`, issues tokens, publishes `user.created`.
- **Login** (`POST /auth/login`) — account-or-email identifier, email-verified gate, **account lockout** enforced.
- **Account lockout** — `recordFailedLogin` atomically increments `failedLoginAttempts`; once `AUTH_MAX_FAILED_LOGINS` (default 5) is hit, sets `lockedUntil = now + AUTH_LOCKOUT_MINUTES` (default 15). Login rejects while `lockedUntil` is in the future. `recordSuccessfulLogin` resets both.
- **Sessions / refresh** (`session.service.ts`) — refresh looks up by token **hash**, checks expiry/revocation/account-active, detects **reuse** via `rotatedToId` (revokes all sessions on reuse), rotates the refresh token. `logout` revokes the session. List / revoke-one / revoke-all sessions implemented.
- **Social login** (`/auth/google`, `/auth/apple`) — **Firebase-based.** The mobile client signs in with Google/Apple via the **Firebase Auth SDK** and sends the resulting **Firebase ID token** (field stays `idToken` / `identityToken`). The backend verifies it with **firebase-admin** (`firebaseAuth.verifyIdToken`) in `lib/firebase-id-token.ts`, asserts `firebase.sign_in_provider` matches the endpoint, and extracts the provider sub from `firebase.identities[provider][0]` (falls back to Firebase `uid`). Same verifier powers `social-link.service.ts` (link provider to a logged-in account). **Email is only trusted as verified when present on the Firebase token** — never client-supplied. Auto-merge by email only when `email && emailVerified`; link creation relies on unique constraint + P2002 catch.
  - Firebase Admin init: `config/firebase.ts`, credentials via `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` (same 3-var cert pattern as notifications-service). The old direct-verification path (`google-auth-library`, `jwks-rsa`, `GOOGLE_CLIENT_IDS`/`APPLE_CLIENT_IDS`) was **removed**.
  - **Firebase env is OPTIONAL and init is LAZY** (`getFirebaseAuth()`). The service boots without Firebase configured — only `/auth/google` + `/auth/apple` + social link/unlink error (clear "Firebase is not configured" message) until the 3 vars are set. This prevents the whole auth-service from crashing on boot when creds are absent.
- **QR device linking** (Redis, polling, WhatsApp-style) — new device shows a QR, logged-in device approves:
  - `POST /auth/devices/link/initiate` (no auth) → `{ linkToken, pollSecret, expiresAt }`; QR encodes **only** `linkToken`; `pollSecret` stays private on the new device.
  - `GET /auth/devices/link/status?linkToken=&pollSecret=` (no auth, polled) → `{ state: PENDING|APPROVED|EXPIRED|CONSUMED, approvedDeviceLabel, tokens }`; tokens delivered **exactly once** after approval, then CONSUMED. Bad/missing pollSecret → EXPIRED (no enumeration).
  - `POST /auth/devices/link/approve` (auth) → mints a real device Session+RefreshToken for the new device via `issueAuthTokens` with a **fresh random deviceId** (NOT the approver's — avoids wiping the approver's session). Returns `{ linkedAt, sessionId }` — `sessionId` is the new device's session so the approver can **"undo"** the link (Figma "Auth Successful → UNDO") via `DELETE /auth/sessions/{sessionId}`. (`issueAuthTokens` now returns `{ tokens, sessionId }`.)
  - **Sessions screen (Figma "Linked Device"):** `GET /auth/sessions` (list devices, `isCurrent` flag), `DELETE /auth/sessions/{sessionId}` (terminate one / UNDO a link), `POST /auth/sessions/revoke-all` = **"Sign Out from all Other Devices"** — revokes all sessions EXCEPT the caller's current one (via `revokeOthersForUser`; `revokeAllForUser` is kept for reuse-detection which must kill all).
  - **Boot resilience:** `server.ts` bounds the Redis connect with a 5s timeout race so a hung/misconfigured Redis (e.g. the Windows 6379 native-service conflict — see aimess-dev-setup) can never block `app.listen`; the service starts and Redis-backed features recover once Redis is reachable.
  - Store: `lib/device-link-store.ts`, Redis key `aimess:devlink:{linkToken}`, TTL 120s. Single-use approve + deliver-once consume are **atomic Lua** (`redis.eval`, KEEPTTL). pollSecret stored hashed only.
- **Delete account** (soft) — `DELETE /auth/account` (auth): confirm via `currentPassword` (password accounts) or email `otp` (social-only; request via `POST /auth/account/delete/request-otp`). Order: confirm → `softDeleteUser` (atomic `$transaction`: status=DELETED + deletedAt, revoke all sessions w/ `SessionRevokeReason.ACCOUNT_DELETED` + refresh tokens) → `markSessionsRevoked` → publish `user.deleted`. Migration `20260520120000_account_deleted_revoke_reason` adds the enum value. user-service consumes `user.deleted` (own queue `user.deleted.queue` + DLX, mirrors user.created) → idempotent profile soft-delete + username release. DELETED accounts already rejected at login/refresh. OTP verify-and-consume consolidated into `lib/otp.ts` `verifyAndConsumeOtp` (shared by account-deletion + email-link; password-reset left separate due to different consume semantics).
- **Social link / unlink** (`POST /api/auth/social/google/link`, `/social/apple/link`, `/social/unlink`) — `social-link.service.ts`, all `authenticateAccessToken`-guarded. Link verifies the Firebase ID token (same `verifyFirebaseIdToken`), then `linkProvider` guards: `AUTH_SOCIAL_ALREADY_LINKED` (same user), `AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE` (another user owns it), `AUTH_PROVIDER_ALREADY_LINKED` (user already has that provider). Create is wrapped in **P2002 race handling** mapping to those conflicts. Unlink refuses to remove the **last sign-in method** (`AUTH_LAST_SIGN_IN_METHOD`) via `countSignInMethods` (password + linked providers).
- **OTP** — issuance throttled per identifier via `lib/otp-rate-limit.ts` (`OTP_REQUEST_MAX` / `OTP_REQUEST_WINDOW_SEC`, defaults 5 / 900s). Per-OTP attempt cap via `OTP_MAX_ATTEMPTS`.
- **Password reset, change-email, change-password, email-link, account availability, social-link** — controllers/services/repos present.

### user-service (Postgres `aimess_users` + Redis + RabbitMQ + MinIO)

- **Profile** created via `user.created` RabbitMQ consumer (idempotent + DLQ — see §3).
- **Profile CRUD** (`GET/PATCH /profiles/me`) — username change has a **30-day cooldown** (`USERNAME_CHANGE_COOLDOWN_MS`). Email aggregated from auth-service (cache-first, see §3).
- **Username** (`/username/generate`, `/username/validate`) — **read-only**; they do NOT persist. Username only changes via `PATCH /me`.
- **Avatar** — MinIO presigned PUT, MIME whitelist, post-upload HEAD size re-check, ownership-prefix check. Private bucket, presigned GET on read.
- **Settings** (`GET`/`PATCH /settings/me`) — Figma-aligned, 5 groups, partial update, atomic in one `$transaction`, lazy default-creation:
  - `privacy` — 5 scopes (per-field option sets match each Figma screen) + `callAllowedFriendIds` (≤500).
  - `chat` — `autoDeleteTimer` (`OFF/DAYS_7/DAYS_15/DAYS_30`), `typingIndicators`, `readReceipts`.
  - `app` — `language` (`en/vi/th`), `theme` (`LIGHT/DARK/AUTO`; AUTO="System").
  - `notifications` — 6 toggles (`chat/call/friendRequest/system/community/liveStream`) + `quietHours{enabled,start,end,days[]}` (days 0=Sun..6=Sat, time "HH:mm").
  - `liveStream` — `defaultVideoQuality` (`AUTO/HIGH_1080P/STANDARD_720P/DATA_SAVER_480P`).
  - API `notifications` keys map to DB `*Enabled` columns in the service layer. Models: `PrivacySettings`, `ChatSettings`, `AppSettings`, `NotificationSettings`, `LiveStreamSettings` — all created for new users in `createFromRegistration` and lazily via `ensureDefaultSettings`.
  - Migration `20260520120000_settings_figma_alignment`: added NotificationSettings + LiveStreamSettings + `LiveStreamQuality` enum; changed `AutoDeleteTimer` to day-based; **removed** `dataSaverMode`/`autoplayVideos` + `AutoplayMode` enum (not in design).
  - **Out of scope (by design):** _Data Usage_ screen = read-only network analytics (no settings write — future metrics endpoint). _Block List_ = separate blocks domain (`Block` model), not part of settings PATCH.
- **Connected accounts** — aggregates auth-service linked accounts.

### chat-service (MongoDB `chat_db` · Prisma 6 · Redis · MinIO · Socket.IO · port **3004**)

Owns: private messaging, group messaging, community room messages, notifications, presence/heartbeat, pins, livestream comments, friendships (local cache), group invite links.

ORM = **Prisma 6** (same as community-service — Prisma 7 dropped MongoDB support). MongoDB must be a replica set (same P2031 constraint). Socket.IO is set up in this service with `@socket.io/redis-adapter` for horizontal scaling across multiple pod instances.

#### chat-service — scalability hardening (shipped 2026-05-25)

Three safe, non-breaking improvements applied to handle high concurrent load without touching any existing API behavior:

**1. Redis auto-pipelining (`config/redis.ts`)**

- Added `enableAutoPipelining: true` to `redisConfig`. ioredis automatically coalesces multiple Redis commands issued within the same event-loop tick into a single pipelined request, reducing round-trips for free.
- `createRedisSubClient()` explicitly overrides `enableAutoPipelining: false` — the Socket.IO Redis adapter subscriber client uses `SUBSCRIBE`/`PSUBSCRIBE` commands that must NOT be batched into a pipeline (would silently misbehave). **Always keep this override when `redisConfig` is shared with a sub-client.**

**2. `getDeviceSessions` N\*1 Redis fix (`repositories/cache.repository.ts`)**

- Old: `for...of` loop calling `await this.redis.hgetall(key)` per key = N sequential round-trips per presence lookup.
- New: single `redis.pipeline()` — enqueues all `hgetall` calls, `await pipeline.exec()` once, collects `[err, data]` pairs. Mirrors the identical pattern already in `getUserSnapshots`. Method signature and return type unchanged.

**3. MongoDB text indexes at startup (`server.ts`)**

- `searchByText` on `PrivateMessage` and `GroupMessage` used `findRaw` with a `$regex` on `"content.text"` (a sub-field of a `Json` column) — without an index this causes a **full collection scan** on every search request.
- At boot, after `connectDatabase()`, `prisma.$runCommandRaw` creates three text indexes (idempotent — MongoDB returns `{ ok: 1 }` if already exists):
  - `private_messages` → `{ "content.text": "text" }`, name `private_messages_content_text_idx`
  - `group_messages` → `{ "content.text": "text" }`, name `group_messages_content_text_idx`
  - `general_room_messages` → `{ message: "text" }`, name `general_room_messages_message_idx`
- Each index creation is in its own `try/catch` — failure logs `warn` and startup continues. Server never crashes over a missing index.

**Known remaining scalability gaps (deferred):**

- **In-memory `deletedFor` filtering** (`private-message.repository.ts:86–104`): fetches `limit + 10` rows and filters in Node.js. Moving this filter to the DB requires understanding the exact `deletedFor` semantics (currently `deleteForMe` sets `{ type: "forMe" }` not `{ [userId]: timestamp }` — the in-memory filter may never match in practice; left as-is to avoid breaking behavior).
- **MongoDB sharding**: `private_messages` and `group_messages` have shard keys defined in schema (`roomId + _id`) but sharding requires a MongoDB cluster — infra concern, not a code change. Use MongoDB Atlas for production.
- **chat-service Redis client diverges from `@aimess/redis`**: the service instantiates its own ioredis client instead of using the shared package client. Pre-existing, not introduced by the hardening. Remediate when consolidating shared Redis setup.

#### chat-service — infrastructure scalability (shipped 2026-05-25)

Second wave of scalability work: Redis Cluster support in code + docker-compose, horizontal pod scaling via compose overlay, nginx sticky sessions, and Dockerfile correctness fixes.

**Redis Cluster support (`config/redis.ts`, `config/env.ts`, `repositories/cache.repository.ts`)**

- New env var `REDIS_CLUSTER_NODES` (optional, comma-separated `host:port` list, e.g. `127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003`). When set, a `Cluster` instance is created; when absent, falls back to the existing single-node `Redis` config.
- `createClient(enableAutoPipelining)` factory handles both modes. The subscriber client for the Socket.IO adapter is always created with `enableAutoPipelining: false`.
- `CacheRepository` constructor now accepts `Redis | Cluster`. Device-session keys use a Redis hash tag `{userId}` (e.g. `presence:device:{userId}:deviceId`) so all sessions for one user land on the same cluster slot, making SCAN reliable. In cluster mode `getDeviceSessions` iterates `cluster.nodes('master')` and scans each; in single-node mode the existing cursor-SCAN loop runs as before.
- `isCluster` check uses `(this.redis as { isCluster?: boolean }).isCluster` (set by ioredis Cluster class).

**docker-compose Redis Cluster (`docker-compose.yml`, `docker/redis/cluster-init.sh`)**

- Three `redis-node-1/2/3` services added (ports 7001–7003, bus ports 17001–17003). Each uses `--cluster-announce-hostname host.docker.internal` + `--cluster-announce-port 700x` so MOVED redirects resolve from both inside Docker (via host bridge) and from the host.
- `redis-cluster-init` one-shot container runs `docker/redis/cluster-init.sh`: waits for all 3 nodes, skips if already formed, resolves internal container IPs via `getent hosts`, then calls `redis-cli --cluster create` with `--cluster-replicas 0` (3 primaries, no replicas for dev).
- Existing single `redis` service kept unchanged for auth/user/community services.

**nginx with WebSocket sticky sessions (`docker-compose.yml`, `docker/nginx/nginx.conf`)**

- `nginx` service added (port 80). Routes: `/z-socket/` → `chat_ws` upstream (ip_hash for Socket.IO sticky), `/api/` → `api_gateway` upstream. Both target `host.docker.internal` for local `pnpm dev` use.
- `docker/nginx/nginx.scale.conf` (used by compose overlay) targets chat-service container names directly.

**Multi-pod compose overlay (`docker/compose.scale.yml`, `docker/nginx/nginx.scale.conf`)**

- `docker/compose.scale.yml` adds `chat-service-1/2/3` services built from the monorepo Dockerfile. Environment overrides set `MONGO_HOST=mongodb`, `REDIS_HOST=redis`, `REDIS_CLUSTER_NODES=redis-node-1:6379,...` (container-internal addresses, not host ports). Each pod has a healthcheck (`wget /health`) so nginx waits for `service_healthy` before resolving upstream DNS.
- `nginx.scale.conf` upstream `chat_ws` uses `ip_hash` across the 3 explicit pod `server` entries.
- Command: `docker compose -f docker-compose.yml -f docker/compose.scale.yml up`

**Dockerfile fix (`apps/chat-service/Dockerfile`)**

- Two bugs fixed: (1) `pnpm deploy` excluded `dist/` because root `.gitignore` lists `dist` — fixed by `cp -r apps/chat-service/dist /out/dist` after deploy. (2) Prisma generates its runtime client as `.js` files to `src/generated/prisma/`; `tsc` only compiles `.ts` files and never copies the client to `dist/generated/`; compiled code imports `../generated/prisma/index.js` relative to `dist/` — fixed by `cp -r apps/chat-service/src/generated apps/chat-service/dist/generated` before deploy.

**Idempotency index: sparse → partial (`server.ts`)**

- `sparse: true` only skips documents where the field is **absent**, not where it is explicitly `null`. Existing messages have `clientMessageId: null`, so building a sparse unique index on `(roomId, senderId, clientMessageId)` immediately hit `E11000` duplicate key errors.
- Fixed by replacing `sparse: true` with `partialFilterExpression: { clientMessageId: { $type: "string" } }`. This index only covers documents where `clientMessageId` is an actual string — all `null`/missing rows are invisible to the index. Applies to both `group_messages_idempotency_idx` and `general_room_messages_idempotency_idx`.

**Capacity with these changes:**

| Setup                          | Concurrent users (estimate) |
| ------------------------------ | --------------------------- |
| Before (1 pod, single Redis)   | ~10,000–15,000              |
| After code hardening (round 1) | ~15,000–20,000              |
| 3 pods + Redis Cluster + nginx | ~50,000–100,000             |
| Kubernetes 700+ pods + Atlas   | ~10,000,000                 |

---

#### auth-service — fcmTokens deferred (2026-05-25)

`fcmTokens String[] @default([])` was in the Prisma schema but the column was never added to the DB (migration not run). Because Prisma includes all schema fields in the `RETURNING *` clause of every query, **every** `AuthUser` operation failed — including `recordSuccessfulLogin` which doesn't touch `fcmTokens` at all.

**Changes made:**

- `prisma/schema.prisma`: removed `fcmTokens` field entirely — schema now matches reality.
- `auth.repository.ts`: `mergeFcmTokens` is a no-op (`_userId`, `_tokens` params, returns immediately). `fcmTokens` removed from `createUserWithLinkedAccount` params and data.
- `auth.service.ts`: removed `fcmTokens: input.fcmTokens` from `createUser` data.
- `social-auth.service.ts`: removed `fcmTokens` from `createUserWithLinkedAccount` call.
- `auth.validator.ts` + `social-auth.validator.ts`: `fcmTokens` made **optional** (`.optional().default([])`) so existing frontend clients that don't send it don't break, and future clients that do send it also won't break.
- Prisma client regenerated (`pnpm --filter auth-service db:generate`).

**To re-enable FCM when frontend ships it:**

1. Add `fcmTokens String[] @default([])` back to `prisma/schema.prisma`.
2. Run `pnpm --filter auth-service db:migrate:dev --name add_fcm_tokens`.
3. Un-no-op `mergeFcmTokens` in the repository.
4. Add `fcmTokens: params.fcmTokens ?? []` back to `createUserWithLinkedAccount`.

### api-gateway (port **8000**)

- Single global rate limiter (100/min/IP, in-memory) applied app-wide.
- **Stricter per-route limiter** `sensitiveAuthRateLimiter` (20 / 15 min / IP) on `/auth/login`, `/auth/forgot-password/*`, `/auth/google`, `/auth/apple`.
- Generic per-service proxy by URL segment (`auth`, `users`, …) via `versioning/registry.ts`.

---

## 2. Fixes applied during the 2026-05-20 review

| Area                        | Fix                                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth typecheck (was broken) | `session-api-messages.ts` was empty but imported by `session.controller.ts`. Message keys already exist in `@aimess/constants`, so the controller now uses `t()` directly and the dead file was deleted. |
| gateway                     | Added `sensitiveAuthRateLimiter` for sensitive auth endpoints (defense-in-depth over account lockout).                                                                                                   |
| docs                        | `aimess-architecture` skill catalogue: api-gateway port `3000 → 8000` (matches CLAUDE.md + env).                                                                                                         |
| eslint                      | Added `varsIgnorePattern: "^_"` + `ignoreRestSiblings` to mirror existing `argsIgnorePattern` (cleared blocking error on intentional `_ignored` rest-omit).                                              |
| user-service                | Hardened `user.created` consumer (DLQ, parse-in-try, idempotency), username race retry, cache-first auth lookup, removed dead `example.*` scaffold. (Most done in-flight; verified.)                     |

---

## 3. Key decisions & conventions (so future work stays consistent)

- **Session revocation model:** this codebase uses **session-based** revocation (Redis `session-active-cache` + DB `revokedAt`/`SessionRevokeReason`), NOT the jti-blacklist described in the architecture skill's "Auth quick reference". Logout/revoke mark the session revoked; the auth middleware checks session-active state. Keep this model unless deliberately migrating to jti.
- **RabbitMQ DLQ (user.created):** uses a **simple dedicated pair** — exchange `user.queue.dlx` (direct, durable), queue `user.queue.dlq`, routing key `user.queue.dead`; main `user.queue` declared with `deadLetterExchange`/`deadLetterRoutingKey`. **Publisher (auth-service) and consumer (user-service) MUST declare identical queue args** — RabbitMQ queue args are immutable, mismatch → `PRECONDITION_FAILED`. This is NOT yet the full `aimess.events` topic + `aimess.retry` TTL-backoff mesh from the architecture spec (known gap — see §4).
- **user-service → auth-service** uses **HTTP** (`AUTH_SERVICE_URL` + `fetch`), not gRPC, for profile/email aggregation. This is the one sanctioned internal HTTP hop. `resolve-auth-account.ts` is **cache-first** (Redis `account:summary`) then HTTP on miss, with on-failure cache fallback.
- **Username:** DB `@unique` is the source of truth. Generation/claim handles P2002 by retrying with the next suffix (bounded). A P2002 on `userId` during profile create = idempotent success (concurrent event).
- **OTP/email delivery:** still a **dev stub** — OTPs are logged, not emailed. Real delivery waits on notifications-service wiring. `OTP_DEV_FIXED_CODE` can pin a code in dev.
- **Rate limiting:** in-memory stores (per process). Move to a Redis store (`rate-limit-redis`) before horizontal scaling.
- **Layering is clean** in both services: controllers thin, repositories own all Prisma, services hold logic, multi-write ops use `$transaction`. Keep it that way.
- **Community authz primitive:** ALL community member-management/moderation goes through `assertCommunityRole(membership, minRole)` + the `COMMUNITY_ROLE_RANK` map (`community-service/src/lib/community-authz.ts`). Never re-implement role/status checks inline. Future moderator powers (join-request approve, etc.) MUST reuse this gate. Role hierarchy: ADMIN > MODERATOR > MEMBER; the admin role is immutable via the member endpoints (can't be demoted/kicked/banned, and the admin can't leave) until a separate ownership-transfer flow exists.
- **`memberCount` is recomputed, not deltaed:** every community membership status change recomputes via `countActiveMembers` → `setMemberCount`. Robust against drift and safe without a transaction. Do NOT switch to blind ±1.
- **`$transaction` is per-store:** Postgres services (auth, user) DO use `prisma.$transaction` for multi-row writes — e.g. friendship accept/unfriend bumping `friendsCount`. **community-service (standalone Mongo) does NOT** — Prisma interactive transactions fail there, so it uses sequential writes + recompute / compensating cleanup.
- **Friendship = one row per pair, recycled:** re-sending after reject/cancel/unfriend updates the existing `Friendship` row (resets status + direction + clears timestamps) rather than inserting a new one; a mutual pending request auto-accepts. Friendship/discovery queries respect two-way blocks.

---

## 4. Known gaps / TODOs (not yet done)

- [ ] **No runtime/integration tests run** — everything above is verified by typecheck + lint + code reading only. APIs not yet smoke-tested end-to-end.
- [ ] **No automated test suite** exists for these services.
- [ ] **OTP/email delivery** not wired (dev stub only).
- [ ] **DLQ topology** is the simple per-queue pair, not the spec's `aimess.events` topic + `aimess.retry` (1s→2s→4s TTL) + `aimess.dlq` retry mesh.
- [ ] **gRPC** path (`packages/grpc-contracts`) exists but is unused; auth aggregation is HTTP. Migrate when ready.
- [ ] **Rate-limit Redis store** for multi-replica gateways.
- [ ] **Not deeply reviewed/tested:** `account.controller.ts`, `settings.controller.ts`, `connected-accounts.service.ts`, full avatar/MinIO round-trip, gateway `app-version` routes.
- [ ] **Session revocation** intentionally diverges from the skill's jti-blacklist note — reconcile the doc or the design.
- [ ] **Build output collision (infra):** all apps' `tsconfig` resolve `outDir` to the repo-root `dist/` (from `tsconfig.base.json`), so `auth/user/gateway` builds overwrite each other — a per-service `pnpm start` against `apps/<svc>/dist/index.js` would fail. Fix: per-app `outDir`/`rootDir`. (Found by Quality Tester 2026-05-20; pre-existing.)
- [ ] **No circuit breakers (opossum):** architecture mandates opossum on outbound cross-service calls, but it isn't used anywhere (e.g. `user-service/src/lib/auth-client.ts` HTTP hop has a timeout + cache fallback but no breaker).
- [ ] **`resolve-auth-account` cache staleness:** the cache-first read serves a recent Redis copy even when auth-service is healthy, so connected-accounts/email can be stale up to the TTL right after a link/unlink or email change. Decide: invalidate on change (event from auth-service) vs live-first for the connected-accounts path vs accept the TTL window.
- [ ] **`extractBearerToken`** (user-service `lib/`) is a generic helper that should live in `@aimess/utils`/`@aimess/auth-jwt` to avoid re-copying per service.
- [ ] **Friendship events have NO consumer.** `friendship.queue` (`friend.requested/accepted/unfriended`) is published but unconsumed. notifications-service wiring is the natural next step.
- [x] **Community member user snapshots** — shipped 2026-05-22 (see §0 subsection below).
- [ ] **Friend-request privacy gate skipped (v1):** `PrivacySettings.whoCanSendFriendRequests` is not enforced on `POST /friends/requests`. Add before GA.
- [ ] **Community member input not validated as friends:** create `memberIds` and add-members `userIds` trust the client (no friendship/consent check).
- [ ] **Community features still unbuilt:** join-requests, invites, ownership transfer, soft-delete endpoint, discovery/search, cover image, reports. The `CommunityJoinRequest` / `CommunityInvite` / `CommunityReport` models exist as `/// FUTURE` (defined but unwired — no repo/service/routes). Join-requests need a "request to join" flow first (today members are only added at create time or directly by admin/mod — there is no join/invite path).

---

## 5. Verification status (2026-05-20)

- `pnpm --filter @aimess/auth-service typecheck` — **PASS**
- `pnpm --filter @aimess/user-service typecheck` — **PASS**
- `pnpm --filter @aimess/api-gateway typecheck` — **PASS**
- `lint` (auth, user, gateway) — **0 errors** (2 warnings each = intentional `console.error` in env validation)
- `prisma migrate status` (user-service) — **up to date**; `username` column present.
- Runtime / integration — **NOT done.**

---

## 6. Verification status (2026-05-21 — friendship + community member management)

- `pnpm --filter @aimess/shared-types build` / `@aimess/constants build` — **PASS**.
- `pnpm --filter @aimess/user-service typecheck` — **PASS** (friendship + user discovery).
- community-service `npx tsc --noEmit` — **PASS** (member mgmt / moderation / lifecycle). Run **directly**, not via the `typecheck` script: the running `pnpm dev` holds a Windows file lock on the `prisma generate` engine DLL → the script's pre-`generate` step throws `EPERM`. `tsc` against the already-generated client is the workaround.
- `pnpm --filter @aimess/api-gateway typecheck` — **PASS** (OpenAPI path additions).
- `lint` (user, community, constants) — **0 errors** (only the pre-existing `no-console` warnings in each `config/env.ts`).
- Runtime / integration — **NOT done** (no test runner in repo; verified by typecheck + lint + multi-agent review/tester code-reading).
- **Infra incident (resolved):** a stale RabbitMQ `user.queue` (declared before the dead-letter topology was added) caused boot-time `406 PRECONDITION_FAILED — inequivalent arg 'x-dead-letter-exchange'`, which crashed auth- and user-service on the first publish (cascading to `ECONNREFUSED` on 3001). **RabbitMQ queue args are immutable** — fixed by `rabbitmqctl delete_queue user.queue` so it's recreated with the DLX args. **Prod implication:** deploying a queue-arg change to an env that already has the old queue needs a drain+recreate (or a versioned queue name) — see the DLQ note in §3.

---

## 7. Verification status (2026-05-25 — chat-service scalability hardening)

- `npx tsc --noEmit` (chat-service) — **PASS** (zero type errors after all three fixes)
- ESLint (`config/redis.ts`, `repositories/cache.repository.ts`, `server.ts`) — **0 errors, 0 warnings**
- DRY review — **PASS** (one blocking issue caught and fixed: `createRedisSubClient` must not inherit `enableAutoPipelining:true`; corrected before merge)
- Runtime / integration — **NOT done** (no test runner; verified by typecheck + lint + multi-agent review)

---

### Postman

A ready-to-import collection + environment live at `postman/` (`aimess-friends.postman_collection.json`, `aimess-local.postman_environment.json`): auth (register/login/refresh, two users), the friend-request lifecycle, and user discovery — with test scripts that auto-capture tokens, `userId` (decoded from the JWT `sub`), and `friendshipId`. Defaults hit services directly (auth `:3001/api/auth`, user `:3002/api/v1`); switch the two base-URL env vars to the gateway to route through `:3000`.
