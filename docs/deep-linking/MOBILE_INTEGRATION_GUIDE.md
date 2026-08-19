# AIMESS Deep Linking — Mobile Integration Guide

**Audience:** the Android and iOS teams.
**Date:** 2026-08-19.
**Companion doc:** `docs/deep-linking/IMPLEMENTATION.md` (what the backend + web actually do).

This document is the contract. Everything in it was read out of the repository, not
assumed. Anything the backend does **not** do is called out explicitly under
[Open items](#12-open-items-for-mobile) — please do not build against it.

---

## 1. Status — what shipped on the server side

| Item                                              | Before                                                             | Now                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `https://ai5dev.tech/.well-known/assetlinks.json` | **404**                                                            | served, `200`, `application/json`, no redirect                  |
| Web routes for `/+<code>`, `/<handle>`            | redirected straight to the app page, no OG, no handoff             | "Open in app" interstitial + OG unfurl                          |
| Web route for `/g/<token>`                        | **did not exist**                                                  | interstitial + OG unfurl                                        |
| Gateway link grammar                              | single-segment only, no group kind                                 | `detectFromPath()` — one owner, all shapes                      |
| Gateway AASA `components`                         | `"/*"` (claimed the whole marketing site)                          | `/+*`, `/g/*`, `/community/*`                                   |
| `INVITE_LINK_BASE_URL` code default               | `https://aimess.me` (dead domain); chat-service had **no** default | `https://ai5dev.tech` in community-service **and** chat-service |
| `ANDROID_PACKAGE_NAME` in templates               | `com.aimess.app`                                                   | `com.aifivetech.aimess.app`                                     |
| Cert fingerprints in templates                    | empty                                                              | both fingerprints present                                       |

> **Heads-up on the earlier guide.** `DEEP_LINKING_INTEGRATION.md` §5.1 stated the gateway
> work was already done on a branch `feat/deep-link-app-handoff`. That branch does not exist
> in `aimess_backend`, and none of that work was present. It has now been implemented here.
> If you have a local copy of that branch, reconcile before merging.

**Still blocked on deployment, not code:** the live `.env.dev02` deep-link block, and a
Cloudflare bypass rule for `/.well-known/*`. Until both are done, group invite links may
still be minted on the dead `aimess.me` domain and App Link verification can fail silently.

---

## 2. Hosts

```
ai5dev.tech        → Cloudflare → Next.js website  (marketing site + web app + link pages)
api.ai5dev.tech    → api-gateway                   (REST + Socket.IO)
minio.ai5dev.tech  → MinIO
```

- The canonical link host is **`https://ai5dev.tech`**.
- `aimess.me` **does not resolve** (NXDOMAIN). It is still pre-claimed in the Android
  manifest for a possible future migration, which makes it inert — but never mint or
  hard-code it.
- REST base URL is **`https://api.ai5dev.tech/api/v1`**. `/api/v2` no longer exists.
- Socket.IO is served by the gateway at `api.ai5dev.tech`.

**The link host is shared with the marketing site.** This is the governing constraint of
the whole design: the app must claim only namespaced link paths, never the bare host, or
AIMESS hijacks its own `/terms-of-service` and `/privacy-policy`.

---

## 3. Canonical URL grammar (NORMATIVE)

Three implementations must stay behaviourally identical:

| Surface | File                                                                |
| ------- | ------------------------------------------------------------------- |
| Android | `aimess_native_android/app/.../deeplink/CommunityLink.kt`           |
| Gateway | `apps/api-gateway/src/linkhost/detect-link.ts` — `detectFromPath()` |
| Web     | `aimess_website/src/utils/linkGrammar.ts` — `detectFromPath()`      |

### 3.1 Path space

| Path                   | Target                                | Claim as a verified App Link?        |
| ---------------------- | ------------------------------------- | ------------------------------------ |
| `/+<code>`             | private community invite              | **YES** — `pathPrefix="/+"`          |
| `/g/<token>`           | group invite                          | **YES** — `pathPrefix="/g/"`         |
| `/community/@<handle>` | public community (canonical)          | **YES** — `pathPrefix="/community/"` |
| `/community/<handle>`  | public community (`@` optional)       | **YES** — same prefix                |
| `/<handle>`            | public community (legacy pretty link) | **NO** — see §3.5                    |
| anything else          | marketing site                        | **NEVER**                            |

`+` and `@` are display markers. Strip both before using the value.

### 3.2 Charset

```
handle      ^[a-z0-9_]{3,32}$
code/token  ^[A-Za-z0-9_-]{1,100}$
```

Handles fold to lowercase. Codes and tokens are case-sensitive — do **not** lowercase them.

Anything failing these is invalid. This is also the first line of XSS defence: neither
charset permits `<`, `>`, `"` or `/`.

### 3.3 Three-valued result — the part that matters most

Your parser must distinguish three outcomes, not two:

| Result       | Meaning                                                                                  | Behaviour                                       |
| ------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| a target     | ours and usable                                                                          | route in-app                                    |
| **invalid**  | inside our path space but malformed — `/g/`, `/+`, `/community/@`, bad charset           | in-app error screen. **Never** a browser bounce |
| **not ours** | outside the link path space — `/terms-of-service`, `/privacy-policy`, `/about`, `/login` | open the **browser**. Do not touch it           |

Collapsing "not ours" into "invalid" is the single most damaging regression available here:
it makes AIMESS swallow its own legal pages. Both the web and gateway now have explicit
regression tests for exactly this.

### 3.4 Reserved segments

The charset already excludes every hyphenated marketing route (`terms-of-service`,
`privacy-policy`, `delete-account`, `child-safety-standards`). Un-hyphenated names need an
explicit list. Keep all three implementations in sync with this set:

```
about, api, app, auth, blog, community, contact, docs, download, help, invite,
link, login, message, notifications, pricing, privacy, register, settings,
signup, support, terms, web
```

Additionally reserved as the **second** segment under `/community/`:

```
create, invite
```

because `/community/create` and `/community/invite/<code>` are real web pages.
`/community/@create` is still a handle — the `@` form is unambiguous, so only the bare form
collides.

Add a name to these lists whenever a new single-word top-level page ships, or that page
becomes unreachable for anyone who has the app installed.

### 3.5 Why `/<handle>` must NOT be claimed

Android intent filters on `minSdk 24` cannot express "one path segment matching
`[a-z0-9_]{3,32}`". `pathPattern` supports only `*` and `.*`; `pathAdvancedPattern` (which
does support `{3,32}`) is API 31+, and on an older device an unrecognised attribute widens
the filter to the whole host. Claiming bare `/<handle>` therefore means claiming the whole
marketing site.

