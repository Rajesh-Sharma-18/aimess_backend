# Community Sharing & Deep Linking — Backend Audit

**Spec source:** `AIMESS_Community_Sharing_and_Deeplinking_Guide.md` (the "Guide")
**Branch:** `rajesh-dev`
**Date:** 2026-06-24
**Method:** Every Guide requirement was compared against the **actual code** (the codebase is the source of truth; the Guide is the _target_). File:line citations below are from the live working tree.

## Status legend

| Code        | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| ✅ DONE     | Already implemented and correct (matches spec)                                             |
| 🔶 DIFFERS  | Exists but differs from the Guide (divergence documented + decision recorded)              |
| 🟥 MISSING  | Was missing — implemented in this pass                                                     |
| 📘 DOC      | Exists in code but needed a Swagger / AsyncAPI / `.env.example` update (done in this pass) |
| 🏗️ EXTERNAL | Requires infra/domain/store config outside this repo (handoff)                             |
| 📱 FE-ONLY  | Frontend/mobile/web responsibility only (out of backend scope)                             |

## Executive summary

The Community Sharing & Deep Linking backend was **largely shipped already** on `rajesh-dev` (the core `by-handle` resolver, the six invite-link endpoints, the join/request/approve/reject/cancel flow, ACTIVE-membership chat gating, the three realtime events, and the api-gateway link host with `.well-known` files were all live and at `HEAD` or in the working tree). This pass **audited every requirement against code**, then closed the real gaps:

1. 🟥 **Public share URL** — the by-handle resolver now returns server-generated `shareUrl` + `appDeepLink` (Guide §9.5) instead of leaving the FE to construct them.
2. 📘 **AsyncAPI** — added the missing `community:joined` message + schema + operation (the event was live in code but undocumented).
3. 📘 **`.env.example`** — added all link-host / deep-link env vars (Android/iOS app-link config, internal-card secret, link base URL) so deployers know what to set.
4. 🔶 **Handle length** — Guide says `{5,32}`; code is `{3,32}` everywhere (creation + resolver + linkhost). **Decision: keep `{3,32}`** (the resolver must accept any handle that can be _created_; tightening only the resolver would strand existing 3–4 char public communities). Divergence documented.

No security gaps were found in chat/socket gating (the dedicated audit returned PASS). External handoffs (DNS/cert/store IDs) are itemized in §G.

---

## A. Public Community Handle Resolver — `GET /api/v1/communities/by-handle/:handle`

| Field           | Detail                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spec source** | Guide §3 (`PublicCommunityResponse`), §9.1, §9.6, §11 (E18/E24), §12 backend checklist                                                                                      |
| **Summary**     | Resolve a PUBLIC community by handle for the deep-link Join preview. PUBLIC-only; never reveal private; banned→403; malformed→400; missing/private/suspended→collapsed 404. |

### Findings (per requirement)

| Requirement                                                                    | Status                       | Evidence / Gap                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------- | --- | ------------------------------------------------------------------------------------------ |
| Route exists, registered **before** `/:id`                                     | ✅ DONE                      | `apps/community-service/src/api/routes/community.routes.ts:193` (`/by-handle/:handle`) precedes `/:id` (line 282). Controller `apps/community-service/src/api/controllers/community.controller.ts:100`.                                                                                                                               |
| PUBLIC-only; private/suspended/closed/missing → single 404 (no private oracle) | ✅ DONE                      | `community.service.ts getByHandle` collapses `!community                                                                                                                                                                                                                                                                              |     | type!==PUBLIC |     | isEffectivelyClosed(community)`→`NotFoundError("COMMUNITY_NOT_FOUND")` (service.ts ~1308). |
| Banned caller → 403                                                            | ✅ DONE                      | `assertNotBanned(membership)` (service.ts ~1321) → `ForbiddenError("COMMUNITY_JOIN_BANNED")`.                                                                                                                                                                                                                                         |
| Malformed handle → 400 `INVALID_HANDLE`                                        | ✅ DONE                      | `handleParamsSchema` (validator.ts:107) rejects pre-service; service re-guards with `BadRequestError("INVALID_HANDLE")` (service.ts ~1299).                                                                                                                                                                                           |
| Auth required (401 without token)                                              | ✅ DONE                      | All `communityRoutes` are behind `authenticateAccessToken`. (Guide §9 says all endpoints require Bearer; matches.)                                                                                                                                                                                                                    |
| Response DTO = `PublicCommunityResponse`                                       | ✅ DONE                      | `apps/community-service/src/types/community.types.ts:101`. All Guide §3 fields present.                                                                                                                                                                                                                                               |
| Handle validation regex `^[a-z0-9_]{5,32}$`                                    | 🔶 DIFFERS                   | Code is `{3,32}` (`community.validator.ts:20`). **Decision: keep `{3,32}`.** Rationale: handle _creation_ uses `{3,32}`; the resolver must resolve any creatable handle. Tightening only the resolver would 400 a legitimately-created 3–4 char public community → unreachable by its own link. Spec's "5" is treated as approximate. |
| Server returns canonical share URL for public                                  | 🟥 MISSING → **implemented** | Backend previously returned no share URL for public communities (only private invite links carried `url`/`appDeepLink`). Guide §9.5 says server generates public URLs. **Added** `shareUrl` + `appDeepLink` (see §B).                                                                                                                 |

