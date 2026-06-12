# community-service — Test Cases

Audit + documentation of every HTTP endpoint exposed by **community-service**.

- **Base path:** `/api/v1/communities` (mounted in `src/app.ts` → `src/api/routes/index.ts`).
- **Auth:** every route under `/api/v1/communities` requires a valid access token
  (`communityRoutes.use(authenticateAccessToken)` — `src/api/routes/community.routes.ts:126`).
  community-service does **not** track sessions, so only the JWT signature/exp is verified.
- **Health:** `GET /health` is public (mounted before the authed router).

## Envelopes (verified in code)

- **Success:** `{ success: true, message, data }` — `@aimess/utils` `ApiResponse`. `Date`
  fields are serialized to **ISO strings** by the DTO mappers in `community.service.ts`
  (not epoch ms — except `lastActivity.dateTime`, `createdAt` in discover items, and
  `lastActivityAt` in `/mine` joined-mode, which are epoch ms by design).
- **Error:** `{ success: false, message }` — `src/middleware/error-handler.ts`.
- **Status mapping** (`@aimess/errors` → `error.statusCode`):
  Zod body/query/param failure → **400**; `BadRequestError` → 400; auth failure → **401**;
  `ForbiddenError` → **403**; `NotFoundError` → **404**; `ConflictError` → **409**;
  `GoneError` → **410**; `UnsupportedMediaTypeError` → **415**; unhandled → **500**.

## Test strategy & coverage note (IMPORTANT)

The generated Jest suite (`12 suites / 224 passing / 1 skipped`) drives the **real Express
app** via supertest. It exercises, for real: routing & route ordering, the auth middleware
(real JWT verify — valid / missing / expired / forged), Zod **body/query/param** validation,
controllers, and the error→HTTP envelope mapping.

**The `communityService` (and `uploadService`) layer is mocked per test file.** Therefore the
service-layer business rules — authz role gates (`assertCommunityRole`), state machines
(report transitions, invite/join-request status), member-count recompute, friend validation,
event publishing, the no-`$transaction` compensating writes — are **NOT executed**. Tests that
assert 403/404/409 from the service do so by making the mock _reject_ with the corresponding
error; they prove the controller→error-handler mapping, not that the service actually throws
in that situation. Those service guards are therefore marked **DOCUMENTED-ONLY** below even
when a same-status test exists, and they are the largest uncovered area (see `AUDIT.md`).

Legend: **[E]** = executed by a Jest test · **[D]** = documented-only (no test, or only the
HTTP-mapping is tested while the underlying rule is mock-driven).

---

## 1. Health

### `GET /health`

- **Description:** Liveness/identity probe. Public (no token).
- **Positive:** 200 `{ success:true, service:"community-service", environment }`. **[E]** (smoke)
- **Edge:** unknown route → 404. **[E]** (smoke)

---

## 2. Community CRUD & availability

### `POST /api/v1/communities` — create

- **Pre:** valid token.
- **Body:** `name` (3–50), `handle` (3–32, `[a-z0-9_]`, normalized), `type` PUBLIC|PRIVATE,
  `categoryId` (24-hex), `description?` (≤500), `avatarObjectKey?`, `memberIds?` (uuid[], ≤500, deduped).
- **Positive:** 201 with community DTO; `creatorId` taken from token. **[E]**
- **Negative:** 401 no token **[E]**; 400 empty/missing name/short/long/bad handle/bad type/bad
  categoryId/long description/non-uuid memberIds **[E]**; 409 name|handle taken (service) **[E-mapping / D-rule]**;
  400 invalid category (service guard) **[E-mapping / D-rule]**.
- **Security:** mass-assignment of `creatorId`/`adminId`/`memberCount` ignored (stripped by Zod) **[E]**;
  NoSQL-shaped handle `{$ne:null}` → 400 **[E]**.
- **Edge/DOCUMENTED:** friend-validation silently drops non-friend `memberIds` **[D]**;
  partial-write compensating cleanup on member-insert failure **[D]**.

### `GET /api/v1/communities/:id`

- **Positive:** 200 with DTO; `role`/`isJoined` reflect ACTIVE membership only. **[E]**
- **Negative:** 404 not found **[E-mapping]**; 400 non-ObjectId id **[E]**; 401 no token **[E]**.

### `PATCH /api/v1/communities/:id` — update (ADMIN only)