**Consequence:** bare-handle links cost one extra tap (browser → interstitial → app). The
three namespaced shapes are zero-tap. This is unchanged and deliberate.

To close it later, pick one:

- **(a)** move public share URLs to `/community/@<handle>` — change `buildPublicShareUrl` at
  `apps/community-service/src/services/community.service.ts:1386`. Uglier link, zero taps.
- **(b)** move the whole link space to a dedicated host (`link.ai5dev.tech`) DNS'd at the
  gateway. The gateway code then serves everything as-is and the app can safely claim the
  bare host.

Neither is done.

### 3.6 Encoded `+`

`/+CODE`, `/%2BCODE` and a `+`-collapsed-to-space (`/ CODE`) must all resolve to the same
private invite. URL-decode each path segment individually, then trim, then test for the
leading `+`. All three forms are covered by tests on the web and gateway.

---

## 4. Custom scheme

Always works, even when App Link verification fails. This is the interstitial's escape hatch
and what the web "Open in app" button fires on iOS.

```
aimess://resolve?handle=<handle>
aimess://join?code=<code>
aimess://joingroup?token=<token>
```

Also accept the path-segment form — some launchers surface the action there rather than as
the host:

```
aimess:///resolve?handle=<handle>
```

> **Discrepancy to resolve.** chat-service mints the **hyphenated** `aimess://join-group?token=<token>`
> in DM group-invitation payloads (`buildGroupInviteDeepLink`,
> `apps/chat-service/src/services/group-invite-link.service.ts:53`), while the canonical
> scheme above is `joingroup`. The backend was deliberately **not** changed — three tests
> assert the current shape and the Android parser could not be verified from this repo. The
> web parser now accepts **both**.
> **Action for mobile: tell us which form the app parses, and we will align the backend.**

---

## 5. Android App Links

### 5.1 assetlinks.json (now live)

