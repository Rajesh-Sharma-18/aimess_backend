# Community Sharing & Deep Linking — Frontend Integration Guide

**Audience:** Frontend (web), Android, iOS engineers.
**Status:** Reflects the **final backend implementation** on `rajesh-dev` (not the spec assumptions). Where the original spec (the "Guide") and the real backend differ, this document follows the **backend**.
**Base URL:** all REST is via the api-gateway under `/api/v1`. All endpoints require `Authorization: Bearer <accessToken>` unless stated.

> ⚠️ **Three corrections vs the original spec — read these first**
>
> 1. **Error bodies have no machine-readable `error`/`code` field.** Community endpoints return `{ "success": false, "message": "<localized human text>" }`. **Branch on the HTTP status code**, not on a body code. Display `message` to the user. (The spec's `data.error: "..."` shape does not exist here.)
> 2. **Handle format is `^[a-z0-9_]{3,32}$`** (min **3**, not 5). The local `+`-prefix detection rule is unchanged.
> 3. **Public share URLs are now server-generated.** The by-handle resolver returns `shareUrl` + `appDeepLink`. Use them verbatim; do not reconstruct.

---

## 1. Feature overview

AIMESS uses one dedicated link domain, `aimess.me` (Telegram-style), where a single `+` prefix separates public from private:

```
PUBLIC   →  https://aimess.me/<handle>     → JOIN directly (instant ACTIVE membership)
PRIVATE  →  https://aimess.me/+<code>      → REQUEST to join (no chat until approved*)
```

`*` unless the invite link was created with `autoApprove:true`, in which case redeem makes you ACTIVE immediately.

- **Public community sharing** — share `https://aimess.me/<handle>`. Anyone can resolve it (auth required), preview metadata, and **Join** directly → instantly ACTIVE.
- **Private invite-link sharing** — moderators/members create a code link `https://aimess.me/+<code>`. Recipients preview **metadata only** and **Request to Join** (or join instantly if `autoApprove`).
- **Direct join vs join request** — PUBLIC `POST /join` → `JOINED`. PRIVATE `POST /join` (or invite `redeem` with `autoApprove:false`) → `REQUEST_CREATED` (PENDING).
- **When chat is accessible** — **only when the backend confirms ACTIVE membership** (`isJoined:true` / a `member{status:"ACTIVE"}` / the `community:joined` or `community:join_request:update{APPROVED}` socket event). Never render chat or join the chat socket room for PENDING/REJECTED/BANNED/non-member.
- **URL formats** (server-owned, returned in responses):
  | | HTTPS share | App deep link |
  |---|---|---|
  | Public | `https://aimess.me/<handle>` (`shareUrl`) | `aimess://resolve?handle=<handle>` (`appDeepLink`) |
  | Private | `https://aimess.me/+<code>` (`inviteUrl`) | `aimess://join?code=<code>` (`appDeepLink`) |

### Two-stage rule (enforce on all clients)

- **Stage 1 (local):** the `+` prefix decides which preview screen to show instantly, before any network call.
- **Stage 2 (server):** the resolver/preview response is authoritative for `type`/`communityType`, membership, ban, and dead-link state. **Chat renders only when the server confirms ACTIVE.**

### Local link detection (unchanged from spec §4.2)

```
https://aimess.me/<seg>   → seg startsWith "+" ? PRIVATE(code=seg.slice(1)) : PUBLIC(handle=seg)
aimess://join?code=<c>    → PRIVATE(code=c)
aimess://resolve?handle=<h> → PUBLIC(handle=h)
```

Handle charset for validation: `^[a-z0-9_]{3,32}$`. Code charset: `^[A-Za-z0-9_-]{1,100}$` (base64url; the `+` is a URL marker, strip it).

---

## 2. API reference

> **Success envelope:** `{ "success": true, "message": "<localized>", "data": <T> }`
> **Error envelope:** `{ "success": false, "message": "<localized>" }` — **no code field; use the HTTP status.**
> Timestamps: `createdAt`/`expiresAt` etc. are **ISO-8601 strings** in REST DTOs, except where a field is documented as epoch ms. Avatars/banners are **presigned GET URLs** (already resolved — never persist them).

### 2.1 `GET /api/v1/communities/by-handle/:handle` — public resolver

- **Auth:** required. **Authorization:** any authenticated user.
- **Params:** `handle` `^[a-z0-9_]{3,32}$`.
- **PUBLIC only** — a private/suspended/closed/missing handle returns a single 404 (no private-existence oracle).

**Request**

```http
GET /api/v1/communities/by-handle/photography_club
Authorization: Bearer <accessToken>
```

**200 response** (`PublicCommunityResponse`)

```json
{
  "success": true,
  "message": "OK",
  "data": {
    "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
    "handle": "photography_club",
    "name": "Photography Club",
    "description": "Lens nerds welcome",
    "avatarUrl": "https://cdn…/avatar.png?sig=…",
    "bannerUrl": null,
    "memberCount": 1280,
    "type": "PUBLIC",
    "shareUrl": "https://aimess.me/photography_club",
    "appDeepLink": "aimess://resolve?handle=photography_club",
    "isJoined": false,
    "role": null,
    "isBanned": false
  }
}
```

**Statuses:** `200` ok · `400` malformed handle · `401` no/invalid token · `403` caller banned · `404` not found / private / suspended.
**Idempotency:** safe GET; repeat freely.
**FE action after success:** drive the button from `isJoined`/`role` (see §5). Use `shareUrl`/`appDeepLink` for the Share sheet — do not build URLs yourself.

### 2.2 `POST /api/v1/communities/:id/join` — direct join / request

- **Auth:** required. **Authorization:** any non-banned user; community must be ACTIVE (not CLOSED/SUSPENDED).

**Request:** no body needed.
**Responses** (`CommunityJoinResult`):

```jsonc
// 201 — PUBLIC direct join
{ "success": true, "data": { "status": "JOINED", "membershipStatus": "ACTIVE", "member": { "userId":"…","role":"MEMBER","status":"ACTIVE","joinedAt":"2026-06-24T…", … } } }
// 201 — PRIVATE via this endpoint
{ "success": true, "data": { "status": "REQUEST_CREATED", "membershipStatus": "PENDING", "request": { "requestId":"…","status":"PENDING","createdAt":"…", … } } }
// 200 — already a member (idempotent)
{ "success": true, "data": { "status": "ALREADY_MEMBER", "membershipStatus": "ACTIVE", "member": { … } } }
```

**Statuses:** `201` JOINED/REQUEST_CREATED · `200` ALREADY_MEMBER · `403` banned / closed / suspended · `404` not found.
**Idempotency:** ✅ re-calling when already ACTIVE returns `200 ALREADY_MEMBER` (treat as joined). Re-calling a PRIVATE join when already PENDING recycles/returns the same PENDING request.
**FE action:** on `JOINED`/`ALREADY_MEMBER` → button `PUBLIC_OPEN`, add to My Communities, `memberCount+1`, you may join the chat room. On `REQUEST_CREATED` → `PRIVATE_REQUESTED`, chat stays hidden.

### 2.3 `GET /api/v1/communities/invite-links/:code` — private preview

- **Auth:** required. **Metadata-only** (never returns messages).

**200 response** (`InviteLinkPreviewData`)

```json
{
  "success": true,
  "message": "OK",
  "data": {
    "communityId": "6843e1a2b5c3d4e5f6a7b8c9",
    "communityName": "Secret Roasters",
    "description": "invite-only",
    "avatarUrl": "https://cdn…?sig=…",
    "bannerUrl": null,
    "memberCount": 42,
    "communityType": "PRIVATE",
    "isJoined": false,
    "joinRequestId": null,
    "joinRequestStatus": null,
    "invitationCode": "AbC123…",
    "inviteUrl": "https://aimess.me/+AbC123…",
    "appDeepLink": "aimess://join?code=AbC123…",
    "expiresAt": 1751000000000,
    "creatorId": "…"
  }
}
```

**Statuses:** `200` ok · `400` malformed code · `401` · `403` banned · `404` not found / invalid code · `410` dead link (expired / revoked / exhausted).
**410 sub-reasons:** the HTTP status is `410` for all three; the **localized `message`** differs ("expired" / "revoked" / "usage limit"). The FE can **display `message`** but cannot programmatically distinguish the three from the body. If you must distinguish, treat all 410s as `LINK_DEAD` and show `message`.
**FE action:** drive button from `isJoined` + `joinRequestStatus` (see §5). Render metadata + lock badge; **chat hidden**.

### 2.4 `POST /api/v1/communities/invite-links/:code/redeem` — redeem

- **Auth:** required.

**200 response** (`RedeemInviteLinkResult`) — handle **both** shapes:

```jsonc
// autoApprove:true → immediate ACTIVE membership
{ "success": true, "data": { "link": { … }, "member": { "memberId":"…","status":"ACTIVE" } } }
// autoApprove:false (default) → pending request
{ "success": true, "data": { "link": { … }, "request": { "requestId":"…","status":"PENDING" } } }
```

**Statuses:** `200` · `401` · `403` banned · `404` not found · `410` dead link.
**Idempotency:** ✅ already-ACTIVE returns `member` again (no usage burn); already-PENDING returns `request` again (no usage burn). A usage slot is consumed only on a genuinely new join effect.
**FE action:** `member` present → `PRIVATE_OPEN` (chat allowed). `request` present → `PRIVATE_REQUESTED` (chat hidden).

### 2.5 Cancel / approve / reject join requests

| Method + path                                            | Auth       | Success                       | Notes                                                                                          |
| -------------------------------------------------------- | ---------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `DELETE /communities/:id/join-requests/mine`             | requester  | `200` (cancelled request DTO) | `404` if no request; `400` if not PENDING.                                                     |
| `POST /communities/:id/join-requests/:requestId/approve` | MODERATOR+ | `200 { request, member }`     | PENDING→ACTIVE; idempotent on already-APPROVED; `403` non-moderator/banned; `400` not PENDING. |
| `POST /communities/:id/join-requests/:requestId/reject`  | MODERATOR+ | `200 { request }`             | PENDING→REJECTED; `400` not PENDING.                                                           |

`CommunityJoinRequestData` = `{ requestId, communityId, userId, status: "PENDING"|"APPROVED"|"REJECTED"|"CANCELLED", message, decidedBy, decidedAt, createdAt, updatedAt }`.

### 2.6 Invite-link management (moderator/member)

| Method + path                                  | Auth              | Body / Query                                    | Success                                                                         | Errors                                                                                    |
| ---------------------------------------------- | ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /communities/:id/invite-links`           | any ACTIVE member | `{ maxUses?, expiresInMinutes?, autoApprove? }` | `201 CommunityInviteLinkData`                                                   | `403` non-member/PENDING/BANNED/LEFT or active-link cap reached · `429` create rate limit |
| `GET /communities/:id/invite-links`            | any ACTIVE member | `?status=active\|expired\|revoked&page&limit`   | `200 { pagination, data: CommunityInviteLinkData[] }`                           | `403`                                                                                     |
| `DELETE /communities/:id/invite-links/:linkId` | MODERATOR+        | —                                               | `200 CommunityInviteLinkData` (revokedAt set)                                   | `403` · `404` cross-community linkId                                                      |
| `POST /communities/:id/invite-links/bulk-send` | any ACTIVE member | `{ userIds: string[] (1–50 UUIDs), linkId? }`   | `200 { link, summary{requested,sent,failed,skipped}, sentUserIds, failures[] }` | `429` bulk rate limit · `404` cross-community link                                        |

`CommunityInviteLinkData` = `{ linkId, code, url, appDeepLink, communityId, createdBy, maxUses, usedCount, autoApprove, expiresAt, revokedAt, createdAt, isActive }`.
**Bulk-send** is partial-success: per-recipient outcomes are in `failures[]` (codes like `USER_NOT_FOUND`, `ALREADY_MEMBER`, `USER_BANNED`); eligible recipients receive a system DM + a `message:new` socket event.

---

## 3. End-to-end flows

> Notation: `→ REST` API call, `⇢ socket` event with `(namespace, direction, target)`.

### Flow 1 — Public link, logged-in, app installed

1. App Link opens app → `detectLink` → PUBLIC(handle).
2. `→ GET /communities/by-handle/<handle>` → `200 type:PUBLIC, isJoined:false`. Button `PUBLIC_JOIN`.
3. Tap Join → `→ POST /communities/<id>/join` → `201 JOINED`.
4. FE: button `PUBLIC_OPEN`; add to My Communities; `memberCount+1`; chat now allowed; you may join the chat room.
5. `⇢ community:joined` _(/notify → your other devices)_ reconciles them. `⇢ community:member:joined` _(/community → the room)_ updates roster/count for everyone in the community.

### Flow 2 — Public link, logged-out

1. `detectLink` → PUBLIC(handle) → **persist target** → run login.
2. On login success → resume target → continue from Flow 1 step 2.

### Flow 3 — Private link, logged-in

1. `detectLink` → PRIVATE(code).
2. `→ GET /communities/invite-links/<code>` → `200 communityType:PRIVATE, isJoined:false, joinRequestStatus:null`. Button `PRIVATE_REQUEST`, **chat hidden**.
3. Tap Request to Join → `→ POST /communities/invite-links/<code>/redeem`.

### Flow 4 — Private link with auto-approve

- Step 3 returns `{ member: { status:"ACTIVE" } }` → button `PRIVATE_OPEN`; add to My Communities; chat allowed; you may join the chat room.
- `⇢ community:joined` (/notify, your devices) + `⇢ community:member:joined` (/community, room).

### Flow 5 — Private link with approval required (default)

- Step 3 returns `{ request: { status:"PENDING" } }` → button `PRIVATE_REQUESTED` (+ Cancel); **not** added; **chat stays hidden**.

### Flow 6 — Pending request approved in realtime

- State `PRIVATE_REQUESTED`. Moderator approves.
- `⇢ community:join_request:update` _(/notify → you)_ `{ status:"APPROVED", communityId, requestId, communityName, decidedAt, navigation }`.
- FE: button `PRIVATE_OPEN`; add to My Communities; `memberCount` sync; **now allow chat + join the chat socket room**.
- The community room also gets `⇢ community:member:joined`.
- An inbox `⇢ notification:new` + `⇢ notification:count_update` arrive on /notify.

### Flow 7 — Pending request rejected in realtime

- `⇢ community:join_request:update` `{ status:"REJECTED" }` _(/notify → you)_.
- FE: button back to `PRIVATE_REQUEST` (can re-request); clear pending; **chat stays hidden**.

### Flow 8 — Already a member

- Resolver/preview returns `isJoined:true` → button `*_OPEN` → tap → navigate in (chat visible).
- If the user taps Join anyway → `200 ALREADY_MEMBER` → idempotent, treat as joined.

### Flow 9 — Banned

- Resolver/preview returns `403` → button `BANNED` (disabled). No chat, no retry CTA. (The body `message` is localized; the status `403` is the signal.)

### Flow 10 — Expired / revoked / exhausted / invalid private link

- `→ GET /communities/invite-links/<code>` → `410` → button `LINK_DEAD`; show the response `message`; offer "Find communities".
- `404` → `INVALID` ("This invite link is invalid"). `400` → "Invalid invite link format".

### Flow 11 — Cancel a pending request

- State `PRIVATE_REQUESTED` → tap Cancel → `→ DELETE /communities/<id>/join-requests/mine` → `200`. Button back to `PRIVATE_REQUEST`.

### Flow 12 — Create / list / revoke / bulk-send invite links

1. `→ POST /communities/<id>/invite-links { maxUses?, expiresInMinutes?, autoApprove? }` → `201` → show card with `url` (HTTPS), `appDeepLink`, QR, badges.
2. Share → native share sheet with `url`. Copy → clipboard.
3. `→ GET /communities/<id>/invite-links?status=active` to list. `→ DELETE …/:linkId` to revoke (idempotent).
4. `→ POST …/bulk-send { userIds }` → `200` partial-success; inspect `failures[]`. Eligible recipients get a system DM (`⇢ message:new`).

- **Public** communities need no link creation — use the by-handle `shareUrl`.

### Flow 13 — Chat access after membership becomes ACTIVE

- Render chat / join the chat socket room **only** after a backend-confirmed ACTIVE signal: resolver `isJoined:true`, a `member{status:"ACTIVE"}` from join/redeem, or `community:joined` / `community:join_request:update{APPROVED}`.
- The backend independently enforces this: chat read/send/socket-room-join all reject non-ACTIVE callers — but the FE must not optimistically show chat.

### Flow 14 — Community-list update after join/approval

- On `community:joined` (your devices) or `community:join_request:update{APPROVED}` → insert/refresh the community row without a refetch.
- `community:added` (/community) and `community:updated` (/community list bump) keep the list live; `community:stats:updated` updates member counts.

**Retry/idempotency for all flows:** join is idempotent (`ALREADY_MEMBER`); redeem is idempotent (no double usage burn); preview/resolver are safe GETs. On a transient network error, re-run the same call.

---

## 4. Socket event reference

All socket traffic is via the api-gateway. Namespaces: `/notify` (per-user), `/community` (community rooms + community list). Events below are **server → client** (`receive`) unless noted. Payloads are objects (already parsed); only **FCM push** `data` maps and REST `payload.data` are JSON strings.

| Event                           | Namespace    | Direction     | Delivered to                       | Trigger                                                                             | Payload (shape)                                                                                    | FE action                                                           |
| ------------------------------- | ------------ | ------------- | ---------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `community:joined`              | `/notify`    | server→client | `user:<userId>` (all your devices) | You became ACTIVE (public self-join, invite auto-approve, or your request approved) | `{ communityId, communityName, communityHandle, communityAvatarUrl, reactivated }`                 | Flip Join→Open; insert into My Communities; reconcile other devices |
| `community:join_request:update` | `/notify`    | server→client | `user:<userId>` (the requester)    | Mod approved/rejected your request                                                  | `{ communityId, requestId, status: "APPROVED"\|"REJECTED", communityName, decidedAt, navigation }` | APPROVED→`PRIVATE_OPEN`+allow chat; REJECTED→`PRIVATE_REQUEST`      |
| `community:member:joined`       | `/community` | server→client | room `community:<id>`              | A member became ACTIVE                                                              | `{ userId, username, displayName, avatarUrl, role, joinedAt(epoch ms) }`                           | Refresh roster + member count                                       |
| `notification:new`              | `/notify`    | server→client | `user:<userId>`                    | New in-app notification (incl. join approved/rejected, member added)                | full notification row (`id, type, title, body, navigation, data, createdAt, readAt`)               | Prepend to inbox                                                    |
| `notification:count_update`     | `/notify`    | server→client | `user:<userId>`                    | Unread count changed                                                                | `{ count }`                                                                                        | Replace badge with `count`                                          |
| `community:added`               | `/community` | server→client | `user:<userId>`                    | You were added to a community                                                       | community list-row DTO                                                                             | Insert row into list                                                |
| `community:updated`             | `/community` | server→client | room/list                          | New activity → list bump                                                            | list-row patch                                                                                     | Move community to top                                               |
| `community:stats:updated`       | `/community` | server→client | room `community:<id>`              | Member count changed                                                                | `{ communityId, memberCount, … }`                                                                  | Update count                                                        |
| `community:member:removed`      | `/community` | server→client | room `community:<id>`              | Member kicked/banned/left                                                           | `{ communityId, userId, reason }`                                                                  | Remove from roster; if it's you and reason=banned, leave room       |

No client→server acknowledgements are required for the join/sharing flow (joining the **chat** socket room is gated separately — see §5/§6).

---

## 5. FE state machine (button + chat visibility)

```
LOADING → { PUBLIC_JOIN | PUBLIC_OPEN | PRIVATE_REQUEST | PRIVATE_REQUESTED | PRIVATE_OPEN | BANNED | LINK_DEAD | INVALID }
```

**Derivation after Stage-2 resolve (branch on HTTP status, then body):**
| Condition | State |
|---|---|
| local target invalid | `INVALID` |
| resolver/preview `403` | `BANNED` |
| `404` (public by-handle) | `INVALID` |
| `404` (private code) | `INVALID` (invalid code) |
| `410` (private) | `LINK_DEAD` (show `message`) |
| `type:"PUBLIC"` & `isJoined:true` | `PUBLIC_OPEN` |
| `type:"PUBLIC"` & `isJoined:false` | `PUBLIC_JOIN` |
| `communityType:"PRIVATE"` & `isJoined:true` | `PRIVATE_OPEN` |
| `communityType:"PRIVATE"` & `joinRequestStatus:"PENDING"` | `PRIVATE_REQUESTED` |
| `communityType:"PRIVATE"` & else | `PRIVATE_REQUEST` |

**Transitions:**

- `PUBLIC_JOIN` —`POST /join → 201 JOINED` / `200 ALREADY_MEMBER`→ `PUBLIC_OPEN`
- `PRIVATE_REQUEST` —`redeem → request PENDING`→ `PRIVATE_REQUESTED`
- `PRIVATE_REQUEST` —`redeem → member (autoApprove)`→ `PRIVATE_OPEN`
- `PRIVATE_REQUESTED` —`community:join_request:update APPROVED`→ `PRIVATE_OPEN`
- `PRIVATE_REQUESTED` —`community:join_request:update REJECTED`→ `PRIVATE_REQUEST`
- `PRIVATE_REQUESTED` —`DELETE join-requests/mine`→ `PRIVATE_REQUEST`
- any —`403`→ `BANNED`

**Button label rules:**

- Show **Join** → `PUBLIC_JOIN`.
- Show **Request to Join** → `PRIVATE_REQUEST`.
- Show **Pending / Requested** (+ Cancel) → `PRIVATE_REQUESTED`.
- Show **Open** → `PUBLIC_OPEN` / `PRIVATE_OPEN`.
- Show **Banned** (disabled) → `BANNED`.
- Show **dead/invalid** message → `LINK_DEAD` / `INVALID`.

**Chat-visibility invariant:** chat UI **and** the chat socket room are reachable **iff** state ∈ `{PUBLIC_OPEN, PRIVATE_OPEN}` (server-confirmed ACTIVE). Never from `PRIVATE_REQUEST/REQUESTED/LINK_DEAD/INVALID/BANNED`.

---

## 6. Security rules the FE must respect

1. **Never infer membership from a URL alone.** A link only decides which _preview_ to show. Membership/chat requires a Stage-2 server confirmation.
2. **Never render chat from client state.** Gate chat on backend-confirmed ACTIVE (`isJoined:true` / `member{ACTIVE}` / `community:joined` / approval event). The backend will reject non-ACTIVE chat access anyway (403), but don't flash it.
3. **Use backend-confirmed ACTIVE membership** before joining the chat socket room. Joining the room for a non-ACTIVE state is rejected/evicted server-side.
4. **Do not build canonical URLs by hand.** Use `shareUrl`/`appDeepLink` (public) and `url`/`inviteUrl`/`appDeepLink` (private) from responses. Likewise, avatars/banners are already presigned — never construct media URLs.
5. **A `404` from by-handle does not mean "private exists".** It is a deliberately collapsed result (missing OR private OR suspended). Do not display "this is a private community" — show a generic "not found".
6. **Branch on HTTP status, not a body code.** Error bodies are `{ success:false, message }` with no stable `error` field. Display `message`; decide UI from the status.
7. **Handle socket reconnect/reconciliation.** On reconnect, re-resolve the current screen (re-call by-handle/preview) and re-sync My Communities; a `community:joined`/approval event may have been missed offline. The inbox `notification:new` + `notification:count_update` also reconcile the badge.

---

## 7. Swagger / AsyncAPI cross-reference

| Feature                      | Swagger (OpenAPI) endpoint                     | DTO / schema                                                                       | AsyncAPI event                                             | FE action                      |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| Public resolve               | `GET /communities/by-handle/{handle}`          | `PublicCommunityResponse` (+`shareUrl`,`appDeepLink`)                              | —                                                          | drive Join button; Share sheet |
| Private preview              | `GET /communities/invite-links/{code}`         | `InviteLinkPreviewData`                                                            | —                                                          | drive Request button           |
| Redeem                       | `POST /communities/invite-links/{code}/redeem` | `RedeemInviteLinkResponseData`                                                     | —                                                          | member→Open / request→Pending  |
| Join                         | `POST /communities/{id}/join`                  | `CommunityJoinResult` (3 variants)                                                 | `community:joined`, `community:member:joined`              | flip button, list insert       |
| Create/list/revoke/bulk-send | `…/invite-links` (+`/bulk-send`)               | `CommunityInviteLinkData`, `CreateInviteLinkRequest`, `InviteLinkListResponseData` | (`message:new` on bulk-send DM)                            | link card / share              |
| Cancel request               | `DELETE /communities/{id}/join-requests/mine`  | `JoinRequestData`                                                                  | —                                                          | button → Request               |
| Approve / reject             | `…/join-requests/{requestId}/approve\|reject`  | `JoinRequestData` (+member on approve)                                             | `community:join_request:update`, `community:member:joined` | requester realtime flip        |
| Inbox / badge                | (REST inbox endpoints)                         | notification row                                                                   | `notification:new`, `notification:count_update`            | inbox + badge                  |

AsyncAPI source: `apps/api-gateway/asyncapi/asyncapi.yaml` (messages `CommunityJoined`, `CommunityJoinRequestUpdate`, `CommunityMemberJoined`, `NotificationForwarded`, `NotificationCountUpdate`).

---

## 8. Known external handoffs (NOT in the backend repo)

| Task                                                   | Owner            | Required artifact                                                                                        | Verification                                                                                                |
| ------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `aimess.me` DNS + TLS (no redirect on `.well-known/*`) | Infra/DevOps     | A/CNAME → gateway, valid cert                                                                            | `curl -I https://aimess.me/.well-known/apple-app-site-association` → `200`, `application/json`, no redirect |
| Android `assetlinks.json` fingerprints                 | Android + DevOps | `ANDROID_SHA256_CERT_FINGERPRINTS` = upload **and** Play App Signing certs                               | `adb shell pm get-app-links com.aimess.app` → `verified`                                                    |
| iOS AASA app IDs                                       | iOS + DevOps     | `APPLE_APP_IDS` = `<TEAMID>.com.aimess.app`                                                              | tap a Universal Link **from Messages** → app opens                                                          |
| Play / App Store IDs (deferred store fallback)         | DevOps           | `ANDROID_STORE_APP_ID`, `APPLE_STORE_APP_ID`                                                             | install-via-referrer test                                                                                   |
| Internal OG card                                       | DevOps           | `COMMUNITY_INTERNAL_URL` + matching `INTERNAL_SHARED_SECRET` (both services)                             | preview renders the real community card                                                                     |
| Android deferred deep link                             | Android          | `InstallReferrerClient` reads `h_<handle>`/`p_<code>` token, consume once                                | first-launch resolves the saved target after login                                                          |
| iOS deferred deep link                                 | iOS              | Branch/Adjust/AppsFlyer SDK (recommended) or clipboard fallback                                          | first-launch resolves the saved target                                                                      |
| Platform app-link manifest/entitlements                | Android/iOS      | `autoVerify` intent-filter `host=aimess.me` + `aimess` scheme / `applinks:aimess.me` + `aimess` URL type | the §13 spec test commands                                                                                  |

The backend already: serves both `.well-known` files with correct content types and no redirect, renders the platform-aware "Open in app" preview (incl. the `h_`/`p_` Play referrer token and the iOS scheme/App-Store fallback), and exposes the internal OG card. The handoffs above are configuration/DNS/store/SDK only.