- **Body:** any subset of create fields (`description`/`avatarObjectKey` nullable); ≥1 field required.
- **Positive:** 200 with updated DTO. **[E]**
- **Negative:** 403 non-admin **[E-mapping / D-rule]**; 409 name|handle conflict **[E-mapping / D-rule]**;
  400 empty body **[E]**; 400 bad type enum **[E]**.
- **DOCUMENTED:** `assertCommunityNotSuspended` blocks update on SUSPENDED community **[D]**;
  `memberIds` diff drives add/kick **[D]**.

### `DELETE /api/v1/communities/:id` — soft delete (ADMIN only)

- **Positive:** 200 `data:null`. **[E]**
- **Negative:** 403 non-admin **[E-mapping / D-rule]**; 404 gone **[E-mapping]**.

### `GET /api/v1/communities/name-available` & `/handle-available`

- **Positive:** 200 `{ available }`. **[E]**
- **Negative:** 400 missing `name` **[E]**; 400 handle too short **[E]**.

---

## 3. Discovery & listing

### `GET /api/v1/communities/categories` — public list

- **Positive:** 200 `{ categories }`. **[E]**
- **Security:** 401 no token **[E]**; 401 forged token **[E]**.

### `GET /api/v1/communities/categories/admin` — admin category list

- **Pre:** valid token (**no admin role gate — see AUDIT High-1**).
- **Positive:** 200 categories + pagination; forwards `search`/`status`. **[E]**
- **Negative:** 400 invalid `status` enum **[E]**; 401 no token **[E]**.

### `GET /api/v1/communities/mine` — dual-mode

- **Query:** `before_ts`|`after_ts` (cursor, joined mode) **XOR**; else `q`/`categoryId` (search,
  offset). `filter` all|live|upcoming (default all), `page`, `limit` (≤50).
- **Positive:** joined-mode before_ts → `listMine` direction=before **[E]**; after_ts → after **[E]**;
  search-mode q → `discover` with `includeJoined:true` **[E]**.
- **Negative:** 400 both timestamps **[E]**; 400 limit 0 / >50 **[E]**; 400 bad filter **[E]**;
  400 bad categoryId **[E]**.
- **DOCUMENTED inconsistency:** schema does NOT enforce "≥1 of before_ts/after_ts/q/categoryId";
  a param-less `/mine` returns all public communities (see AUDIT Low-9). **[D]**

### `GET /api/v1/communities/discover` — deprecated alias

- **Positive:** 200 paginated; `discover` called WITHOUT `includeJoined`; `page` forwarded. **[E]**
- **Negative:** 400 q >100 chars **[E]**; 401 no token **[E]**.

---

## 4. Members

### `GET /:id/members`

- **Pre:** PUBLIC → any caller; PRIVATE → ACTIVE MEMBER+.
- **Positive:** 200 paginated; `status` filter forwarded (default ACTIVE). **[E]**
- **Negative:** 400 bad status enum **[E]**; 403 private not-member **[E-mapping / D-rule]**;
  400 bad community id **[E]**.

### `POST /:id/members` — add (MODERATOR+)

- **Body:** `userIds` uuid[] (1–100, deduped).
- **Positive:** 201 `{ added, skipped }`. **[E]**
- **Negative:** 400 empty/non-uuid/>100 **[E]**; 403 below MODERATOR **[E-mapping / D-rule]**.
- **DOCUMENTED (AUDIT High-2):** the friend-validation gate is **commented out** — any user
  can be added regardless of friendship; BANNED skipped, LEFT reactivated. **[D]**

### `PUT /:id/members/:userId/role` — (ADMIN only)

- **Body:** `role` MODERATOR|MEMBER (cannot assign ADMIN).
- **Positive:** 200 updated member. **[E]**
- **Negative:** 400 role=ADMIN/invalid **[E]**; 400 non-uuid userId **[E]**; 404 member not
  found **[E-mapping]**; 400 modify admin **[E-mapping / D-rule]**; (D) 400 modify self.

### `DELETE /:id/members/:userId` — kick (MODERATOR+, strict-rank)

- **Body:** `reason?` (≤500).
- **Positive:** 200; reason forwarded; empty body OK. **[E]**
- **Negative:** 400 reason >500 **[E]**; 403 peer-mod can't outrank **[E-mapping / D-rule]**;
  400 kick self **[E-mapping / D-rule]**.

### `POST /:id/members/:userId/ban` & `DELETE …/ban` — (ADMIN only)