`https://ai5dev.tech/.well-known/assetlinks.json`

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.aifivetech.aimess.app",
      "sha256_cert_fingerprints": [
        "B2:D0:AA:F8:1B:A6:64:8F:65:AB:FE:8F:CD:C8:35:94:4A:7E:CC:EE:A9:86:9D:0F:30:2F:CA:3C:84:A3:FE:FD",
        "E5:BC:9F:BA:B2:FF:1A:C0:EF:A6:89:B3:DA:B0:F2:14:3A:7F:CE:8A:F9:66:C5:A8:9D:E9:DA:3A:09:32:E8:95"
      ]
    }
  }
]
```

First = **Google Play App Signing** certificate (verifies every Play-installed build).
Second = the upload / internal-test certificate. Listing an extra fingerprint is harmless;
omitting the Play one silently breaks verification for every real user.

> **Please confirm both values against Play Console → App integrity.** They came from the
> mobile team's own guide; every fingerprint field in this repository was empty before this
> change, so there was nothing to cross-check them against.

**Debug / staging builds.** The app appends `applicationIdSuffix` (`.debug`, `.staging`).
Those are different package names and need their own entries in this file if App Links must
work in those variants. Production-only is intentional today — tell us if you need the
others added.

### 5.2 Manifest claims

Claim the three namespaced prefixes on `ai5dev.tech` with `android:autoVerify="true"`.
Do **not** claim the bare host, and do **not** claim bare `/<handle>` (§3.5).

```
pathPrefix="/+"
pathPrefix="/g/"
pathPrefix="/community/"
```

### 5.3 Handoff payload the web sends you

When the app is not verified (or the user came from a bare `/<handle>` link), the web
interstitial fires:

```
intent://open#Intent;
  scheme=aimess;
  package=com.aifivetech.aimess.app;
  S.handle=<handle> | S.code=<code> | S.token=<token>;
  S.browser_fallback_url=<url-encoded Play Store URL>;
end
```

So the app must read **all three** string extras: `handle`, `code`, `token`. Exactly one is
present per link.

Real example emitted for `/g/qBc4eEtQ6bopGcwU-HodCHCk`:

```
intent://open#Intent;scheme=aimess;package=com.aifivetech.aimess.app;S.token=qBc4eEtQ6bopGcwU-HodCHCk;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.aifivetech.aimess.app%26referrer%3Dg_qBc4eEtQ6bopGcwU-HodCHCk;end
```

---

## 6. iOS

**Universal Links are not configured and this guide does not pretend otherwise.** The iOS
project has no associated-domains entitlement, `APPLE_APP_IDS` is empty, and no AASA file is
served from the website.

The web interstitial therefore uses the custom scheme only:

1. navigate to `aimess://…`;
2. a ~1200 ms timer falls back to the App Store;
3. the timer is cancelled on `pagehide` — a successful app launch fires `pagehide`, so the
   store is not opened on top of the app;
4. `NEXT_PUBLIC_APPLE_STORE_APP_ID` is currently empty, so the fallback is the web target
   rather than a dead App Store URL.

**To enable Universal Links, iOS needs to:** add the associated-domains entitlement for
`applinks:ai5dev.tech`, and send us the `<TEAMID>.com.aifivetech.aimess.app` app ID plus the
numeric App Store id. We then serve:

```
/.well-known/apple-app-site-association     (no file extension, application/json, no redirect)
```

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["<TEAMID>.com.aifivetech.aimess.app"],
        "components": [{ "/": "/+*" }, { "/": "/g/*" }, { "/": "/community/*" }]
      }
    ]
  }
}
```

Note the components list — never `"/*"`, which would claim the marketing site. The gateway's
builder has already been corrected to this shape.

---

## 7. REST APIs

Base: `https://api.ai5dev.tech/api/v1`. **No API changed as part of this work** — every
endpoint below already existed and is unmodified. Note the auth asymmetry.

### 7.1 Public community — `/<handle>`, `/community/@<handle>`

```
GET  /communities/by-handle/:handle      Bearer REQUIRED
POST /communities/:id/join               Bearer
```

`GET /communities/by-handle/:handle` returns:

```json
{
  "communityId": "…",
  "handle": "gokuldhamsociety",
  "name": "Gokuldham Society",
  "description": "…",
  "avatarUrl": "https://…?X-Amz-Expires=…",
  "bannerUrl": "https://…?X-Amz-Expires=…",
  "memberCount": 128,
  "type": "PUBLIC",
  "shareUrl": "https://ai5dev.tech/gokuldhamsociety",
  "appDeepLink": "aimess://resolve?handle=gokuldhamsociety",
  "isJoined": true,
  "role": "MEMBER",
  "isBanned": false
}
```

- **404** for missing, PRIVATE, owner-CLOSED and platform-SUSPENDED alike — one response, so
  there is no oracle for private-community discovery. Do not try to distinguish them.
