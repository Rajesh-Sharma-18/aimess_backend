# Community Invite Link — URL format, API contract and client behaviour

Reference for web, iOS and Android when opening, previewing and redeeming a
community invite link. Written after issue #65 ("invite link shows Page not
found"), which was a client routing gap, not an API gap: the API described here
already existed and is unchanged apart from one additive error field.

---

## 1. URL formats

The backend is the only producer of shareable links. It never emits an
app-specific path — every link is a single bare segment on the link host, and
the mechanism is chosen by the community's privacy, not by which endpoint
produced the link.

| Community | HTTPS link        | App deep link                 | `linkType`       |
| --------- | ----------------- | ----------------------------- | ---------------- |
| PRIVATE   | `<base>/+<code>`  | `aimess://join?code=<code>`   | `PRIVATE_INVITE` |
| PUBLIC    | `<base>/<handle>` | `aimess://resolve?handle=<h>` | `PUBLIC_HANDLE`  |

- `<base>` is `INVITE_LINK_BASE_URL` (production `https://aimess.me`), and falls
  back to the bare code/handle when unset in local dev.
- The leading `+` is a **marker, not part of the code** — strip it before
  calling the API. `base64url` codes never contain `+`, so the marker is
  unambiguous.
- `code`: `^[A-Za-z0-9_-]{1,100}$` (base64url, 128 bits of entropy).
- `handle`: `^[a-z0-9_]{3,32}$`.
- A community's **permanent** invitation code uses the same `/+<code>` shape and
  is indistinguishable from a generated link on the wire; the preview/redeem
  responses mark it with `isPermanent: true`.

Canonical parser (server copy at
`apps/api-gateway/src/linkhost/detect-link.ts`, mirrored in the web app's
`src/middleware.ts`): take the first path segment; leading `+` → private code;
otherwise a charset-valid segment → public handle; anything else → invalid.

### Web routes

The web app maps the canonical shapes onto its own pages with a 307 redirect, so
a pasted link, a new tab, a refresh and a hand-off from another app all work:

| Incoming         | Redirects to               |
| ---------------- | -------------------------- |
| `/+<code>`       | `/community/invite/<code>` |
| `/<handle>`      | `/community/@<handle>`     |
| `/invite/<code>` | `/community/invite/<code>` |

`/community/invite/<code>` is the invite preview screen. Both it and the
community page are behind the auth guard, which is what drives the logged-out
flow in §4.

---

## 2. Endpoints

All paths are under `/api/v1`. Every `/communities/*` route requires
`Authorization: Bearer <access token>`, **including the preview** — a logged-out
client must authenticate first (see §4).

### 2.1 Preview an invite — `GET /communities/invite-links/:code`

Read-only. Does not join, does not consume a use, does not create a join
request. Rate-limited per IP at the gateway.

```
GET /api/v1/communities/invite-links/Zk9Qw2Lp7AbCdEf123456
Authorization: Bearer <token>
```

```json
{
  "success": true,
  "message": "Invite link preview fetched.",
  "data": {
    "communityId": "665f1c...",
    "communityHandle": "backend_devs",
    "communityName": "Backend Devs",
    "description": "Everything server-side.",
    "avatarUrl": "https://…/avatar.png",
    "bannerUrl": "https://…/cover.png",
    "memberCount": 128,
    "communityType": "PRIVATE",
    "isJoined": false,
    "joinRequestId": null,
    "joinRequestStatus": null,
    "invitationCode": "Zk9Qw2Lp7AbCdEf123456",
    "inviteUrl": "https://aimess.me/+Zk9Qw2Lp7AbCdEf123456",
    "appDeepLink": "aimess://join?code=Zk9Qw2Lp7AbCdEf123456",
    "expiresAt": 1786608000000,
    "creatorId": "665f1b…"
  }
}
```

- `avatarUrl` / `bannerUrl` are freshly resolved, short-lived URLs — **resolve on
  read, never persist them**.
- `expiresAt` is epoch ms, `null` for permanent/non-expiring links.
- `isJoined: true` → the caller is already an ACTIVE member; do not offer Join.
- `joinRequestStatus: "PENDING"` → the caller already requested; offer Cancel.

### 2.2 Redeem an invite — `POST /communities/invite-links/:code/redeem`

The single join entry point for a link. The server decides between an immediate
join and a join request; the client must not.

```
POST /api/v1/communities/invite-links/Zk9Qw2Lp7AbCdEf123456/redeem
Authorization: Bearer <token>
```

```json
{ "success": true, "data": { "link": { … }, "member": { … } } }   // joined
{ "success": true, "data": { "link": { … }, "request": { "requestId": "…", "status": "PENDING" } } }  // request created
```

- `member` present → membership is live now; open the community.
- `request` present → pending approval; show the pending state and wait for the
  `community:join_request_update` socket event (`APPROVED` / `REJECTED`).