- **Positive:** ban → 200 BANNED **[E]**; unban → 200 (→ LEFT) **[E]**.
- **Negative:** ban 403 non-admin **[E-mapping / D-rule]**; unban 404 no ban **[E-mapping]**.
- **DOCUMENTED:** ban is idempotent; unban requires status BANNED else 400. **[D]**

### `POST /:id/leave` & `POST /leave/bulk`

- **Body (single):** optional `reason` enum + `reasonText` (required when reason=OTHER).
- **Positive:** leave empty body → 200 **[E]**; reason enum → 200 **[E]**; OTHER+text → 200 **[E]**;
  bulk-leave → 200 **[E]**.
- **Negative:** 400 bad reason enum **[E]**; 400 OTHER without text (refine) **[E]**; bulk 400 empty list **[E]**.
- **DOCUMENTED:** admin sole-member leave auto-deletes community; admin-with-members → 400
  `ADMIN_CANNOT_LEAVE_COMMUNITY`. **[D]**

### `POST /:id/transfer-admin` — (ADMIN only)

- **Positive:** 200. **[E]**
- **Negative:** 400 missing userId **[E]**; 403 non-admin **[E-mapping / D-rule]**.
- **DOCUMENTED:** target must be ACTIVE non-admin; 3-step reorder (promote→transfer→demote). **[D]**

### `POST /:id/join` — (PUBLIC only → creates a join request)

- **Positive:** 201 join-request DTO. **[E]**
- **Negative:** 404 community gone **[E-mapping]**.
- **DOCUMENTED:** PRIVATE → 403 `COMMUNITY_JOIN_REQUIRES_INVITE`; SUSPENDED → 403. **[D]**

### `GET /:id/audit-logs` — (MODERATOR+)

- **Positive:** 200 paginated. **[E]**
- **Negative:** 403 non-privileged **[E-mapping / D-rule]**; 400 non-positive page **[E]**.

---

## 5. Member moderation (mute / warn)

### `POST /:id/members/:userId/mute` — (MODERATOR+, strict-rank)

- **Body:** `durationMinutes?` (1–525600, null=indefinite), `reason?` (≤500).
- **Positive:** indefinite (empty body) → 200 **[E]**; duration+reason → 200 **[E]**.
- **Negative:** 400 duration 0 / >525600 **[E]**; 403 can't moderate **[E-mapping / D-rule]**;
  404 target not found **[E-mapping]**.

### `DELETE /:id/members/:userId/mute` — unmute (MODERATOR+)

- **Positive:** 200 `data:null`. **[E]**
- **Negative:** 400 bad target uuid **[E]**.
- **DOCUMENTED:** expired-mute row treated as not-muted → 404 `COMMUNITY_MEMBER_NOT_MUTED`. **[D]**

### `GET /:id/muted-members` — (MODERATOR+)

- **Positive:** 200 paginated. **[E]**
- **Negative:** 403 non-mod **[E-mapping / D-rule]**.

### `POST /:id/members/:userId/warn` — (MODERATOR+)

- **Body:** `note` required (1–1000).
- **Positive:** 201 **[E]**; unicode/emoji note accepted **[E]**.
- **Negative:** 400 missing/blank/>1000 note **[E]**; 400 warn admin (service) **[E-mapping / D-rule]**.

### `GET /:id/members/:userId/warnings` — (MODERATOR+)

- **Positive:** 200 paginated. **[E]**

---

## 6. Join requests

### `POST /:id/join-requests`

- **Body:** `message?` (≤500).
- **Positive:** no message → 201 (null forwarded) **[E]**; with message → 201 **[E]**.
- **Negative:** 400 message >500 **[E]**; 409 already exists (service) **[E-mapping]**; 404 community gone **[E-mapping]**.
- **DOCUMENTED:** ACTIVE member → 409 `COMMUNITY_ALREADY_MEMBER`; BANNED → 403; recycles
  non-pending rows; SUSPENDED → 403. **[D]**

### `GET /:id/join-requests` — (MODERATOR+)

- **Positive:** 200; status filter forwarded (default PENDING). **[E]**
- **Negative:** 400 bad status enum **[E]**; 403 non-mod **[E-mapping / D-rule]**.

### `GET /join-requests/mine`

- **Positive:** 200 paginated. **[E]**

### `POST /:id/join-requests/:requestId/approve` — (MODERATOR+)