- **403**, no body, when the caller is banned.
- `isJoined` / `role` drive the CTA: "Open" vs "Join".

### 7.2 Private community invite — `/+<code>`

```
GET  /communities/invite-links/:code           Bearer REQUIRED
POST /communities/invite-links/:code/redeem    Bearer
```

The redeem response is `{ link, request?, member? }`:

- `member` present → the user is now a member (auto-approve link, or a PUBLIC community).
- `request` present → a join request was created; show "Request pending".

`link` (`CommunityInviteLinkData`) carries:

```json
{
  "linkId": "…",
  "code": "5SNjriaRKO5kOX_lvh_7QQ",
  "url": "https://ai5dev.tech/+5SNjriaRKO5kOX_lvh_7QQ",
  "appDeepLink": "aimess://join?code=5SNjriaRKO5kOX_lvh_7QQ",
  "linkType": "PRIVATE_INVITE",
  "communityId": "…",
  "createdBy": "…",
  "maxUses": 50,
  "usedCount": 3,
  "autoApprove": false,
  "expiresAt": "…"
}
```

`linkType` is `"PUBLIC_HANDLE"` or `"PRIVATE_INVITE"` — branch on it rather than
re-deriving privacy from the URL shape.

The same endpoint also accepts a community's **permanent invitation code**, which is stored
on the community row rather than in the invite-link table. It is transparent to you.

### 7.3 Group invite — `/g/<token>`

```
GET  /chat/invite-links/preview/:token    NO AUTH — public
POST /chat/invite-links/join              Bearer, body { "token": "…" }
```

Preview returns `{ success, data }` where `data` is:

```json
{
  "token": "qBc4eEtQ6bopGcwU-HodCHCk",
  "groupId": "room_…",
  "groupName": "Weekend Trip",
  "groupAvatar": "https://…/avatar.jpg?X-Amz-Expires=3600",
  "description": "…",
  "memberCount": 12,
  "memberLimit": 50
}
```

