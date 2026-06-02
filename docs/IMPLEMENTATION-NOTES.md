# AIMess Backend — Implementation Notes & Review Record

> Living record of what is implemented, key decisions, gotchas, and known gaps.
> Update this whenever you ship or change a feature. Last reviewed: **2026-06-02**.
> Scope of this record: **auth-service**, **user-service** (incl. **friendship / social graph** + **internal friendship-check**), **community-service** (create + **member management & moderation** + **user snapshot denormalization** + **v1 lifecycle: self-join / transfer-admin / auto-handover / delete** + **gated communities: join-requests + invites** + **trust & safety: reports + friend validation** + **user preferences: mute + leave reason + invite links** + **12 RabbitMQ event publishers**).
> Scope of this record: **auth-service**, **user-service** (incl. **friendship / social graph**), **community-service** (create + **member management & moderation** + **user snapshot denormalization**), **chat-service** (private/group/community messaging + scalability hardening + **per-room sequence numbers & reconnect catch-up**).

---

## 0. community-service (MongoDB `community_db` · **Prisma 6** · Redis · MinIO · RabbitMQ)

New service (port 3003). Verified: boot reaches "listening on 3003" (Mongo+Redis+MinIO connected), live replica-set write smoke passed (no P2031), typecheck/lint green.

### community-service — v1 lifecycle + gated + safety + preferences + events (shipped 2026-05-25)

Five batches landed end-to-end this session, all through the multi-agent pipeline (PM → Pro Coder → DRY + Contract + QA in parallel). All green; nits filed inline. **Standing rule unchanged: no `prisma.$transaction` anywhere (standalone Mongo); sequential writes + `countActiveMembers` → `setMemberCount` recompute after every membership status change.**