- **Positive:** 200 `{ request, member }`. **[E]**
- **Negative:** 404 request gone / wrong community (IDOR-safe) **[E-mapping]**; 403 non-mod **[E-mapping / D-rule]**;
  400 bad requestId **[E]**.
- **DOCUMENTED:** idempotent on APPROVED; BANNED race → closes REJECTED + 403; non-PENDING → 400;
  SUSPENDED → 403. **[D]**

### `POST /:id/join-requests/:requestId/reject` — (MODERATOR+)

- **Positive:** 200 (→ REJECTED). **[E]**
- **DOCUMENTED:** non-PENDING → 400. **[D]**

### `DELETE /:id/join-requests/:requestId` — cancel (owner only)

- **Positive:** 200 (→ CANCELLED). **[E]**
- **DOCUMENTED:** `request.userId !== caller` → 403 `COMMUNITY_JOIN_REQUEST_NOT_OWNER`; non-PENDING → 400. **[D]**

---

## 7. Direct invites

### `POST /:id/invites` — (MODERATOR+)

- **Body:** `inviteeId` uuid.
- **Positive:** 201. **[E]**
- **Negative:** 400 missing/non-uuid inviteeId **[E]**; 409 exists **[E-mapping]**; 403 non-mod **[E-mapping / D-rule]**.
- **DOCUMENTED:** self-invite → 400; ACTIVE invitee → 409; BANNED → 403; recycles non-pending. **[D]**

### `GET /:id/invites` — (MODERATOR+)

- **Positive:** 200 **[E]**. **Negative:** 400 bad status enum **[E]**.

### `GET /invites/mine`

- **Positive:** 200 paginated. **[E]**

### `POST /invites/:inviteId/accept`

- **Positive:** 200 `{ invite, member }`. **[E]**
- **Negative:** 404 not caller's invite (IDOR) **[E-mapping]**; 410 expired **[E-mapping]**; 400 bad inviteId **[E]**.
- **DOCUMENTED:** `inviteeId !== caller` → 403; idempotent on ACCEPTED; BANNED → 403; SUSPENDED → 403. **[D]**

### `POST /invites/:inviteId/decline`

- **Positive:** 200 (→ DECLINED). **[E]**
- **DOCUMENTED:** non-PENDING → 400; non-invitee → 403. **[D]**

---

## 8. Reports

### `POST /:id/reports` — (ACTIVE member only)

- **Body:** `targetUserId?` uuid, `reason` (3–1000).
- **Positive:** with target → 201 **[E]**; community-level (no target) → 201 **[E]**.
- **Negative:** 400 missing/short/long reason **[E]**; 400 non-uuid target **[E]**; 404 community gone **[E-mapping]**.
- **DOCUMENTED:** non-member → 403; self-report → 400; target member must exist → 404; OPEN dedup
  returns existing idempotently; publishes report-created + admin-ingest. **[D]**

### `GET /:id/reports` — (MODERATOR+)

- **Positive:** 200 (default OPEN). **[E]**
- **Negative:** 403 non-mod **[E-mapping / D-rule]**; 400 bad status enum (PENDING not valid) **[E]**.

### `GET /reports/mine`

- **Positive:** 200 paginated. **[E]**

### `POST /:id/reports/:reportId/{review|action|dismiss}` — (MODERATOR+)

- **Body:** `resolution?` (≤1000).
- **Positive:** review → 200 (resolution / null forwarded) **[E]**; action → 200 **[E]**; dismiss → 200 **[E]**.
- **Negative:** 400 resolution >1000 **[E]**; 400 bad reportId **[E]**; action on non-OPEN → 400
  (illegal transition) **[E-mapping / D-rule]**.
- **DOCUMENTED:** state machine OPEN→{REVIEWED,ACTIONED,DISMISSED}, REVIEWED→{ACTIONED,DISMISSED};
  terminal states 400; only ACTIONED publishes. **[D]**

### `POST /:id/reports/:reportId/withdraw` — reporter self (owner, OPEN only)

- **Positive:** 200 (→ WITHDRAWN). **[E]**
- **Negative:** 403 not the reporter (IDOR guard) **[E-mapping / D-rule]**.
- **DOCUMENTED:** non-OPEN → 400 `COMMUNITY_REPORT_NOT_OPEN`. **[D]**

### `DELETE /:id/reports/:reportId` — hard delete (MODERATOR+)

- **Positive:** 200 `data:null`. **[E]**
- **Negative:** 403 non-mod **[E-mapping / D-rule]**.