There is **no `isJoined` flag** — this has not changed. An existing member tapping their own
group link sees "Join group"; `POST /chat/invite-links/join` is idempotent for existing
members and returns the room either way. See [Open items](#12-open-items-for-mobile).

### 7.4 Server-minted share URLs — use them verbatim

| Kind              | Shape              | Minted by                                                 |
| ----------------- | ------------------ | --------------------------------------------------------- |
| Public community  | `<base>/<handle>`  | `buildPublicShareUrl` — `community.service.ts:1386`       |
| Private community | `<base>/+<code>`   | `buildInviteUrl` — `community.service.ts:1367`            |
| Group             | `<base>/g/<token>` | `buildGroupInviteUrl` — `group-invite-link.service.ts:47` |

All three read `INVITE_LINK_BASE_URL`. **Clients must use the returned `url` verbatim and
never reconstruct it** — the base can differ per environment.

### 7.5 Unauthenticated unfurl (server-to-server only — FYI)

```
GET /internal/communities/by-handle/:handle/card
Header: x-internal-secret: <INTERNAL_SHARED_SECRET>
```

PUBLIC communities only; private/suspended 404 with no metadata. Not reachable through the
gateway's public `/api` proxy and not available to mobile — listed here only so you know how
the web renders an OG card for a logged-out viewer.

---

## 8. Socket events

Namespaces on `api.ai5dev.tech`: `/chat`, `/community`, `/stream`. These are the events that
matter to a link-tap flow — all verified against
`apps/api-gateway/src/sockets/namespaces/*.ts`.

### 8.1 After joining a community (namespace `/community`)

| Event                      | Direction                 | Payload highlights                   | Notes                                                                                                                                                                 |
| -------------------------- | ------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `community:added`          | server → the joining user | `{ communityId, … }`                 | the community appears in their list. The gateway **auto-joins** their live sockets to the community typing room, so no reconnect and no manual re-subscribe is needed |
| `community:member:joined`  | server → the community    | new member                           | roster update for everyone already inside                                                                                                                             |
| `community:updated`        | server → members          | list-row bump (last message, unread) | this is the move-to-top event                                                                                                                                         |
| `community:member:updated` | server → the community    | role change / profile sync           |                                                                                                                                                                       |
| `community:stats:updated`  | server → the community    | member counts                        |                                                                                                                                                                       |

Client → server, once the user is inside:

```
community:join            community:leave
community:message:send    community:messages:fetch    community:catchup
community:message:read    community:message:react     community:message:delivered
community:typing:start    community:typing:stop
```

### 8.2 After joining a group (namespace `/chat`)

| Event           | Direction                 | Payload highlights | Notes                                                                                                                                                               |
| --------------- | ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group:added`   | server → the joining user | `{ roomId, … }`    | the gateway **auto-joins** their live sockets to `conv:<roomId>`, so `message:new` and typing start flowing immediately without a reconnect or a manual `conv:join` |
| `group:removed` | server → the removed user | `{ roomId, … }`    | the mirror: every live socket is forced **out** of `conv:<roomId>` on leave / kick / ban                                                                            |
| `message:new`   | server → the room         | new message        |                                                                                                                                                                     |

Client → server:

```
message:send    message:read    message:delivered    message:react
message:edit    message:delete  message:forward      message:pin / message:unpin
chat:catchup
```

**Practical consequence for the deep-link flow:** after a successful join REST call you do
_not_ need to re-subscribe or reconnect. Wait for `community:added` / `group:added` and push
the destination screen. If the socket is not connected at that moment, the normal catch-up
path (`chat:catchup` / `community:catchup`) fills the gap on reconnect.

### 8.3 Private-community join requests

A join request against a PRIVATE community does not add a member. The requester sees
"Request pending". On resolution the community emits a PERSONAL system message to the
requester:

```
JOIN_REQUEST_APPROVED
JOIN_REQUEST_REJECTED
```

and the corresponding inbox notifications exist as
`NOTIF_COMMUNITY_JOIN_REQUESTED` / `NOTIF_COMMUNITY_JOIN_REQUEST_APPROVED`.
Approval is followed by the normal `community:added` fan-out in §8.1.

---

## 9. Error states

| State                                | App behaviour                                                                     | Server signal                                 |
| ------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------- |
| Valid, not a member                  | preview + join CTA                                                                | 200                                           |
| Valid, already a member              | community: go straight to the chat. group: shows "Join group"; join is idempotent | `isJoined` (community only)                   |
| Private community, request pending   | "Request pending", CTA disabled                                                   | redeem returns `request`                      |
| Invite expired                       | "no longer valid" empty state                                                     | `CHAT_INVITE_LINK_EXPIRED`                    |
| Invite revoked                       | same                                                                              | `CHAT_INVITE_LINK_NOT_FOUND`                  |
| Usage limit reached                  | same                                                                              | `CHAT_INVITE_LINK_USAGE_LIMIT`                |
| Group deleted                        | same                                                                              | `CHAT_GROUP_NO_LONGER_EXISTS`                 |
| Community invite not found           | invalid-link screen                                                               | `COMMUNITY_INVITE_LINK_NOT_FOUND`             |
| Community gone / private / suspended | 404 screen, never revealed                                                        | `COMMUNITY_NOT_FOUND` (404)                   |
| Viewer banned                        | server-authoritative error surfaced in-app                                        | 403, no body                                  |
| Handle/code fails charset            | in-app error, **never** a browser bounce                                          | parser returns `invalid` — no request is made |
| Private handle guessed               | 404, never revealed                                                               | `COMMUNITY_NOT_FOUND`                         |

The community `COMMUNITY_JOIN_REQUEST_*` message keys (`…_NOT_FOUND`, `…_NOT_PENDING`,
`…_PUBLIC_NOT_ALLOWED`, `…_NOT_OWNER`, `…_CANCELLED`) cover the request lifecycle.

---

## 10. Deferred deep links

The Play Store fallback URL the web emits carries:

```
referrer=h_<handle>   |   p_<code>   |   g_<token>
```

**The app does not read the Play Install Referrer yet**, so a not-installed user still has to
find the community manually after installing. The web emits the referrer today so the
app-side work is a drop-in later:

1. add `com.android.installreferrer:installreferrer`;
2. on first launch read `ReferrerDetails.getInstallReferrer()`;
3. match `^(h|p|g)_(.+)$` and route to resolve / join / joingroup respectively;
4. consume once and persist a flag, so a reinstall-restore does not replay it.

Do **not** describe deferred deep linking as working until this ships.

---

## 11. Android behaviours to preserve (do not regress)

These already work and are load-bearing:

| Case                                                | Required behaviour                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cold start from a link                              | park in `DeepLinkBus`, replay once `HomeKey` is the authenticated root                                                            |
| Link arrives on Splash / Login / Register           | stays pending, routed after auth. Never dropped                                                                                   |
| Link arrives while the app is warm                  | `onNewIntent` → `singleTask` reuses the task, no second instance                                                                  |
| Logged out                                          | hold the link, complete auth, then route                                                                                          |
| Same link tapped twice quickly                      | 700 ms de-dupe in `AimessLinkHandler`, no duplicate back-stack entry                                                              |
| Link tapped **inside** an AIMESS chat               | never leaves the app — `AimessLinkHandler` intercepts and pushes the resolver / join screen. Independent of App Link verification |
| Marketing link (`/terms-of-service`) tapped in chat | `isAimessLink` is path-aware → false → **opens the browser**. Critical regression risk                                            |
| Malformed link inside our path space (`/g/`)        | treated as ours → in-app error, not a browser flash                                                                               |

The web now mirrors the last two exactly (§3.3).

---

## 12. Open items for mobile

1. **Confirm the two SHA-256 fingerprints** against Play Console → App integrity (§5.1).
   Nothing in either repository could corroborate them.
2. **Confirm `joingroup` vs `join-group`** (§4) so we can align chat-service's minted deep
   link. Currently the web accepts both; the backend mints the hyphenated form.
3. **Tell us if debug/staging App Links are needed** — those package suffixes need their own
   `assetlinks.json` entries (§5.1).
4. **iOS: associated-domains entitlement + team/app-store IDs** to unblock Universal Links
   (§6). Until then iOS is custom-scheme only, and that is what the web does.
5. **Install Referrer** on Android (§10) — the web side is ready.
6. **Bare `/<handle>` still costs one tap** (§3.5). Pick option (a) or (b) if you want it
   closed.
7. **`isJoined` on the group preview** (§7.3) — say the word and we add it to
   `GroupInviteLinkService.preview()` (`group-invite-link.service.ts:123`). It is a
   one-field change; we left it out because it is a product call, not a deep-link
   requirement.
8. **Re-verify on a real device** once the deployment items land — App Link verification runs
   only on install/update, so an existing install will not pick up new claims until it
   updates.

---

## 13. Verification commands

Well-known file — must be `200` and `application/json`. A `301`/`302` fails verification
**silently**:

```bash
curl -sI https://ai5dev.tech/.well-known/assetlinks.json
```

Google's official validator:

```bash
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://ai5dev.tech&relation=delegate_permission/common.handle_all_urls"
```

Verification state on a device with the app installed — every claimed host must read
`verified`; `legacy_failure` or `1024` means the file was unreachable or malformed:

```bash
adb shell pm get-app-links com.aifivetech.aimess.app
```

Force a re-check:

```bash
adb shell pm verify-app-links --re-verify com.aifivetech.aimess.app
```

End-to-end — the first three must open AIMESS with **no** browser and no chooser:

```bash
adb shell am start -a android.intent.action.VIEW -d "https://ai5dev.tech/+TESTCODE"
```

```bash
adb shell am start -a android.intent.action.VIEW -d "https://ai5dev.tech/g/TESTTOKEN"
```

```bash
adb shell am start -a android.intent.action.VIEW -d "https://ai5dev.tech/community/@testhandle"
```

```bash
adb shell am start -a android.intent.action.VIEW -d "aimess://joingroup?token=TESTTOKEN"
```

The negative case — this one **must** open a browser:

```bash
adb shell am start -a android.intent.action.VIEW -d "https://ai5dev.tech/terms-of-service"
```

Android parser unit tests:

```bash
./gradlew :app:testProductionDebugUnitTest --tests "*CommunityLinkParserTest*"
```

Gateway link tests (26 passing):

```bash
cd apps/api-gateway && node ../../node_modules/jest/bin/jest.js --config jest.config.cjs tests/linkhost
```

Web grammar tests (9 passing), from `aimess_website`:

```bash
npm test
```

---

## 14. Rollout order

1. **Web** — ship `public/.well-known/assetlinks.json`, the four link routes, the
   interstitial and OG tags. _Done in code; needs deploying._
2. **Ops** — fix the live `.env.dev02` deep-link block, restart chat-service and
   community-service, and add the Cloudflare bypass for `/.well-known/*`. Confirm a freshly
   created group invite comes back as `https://ai5dev.tech/g/<token>`.
3. **Backend** — merge the gateway linkhost changes.
4. **Android** — ship the client build. **Verification only runs on install/update**, so an
   existing install will not pick up the new App Links until it updates.
5. Run §13 on a real device.
6. Regression-check §11, especially the `/terms-of-service` negative case.

Steps 1 and 2 are independent of the app release and can ship immediately.