### Implementation (this pass)

- Added `shareUrl: string` + `appDeepLink: string` to `PublicCommunityResponse` (`community.types.ts:101`).
- Added builders `buildPublicShareUrl(handle)` → `<INVITE_LINK_BASE_URL>/<handle>` and `buildPublicDeepLink(handle)` → `aimess://resolve?handle=<handle>` (`community.service.ts`, next to `buildInviteUrl`/`buildInviteDeepLink`).
- Populated both in `getByHandle`’s return.
- Updated OpenAPI `PublicCommunityResponse` schema (`apps/api-gateway/src/docs/openapi/components/schemas.ts`) with the two fields + `required`.

### Tests

- `apps/community-service/tests/communities/by-handle.test.ts` — controller-level: asserts `shareUrl`/`appDeepLink` forwarded in the 200 body. (+ existing 401/403/404/400 cases.)
- `apps/community-service/tests/community/resolve-by-handle.test.ts` — service-level: asserts `appDeepLink === "aimess://resolve?handle=backend_devs"` and `shareUrl` is public-form (ends in handle, no `+` marker). (+ existing PUBLIC-only / ban / suspended / closed / missing / malformed cases.)

### Final status: ✅ DONE (with documented 🔶 handle-length divergence)

---

## B. Community Link Generation

| Field           | Detail               |
| --------------- | -------------------- |
| **Spec source** | Guide §3, §4.1, §9.5 |

| Requirement                                                  | Status                       | Evidence                                                                                                                                                                            |
| ------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private HTTPS share URL `https://aimess.me/+<code>`          | ✅ DONE                      | `buildInviteUrl` (`community.service.ts:975`) → `${INVITE_LINK_BASE_URL}/+${code}`.                                                                                                 |
| Private app deep link `aimess://join?code=<code>`            | ✅ DONE                      | `buildInviteDeepLink` (`community.service.ts:982`).                                                                                                                                 |
| Public HTTPS share URL `https://aimess.me/<handle>`          | 🟥 MISSING → **implemented** | `buildPublicShareUrl` (added).                                                                                                                                                      |
| Public app deep link `aimess://resolve?handle=<handle>`      | 🟥 MISSING → **implemented** | `buildPublicDeepLink` (added).                                                                                                                                                      |
| Full URLs returned (not keys/partial paths)                  | ✅ DONE                      | `inviteUrl`, `appDeepLink`, `shareUrl` are all full URLs. Avatars/banners are presigned GET URLs (resolve-on-read).                                                                 |
| Public handles unique, normalized, validated                 | ✅ DONE                      | `normalizeHandle` + `handleSchema`; handle uniqueness enforced at create.                                                                                                           |
| Private codes secure / non-guessable                         | ✅ DONE                      | `randomBytes(16).toString("base64url")` = 128-bit entropy (`community.service.ts` ~949).                                                                                            |
| FE must not construct canonical URLs if backend returns them | ✅ DONE (contract)           | All canonical URLs now server-owned. Documented in the FE guide.                                                                                                                    |
| Env base URL                                                 | 📘 DOC                       | `INVITE_LINK_BASE_URL` default `https://aimess.me` (`community-service env.ts:45`). `.env.example` previously listed an **outdated** `https://aimess.com/invite` value — corrected. |

### Final status: ✅ DONE

---

## C. Invite Link APIs