---

## 9. Mute settings / bulk / notification prefs

### `GET|PUT|DELETE /:id/mute` — (ACTIVE member)

- **Positive:** GET → 200 **[E]**; PUT duration → 200 **[E]**; PUT empty body (indefinite, null) → 200 **[E]**;
  DELETE → 200 null **[E]**.
- **Negative:** PUT 400 non-integer duration **[E]**; GET 404 not muted / not member **[E-mapping]**.
- **DOCUMENTED:** non-ACTIVE member → 403 `COMMUNITY_FORBIDDEN`. **[D]**

### `POST /mute/bulk` & `POST /read/bulk`

- **Body:** mute → `action` mute|unmute, `communityIds` (1–50 ObjectId), `durationMinutes?`.
- **Positive:** action=mute → `bulkMute` **[E]**; action=unmute → `bulkUnmute` **[E]**; read/bulk → 200 **[E]**.
- **Negative:** 400 bad action **[E]**; 400 empty/non-ObjectId ids **[E]**; read/bulk 400 >50 ids **[E]**.

### `GET|PUT /:id/notification-preferences` — (ACTIVE member)

- **Body (PUT):** ≥1 of `streamEnabled`/`chatEnabled`/`announcementEnabled` (boolean).
- **Positive:** GET → 200 **[E]**; PUT subset → 200 **[E]**.
- **Negative:** PUT 400 empty body (refine) **[E]**; 400 non-boolean **[E]**; 404 not member **[E-mapping]**.

---

## 10. Liked / favorite communities

### `GET /liked`

- **Status: BROKEN — UNREACHABLE.** Registered (route line 306) AFTER `GET /:id` (line 251);
  Express matches `liked` as `:id`, fails the ObjectId regex → **400**, never reaches the handler.
- **Test is `it.skip`-ed** documenting the bug. **[D]** (AUDIT High-3)
- **Also:** no query-schema validation on `cursor`/`limit` (controller reads raw). (AUDIT Med-4)

### `POST /:id/like` — (any ACTIVE-or-not member; not suspended)

- **Positive:** 201 favorite DTO. **[E]**
- **Negative:** 404 community gone **[E-mapping]**; 400 bad community id **[E]**.

### `DELETE /:id/like`

- **Positive:** 200 `data:null`. **[E]**

---

## 11. Uploads

### `POST /api/v1/communities/uploads/url` — presigned avatar upload

- **Body:** `type` (UPLOAD_TYPES enum — only `COMMUNITY_AVATAR`), `contentType` (non-empty),
  `contentLength` (coerced positive int).
- **Positive:** 200 with presigned URL; `ownerId` from token. **[E]**
- **Negative:** 401 no/expired token **[E]**; 400 missing/invalid type, missing/empty contentType,
  missing/zero/negative contentLength **[E]**; 400 service rejects MIME/size (415 for
  UNSUPPORTED_CONTENT_TYPE in service; tested as 400 BadRequest) **[E-mapping]**.

---

## Endpoint × status-code matrix (intended)

| Group          | 200 | 201       | 400 | 401 | 403 | 404 | 409 | 410 | 415    |
| -------------- | --- | --------- | --- | --- | --- | --- | --- | --- | ------ |
| Community CRUD | ✓   | ✓(create) | ✓   | ✓   | ✓   | ✓   | ✓   |     |        |
| Discovery      | ✓   |           | ✓   | ✓   |     |     |     |     |        |
| Members        | ✓   | ✓(add)    | ✓   | ✓   | ✓   | ✓   |     |     |        |
| Moderation     | ✓   | ✓(warn)   | ✓   | ✓   | ✓   | ✓   |     |     |        |
| Join requests  | ✓   | ✓(create) | ✓   | ✓   | ✓   | ✓   | ✓   |     |        |
| Invites        | ✓   | ✓(create) | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |        |
| Reports        | ✓   | ✓(create) | ✓   | ✓   | ✓   | ✓   |     |     |        |
| Mute / prefs   | ✓   |           | ✓   | ✓   | ✓   | ✓   |     |     |        |
| Liked          | ✓   | ✓(like)   | ✓   | ✓   |     | ✓   |     |     |        |
| Invite links   | ✓   | ✓(create) | ✓   | ✓   | ✓   | ✓   |     | ✓   |        |
| Uploads        | ✓   |           | ✓   | ✓   |     |     |     |     | ✓(svc) |