- Idempotent: redeeming again while ACTIVE or PENDING returns the same state and
  does **not** consume another use of a `maxUses` link.

### 2.3 Link management (moderator-facing, unchanged)

| Method   | Path                                      | Purpose                      |
| -------- | ----------------------------------------- | ---------------------------- |
| `GET`    | `/communities/:id/invitation-link`        | Permanent link (PRIVATE)     |
| `POST`   | `/communities/:id/invite-links`           | Create a link                |
| `GET`    | `/communities/:id/invite-links`           | List links                   |
| `DELETE` | `/communities/:id/invite-links/:linkId`   | Revoke a link                |
| `POST`   | `/communities/:id/invite-links/bulk-send` | DM the link to several users |

---

## 3. States and error codes

Errors carry an HTTP status, a localized `message` for display, and a stable
machine `code`. **Branch on `code`, display `message`.**

```json
{
  "success": false,
  "code": "COMMUNITY_INVITE_LINK_EXPIRED",
  "message": "This invite link has expired."
}
```

| Situation                    | Status | `code`                                        | Client shows                               |
| ---------------------------- | ------ | --------------------------------------------- | ------------------------------------------ |
| Valid                        | 200    | —                                             | Community preview + Join / Request to Join |
| Already a member             | 200    | — (`isJoined: true`)                          | Open community; no Join action             |
| Request already pending      | 200    | — (`joinRequestStatus: "PENDING"`)            | Pending state + Cancel                     |
| Unknown / malformed code     | 404    | `COMMUNITY_INVITE_LINK_NOT_FOUND`             | "Invite link is invalid"                   |
| Expired                      | 410    | `COMMUNITY_INVITE_LINK_EXPIRED`               | "Invite link has expired"                  |
| Revoked                      | 410    | `COMMUNITY_INVITE_LINK_REVOKED_ERROR`         | "No longer available"                      |
| Use limit reached            | 410    | `COMMUNITY_INVITE_LINK_EXHAUSTED`             | "No longer available"                      |
| Caller banned                | 403    | `COMMUNITY_JOIN_BANNED`                       | Restriction state; Join disabled           |
| Community deleted            | 404    | `COMMUNITY_NOT_FOUND`                         | "Community is no longer available"         |
| Community closed / suspended | 403    | `COMMUNITY_IS_CLOSED` / `COMMUNITY_SUSPENDED` | "No longer available" (redeem only)        |
| Bad code charset / length    | 400    | validation message                            | "Invite link is malformed"                 |

`code` was added to community-service error responses for this work. It is
**additive** — `success` and `message` are unchanged, so existing clients that
read only `message` keep working. Clients that predate `code` should fall back
to the status: 403 → banned, 404 → invalid, 410 → expired-or-revoked, 400 →
malformed.

A suspended community is still **previewable** (read-only) but not joinable —
the lifecycle check runs on redeem, not on preview.

---

## 4. Authentication behaviour

The preview endpoint requires a token, so an invite opened while logged out must
round-trip through login without dropping the code.

Web (implemented):

1. `/+<code>` → 307 → `/community/invite/<code>`.
2. The auth guard sees no token and replaces with
   `/login?redirect=%2Fcommunity%2Finvite%2F<code>`.
3. After login the app returns to `redirect` (validated as a relative path) and
   the preview loads.

Mobile: keep the code in local state across the auth screens and resume the
preview after sign-in. For a cold install, the link host's interstitial passes a
deferred-deep-link referrer token — `p_<code>` for a private code, `h_<handle>`
for a public one — through the Play Store referrer; read it on first launch and
resume the same flow.

Never auto-join on open. Joining is only ever the explicit redeem call in §2.2.

---

## 5. Deep-link handling

`https://<link host>/…` is served by the API gateway's link-host router
(host-gated on `LINK_HOSTS`), which serves:

- `/.well-known/assetlinks.json` — Android App Links proof.
- `/.well-known/apple-app-site-association` — iOS Universal Links proof.
- `/<handle>` and `/+<code>` — an "Open in app" interstitial with OG tags for
  unfurling. A PUBLIC handle unfurls with the community card; a PRIVATE code
  deliberately shows a generic card so no metadata leaks to a logged-out viewer.
- "Continue on web" sends the browser to `<WEB_APP_URL>/+<code>` (or
  `/<handle>`) — the same canonical shape — so the web app resolves the target
  itself and applies its own auth round-trip.

If the app is installed, Universal Links / App Links open it directly and the
interstitial is never seen.

---

## 6. Security notes for clients

- Send only the code. Never send `communityId` alongside it — the server
  resolves the community from the code, so a tampered id changes nothing.
- Never trust community data held by the client; re-read the preview.
- Treat every state (validity, expiry, revocation, use limit, ban, membership,
  lifecycle) as server-owned. The client renders the outcome, it does not decide
  it — and the redeem call re-validates everything the preview validated, since
  a link can be revoked between the two.