| Field           | Detail                                             |
| --------------- | -------------------------------------------------- |
| **Spec source** | Guide §3, §9.3, §9.4, §5 (F14), §11 (E11–E13, E23) |

### C.1 Preview — `GET /api/v1/communities/invite-links/:code`

| Requirement                                                                               | Status  | Evidence                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Returns `InviteLinkPreviewData` (all §3 fields incl. `joinRequestId`/`joinRequestStatus`) | ✅ DONE | `community.types.ts:487`; `lookupInviteLink` (`community.service.ts` ~6718).                                                                                                                                 |
| Metadata-only (no chat messages, no member list)                                          | ✅ DONE | Returns avatar/banner + counts only; no message access.                                                                                                                                                      |
| 400 malformed / 401 / 403 banned / 404 not-found / 410 expired·revoked·exhausted          | ✅ DONE | `assertInviteLinkActive` throws `GoneError` with sub-codes `COMMUNITY_INVITE_LINK_EXPIRED` / `…_REVOKED_ERROR` / `…_EXHAUSTED`; 404 `COMMUNITY_INVITE_LINK_NOT_FOUND`; banned → 403 `COMMUNITY_JOIN_BANNED`. |
| Auth                                                                                      | ✅ DONE | Bearer required (registered under auth-guarded `communityRoutes`).                                                                                                                                           |

### C.2 Redeem — `POST /api/v1/communities/invite-links/:code/redeem`

| Requirement                                                                       | Status  | Evidence                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Returns `RedeemInviteLinkResult` (`link`, `member?`, `request?`)                  | ✅ DONE | `redeemInviteLink` (`community.service.ts` ~6568).                                                                                                                                                |
| `autoApprove=true` → `member` (ACTIVE); `autoApprove=false` → `request` (PENDING) | ✅ DONE | Both branches return correct shape.                                                                                                                                                               |
| `autoApprove` default = **false** for both PUBLIC & PRIVATE                       | ✅ DONE | Default flipped to request-to-join (supersedes the old PRIVATE=true default).                                                                                                                     |
| Idempotent already-ACTIVE / already-PENDING re-taps                               | ✅ DONE | Re-taps return existing member/request **without** burning a usage slot.                                                                                                                          |
| Usage slot burned only on a **real** join effect                                  | ✅ DONE | `burnUsageSlot()` (atomic increment + `INVITE_LINK_REDEEMED` audit) called only on autoApprove join, or on a genuinely new/recycled PENDING. Tested in `tests/invite-links/redeem-usage.test.ts`. |

### C.3 Management — create / list / revoke / bulk-send