- **v1 lifecycle gaps** — `POST /:id/join` (self-join PUBLIC; idempotent ACTIVE, reactivate LEFT, reject BANNED, reject PRIVATE with `COMMUNITY_JOIN_REQUIRES_INVITE`); `POST /:id/transfer-admin` (explicit, demotes caller to MEMBER); `DELETE /:id` (admin soft-delete + bulk-LEFT members + cache invalidate, Telegram/Discord-style — works even with other ACTIVE members); extended `leaveCommunity` admin branch to **oldest MOD → oldest MEMBER → soft-delete community** (replaces the old `COMMUNITY_ADMIN_CANNOT_LEAVE` throw). The promote-and-demote sequence is extracted into a module-private `handoverAdminTo` helper. New audit actions: `COMMUNITY_JOINED`, `COMMUNITY_DELETED`.
- **Gated communities — join-requests + invites** — `CommunityJoinRequest` + `CommunityInvite` models unhid (4 `/// FUTURE` markers stripped; reports stayed gated until the next batch). 11 endpoints across the two flows (create / list-for-community / list-mine / approve / reject / cancel-own; create / list / list-mine / accept / decline). **Mutual-want auto-merge**: on join-request create, if a PENDING invite exists for the caller, short-circuit to the accept-invite path (write member, mark invite ACCEPTED, skip the new request); symmetric on invite create. **Recycle pattern** for ACCEPTED/DECLINED/EXPIRED rows (the `@@unique([communityId, ...])` constraint forces row reuse). No snapshot denormalization on request/invite rows; `fetchUserSnapshots` runs at list time. New audit actions: `JOIN_REQUEST_APPROVED`, `JOIN_REQUEST_REJECTED`, `MEMBER_INVITED`, `INVITE_ACCEPTED`, `INVITE_DECLINED`.
- **Trust & safety — reports + friend validation** — `CommunityReport` model unhid + extended (`reviewedBy`, `reviewedAt`, `resolution`, new `WITHDRAWN` enum value, `@@index([reporterId, status])`). 7 endpoints: create (caller must be ACTIVE member; can target community itself with `targetUserId: null` or a specific member; service-level dedup on (reporter, community, target) — `findOpenReportByReporterAndTarget` passes `targetUserId` explicitly because Mongo unique-with-null is tricky), list-for-community (mod/admin), list-mine, review/action/dismiss (mod/admin transitions with `_resolveReport` enforcing OPEN → {REVIEWED, ACTIONED, DISMISSED, WITHDRAWN}, REVIEWED → {ACTIONED, DISMISSED}, others terminal), withdraw (reporter-only on OPEN). New audit actions: `COMMUNITY_REPORT_REVIEWED`, `COMMUNITY_REPORT_ACTIONED`, `COMMUNITY_REPORT_DISMISSED`. **Friend validation** on `addMembers` + `create`: new user-service internal endpoint `GET /api/v1/users/internal/friendship-check?callerId=&candidateIds=` (mirrors `/internal/bulk-snapshot` pattern, no auth, ≤500 cap), repo `findAcceptedFriendIdsForUser` (both directions), community-service `fetchAcceptedFriendIds(callerId, candidateIds): Promise<Set<string>>` with **empty-set fallback on user-service failure** (conservative — every candidate is skipped as NOT_FRIEND rather than over-permissively added). `addMembers` partitions NOT_FRIEND **before** existing-row classification; `create` silently filters `memberIds` to friends (no error). Extended `AddMemberSkipReason` union.
- **User preferences** — `CommunityMuteSetting { userId, communityId, mutedUntil DateTime?, @@unique([userId, communityId]) }` (null = indefinite, future Date = until-when, row absent = not muted; lazy expiration, no janitor); 3 endpoints (`GET/PUT/DELETE /:id/mute`); `CommunityData` DTO now exposes `myIsMuted: boolean` + `myMuteUntil: string | null` (only `getById` reads the row — other call sites pass null). Any ACTIVE member can mute themselves (no role gate). **Leave reason** — extended `POST /:id/leave` with optional `{ reason?: enum, reasonText? }` body; `reasonText` required when `reason === "OTHER"`; new `MEMBER_LEFT` audit recorded in all three branches (non-admin, admin handover, admin auto-delete) **before** the existing audits so the timeline reads correctly. **Invitation links** — `CommunityInviteLink { code @unique, maxUses?, usedCount, expiresAt?, revokedAt? }` (separate concept from 1:1 invites — share-codes that anyone with the link can redeem); 4 endpoints (POST/GET on `/:id/invite-links`, DELETE on `/:id/invite-links/:linkId`, **static `POST /invite-links/:code/redeem` registered before `/:id` capture**); code via `randomBytes(6).toString('base64url')` with P2002 retry-3x; **atomic capacity-guarded increment** via optimistic concurrency (load → check → `updateMany` filtered by observed `usedCount`, retry up to 3x — no `$transaction`); idempotent for already-ACTIVE callers (does NOT consume usage); LEFT/PENDING reactivate, missing create. **New HTTP 410 `GoneError`** added to `@aimess/errors` for revoked/expired/exhausted links.
- **RabbitMQ events — emit-only (no consumer this batch)** — new `packages/shared-types/src/events/community.ts` with `CommunityEvents` const + 12 strongly-typed payloads, all carrying `communityId` + `eventAt: ISO`. New `apps/community-service/src/messaging/publish-community.ts` mirrors `publish-friendship.ts` exactly (module-scope lazy `channelPromise`, `assertQueue("community.queue", { durable: true })`, `publishSafe` swallows errors, 12 typed `publish*Safe` exports). 19 call sites wired into `community.service.ts` — every one placed **after recompute + audit, before return**, with idempotent paths suppressed (e.g. already-ACTIVE join doesn't emit, same-role updateMemberRole doesn't emit, review/dismiss/withdraw on reports don't emit, dedup'd PENDING return on join-request/invite doesn't emit). Mutual-want auto-merge paths emit ONLY the resulting `MEMBER_ADDED` (with `via: "join_request_auto_accept" | "invite_auto_approve"`), not also the request/invite event. `acceptInvite` emits `INVITE_ACCEPTED` only (not also `MEMBER_ADDED` — different semantic for downstream notifications). Messages durably queue in `community.queue` until a consumer is added. **No env changes** — `RABBITMQ_URL` already validated.
- **Known gap**: no notifications-service consumer for `community.queue` yet — events accumulate. Building that consumer (plus the existing FCM `sendPush` path) closes the end-to-end loop with the auth-service `fcmTokens` capture. **Engagement tracking** (join rates / activity metrics) and **chat / livestreams** remain out of scope. The `COMMUNITY_ADMIN_CANNOT_LEAVE` message key is now dead (no longer thrown anywhere) — safe to remove. Several small nits filed by reviewers but landed as-is: `approveJoinRequest` idempotent-on-APPROVED is gentler than the spec's 400; `listMyReports` deliberately skips snapshot fetch; `listInviteLinks?status=active` doesn't server-filter exhausted (DTO's `isActive: false` covers it); 3-line role-swap triple duplicated between `transferAdmin` and `handoverAdminTo`. Windows `prisma generate` EPERM during dev (DLL lock from running dev server) is a recurring DX papercut — workaround is `taskkill /F /IM node.exe` then re-run.

---

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

### auth-service + notifications-service — FCM push tokens (shipped 2026-05-25)

Per-device FCM registration tokens are now captured on **every auth entry point** and the notifications-service Firebase Admin SDK is verified delivering pushes end-to-end (web client → token → backend → FCM → device).

- **Storage:** `auth_users.fcmTokens TEXT[]` (Postgres), migration `20260522095552_add_fcm_tokens`. Flat string array; no per-device metadata yet.
- **Capture endpoints (all optional, but if present must be a non-empty array of non-empty strings via `fcmTokensSchema`):** `POST /auth/register`, `/auth/login`, `/auth/google`, `/auth/apple`. Register stores as-is; login/social merge via `authRepository.mergeFcmTokens` (set-union dedupe).
- **Delivery infra:** notifications-service has Firebase Admin wired (`providers/firebase/firebase.ts` + `sendPush.ts`); creds in `.env` (`FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` — same 3-var pattern as auth-service).
- **Verified end-to-end on 2026-05-25** via a throwaway test harness (`tools/fcm-test/`) + temporary `POST /test/send-push` route. Both removed; the harness and route are NOT to be re-added.
- **Important gap:** **nothing in the product actually fires a push yet.** `handleUserRegistered` in `consumers/notification.consumer.ts` is still **commented out**, and no event type beyond `USER_REGISTERED` / `MESSAGE_RECEIVED` (enum only) has a handler. Capture works; trigger-on-event does not.
- **Token lifecycle gaps:** logout does NOT remove the token from the array; stale tokens (`messaging/registration-token-not-registered`) are NOT pruned; no per-device record (label, lastSeenAt) — future feature.
- **Google OAuth audience:** `verifyGoogleIdToken` uses `GOOGLE_OAUTH_CLIENT_ID` from `.env`. **Must match the OAuth client ID the mobile app uses** to issue tokens — mismatches surface as `AUTH_SOCIAL_TOKEN_INVALID`. Web testing additionally needs that client's "Authorized JavaScript origins" to list the test page origin.

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

#### chat-service — calling, forward messages, reaction users, retry idempotency + WebRTC config (shipped 2026-05-28)

Five features shipped end-to-end through the multi-agent pipeline. All green (typecheck PASS on chat-service + api-gateway).

**1. Forward Messages (private + group)**

- `PrivateMessage` + `GroupMessage` gained `isForwarded Boolean @default(false)` and `forwardData Json?`. Shape: `{ originalMessageId, originalRoomId, originalSenderId, originalCreatedAt, originalContentType }`.
- `privateMessageService.forwardMessage()` + `groupMessageService.forwardMessage()` check friendship/membership, then guard idempotency via 3-arg `findByClientMessageId(roomId, senderId, clientMessageId)` before creating.
- HTTP: `POST /private/rooms/:roomId/messages/:messageId/forward` + `POST /groups/:roomId/messages/:messageId/forward`. gRPC: `ForwardMessage` RPC in `MessagingService`. Socket.IO: `message:forward` event on `/chat` namespace; gateway publishes `message:new` to Redis `conv:<targetRoomId>` on success.
- **Constants:** `CHAT_MESSAGE_FORWARDED` + `CHAT_REACTIONS_FETCHED` added to `packages/constants/src/messages/chat.messages.ts` and package rebuilt.

**2. View Reaction Users**

- Reactions stored as `Json` on messages: `Record<emoji, Array<{userId, userName, avatar, memberId}>>`.
- New `getMessageReactions()` on both private + group services — fetches reactions Json, collects unique `userId`s, enriches via `userSnapshotService.getUserSnapshots()`, groups by emoji with `count`, `users[]`, `selfReacted` flag.
- HTTP: `GET /private/rooms/:roomId/messages/:messageId/reactions` + `GET /groups/:roomId/messages/:messageId/reactions`. gRPC: `GetMessageReactions` RPC (routes to private or group service based on `conversationType`). Socket.IO: `message:reactions:get` event.

**3. Retry Failed Messages — clientMessageId Idempotency**

- `PrivateMessage` model gained `clientMessageId String?` + `@@index([clientMessageId])`. (GroupMessage already had it.)
- Sparse-but-partial unique index created at startup: `partialFilterExpression: { clientMessageId: { $type: "string" } }` — covers only actual strings, not null/missing rows (avoids E11000 on existing messages without a clientMessageId).
- `privateMessageService.sendMessage()` now accepts `clientMessageId?`; calls `findByClientMessageId(roomId, senderId, clientMessageId)` BEFORE create — returns existing message if found.
- gRPC `sendMessage` handler passes `clientMessageId` from request; detects idempotency hit (msg.createdAt > 5s ago → `alreadySent: true` in response). New `bool already_sent = 4` field added to proto `SendMessageResponse`.

**4. Audio/Video Calling (signaling + history)**

- New `Call` Prisma model in `apps/chat-service/prisma/schema.prisma`: fields `callId @unique`, `callerId`, `calleeId`, `type` (AUDIO/VIDEO enum), `status` (RINGING/IN_PROGRESS/ENDED/MISSED/DECLINED/FAILED enum), `privateRoomId?`, `initiatedAt`, `answeredAt?`, `endedAt?`, `durationSec?`, `endedBy?`. Indexes on `(callerId, initiatedAt desc)`, `(calleeId, initiatedAt desc)`, `status`.
- `CallRepository` (`repositories/call.repository.ts`): `create`, `findByCallId`, `updateStatus`, `findByParticipant` (cursor-based).
- `CallService` (`services/call.service.ts`) — full lifecycle: `initiateCall` checks `PrivateRoom.blockedBy`, creates Call RINGING, publishes to Redis `user:<calleeId>`; `answerCall` guards status=RINGING → IN_PROGRESS; `declineCall` guards RINGING → DECLINED; `endCall` accepts from either participant when RINGING|IN_PROGRESS, calculates `durationSec` from `answeredAt` → ENDED; `getCallHistory` cursor-based by `initiatedAt`.
- `CallController` + `call.routes.ts`: `GET /calls` (history), `GET /calls/:callId`. gRPC: 5 new RPCs — `InitiateCall`, `AnswerCall`, `DeclineCall`, `EndCall`, `GetCallHistory`. Socket.IO `/chat`: 5 new events — `call:initiate`, `call:answer`, `call:decline`, `call:end`, `call:ice` (ICE relay only: publishes to Redis `call:<callId>`, no DB write). New `CallStatus` + `CallType` enums in `src/types/enums.ts`.

**5. WebRTC Configuration**

- 8 new env vars in `chat-service/src/config/env.ts`: `WEBRTC_STUN_SERVERS` (default: Google STUN), `WEBRTC_TURN_SERVER`, `WEBRTC_TURN_USERNAME`, `WEBRTC_TURN_PASSWORD`, `WEBRTC_TURN_CREDENTIAL_EXPIRES_IN_HOURS`, `WEBRTC_ICE_CANDIDATE_POOL_SIZE` (default 10), `WEBRTC_RTC_CODEC_PREFERENCES` (default "opus,h264"), `WEBRTC_CALL_TIMEOUT_SEC` (default 120).
- `WebRtcConfigService` (`services/webrtc-config.service.ts`): `buildIceServers()` (STUN always; TURN if all 3 vars set, warns if URL without credentials), `getRtcConfiguration()`, `getCodecPreferences()`.
- gRPC: `GetRtcConfig` RPC — returns `RtcConfiguration { iceServers[], iceCandidatePoolSize, iceTransportPolicy }`. `initiateCall` gRPC handler includes `rtcConfig` in response.
- api-gateway: `GET /api/v1/webrtc/rtc-config` HTTP endpoint (returns 503 on circuit-breaker open).
- Socket.IO: `call:initiate` callback includes `rtcConfig` field.
- Constants: `packages/constants/src/webrtc.ts` — `WEBRTC_CODECS`, `WEBRTC_CALL_CONSTRAINTS`, `WEBRTC_TIMEOUTS`.

**Bug fixes (same session)**

- **`markMessagesRead` gRPC routing:** handler always called `privateMessageService.markRead()` regardless of `conversationType`. Fixed to route to `groupMemberService.markRead()` for GROUP.
- **`alreadySent` in gRPC sendMessage:** proto `SendMessageResponse` had `bool already_sent = 4` but handler never set it. Fixed.
- **Group forward idempotency:** was calling `findByClientMessageId(roomId, clientMessageId)` with 2 args (missing `senderId`), risking false matches across senders. Fixed to 3 args.

#### chat-service — per-room sequence numbers + reconnect catch-up (shipped 2026-06-02)

Shipped end-to-end through the multi-agent pipeline (PM → Pro Coder → DRY + Contract + QA in parallel). Both apps typecheck + lint green. Adds the message-ordering guarantee and reconnect gap-fill from the chat system design doc.

**1. Per-room monotonic `sequenceNumber`**

- **Schema (`prisma/schema.prisma`):** `lastSequence Int @default(0)` counter on `PrivateRoom` + `GroupRoom`; `sequenceNumber Int @default(0)` on `PrivateMessage` + `GroupMessage`, each with new `@@index([roomId, sequenceNumber])`. **Community (`GeneralRoomMessage`) deliberately DEFERRED** — different model/channel; follow-up if community catch-up is needed.
- **Atomic allocation:** `allocateSequence(roomId)` on `private-room.repository.ts` + `group-room.repository.ts` does a single Prisma `update({ data: { lastSequence: { increment: 1 } }, select })` → Mongo `$inc`, **document-atomic, race-safe** (no read-modify-write). Concurrent sends to one room get distinct, contiguous, increasing values. **No `$transaction`** (standalone-Mongo rule holds).
- **Ordering vs idempotency:** allocation happens **after** the `clientMessageId` idempotency pre-check and **immediately before** insert, in both `sendMessage` and `forwardMessage` (private + group). A retried `clientMessageId` returns the existing message with its **original** seq and never burns a new one. The group `sendMessage` P2002 race path discards the one allocated seq (an acceptable gap — the only way a gap occurs).
- **Wire:** `sequenceNumber` now flows on `message:new` / `message:edited` (and the forward path) over both the Redis broadcast (as a JS number) and the gRPC ack. `proto-loader` uses `longs: String`, so int64 `sequence_number` arrives as a **string** at the gateway — the messaging client now `Number()`-coerces it on `sendMessage`/`editMessage`/`forwardMessage`/`getConversationMessages` results so the declared `number` type holds.

**2. `chat:catchup` reconnect gap-fill**

- **Repo:** `findAfterSeq(roomId, sinceSeq, limit)` on both message repos — `sequenceNumber > sinceSeq`, ascending, `take: limit + 1` (the +1 is the `hasMore` probe, sliced off). **Tombstones included** (no `isDeleted` filter) so a client reconciles deletes/edits it missed while offline.
- **Service:** `catchup({ roomId, userId, sinceSeq, limit })` on both message services returns `{ authorized, events, hasMore, lastSeq }`. **Auth runs before any data read** — participant check (private, via room) / active-membership check (group, via `findActiveByRoomAndUser`); a non-member gets `{ authorized: false, events: [] }`.
- **gRPC:** new `CatchupRoom` RPC + `CatchupRoomRequest`/`CatchupEventDto`/`CatchupRoomResponse` in `packages/grpc-contracts/proto/messaging.proto`; handler in `grpc/server.ts` dispatches on `conversationType`, clamps `limit` 1–200, maps tombstone fields. `sequence_number` fields also added to `SendMessageResponse`/`MessageDto`/`EditMessageResponse`/`ForwardMessageResponse`.
- **Gateway socket (`api-gateway/.../sockets/namespaces/chat.ns.ts`):** new `chat:catchup` handler — Zod-validated (`rooms[]`, max 50, per-room `limit` ≤ 200 default 100), fans out one gRPC call per room via `Promise.allSettled` through an opossum breaker (standard 2000/50/10000/5), emits one `chat:catchup:result { roomId, events[], hasMore, lastSeq }` per room (all int64 `Number()`-coerced) plus an aggregate ack. **Client paginates by re-sending `sinceSeq = lastSeq` until `hasMore === false`** — `lastSeq` IS the cursor.
- **Dialect decision:** new events ride the existing `conv:*`/`message:*` dialect (ObjectId ids), NOT the alternate `chat:*` rename sketched in `docs/chat-socket-backend-spec.md`.

**Docs updated:** `docs/SOCKET_EVENTS.md` (new `chat:catchup`/`chat:catchup:result` events + `sequenceNumber` on `message:new`/`message:edited`); gateway OpenAPI `ChatMessage` schema gained `sequenceNumber`.

**Rollout (manual, DB-side — not run yet):** `pnpm --filter @aimess/chat-service db:generate && db:push` (Mongo connector adds fields/indexes), then `pnpm --filter @aimess/chat-service backfill:seq` once (script `scripts/backfill-sequence-numbers.ts` assigns 1..N per room by `createdAt`, sets `lastSequence` — idempotent/resumable). **Catch-up only covers backfilled rooms**; un-backfilled rooms degrade to createdAt-based history. `db:push` couldn't run in-session (Windows Prisma engine DLL locked by the dev watcher — the recurring EPERM papercut).

**Known follow-ups:** community/`GeneralRoomMessage` seq deferred; `read`/`delivered` payloads keep `upToMessageId` (no single seq added); no automated runtime test (gate was typecheck + lint + static trace — no test framework installed in chat-service).

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
- **Timestamps are `timestamptz` (UTC) (shipped 2026-06-02):** every Postgres `DateTime` field in auth-service + user-service is mapped `@db.Timestamptz(3)` (TIMESTAMP WITH TIME ZONE) — migrations `*_datetime_to_timestamptz`. Date-only `dateOfBirth` stays `@db.Date`. New DateTime columns MUST carry `@db.Timestamptz(3)` to stay consistent. MongoDB services (chat, community, notifications) need no change — BSON `Date` is always UTC. The Postgres container session TZ is `Etc/UTC`, so the in-place `timestamp → timestamptz` conversion did not shift existing values.

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
- [ ] **FCM push: capture works, delivery does not.** Tokens are stored on register/login/social, and the Firebase Admin SDK is wired + verified end-to-end. But `handleUserRegistered` in notifications-service is commented out and no other event has a push handler — the product fires zero pushes today. Also missing: token removal on logout, stale-token pruning on FCM 404s, per-device metadata.
- [x] **Community member user snapshots** — shipped 2026-05-22 (see §0 subsection below).
- [ ] **Friend-request privacy gate skipped (v1):** `PrivacySettings.whoCanSendFriendRequests` is not enforced on `POST /friends/requests`. Add before GA.
- [ ] **Community member input not validated as friends:** create `memberIds` and add-members `userIds` trust the client (no friendship/consent check).
- [ ] **Community features still unbuilt:** join-requests, invites, ownership transfer, soft-delete endpoint, discovery/search, cover image, reports. The `CommunityJoinRequest` / `CommunityInvite` / `CommunityReport` models exist as `/// FUTURE` (defined but unwired — no repo/service/routes). Join-requests need a "request to join" flow first (today members are only added at create time or directly by admin/mod — there is no join/invite path).
- [x] **Audio/video calling (chat-service)** — shipped 2026-05-28: `Call` model, `CallRepository`, `CallService` full lifecycle, 5 gRPC RPCs, 5 Socket.IO events, ICE relay via Redis `call:<callId>`.
- [x] **Forward messages (private + group)** — shipped 2026-05-28: `isForwarded`/`forwardData` fields, `forwardMessage()` on both services, HTTP + gRPC + Socket.IO.
- [x] **Reaction users view** — shipped 2026-05-28: `getMessageReactions()` on both services, HTTP + gRPC + Socket.IO.
- [x] **clientMessageId idempotency on private messages** — shipped 2026-05-28: `clientMessageId` field + partial-filter index + pre-send dedup + `already_sent` gRPC flag.
- [x] **WebRTC config service + api-gateway endpoint** — shipped 2026-05-28: `WebRtcConfigService`, `GetRtcConfig` gRPC RPC, `GET /api/v1/webrtc/rtc-config` gateway route.
- [ ] **SHOULD FIX — `getMessageReactions` duplicated:** logic is identical between private and group services. Extract to `src/lib/reactions.ts` shared helper.
- [ ] **SHOULD FIX — `buildForwardData()` duplicated:** construction repeated in both private and group forward paths. Extract to a shared helper.
- [ ] **SHOULD FIX — `CALL_*` error codes not in `@aimess/constants`:** affects only i18n/client error mapping, not functionality.
- [ ] **SHOULD FIX — `getCodecPreferences()` unused (dead code):** `WebRtcConfigService.getCodecPreferences()` is not called anywhere — for future codec negotiation. Document or remove.
- [ ] **SHOULD FIX — `iceTransportPolicy` hardcoded to `"all"`:** consider an env var for relay-only mode in production (useful when direct P2P is blocked by corporate firewalls).
- [ ] **SHOULD FIX — `buildIceServers()` rebuilds on every request:** consider caching the result at `WebRtcConfigService` init time and refreshing only on env change.
- [ ] **SHOULD FIX — `CallStatus.MISSED` never set:** requires a Bull delayed job that fires at 60s if the call is still RINGING. Deferred — calls that time out currently stay stuck in RINGING.

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

---

## 8. Verification status (2026-05-28 — calling, forward, reactions, idempotency, WebRTC)

- `npx tsc --noEmit` (chat-service) — **PASS** (zero type errors after all five features + bug fixes)
- `npx tsc --noEmit` (api-gateway) — **PASS** (WebRTC config endpoint + updated OpenAPI schemas)
- Runtime / integration — **NOT done** (no test runner; verified by typecheck + multi-agent review/tester code-reading)

---

### Postman

A ready-to-import collection + environment live at `postman/` (`aimess-friends.postman_collection.json`, `aimess-local.postman_environment.json`): auth (register/login/refresh, two users), the friend-request lifecycle, and user discovery — with test scripts that auto-capture tokens, `userId` (decoded from the JWT `sub`), and `friendshipId`. Defaults hit services directly (auth `:3001/api/auth`, user `:3002/api/v1`); switch the two base-URL env vars to the gateway to route through `:3000`.

---

## Profile-completion flag in login responses (2026-05-29)

Both password login (`POST /auth/login`) and social login (Google/Apple) now return `isProfileCompleted: boolean` so the client can route to the edit-profile screen on first login.

**Source of truth & sync.** Profile data lives only in user-service, so it owns the computation:

- `apps/user-service/src/lib/profile-completion.util.ts` → `isProfileComplete()` derives the flag from exactly three required fields: **`username`, `firstName`, `lastName`** — all must be non-null and non-empty after trimming. `dateOfBirth` and `gender` are **not** part of the rule. (Updated 2026-05-29 — see "Profile-completion rule narrowed" below; was previously firstName + lastName + non-placeholder DOB + gender.)
- On every profile update, user-service includes `isProfileCompleted` in the existing `user.profile_updated` event (`UserProfileUpdatedPayload` in `@aimess/shared-types`).
- auth-service consumes that event (`apps/auth-service/src/messaging/profile-updated-consumer.ts`, started in `server.ts`) and mirrors the flag onto `AuthUser.isProfileCompleted` via `authRepository.markProfileCompletion` (uses `updateMany`, so a stale event for a deleted user is a safe no-op).
- Login reads `AuthUser.isProfileCompleted` directly (no cross-service call on the hot path) — eventual consistency, default `false` until first profile completion.

**Social login.** New accounts return `false`. The email-link path reads the full `AuthUser` (`findByEmail`); the already-linked path fetches the flag via `authRepository.getProfileCompleted(userId)` to avoid coupling to the linked-account `select`.

**Migration.** `apps/auth-service/prisma/migrations/20260529120000_add_profile_completed_flag` adds `isProfileCompleted BOOLEAN NOT NULL DEFAULT false` to `auth_users`. Run `pnpm db:migrate:deploy` (auth) to apply.

**Messaging note.** auth-service had no consumer infrastructure before this; publishers use `channel.sendToQueue(<named queue>)` on the default exchange (no topic exchange / routing keys). The new consumer declares the same `user.profile_updated.queue` + DLX topology the user-service publisher uses.

---

## Profile-completion rule narrowed + stale-flag backfill (2026-05-29)

**Rule change.** `isProfileComplete()` now checks **only `username`, `firstName`, `lastName`** (all non-empty), dropping the `dateOfBirth`/`gender` requirements. `ProfileCompletionFields` and the `PLACEHOLDER_DOB_ISO` constant + `ProfileGender` import were removed from `profile-completion.util.ts`. OpenAPI `LoginResponseData.isProfileCompleted` description updated to match (`components/schemas.ts`).

**Bug: stale `auth_users.isProfileCompleted`.** The flag is mirror-only (auth-service does not own name fields) and is refreshed **solely** by the `user.profile_updated` event, which fires only on a non-empty profile update (`user-profile.service.ts` returns early on a no-op PATCH). So:

- Login is correct as-is — it returns the mirrored flag; no login code change was needed.
- Rows last written under the old rule (e.g. a user with username/first/last filled but no gender/DOB → old logic published `false`) stay stale until the next profile edit re-publishes.

**Backfill (for existing stale rows).** `apps/user-service/scripts/backfill-profile-completion.ts` (run: `pnpm --filter @aimess/user-service backfill:profile-completion [-- <userId>...]`) streams `UserProfile` rows (cursor-paginated, optional userId filter), recomputes `isProfileComplete`, and re-publishes `user.profile_updated` on a **confirm channel** (`waitForConfirms` per batch). Idempotent — the consumer just sets the flag. Requires RabbitMQ up + auth-service running to drain. Not needed for normal operation (the edit-profile event handles it going forward); it's a one-shot cleanup tool.

---

## rememberMe on login (2026-05-29)

`POST /auth/login` accepts `rememberMe?: boolean` (default false). When true, the refresh token is issued with a longer TTL (`JWT_REFRESH_EXPIRES_IN_REMEMBER_ME`, 30 days = 2592000s) so the session survives app restarts; the access-token lifetime is unchanged. Implemented per-request (no DB column): `issueAuthTokens(userId, session, rememberMe)` in `apps/auth-service/src/lib/token.ts` picks the refresh TTL; `loginSchema` carries `rememberMe`. Env: `JWT_REFRESH_EXPIRES_IN_REMEMBER_ME` in auth-service `.env`/`.env.example`.

---

## Account deletion (soft delete, conditional password) (2026-05-29)

`DELETE /auth/account` (auth via access token; `apps/auth-service/src/services/account-deletion.service.ts`):

- Password is confirmed against `auth_users.passwordHash` **only when the account has one**. Accounts with a password: missing → 400 `AUTH_PASSWORD_REQUIRED`, wrong → 401 `AUTH_PASSWORD_INCORRECT`. Social-only accounts (no passwordHash) skip the password. Request body: `{ password?: string }` (`account-deletion.validator.ts`).
- Soft delete: `authRepository.softDeleteUser` sets `status=PENDING_DELETION`, `deletionRequestedAt`, `scheduledDeletionAt` (+30d), `deletedAt`, and revokes all active sessions/refresh tokens (`SessionRevokeReason.ACCOUNT_DELETED`). A `user.deleted` event is published.
- After deletion, BOTH password login and any linked Google/Apple provider are blocked by the `deletedAt`/non-ACTIVE guards in `auth.service` and `social-auth.service` (`assertUserCanLogin`).
- Linked accounts: managed via existing `/auth/social/{google,apple}/link` + `/auth/social/unlink`; connected/not-connected status comes from the account-summary providers list.
- TODO: the 30-day grace-period hard-purge job (consume/scan `scheduledDeletionAt`) is not wired yet.

---

## isGoogleLogin / isAppleLogin on GET /users/profiles/me (2026-05-29)

`GET` and `PATCH /users/profiles/me` now return `isGoogleLogin` and `isAppleLogin`. user-service derives them live from the `providers[]` array of auth-service's `GET /api/auth/internal/account` (already fetched via `resolveAuthAccountSummary`): `isProviderConnected(account, "GOOGLE"|"APPLE")` in `apps/user-service/src/services/user-profile.service.ts`. When auth-service is unavailable (no providers), `isGoogleLogin` falls back to the synced-at-registration DB flag and `isAppleLogin` falls back to `false`. No schema/migration change; reuses the existing Redis cache + outage fallback.

---

## 2026-05-29 — Personal (1:1) chat: completed 6 partial features

Closed out the six partially-implemented direct-message features. Work spans **chat-service** (Prisma v6 on MongoDB `chat_db`), **api-gateway** (Socket.IO `/chat` namespace + gRPC client + Swagger), and shared **packages/grpc-contracts** + **packages/constants**. Real-time transport unchanged: chat-service publishes `{event,data}` to Redis `conv:<roomId>` / `user:<userId>`; the gateway psubscribes `conv:*`/`user:*` and re-emits over Socket.IO.

### 13 — Edit message

- `PrivateMessage.editedAt` + `editHistory` (Json, prior-content snapshots). Sender-only; rejects deleted (cannot resurrect a forEveryone-deleted msg) and non-TEXT.
- gRPC `EditMessage`; REST `PATCH /api/chat/private/messages/:messageId` (Zod `editMessageSchema`, reuses shared `messageFileSchema`). Emits `message:edited` on `conv:<roomId>`; socket inbound `message:edit`.
- Both gRPC + REST publish via one shared helper `src/lib/edited-event.ts` (`stringifyContent` / `buildEditedEventData`) so the payload is identical and never throws.

### 15 — Delivered status (full per-recipient)

- `PrivateMessage.deliveredTo` (Json array of userIds) + `deliveredAt` (Json map). gRPC `MarkDelivered` (ack by `upToMessageId`, mirrors MarkMessagesRead). `markDeliveredUpTo` is idempotent (skips already-delivered), never self-delivers (`senderId != recipientId`), skips deleted/hidden, batch-capped at 200.
- Socket: recipient emits `message:delivered {conversationId, upToMessageId}` on receiving `message:new`; sender receives `message:delivered` on `conv:<roomId>`. Status chain: sent → delivered → read.
- NOTE: 200-row cap has no continuation cursor yet — a recipient returning after >200 undelivered msgs leaves the tail unmarked (follow-up).

### 18/19 — Presence: online/offline + last seen (Option A: chat-service Redis owns presence; no cross-DB write to user-service)

- Wired the previously-unwired `PresenceService` + device-session cache. gRPC `PresenceConnect/PresenceDisconnect/PresenceHeartbeat`. Gateway `/chat` connect hook → `presenceConnect`; `disconnect` → `presenceDisconnect`; inbound `presence:heartbeat`, `presence:subscribe`/`unsubscribe` (join/leave `user:<peerId>` to receive `presence:status`). `deviceId = socket.data.sessionId`.
- `recompute` aggregates across all device sessions (online until ALL devices drop); writes `presence:lastseen:<id>` on offline transition; emits `presence:status {isOnline,lastSeen}` on `user:<id>`. REST `GET /api/chat/private/presence/:userId` → `{isOnline,lastSeen}`. "Online duration" intentionally out of scope.

### 22 — Mute/unmute private chat

- `PrivateRoom.mutedBy` Json map `{ [userId]: { mutedAt, muteUntil|null } }` (mirrors `deletedFor`). REST `POST /rooms/:roomId/mute` (optional ISO `muteUntil`, null = indefinite) + `POST /rooms/:roomId/unmute`. Conversation list now carries computed `isMuted` (expired `muteUntil` ⇒ not muted). Participant-guarded; orthogonal to block.
- NOTE: no PM push pipeline exists yet, so mute is stored + exposed but inert for push until a chat-notification producer is added.

### 27 — Report private message

- New model `PrivateMessageReport` (reporterId, reportedUserId, messageId, roomId, reason enum, description, status=PENDING, `@@unique([messageId, reporterId])`). REST `POST /rooms/.../messages/:messageId/report` → 201 (rate-limited). Participant-guard + self-report reject; duplicate → `CHAT_ALREADY_REPORTED` (P2002). Stored for an admin/moderation panel (no backoffice consumer yet).

### Cross-cutting

- proto: 5 new RPCs in `packages/grpc-contracts/proto/messaging.proto` (loaded at runtime by both services — restart both to pick up). Gateway gRPC client methods all wrapped in opossum breakers (markMessagesRead pattern).
- i18n: new `CHAT_*` keys in `packages/constants/src/messages/chat.messages.ts` (en + vi).
- Swagger: `ChatEditMessageRequest`, `ChatMuteRoomRequest`, `ChatReportMessageRequest`, `ChatPresence`, `PrivateMessageReport` schemas + paths for edit (PATCH), report, mute, unmute, presence (all `bearerAuth`).

### Build / review status

- Agent-team review (DRY + Contract + Quality) passed after 2 fixes: (1) 4 OpenAPI path objects had been left commented out — now defined + registered; (2) REST edit publish unified onto the safe shared helper.
- typecheck/lint green for all touched files in chat-service, api-gateway, constants. The only remaining chat-service `tsc` errors are **pre-existing** amqplib type-API drift in `src/events/index.ts` + `src/events/friendship.consumer.ts` (untouched here) — fix separately by moving to the amqplib v0.10 `ChannelModel` API.

### Migration / deploy action

- chat-service schema synced via `prisma db push` (Mongo, no SQL migration). `db push` + `db generate` were applied locally (collection `private_message_reports` + indexes created). Re-run `pnpm db:push && pnpm db:generate` in `apps/chat-service` on other environments. Restart chat-service AND api-gateway so the new proto RPCs load.

### Remaining follow-ups (out of scope this pass)

- Delivered batch continuation beyond 200.
- PM push-notification producer (so mute actually suppresses pushes) + presence durability in user-service if a durable last-seen column is needed (would use a `presence.changed` event + user-service consumer — Option B).
- Pre-existing amqplib type drift in chat-service `src/events/*`.

---

## 2026-06-01 — chat message limits, stickers, edit window, shared media, conversation API

Closed out five chat-service capabilities spanning private/group/community messaging. Shipped via the `aimess-architecture` Agent Team Mode (PM → Pro Coders → DRY + Contract reviewers + Quality Tester → fix loop). No real-time transport change: chat-service publishes `{event,data}` to Redis (`conv:<roomId>` / `community:<communityId>`); the gateway re-emits over Socket.IO.

### Message validation limits (send + edit, all three contexts)

- Enforced in the send validators (Zod `superRefine` via `enforceMediaLimits`) AND defensively at the service layer (`assertAttachmentsValid`), on **both** send and edit, across private/group/community:
  - text ≤ **4,000** chars (was 10,000)
  - photos ≤ **10** per message
  - video ≤ **100 MB** and `durationMs` ≤ **180000** (3 min)
  - voice `durationMs` ≤ **300000** (5 min)
- Per-type caps centralized in `apps/chat-service/src/constants/media-limits.ts` (single source of truth — `MEDIA_LIMITS` table + the two enforcement functions). Byte caps: video 100 MB via `CHAT_VIDEO_MAX_BYTES`; images/voice/GIF/document/sticker 50 MB via `CHAT_UPLOAD_MAX_BYTES` (the generic cap). Stable error codes: `CHAT_IMAGE_COUNT_EXCEEDED`, `CHAT_VIDEO_TOO_LARGE`, `CHAT_VIDEO_TOO_LONG`, `CHAT_VOICE_TOO_LONG`, `CHAT_FILE_TOO_LARGE`.
- New env vars (`config/env.ts`, coerced+defaulted): `CHAT_TEXT_MAX_CHARS` (4000), `CHAT_VIDEO_MAX_BYTES` (104857600). `CHAT_UPLOAD_MAX_BYTES` (52428800) already existed.

### STICKER message type

- Added `STICKER` to `MessageType` (`"STICKER"`) and `CommunityMessageType` (`"sticker"`) in `src/types/enums.ts`.
- `content.sticker` shape via `stickerSchema` in `api/validators/attachment.validator.ts`: `{ objectKey? | url? (one required, `.refine`), packId, stickerId }`. **Client-supplied — there is no server-side sticker-pack system** (no pack catalog, no validation that packId/stickerId exist). Stickers carry no `files[]` array, so `assertAttachmentsValid`/`enforceMediaLimits` treat STICKER as a no-op.

### 15-minute edit window

- Edits rejected when `now - createdAt > 15 min` (`CHAT_EDIT_WINDOW_MS` in `media-limits.ts`) → **`GoneError("CHAT_EDIT_WINDOW_EXPIRED")`** (HTTP 410), enforced in all three message services (`private-message.service.ts`, `group-message.service.ts`, `community-message.service.ts`).
- Net-new edit endpoints: group `PATCH /api/chat/groups/messages/:messageId` and community `PATCH /api/chat/community/messages/:messageId` (the latter requires `communityId` in the body). Private edit already existed (see "13 — Edit message" above). Community edit broadcasts on the `community:<communityId>` Redis channel with a `community:message:edited` event.

### Shared media/docs endpoints (cursor-paginated, type-filtered)

- `GET /api/chat/private/rooms/:roomId/media`, `GET /api/chat/groups/:roomId/media`, `GET /api/chat/community/rooms/:roomId/media`. Query (`mediaListQuerySchema`): `type` (IMAGE|VIDEO|GIF|VOICE|DOCUMENT|STICKER), `cursor`, `limit`.
- Community stores its media type differently (IMAGE/VOICE/STICKER lower-cased; VIDEO/GIF/DOCUMENT collapsed to `"custom"`) — the incoming filter is mapped via `mapCommunityMediaType` in `media-limits.ts`; unknown types return an empty result rather than broadening the query.
- New composite index `[roomId, messageType, createdAt(desc)]` added on `PrivateMessage` / `GroupMessage` / `GeneralRoomMessage` to back the filtered listing (see migration note below).

### Conversation list + mark-as-read (offset-paginated)

- `GET /api/chat/groups/:roomId/conversation`, `GET /api/chat/community/rooms/:roomId/conversation`. Query (`conversationQuerySchema`): `pageNumber` (1-based, default 1), `limit` (default 30, max 100), `timestamp` (epoch ms, default now).
- Returns messages with `createdAt < timestamp`, newest-first, offset `(pageNumber-1)*limit`, **excluding deleted-for-all and the caller's deleted-for-self** — filtered **at the DB level** via raw Mongo (`$ne`-on-array against the `deletedForUserIds` / `deletedBy` Json arrays) rather than the old over-fetch-and-slice approach.
- **Side effect:** advances the caller's read pointer (`lastReadAt` / `lastReadMessageId`), **forward-only**, and recomputes remaining unread (group `unreadCount` is recomputed, not blind-zeroed). New fields added to the community `RoomMember`: `lastReadMessageId`, `lastReadAt` (group `GroupMember` already had them).

---

## 2026-06-01 — notifications-service: community + friend notifications and event-driven push

Built the notifications-service from a stub into a working push/mail **transport + orchestration** layer, plus the cross-service contracts it needs. Shipped via the Agent Team Mode.

### Architecture decision (important)

- The notification **inbox** is owned by **chat-service** (its existing `Notification` model). **notifications-service does not own the inbox and never writes another service's DB** (one-service-one-DB). It persists inbox rows by calling a **new chat-service gRPC `CreateNotification`** RPC, and otherwise only sends push/mail.

### Device-token store (owned by notifications-service)

- **Prisma 6 MongoDB connector** (NOT Mongoose), in its own `aimess_notifications` DB. Model `DeviceToken { userId, token @unique, platform, deviceId?, lastSeenAt, createdAt, @@index([userId]) }` (`apps/notifications-service/prisma/schema.prisma`). `token` is globally unique so re-registering the same token from another user moves ownership.
  - **NB:** the service pins `prisma`/`@prisma/client` `^6.9.0`, consistent with the project-wide rule that **Prisma 7 dropped MongoDB support** (the same reason community-/chat-service stay on Prisma 6). (The internal task summary called this "Prisma 7" — that was inaccurate; the code is Prisma 6.)
- REST (JWT-auth): `POST /v1/devices` (upsert `{token, platform, deviceId}`), `DELETE /v1/devices/:token` (unregister). Dead tokens are auto-pruned on FCM invalid-token errors.

### Community + friend notifications (event-driven)

- New consumer on **`community.queue`** maps community events → recipients: `JOIN_REQUESTED`→admins/mods, `MEMBER_ADDED`→target, `ADMIN_TRANSFERRED`→new admin, `KICKED`/`BANNED`/`ROLE_CHANGED`→affected, `INVITE_SENT`→invitee, `INVITE_ACCEPTED`→inviter, `REPORT_CREATED`→admins/mods, `REPORT_ACTIONED`→reporter, `DELETED`→all members. Honors the `communityEnabled` setting. (This is the consumer the community-service event publishers — see §0 — were waiting on.)
- New consumer on **`friendship.queue`** → friend push under the `friendRequestEnabled` category. (Also previously unconsumed — see §4.)

### Settings lookup + push pipeline

- New user-service gRPC **`GetNotificationSettings`**, opossum-wrapped, Redis-cached (key `notif:settings:<userId>`, TTL 300 s, allow-on-open). Cache is busted by a new **`user.settings_updated`** event (consumer on `user.settings_updated.queue`).
- Push pipeline: check per-category setting + quiet hours → look up device tokens → `sendPush` per token → prune dead tokens → write the inbox row via the chat `CreateNotification` gRPC.
- **gRPC client host = `127.0.0.1`** (e.g. `USER_SERVICE_GRPC_URL` default `127.0.0.1:4002`, `CHAT_SERVICE_GRPC_URL` `127.0.0.1:4004`) — **not `0.0.0.0`**, which is a bind-only address and fails as a _connect_ target on Windows. (The server still _binds_ `0.0.0.0:<port>`, which is correct.)

### Cross-service contracts

- `packages/grpc-contracts/proto/user.proto`: `+GetNotificationSettings`. `notification.proto`: `+CreateNotification` (served by chat-service).
- `packages/shared-types`: community events enriched with recipient rosters (`moderatorRecipientIds`, `memberIds`, `inviterId`); user events `+SETTINGS_UPDATED`.

---

## Known gaps / TODOs (2026-06-01 — chat limits/media/conversation + notifications)

- [ ] **`message.sent` (chat-service) and `call.*` (call-service) publishers NOT built** → push-on-new-message and push-on-call are **deferred** until those publishers exist. Only `community.*` and `friend.*` push are live today.
- [ ] **Pending `prisma db push` (needs a live Mongo):** chat-service (group/community `editedAt`/`editHistory`, the new media composite indexes, community `RoomMember.lastReadAt`/`lastReadMessageId`) and notifications-service (`device_tokens` unique index). Run `pnpm db:push && pnpm db:generate` in each app on every environment.
- [ ] **Conversation API raw-Mongo queries** verified by construction (field names, `$oid` for the community ObjectId `roomId`) but **not yet live-DB smoke-tested**.
- [ ] **Pre-existing amqplib type errors** in `apps/chat-service/src/events/` (`friendship.consumer.ts`, `index.ts`) — unrelated to this work; they block a full chat-service `tsc` build. Spawned as a separate task (same drift noted in §"2026-05-29" above).
- [ ] **No automated tests** in chat-/notifications-service (test scripts are placeholders) — sign-off was multi-reviewer + typecheck + lint.

### Resolved by this session (see §4 entries above)

- [x] **Friendship events have a consumer** — notifications-service `friendship.queue` consumer (was "NO consumer" in §4).
- [x] **`community.queue` has a consumer** — notifications-service community consumer (was the §0 "Known gap").
- [x] **FCM trigger-on-event for community + friend** — push now fires for those event families (the §4 "delivery does not" item is now partial: community/friend live, message/call deferred). Device-token lifecycle (register/unregister, dead-token pruning) is also addressed by the new `DeviceToken` store.

---

## Verification status (2026-06-01 — chat limits/media/conversation + notifications)

- Executed via the **aimess-architecture Agent Team Mode** (PM → Pro Coders → DRY + Contract reviewers + Quality Tester → fix loop). Reviewers + Quality Tester ran before sign-off.
- **Notable fixes from review:** community edit Redis channel corrected (`conv:*` → `community:*`); community media type-filter mapping fixed; conversation pagination corrected to a **DB-level deletion filter + boundary-aware count** (replacing a broken over-fetch + in-memory-slice); group `unreadCount` is **recomputed** instead of unconditionally zeroed.
- **Final state:** `typecheck` + `lint` clean across chat / notifications / user / community — only the **6 pre-existing amqplib errors** in chat-service `src/events/*` remain.
- Runtime / integration — **NOT done** (no test runner; verified by typecheck + lint + multi-agent review/tester code-reading). Conversation raw-Mongo queries not yet live-DB smoke-tested.

---

## Unified inbox endpoint — `GET /api/chat/inbox` (shipped 2026-06-02)

- **What:** merges private 1:1 rooms + group chats into one `lastMessageAt`-ordered list. New endpoint; the two source endpoints (`/chat/private/conversations`, `/chat/groups/my-groups`) are **unchanged**. Public path via gateway: `GET /api/v1/chat/inbox`.
- **Query (epoch ms, mutually exclusive; omit both for newest page):** `before_ts` → `lastMessageAt <= before_ts`, newest-first (DESC); `after_ts` → `lastMessageAt >= after_ts`, oldest-first (ASC). `limit` default 20, max 100. Matches the existing `conversationQuerySchema` epoch-ms convention.
- **How:** each collection is queried in its own repo (`PrivateRoomRepository.getInboxConversations`, `GroupRoomRepository.getInboxGroups`) with the same time bound + `limit+1` over-fetch, then `InboxService` merges in memory, sorts by `(lastMessageAt, roomId)`, and slices to `limit`. `hasMore = merged.length > limit` (exact, thanks to over-fetch). Private peer-enrichment was extracted into `PrivateRoomService.enrichConversations` and is shared with the legacy conversation list.
- **Contract notes:** boundaries are **inclusive** (as specified) → consecutive pages can share the boundary item; **clients de-dupe by `roomId`**. `nextCursor` is an **epoch-ms string** (matches this endpoint's own `before_ts`/`after_ts` input — intentionally different from the ISO cursor the sibling endpoints emit). Unified item carries a `type: PRIVATE|GROUP` discriminator; the other kind's fields are null. `totalData` is the user's overall conversation count (not window-scoped) — page with `nextCursor`/`hasMore`, not `totalPage`.
- **Auth:** private filtered by `participants has userId`; group filtered to ACTIVE memberships only — no cross-tenant leakage. Per-user read rate limit (120/min) added (heaviest read in the service).
- **OpenAPI:** documented in `api-gateway` (`ChatInboxItem`/`ChatInboxList` schemas, `/chat/inbox` path, tag "Chat — Inbox").
- **Sign-off:** two parallel reviewers (pagination-correctness + architecture/contract) → fixes applied (`limit+1` over-fetch for exact `hasMore`, `roomId` tiebreaker, `isOnline` boolean coercion, rate limiter). `tsc --noEmit` + `lint` clean on chat-service and api-gateway. Runtime/integration not smoke-tested (no test runner).

### Message-list endpoints → before_ts/after_ts pagination (shipped 2026-06-02)

- **What:** both message-history endpoints — `GET /api/v1/chat/private/rooms/{roomId}/messages` and `GET /api/v1/chat/groups/{roomId}/messages` — replaced the legacy `cursor`/`page` query with the same epoch-ms `before_ts`/`after_ts` contract as the inbox. `before_ts` → `createdAt <= ts`, newest-first (DESC); `after_ts` → `createdAt >= ts`, oldest-first (ASC); omit both → newest page. `limit` default 30, max 100, mutually exclusive (`messageTimelineQuerySchema`).
- **How:** new repo methods `findByRoomIdTimeline({userId, roomId, direction, ts, limit})` on both `PrivateMessageRepository` + `GroupMessageRepository` — direction-aware bound (`lte`/`gte`) + order (`desc`/`asc`), over-fetch `limit+1+10` (the `+10` absorbs the in-memory per-user "delete for me" filter, `+1` gives exact `hasMore`), return up to `limit+1` survivors. New service methods `getMessagesTimeline` compute `hasMore = rows.length > limit`, slice to `limit`, and emit `nextCursor` = boundary message `createdAt` as **epoch-ms string** (feed back as the same before_ts/after_ts). `buildTimelineResponse` keeps the existing `{pagination:{...}, data}` outer shape (client contract stable) but with the epoch-ms `nextCursor` + exact `hasMore`.
- **Visibility parity preserved per type:** private filters `isDeleted:false` at the DB (deleted-for-everyone hidden); group keeps deleted-for-everyone rows so the client can render the placeholder (matches the legacy `findByRoomIdWithTime`). Per-user delete-for-me filtered in memory (private `deletedFor` object, group `deletedForUserIds` array).
- **Scope:** only the two HTTP message-list endpoints changed. `getMessages` (cursor-based) is **untouched** — still used by gRPC (`server.ts`) and the community-message controller, so those signatures didn't break. Contract note: boundaries inclusive → consecutive pages can share the boundary message; **clients de-dupe by message id**.
- **OpenAPI:** `privateMessages`/`groupMessages` paths updated with `messageTimelineParams()` (before_ts/after_ts) replacing `cursorParam`.
- **Sign-off:** live-DB verification against real rooms (`prv_OfVQ4b13IvEKnOtd` 7 msgs, `grp_6_HYP0VY-0srq3TU` 26 msgs) — asserted `before<=ts` DESC + `after>=ts` ASC, inclusive boundary present in both directions, exact `hasMore` via over-fetch. `tsc --noEmit` + `lint` clean on chat-service and api-gateway.

### Group system messages → inbox (shipped 2026-06-02)

- **Why:** a brand-new group has `lastMessageAt = null` and so wouldn't appear in the inbox. Group lifecycle events now post a SYSTEM message which sets `lastMessageAt` → the group surfaces and sorts immediately.
- **New `GroupSystemMessageService`** (`apps/chat-service/src/services/group-system-message.service.ts`): persists a `messageType:"SYSTEM"` GroupMessage with a `systemEvent` code + structured `systemData` (+ English `content.text` fallback), bumps the room via `updateLastMessage`, and publishes `conv:<roomId>` → `message:new` (same shape as a real send, plus `systemEvent`/`systemData`). **Does NOT increment unread** (lifecycle chatter must not raise badges). Fully **best-effort** (try/catch, never throws) so a lifecycle op never fails on its system message.
- **Events wired (full lifecycle):** `GROUP_CREATED` (createGroup), `MEMBER_ADDED` (direct `/group-members/add`), `MEMBER_JOINED` (invite-link join — `addMember` takes an `opts {systemEvent, actorId}` directive so the join path attributes to the joiner, not a double MEMBER_ADDED), `MEMBER_LEFT` (leave), `MEMBER_REMOVED` (kick), `ROLE_CHANGED` (updateRole), and `ROOM_RENAMED`/`AVATAR_CHANGED`/`DESCRIPTION_CHANGED` (updateRoom — only on real field changes; `memberLimit` stays silent). DI: `GroupSystemMessageService` injected into `GroupRoomService` + `GroupMemberService`.
- **createGroup** re-reads the room after posting so the POST response reflects the freshly-set `lastMessageAt`/preview (not the stale pre-post row).
- **Docs:** `SOCKET_EVENTS.md` updated with the SYSTEM `message:new` shape + the `systemEvent` code list.
- **Sign-off:** adversarial reviewer (double-post/attribution, DI ordering, unread, best-effort, inbox effect) → only fix was the stale-room return on create. `tsc --noEmit` + `lint` clean.

## /communities/mine — activity-ordered cursor pagination (shipped 2026-06-02)

- **What:** `GET /api/v1/communities/mine` (community-service) replaced page-based pagination with timestamp-cursor pagination (`before_ts`/`after_ts` epoch ms, mutually exclusive, `limit` ≤ 50), ordered by **`Community.lastActivityAt`** — latest community message, else createdAt. Same inclusive `<=`/`>=` + epoch-ms `nextCursor` contract as the chat inbox; clients de-dupe boundary item by `id`.
- **Schema:** added `Community.lastActivityAt DateTime @default(now())` + `@@index([lastActivityAt])` (Mongo `db push`); existing docs backfilled `lastActivityAt = createdAt` via a `$set:"$createdAt"` pipeline update (14 rows). Read path queries from the **Community side** (`where: { members: { some: { userId, status: ACTIVE } } }`, `orderBy: [lastActivityAt, id]`, filtered `members` include for `myRole`) so it can order by the native field — verified to execute on the Prisma **mongodb** provider against live data.
- **Denormalization pipeline:** community chat lives in **chat-service** (the latest-message time isn't in community-service). chat-service's gRPC `sendCommunityMessage` handler publishes a durable `community.activity.queue` event `{ communityId, lastMessageAt, lastMessageId }` (best-effort, guarded on `RABBITMQ_URL`); community-service consumes it (`startCommunityActivityConsumer`) and `bumpLastActivityAt` forward-only (`updateMany where lastActivityAt < at`). Publisher + consumer assert identical queue args (`durable:true`, no DLX).
- **CRITICAL fix from review:** the activity event MUST carry **`req.communityId`** (the community-service `Community.id`, used for the `community:<id>` socket channel), **NOT** `roomId` — `roomId` is the chat-service `GeneralRoom._id`, an independent ObjectId. Publishing happens in the gRPC handler where `communityId` is available, not inside `CommunityMessageService` (which only sees `roomId`).
- **Community chat room provisioning (shipped 2026-06-02):** the earlier gap (no chat room existed per community, so messages had nowhere to land) is now closed. **Decision: one chat room per community, `GeneralRoom.id === Community.id`** — `roomId` and `communityId` are the same value across the whole community-chat path. community-service publishes `community.created`/`community.deleted` to a **dedicated** `community.chat.sync.queue` (separate from `community.queue`, which notifications-service consumes — a single queue would split messages between competing consumers); chat-service's `CommunityRoomSyncConsumer` provisions/deactivates the `GeneralRoom` (idempotent upsert with explicit `id`). Existing 16 communities backfilled into `general_rooms`. Verified end-to-end against live DBs: explicit-id room create/upsert + reads work on the Prisma mongodb provider, and a published `community.activity` event bumps `Community.lastActivityAt` (forward-only). So once clients post community messages (room now exists; `sendCommunityMessage` has no membership guard), ordering is genuinely activity-based.
- **`RoomMember` sync for community-chat READ history (shipped 2026-06-02):** `getConversation`/`listMedia` gate on `RoomMember.status === "active"`, so community membership is now mirrored into chat-service `RoomMember`. community-service emits `community.member.synced { communityId, userId, status?, role? }` on the **same `community.chat.sync.queue`**, published from the **repository** mutation methods (`createMember`, `createManyMembers`, `updateMemberStatus`, `updateMemberRole`) — the single funnel every service branch (join, addMembers, acceptJoinRequest, leave's 3 branches, kick, ban, unban, role change, admin handover) passes through, so `RoomMember` can't drift no matter which path ran. (Deliberate repo-level emit — best-effort/fire-and-forget, doesn't change repo semantics; chosen over instrumenting ~10 branchy service paths.) chat-service's consumer maps status ACTIVE→active / BANNED→banned / else→left (+ leftAt/bannedAt bookkeeping) and role ADMIN→admin/MODERATOR→moderator/MEMBER→member via `RoomMember` upsert; `community.deleted` also marks all the room's members left. Backfilled 46 active members into `room_members` (`roomId` = community id **hex string**, since `RoomMember.roomId` is a plain String — distinct from `GeneralRoom.id` which is `@db.ObjectId`; both encode the same community id). Verified live: status transitions (active↔left↔banned, reactivation clears timestamps) and role-only sync all work via `RoomMember.upsert`.
- **Note for local dev:** the new RabbitMQ consumers/publishers require a **restart of the chat-service and community-service dev processes** to load (a running `tsx watch` instance held the old consumer during testing). The shared `community.chat.sync.queue` carries three event types (`community.created`, `community.deleted`, `community.member.synced`); publisher + consumer assert identical args (`durable:true`, no DLX).
- **roomId for communities — no generation:** community chat does **not** mint a `roomId`. The `GeneralRoom.id` IS the `Community.id` (reused verbatim), so `roomId === communityId` everywhere (works because community ids are 24-hex Mongo ObjectIds, compatible with `GeneralRoom.id @db.ObjectId`; `RoomMember.roomId` is a plain `String` holding the same hex). Provisioning is purely event-driven (`community.created` → `provisionForCommunity`) — its weakness is no self-heal: communities created while chat-service is down stay roomless.
- **Reconciliation backfill (run 2026-06-02):** live DB had drifted to 8 `general_rooms` for 22 communities (14 roomless — events missed during dev downtime). Ran an idempotent backfill (reuses `GeneralRoomRepository.provisionForCommunity` + `RoomMemberRepository.upsert` + the consumer's exact status/role mapping): provisioned the 16 missing rooms and upserted 55 members. Verified **0 communities without a room** (24 general_rooms = 22 community + 2 non-community, all active).
- **Boot-time reconciliation (shipped 2026-06-02) — the durable self-heal:** chat-service now reconciles community rooms on every boot, so dropped events / downtime gaps can't leave a community permanently roomless. **New gRPC method** `CommunityService.ListCommunities` (`packages/grpc-contracts/proto/community.proto`) — cursor-paginated (`after_id` on community id, ASC; `limit` default 100 / max 200) returning each community (`id, name, adminId, avatarUrl, deleted`) **with all its members** (`userId, status, role, joinedAt`). Implemented in community-service's gRPC server via `communityRepository.listForReconciliation` (Prisma `cursor`+`skip:1` paging, includes soft-deleted). chat-service: outbound `grpc/community.client.ts` (opossum breaker, 10s timeout, `env.COMMUNITY_GRPC_URL` default `0.0.0.0:4003`) + `startup/reconcile-community-rooms.ts`, fired best-effort/non-blocking after HTTP listen (`void reconcileCommunityRooms()`), gated by `COMMUNITY_ROOM_RECONCILE_ENABLED` (default true).
- **Reconciler scope (deliberate, logged — no silent caps):** active community **without** a room → provision room + sync its members; **deleted** community **with** a live room → deactivate + `markAllLeft`. For communities whose room **already exists**, steady-state member drift is left to the live `community.member.synced` events (re-syncing every member on every boot would be costly at scale) — members are synced here only for rooms this run actually provisions, so a freshly-created room is never empty. Bulk member-repair remains the manual backfill. Counts logged (`scanned/provisioned/deactivated/membersSynced`). The status/role→RoomMember mapping is shared with the consumer via the extracted `buildRoomMemberSyncData` (one source of truth). `MAX_PAGES` backstop guards a pathological cursor loop.
- **Verification:** live end-to-end smoke of `ListCommunities` against the real DB (fresh gRPC server on a throwaway port + raw client): page-1 shape (`returned=5, hasMore=true`, cursor set), members carry `status/role/joinedAt`, cursor paging covered all communities. `tsc --noEmit` + `lint` clean on chat-service, community-service, api-gateway.
- **Incidental fix:** resolved a pre-existing `git stash` merge-conflict in `community.repository.ts` (`updateMemberStatus` header — kept the richer ban-metadata docstring + the required `async`) and regenerated the stale community-service Prisma client (schema had `CommunityMemberMute`/`CommunityMemberWarning`/mute-flags the on-disk client lacked). Both blocked community-service typecheck; neither was caused by this change.
- **Removed `take:1`** from the Mongo relation include (unsupported on the provider + redundant under the `(communityId, userId)` unique constraint).
- **Docs:** api-gateway OpenAPI `/communities/mine` (before_ts/after_ts params + `lastActivityAt` on `CommunityListItem`). **Sign-off:** adversarial cross-service review → fixed the wrong-id bug (C1) + `take:1` (C2); live-DB query verification; `tsc --noEmit` + `lint` clean on community-service, chat-service, api-gateway.