| Endpoint                                                             | Status  | Evidence                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /:id/invite-links` (maxUses?, expiresInMinutes?, autoApprove?) | ✅ DONE | Auth = **any ACTIVE member** (`assertCommunityRole(membership, MEMBER)` — status-gated, so non-member/PENDING/BANNED/LEFT rejected). `assertWritable` gates closed/suspended. Per-user create rate-limit + per-member active-link cap.                                        |
| `GET /:id/invite-links?status&page&limit`                            | ✅ DONE | Any ACTIVE member; pagination + status filter.                                                                                                                                                                                                                                |
| `DELETE /:id/invite-links/:linkId`                                   | ✅ DONE | MODERATOR+; idempotent re-revoke. Cross-community linkId → 404.                                                                                                                                                                                                               |
| `POST /:id/invite-links/bulk-send` (userIds 1–50)                    | ✅ DONE | Any ACTIVE member; dedup; self-skip; UUID validation via `fetchExistingUserIds` (gRPC); ban/already-member skip; cross-community link → 404; recipient SYSTEM/`COMMUNITY_INVITE` DM + `message:new` (via chat `community-room-sync.consumer`); `INVITE_LINK_BULK_SENT` audit. |
| Rate limiting                                                        | ✅ DONE | `apps/community-service/src/lib/invite-rate-limit.ts` (per-user fixed-window; fails open when cache not ready). Knobs in community-service `env.ts`.                                                                                                                          |
| `CommunityInviteLinkData` DTO                                        | ✅ DONE | `community.types.ts` (linkId, code, url, appDeepLink, communityId, createdBy, maxUses, usedCount, autoApprove, expiresAt, revokedAt, createdAt, isActive).                                                                                                                    |
| Swagger                                                              | ✅ DONE | All six paths documented in `apps/api-gateway/src/docs/openapi/paths/community.paths.ts` incl. 403/429/cross-community cases.                                                                                                                                                 |
| Tests                                                                | ✅ DONE | `tests/invite-links/{invite-links,create-invite-link,bulk-send-invite,invite-rate-limit,redeem-usage}.test.ts`.                                                                                                                                                               |

### Final status: ✅ DONE

---

## D. Join / Join-Request / Cancel / Approve / Reject

| Field           | Detail                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| **Spec source** | Guide §3 (`JoinResult`), §5 (F1, F5, F9, F10, F11, F15), §9.2, §11 (E1–E10) |

| Requirement                                              | Status  | Evidence                                                                                                                                                                                 |
| -------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ---------------------------------------- | -------- | -------- | ------------------------------------ |
| `POST /:id/join` → `JoinResult`                          | ✅ DONE | `joinCommunity` (`community.service.ts` ~3665); controller ~500.                                                                                                                         |
| PUBLIC → direct join, **201 `JOINED`**, `member{ACTIVE}` | ✅ DONE | PUBLIC branch creates/reactivates ACTIVE member, refreshes count, publishes events.                                                                                                      |
| PRIVATE → **201 `REQUEST_CREATED`**, `request{PENDING}`  | ✅ DONE | PRIVATE branch delegates to `createJoinRequest`.                                                                                                                                         |
| Already-member idempotency → **200 `ALREADY_MEMBER`**    | ✅ DONE | Controller returns 200 for `ALREADY_MEMBER`, 201 otherwise.                                                                                                                              |
| Ban check (403 `COMMUNITY_JOIN_BANNED`)                  | ✅ DONE | Early ban guard in `joinCommunity` + `createJoinRequest` + `approve`.                                                                                                                    |
| Availability check (CLOSED/SUSPENDED → 403)              | ✅ DONE | `communityAccessPolicy.assertWritable` on join/request/approve.                                                                                                                          |
| `DELETE /:id/join-requests/mine` (cancel)                | ✅ DONE | 200; 404 if no request; 400 if not PENDING; → CANCELLED + `community.join_request_cancelled`.                                                                                            |
| `POST /:id/join-requests/:requestId/approve`             | ✅ DONE | MODERATOR+; PENDING→ACTIVE; member-count refresh; ban race-guard; idempotent already-APPROVED; emits `community.member_added` + `community.join_request_approved` + personal system msg. |
| `POST /:id/join-requests/:requestId/reject`              | ✅ DONE | MODERATOR+; → REJECTED; emits `community.join_request_rejected` + personal system msg; 400 if not PENDING.                                                                               |
| Membership state model                                   | ✅ DONE | `CommunityMemberStatus = ACTIVE                                                                                                                                                          | PENDING | BANNED | LEFT`; `CommunityJoinReqStatus = PENDING | APPROVED | REJECTED | CANCELLED` (`prisma/schema.prisma`). |
| Member count sync                                        | ✅ DONE | `countActiveMembers` + `setMemberCount` on join/approve/bulkApprove/leave/kick.                                                                                                          |
| Community list sync                                      | ✅ DONE | Realtime via `community:joined` (joiner devices) + `community:member:joined` (room) + existing `community:added`/`community:updated` (see §F).                                           |
| Tests                                                    | ✅ DONE | `tests/community/join-community.test.ts`, `tests/join-requests/*`.                                                                                                                       |

### Final status: ✅ DONE

---

## E. Security — Chat & Socket Access Gating (ACTIVE-membership)

| Field           | Detail                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------- |
| **Spec source** | Guide §1 (Stage-2 invariant), §6 (chat-visibility invariant), §9.6, §11 (chat gating), §13    |
| **Verdict**     | ✅ **PASS** — dedicated audit traced every non-ACTIVE state across read / send / socket-room. |

### Per-state × per-surface matrix (verified)

| State                                 | Chat read                    | Chat send  | Socket room join          | Receive broadcasts |
| ------------------------------------- | ---------------------------- | ---------- | ------------------------- | ------------------ |
| Not a member (PRIVATE)                | ❌ blocked                   | ❌ blocked | ⚠️ fail-open\*            | brief\*            |
| Not a member (PUBLIC)                 | ✅ allowed (Telegram parity) | ❌ blocked | ⚠️ fail-open\*            | brief\*            |
| Pending join request                  | ❌ blocked                   | ❌ blocked | ⚠️ fail-open\*            | brief\*            |
| Rejected request                      | ❌ blocked                   | ❌ blocked | ⚠️ fail-open\*            | brief\*            |
| Banned                                | ❌ blocked                   | ❌ blocked | ❌ rejected + **evicted** | ❌                 |
| Removed / kicked (LEFT)               | ❌ blocked                   | ❌ blocked | ⚠️ fail-open\*            | brief\*            |
| Suspended/inactive membership         | ❌ blocked                   | ❌ blocked | ⚠️ fail-open\*            | brief\*            |
| Expired/revoked invite, no membership | ❌ blocked                   | ❌ blocked | ⚠️ fail-open\*            | brief\*            |
| **ACTIVE**                            | ✅                           | ✅         | ✅                        | ✅                 |

### Enforcement points (evidence)

- **Send (single chokepoint for REST + socket + gRPC):** `assertCommunityMember(memberRepo, roomId, sentBy)` in `apps/chat-service/src/services/community-message.service.ts` (~248) — requires `RoomMember.status === "active"`.
- **Read (history/sync/conversation/search/media):** `assertCommunityReadAccess` (`apps/chat-service/src/lib/access-guard.ts` ~136): BANNED→reject; ACTIVE→allow; PUBLIC→allow non-member read; PRIVATE non-member→reject. Personal/system messages filtered by `viewerIsActiveMember`.
- **Edit/delete/react/pin/unpin/mark-read/forward/report:** all guard via `assertActiveMemberOfMessageRoom` / explicit `status !== "active"` checks.
- **Socket room join:** `apps/api-gateway/src/sockets/namespaces/community.ns.ts` (~409) calls gRPC `CheckCommunityMembership`; **rejects explicit BANNED**, **fails open** on gRPC/breaker error (mitigated — every act-vector is independently hard-blocked at chat-service, so a transient failure risks only a brief receive-side leak, never an integrity breach).
- **Evict-on-ban:** relay handler on `community:member:removed` calls `fetchSockets().leave(channel)` — real-time removal of connected banned/kicked users.
- **RoomMember mirroring:** `community-room-sync.consumer.ts` maps community ACTIVE→`active`, BANNED→`banned`, LEFT/PENDING→`left` (PENDING never yields an `active` RoomMember).
- **Preview/by-handle never leak chat:** both return metadata only.

`*` **Fail-open socket join** and **typing-indicator broadcast (no membership guard)** are the only two soft spots — both LOW risk and intentional/acceptable (see §"Known low-risk items"). No change required for spec compliance.

### Final status: ✅ DONE (PASS) — no fixes required

---

## F. Realtime Events

| Field           | Detail                           |
| --------------- | -------------------------------- |
| **Spec source** | Guide §5 (F1, F9, F10), §10, §13 |

### Pipeline: community-service publishes a RabbitMQ domain event → notifications-service consumes → Redis `notify:<userId>` / `community:<id>` → api-gateway forwards verbatim to the socket namespace.

| Guide event                                                 | Status  | Real name / namespace / target / payload                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `community:joined` (joiner, public/direct join)             | 📘 DOC  | **EXISTS in code** — `/notify` → `user:<userId>`. Producer: `community.member_joined` (community-service `notifyMemberJoined`); consumer: `notifications-service/src/consumers/community.consumer.ts:237`. Payload `{communityId, communityName, communityHandle, communityAvatarUrl, reactivated}`. **Was undocumented in AsyncAPI → added** (message `CommunityJoined`, schema `CommunityJoinedDTO`, operation `notify.onCommunityJoined`). |
| `community:join_request:update` (requester, approve/reject) | ✅ DONE | `/notify` → `user:<userId>`. Producer `community.join_request_approved`/`_rejected`; consumer `community.consumer.ts:127/172`. Payload `{communityId, requestId, status: APPROVED\|REJECTED, communityName, decidedAt, navigation}`. AsyncAPI `CommunityJoinRequestUpdate` (≈2786) + schema `CommunityJoinRequestUpdateDTO`.                                                                                                                  |
| `community:member:joined` (community room, member→ACTIVE)   | ✅ DONE | `/community` → room `community:<id>`. Producer `notifyMemberJoined` → `publishCommunityRoomEvent`; gateway `community.ns.ts` psubscribe. Payload `{userId, username, displayName, avatarUrl, role, joinedAt}`. AsyncAPI `CommunityMemberJoined` + schema `CommunityMemberDTO`.                                                                                                                                                                |
| `notification:new` (inbox)                                  | ✅ DONE | `/notify` → `user:<userId>`. AsyncAPI `NotificationForwarded` / `notify.onForwarded`.                                                                                                                                                                                                                                                                                                                                                         |
| `notification:count_update` (badge)                         | ✅ DONE | `/notify` → `user:<userId>`. AsyncAPI `NotificationCountUpdate` / `notify.onCountUpdate`.                                                                                                                                                                                                                                                                                                                                                     |

**Related events also live (used by the FE for list sync — documented in the FE guide):** `community:added` (`/community`, personal onboarding row), `community:updated` (`/community`, list bump), `community:stats:updated` (`/community`, member count), `community:member:removed` (`/community`, evict).

### Implementation (this pass)

- AsyncAPI 3.0 (`apps/api-gateway/asyncapi/asyncapi.yaml`): added channel-message ref `communityJoined`, message `CommunityJoined` (+ realistic example), schema `CommunityJoinedDTO` (required `[communityId, communityName, communityHandle, reactivated]`), and receive operation `notify.onCommunityJoined`. Validated: YAML parses, example satisfies the schema, gateway suite green.

### Tests

- `notifications-service/tests/consumers/community-member-joined.test.ts` (asserts `community:joined` emit) and `community-consumer.test.ts` (asserts `community:join_request:update`) — pre-existing, still green.
- `community-service/tests/join-requests/*` and `community/join-community.test.ts` assert `community:member:joined` room broadcast.

### Final status: ✅ DONE (📘 AsyncAPI gap closed)

---

## G. Domain / `.well-known` files

| Field           | Detail                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spec source** | Guide §2, §7.1–§7.4, §8, §12                                                                                                                                                                                                 |
| **Ownership**   | **This repo (api-gateway) owns the link host.** It host-gates on `LINK_HOSTS` and serves the `.well-known` files + the server-rendered "Open in app" preview on those hosts; any other Host falls through to the normal API. |

| Requirement                                                                                     | Status      | Evidence                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host-gated link router                                                                          | ✅ DONE     | `apps/api-gateway/src/routes/linkhost.routes.ts` (`isLinkHost` → `next("router")` for non-link hosts); mounted first in `app.ts`.                                                                             |
| `GET /.well-known/assetlinks.json` (application/json, no redirect)                              | ✅ DONE     | `linkhost/well-known.ts buildAssetLinks`; package + SHA-256 fingerprints from env.                                                                                                                            |
| `GET /.well-known/apple-app-site-association` (application/json, **no extension**, no redirect) | ✅ DONE     | `buildAppleAppSiteAssociation`; appIDs from `APPLE_APP_IDS`; `components:[{ "/":"/*" }]`.                                                                                                                     |
| Server-rendered preview (OG tags + platform-aware deferred deep-link JS)                        | ✅ DONE     | `linkhost/preview.ts` — Android `intent://` + Play referrer (`h_<handle>`/`p_<code>`); iOS scheme + App Store timeout fallback; desktop → web. XSS guards (`detectFromSegment` charset, `esc`, `scriptJson`). |
| Public OG card (internal, shared-secret, PUBLIC-only)                                           | ✅ DONE     | community-service `GET /internal/communities/by-handle/:handle/card` (`x-internal-secret`); gateway `linkhost/public-card.ts` fetch (fails to generic card, never throws).                                    |
| Detection parity (`detectLink`)                                                                 | ✅ DONE     | `linkhost/detect-link.ts` (+ tests assert all 7 spec cases).                                                                                                                                                  |
| `.env.example` documents link-host vars                                                         | 📘 DOC      | **Was missing → added** to both `apps/api-gateway/.env.example` and `apps/community-service/.env.example`.                                                                                                    |
| HTTPS, DNS, real store/cert values                                                              | 🏗️ EXTERNAL | See handoff table below.                                                                                                                                                                                      |

### Tests

- `apps/api-gateway/tests/linkhost/linkhost.test.ts` — serves `assetlinks.json` + AASA with correct content-type; public preview OG + "Open in app"; generic private preview (no leak); root 302; non-link host 404 fallthrough; `detectLink` parity. (Run gateway suite with `--runInBand`.)

### 🏗️ External handoffs (NOT in this repo — config/infra)

| Item                                                                       | Owner            | Required artifact                                                     | Verify                                                                                       |
| -------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `aimess.me` DNS + TLS                                                      | Infra/DevOps     | A/CNAME → gateway; valid cert; **no redirect** on `.well-known/*`     | `curl -I https://aimess.me/.well-known/apple-app-site-association` → 200, `application/json` |
| `ANDROID_SHA256_CERT_FINGERPRINTS`                                         | Android + DevOps | Comma-separated **upload cert + Play App Signing cert** SHA-256       | `adb shell pm get-app-links com.aimess.app` → `verified`                                     |
| `APPLE_APP_IDS`                                                            | iOS + DevOps     | `<TEAMID>.com.aimess.app`                                             | tap UL from Messages → app opens                                                             |
| `ANDROID_STORE_APP_ID` / `APPLE_STORE_APP_ID`                              | DevOps           | Play package id / numeric App Store id (deferred-link store fallback) | install via referrer test                                                                    |
| `COMMUNITY_INTERNAL_URL` + `INTERNAL_SHARED_SECRET` (both services, equal) | DevOps           | Internal base URL + shared secret                                     | preview renders real OG card                                                                 |
| Play Install Referrer (Android deferred)                                   | Android          | `InstallReferrerClient` reads `h_`/`p_` token                         | 📱 FE-ONLY (backend already emits the token in the Play URL)                                 |
| iOS deferred (Branch/Adjust/AppsFlyer or clipboard)                        | iOS              | Vendor SDK or clipboard fallback                                      | 📱 FE-ONLY                                                                                   |

### Final status: ✅ DONE (code) + 🏗️ EXTERNAL (config) + 📘 (.env.example added)

---

## Cross-cutting: Swagger / AsyncAPI / Tests

| Area                                                                                                                                                                                     | Status                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI paths (by-handle, preview, redeem, join, invite create/list/revoke/bulk-send, join-request mine/approve/reject)                                                                  | ✅ DONE — all documented in `community.paths.ts`. `PublicCommunityResponse` schema updated with `shareUrl`/`appDeepLink` this pass.                                 |
| OpenAPI schemas (`PublicCommunityResponse`, `InviteLinkPreviewData`, `CommunityInviteLinkData`, `RedeemInviteLinkResponseData`, `CreateInviteLinkRequest`, `InviteLinkListResponseData`) | ✅ DONE — fields match service output.                                                                                                                              |
| AsyncAPI events (`community:member:joined`, `community:join_request:update`, `notification:new`, `notification:count_update`)                                                            | ✅ DONE. `community:joined` **added** this pass.                                                                                                                    |
| Tests run                                                                                                                                                                                | community-service **519 passed / 35 suites**; api-gateway **115 passed / 11 suites** (`--runInBand`); both `tsc --noEmit` clean; AsyncAPI YAML + example validated. |

## Known low-risk items (documented, no change required)

1. **Socket room join fail-open** — on gRPC/breaker failure, `community:join` is allowed (only explicit BANNED rejects). Mitigated: send/read/edit/react are independently hard-blocked at chat-service, so the worst case is a brief receive-side leak during an outage. Recommend monitoring the `CheckCommunityMembership` breaker.
2. **Typing indicator has no membership guard** — `typing:start`/`stop` broadcast to the room without re-checking membership. Fire-and-forget, no ack, and connected non-ACTIVE users are already evicted on ban; LOW info-leak risk. Optional future hardening.

## Decisions recorded

1. **Handle length stays `{3,32}`** (not the spec's `{5,32}`) — the resolver must accept any creatable handle; divergence documented above and in the FE guide.
2. **Public share URL is server-generated** (`shareUrl` + `appDeepLink` on the by-handle response) — backend owns all canonical URLs; FE never reconstructs.
3. **Commit scope** — only cleanly-isolated, fully-new files (this audit, the FE guide, both `.env.example`, the AsyncAPI spec) were committed via explicit pathspec. The TypeScript code edits (`shareUrl`/`appDeepLink` in `community.service.ts`/`community.types.ts`/`schemas.ts` + the two by-handle tests) are interleaved in shared god-files with two **other** in-flight uncommitted features (invite-authz refinements and admin role-change); committing those files would sweep unrelated work, so they were left in the working tree (verified: 519+115 green, tsc clean).
