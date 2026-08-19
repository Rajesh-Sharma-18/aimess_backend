# AIMESS Deep Linking Implementation

What is actually built, as of 2026-08-19, across `aimess_backend` and `aimess_website`.
Anything not implemented is listed under [Remaining gaps](#remaining-gaps) — it is not
described as if it were.

Source contract: the mobile team's `DEEP_LINKING_INTEGRATION.md`. Where this document and
that one disagree, this one describes the repository.

---

## Architecture

```
                     https://ai5dev.tech/<link>
                                |
                          Cloudflare
                                |
                      HAProxy (dev01)  ── /.well-known/assetlinks.json ──> public/ (static)
                                |
                     Next.js website :3000
                                |
                       src/middleware.ts
                    (canonical grammar match)
                                |
                +---------------+----------------+
                |                                |
        not an AIMESS link                AIMESS link
                |                                |
        marketing / app route          rewrite to /link?k=&v=
        (untouched)                             |
                                    server-rendered interstitial
                                       + OG metadata
                                                |
                             +------------------+------------------+
                             |                                     |
                       "Open in app"                      "Continue on web"
                             |                                     |
              Android intent:// / iOS aimess://        in-app route (PrivateGuard
              (+ Play Store fallback w/ referrer)       carries ?redirect= through login)
```

Hosts:

| Host                | Serves                                                              |
| ------------------- | ------------------------------------------------------------------- |
| `ai5dev.tech`       | Next.js website — marketing site **and** web app **and** link pages |
| `api.ai5dev.tech`   | api-gateway (REST + Socket.IO)                                      |
| `minio.ai5dev.tech` | MinIO                                                               |

The link host is **shared with the marketing site**. That is the governing constraint:
the app claims only namespaced link paths, never the bare host.

The gateway also contains a complete link-host implementation
(`apps/api-gateway/src/linkhost/`). It is **dead code in this environment** — `isLinkHost()`
gates on `LINK_HOSTS=ai5dev.tech` but the gateway is only ever reached at `api.ai5dev.tech`.
It is kept correct and tested because it is the reference implementation and it activates
immediately if a link subdomain is ever DNS'd at the gateway.

---

## Canonical URL Grammar

One grammar, three implementations that must not drift:

| Surface | File                                                                |
| ------- | ------------------------------------------------------------------- |
| Android | `aimess_native_android/app/.../deeplink/CommunityLink.kt`           |
| Gateway | `apps/api-gateway/src/linkhost/detect-link.ts` — `detectFromPath()` |
| Web     | `aimess_website/src/utils/linkGrammar.ts` — `detectFromPath()`      |

On the web that module is the **single** owner: both `src/middleware.ts` (edge runtime) and
`src/utils/deeplink.ts` (in-app link handler) import it, so the router and the in-app
handler cannot disagree. It is dependency-free so it also runs under bare `node --test`.

### Path space

| Path                   | Target                                | App-claimed (verified App Link)  |
| ---------------------- | ------------------------------------- | -------------------------------- |
| `/+<code>`             | private community invite              | YES — `pathPrefix="/+"`          |
| `/g/<token>`           | group invite                          | YES — `pathPrefix="/g/"`         |
| `/community/@<handle>` | public community (canonical)          | YES — `pathPrefix="/community/"` |
| `/community/<handle>`  | public community (`@` optional)       | YES — same prefix                |
| `/<handle>`            | public community (legacy pretty link) | **NO** — see below               |
| anything else          | marketing site                        | NEVER                            |

`+` and `@` are display markers only; both are stripped before the value is used.

### Charset

```
handle      ^[a-z0-9_]{3,32}$
code/token  ^[A-Za-z0-9_-]{1,100}$
```

### Three-valued result — this is the important part

`detectFromPath()` returns one of:

- a target (`public` / `private` / `group`) — ours and usable;
- `{ kind: "invalid" }` — inside our path space but malformed (`/g/`, `/+`,
  `/community/@`). Renders a 404 page. Never a browser bounce;
- **`null`** — _not ours_. `/terms-of-service`, `/privacy-policy`, `/about`, `/login`, …
  These must pass through untouched.

Collapsing `null` into `invalid` is the single most damaging regression available here: it
makes AIMESS swallow its own legal pages. It is covered by tests on both surfaces.

### Reserved bare segments

The charset already excludes every hyphenated route (`terms-of-service`, `privacy-policy`,
`delete-account`, `child-safety-standards`). Un-hyphenated names need an explicit list —
keep the web, gateway and Android lists in sync:

```
about, api, app, auth, blog, community, contact, docs, download, help, invite,
link, login, message, notifications, pricing, privacy, register, settings,
signup, support, terms, web
```

Additionally, `create` and `invite` are reserved as the **second** segment under
`/community/`, because `/community/create` and `/community/invite/<code>` are real pages.
`/community/@create` is still a handle — the `@` form is unambiguous.

Add a name to these lists whenever a new single-word top-level page ships, or that page
becomes unreachable for anyone who has the app installed.

### Why `/<handle>` is NOT an App Link

Android intent filters on `minSdk 24` cannot express "one path segment matching
`[a-z0-9_]{3,32}`". `pathPattern` supports only `*` and `.*`; `pathAdvancedPattern` is
API 31+, and on older devices an unrecognised attribute widens the filter to the whole
host. Claiming bare `/<handle>` therefore means claiming the entire marketing site.

Consequence: bare-handle links cost **one extra tap** (browser → interstitial → app). The
three namespaced shapes are zero-tap. Unchanged by this work — deliberately.

### Custom scheme

```
aimess://resolve?handle=<handle>
aimess://join?code=<code>
aimess://joingroup?token=<token>
```

`aimess:///resolve?…` (action as the first path segment) also parses — some launchers
surface it that way.

---

## Route Handling

`aimess_website/src/middleware.ts`:

| Incoming                                      | Action                                        |
| --------------------------------------------- | --------------------------------------------- |
| `/+<code>`                                    | **rewrite** to `/link?k=private&v=<code>`     |
| `/g/<token>`                                  | **rewrite** to `/link?k=group&v=<token>`      |
| `/<handle>`                                   | **rewrite** to `/link?k=public&v=<handle>`    |
| `/community/@<handle>`, `/community/<handle>` | untouched — already this app's own page       |
| `/link?k=&v=` with an unvalidatable pair      | rewrite to a non-existent path → real **404** |
| everything else                               | `NextResponse.next()`                         |

**Rewrite, not redirect**, on purpose: the address bar keeps the shared URL, so `og:url`
stays the URL that was actually pasted, Android App Link verification sees the claimed
path, and a refresh re-enters the same handoff.

`/community/@<handle>` is deliberately _not_ rewritten. It is the destination of every
in-app navigation (`PATHS.COMMUNITY_DETAIL`); putting an interstitial in front of it would
make every sidebar click ask permission to open the app. Public communities are shared as
bare `/<handle>` (that is what `buildPublicShareUrl` mints), which _does_ get the
interstitial, and the app claims `/community/*` as a verified App Link so an installed app
never reaches the web there anyway.

### Encoded `+`

`/%2BCODE` and `/+CODE` resolve to the same link. A client that collapses `+` into a space
(`/ CODE`) is also handled — the segment is trimmed before the `+` test. All three are
covered by tests.

---

## Android App Links

`aimess_website/public/.well-known/assetlinks.json` — served statically by Next.js from
`public/`, which the Dockerfile copies alongside the standalone build.

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.aifivetech.aimess.app",
      "sha256_cert_fingerprints": [
        "B2:D0:…:FE:FD", // Google Play App Signing certificate
        "E5:BC:…:E8:95" // upload / internal-test certificate
      ]
    }
  }
]
```

The first fingerprint is the Play App Signing certificate — it verifies every
Play-installed build. Omitting it silently breaks verification for every real user. The
second is the upload certificate, for sideloaded and internal-test builds.

> **Not verifiable from this repository.** Both fingerprints come from the mobile team's
> guide. Every fingerprint field in this repo (`ANDROID_SHA256_CERT_FINGERPRINTS` in the
> gateway `.env.example` and in `deploy/dev02/.env.dev02.example`) was **empty** before
> this change. Confirm them against Play Console → App integrity before relying on them.

Hard requirements — failing any of these breaks verification **silently**:

- `200 OK`, no `301`/`302` — Android does not follow redirects for this file
- `Content-Type: application/json`
- HTTPS with a valid certificate
- reachable at the **apex** `ai5dev.tech`
- no auth, no Cloudflare challenge, no bot-fight interstitial on this path
- no trailing-slash redirect

The Next.js middleware matcher explicitly excludes `\.well-known` so nothing can sit
between Android's fetch and the static file. HAProxy (`deploy/haproxy/dev01.cfg`) proxies
the apex straight to the website with no path rewriting.

Debug/staging builds append `applicationIdSuffix` (`.debug`, `.staging`). Those are
different package names and would need their own entries. Production-only is intentional.

### Android handoff (from the web interstitial)

```
intent://open#Intent;
  scheme=aimess;
  package=com.aifivetech.aimess.app;
  S.handle=<handle> | S.code=<code> | S.token=<token>;
  S.browser_fallback_url=<encoded Play Store URL>;
end
```

The Play Store fallback carries `&referrer=<deferredToken>` (see
[Deferred deep links](#deferred-deep-links)). With `NEXT_PUBLIC_ANDROID_STORE_APP_ID`
empty, the fallback is the web target instead of a possibly-dead store page.

---

## Web Interstitial

`aimess_website/src/app/link/page.tsx` (server component, OG metadata) plus
`aimess_website/src/app/link/LinkHandoff.tsx` (client component, platform handoff). Ported
from the gateway reference `apps/api-gateway/src/linkhost/preview.ts`, adapted to Next.js.

- Two buttons: **Open in app** (primary) and **Continue on web** (secondary).
- Desktop shows **only** "Continue on web".
- The platform is resolved through `useSyncExternalStore` with a `null` server snapshot, so
  the pre-hydration markup an OG crawler sees is identical to the server markup.
- **The app is never fired on page load.** Browsers block navigation without a user
  gesture, an auto-redirect breaks the back button, and a crawler would trip it.

---

## iOS Handoff

iOS Universal Links are **not configured**. The iOS project has no associated-domains
entitlement, `APPLE_APP_IDS` is empty, and no AASA file is served from the website.

The interstitial therefore uses the custom scheme only:

1. navigate to `aimess://…`;
2. a ~1200 ms timer falls back to the App Store;
3. the timer is cleared on `pagehide` — a successful app launch fires `pagehide`, so the
   store is not opened on top of the app;
4. with `NEXT_PUBLIC_APPLE_STORE_APP_ID` empty (it is, today), the fallback is the web
   target rather than a dead App Store URL.

The gateway's `buildAppleAppSiteAssociation()` was corrected to claim only `/+*`, `/g/*`
and `/community/*` — never `"/*"`, which would claim the whole marketing site. It stays
inert until an entitlement ships.

---

## API Contracts

**No API changes were required.** Every endpoint below already existed and is unmodified.

| Link                                | Preview endpoint                               | Auth              | Join endpoint                                        | Auth   |
| ----------------------------------- | ---------------------------------------------- | ----------------- | ---------------------------------------------------- | ------ |
| `/<handle>`, `/community/@<handle>` | `GET /api/v1/communities/by-handle/:handle`    | Bearer            | `POST /api/v1/communities/:id/join`                  | Bearer |
| `/+<code>`                          | `GET /api/v1/communities/invite-links/:code`   | Bearer            | `POST /api/v1/communities/invite-links/:code/redeem` | Bearer |
| `/g/<token>`                        | `GET /api/v1/chat/invite-links/preview/:token` | **none — public** | `POST /api/v1/chat/invite-links/join` `{token}`      | Bearer |

Both community previews require a Bearer token, so a logged-out visitor and every OG
crawler cannot call them. That is why the unfurl uses the shared-secret internal route:

```
GET <COMMUNITY_INTERNAL_URL>/internal/communities/by-handle/:handle/card
Header: x-internal-secret: <INTERNAL_SHARED_SECRET>
```

PUBLIC communities only. `communityService.getPublicCard()` 404s for a private, suspended
or missing community and never leaks metadata. The route is mounted at
`apps/community-service/src/api/routes/internal.routes.ts` and is **not** reachable through
the gateway's public `/api` proxy. When the secret is unset the whole internal surface 404s.

Website consumer: `aimess_website/src/server/publicCard.ts` — server-only, 2.5 s timeout,
returns `null` on any failure so the interstitial always renders.

### Share-URL generation (unchanged, verified)

| Kind              | Function                                   | File                                                             |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Public community  | `buildPublicShareUrl` → `<base>/<handle>`  | `apps/community-service/src/services/community.service.ts:1386`  |
| Private community | `buildInviteUrl` → `<base>/+<code>`        | `apps/community-service/src/services/community.service.ts:1367`  |
| Group             | `buildGroupInviteUrl` → `<base>/g/<token>` | `apps/chat-service/src/services/group-invite-link.service.ts:47` |

All three read `INVITE_LINK_BASE_URL`. **Clients must use the server-returned URL verbatim
and never reconstruct it.**

---

## Environment Configuration

### Backend

| Var                                | Value                               | Read by                                             |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `LINK_HOSTS`                       | `ai5dev.tech`                       | api-gateway (host gate; inert today)                |
| `APP_SCHEME`                       | `aimess`                            | api-gateway                                         |
| `WEB_APP_URL`                      | `https://ai5dev.tech`               | api-gateway                                         |
| `INVITE_LINK_BASE_URL`             | `https://ai5dev.tech`               | **community-service AND chat-service — must match** |
| `ANDROID_PACKAGE_NAME`             | `com.aifivetech.aimess.app`         | api-gateway                                         |
| `ANDROID_SHA256_CERT_FINGERPRINTS` | Play cert first, upload cert second | api-gateway                                         |
| `ANDROID_STORE_APP_ID`             | `com.aifivetech.aimess.app`         | api-gateway                                         |
| `APPLE_APP_IDS`                    | _(empty — blocked)_                 | api-gateway                                         |
| `APPLE_STORE_APP_ID`               | _(unset — blocked)_                 | api-gateway                                         |
| `COMMUNITY_INTERNAL_URL`           | `http://community-service:3003`     | api-gateway                                         |
| `INTERNAL_SHARED_SECRET`           | shared secret                       | api-gateway + community-service                     |

Code defaults now point at `ai5dev.tech` in all three services, so an unset variable can no
longer mint links on the dead `aimess.me` domain. chat-service's `INVITE_LINK_BASE_URL` was
`optional()` with no default, which silently degraded a group link to a bare token; it now
carries the same default as community-service so the two can never split.

### Website

`NEXT_PUBLIC_*` values are **inlined at build time** — they are not read from the container
environment at runtime. Supply them in `.env.production` before `next build` and rebuild the
image whenever one changes.

| Var                                | Value                                                |
| ---------------------------------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_LINK_DOMAIN`          | `ai5dev.tech` (CSV; must match `LINK_HOSTS`)         |
| `NEXT_PUBLIC_WEB_APP_URL`          | `https://ai5dev.tech` (og:url + store fallback base) |
| `NEXT_PUBLIC_APP_SCHEME`           | `aimess`                                             |
| `NEXT_PUBLIC_ANDROID_PACKAGE_NAME` | `com.aifivetech.aimess.app`                          |
| `NEXT_PUBLIC_ANDROID_STORE_APP_ID` | `com.aifivetech.aimess.app`                          |
| `NEXT_PUBLIC_APPLE_STORE_APP_ID`   | _(empty until iOS ships)_                            |
| `COMMUNITY_INTERNAL_URL`           | server-only — no `NEXT_PUBLIC_` prefix               |
| `INTERNAL_SHARED_SECRET`           | server-only — no `NEXT_PUBLIC_` prefix               |

The last two are read at runtime by a server component only. Prefixing either with
`NEXT_PUBLIC_` would publish the shared secret in the browser bundle.

---

## OG Metadata

Server-rendered on `/link` via `generateMetadata`, so a pasted link unfurls in WhatsApp,
Slack and iMessage:

```
og:title  og:description  og:type  og:url  og:image  twitter:card
```

| Link kind     | Metadata                                                                               |
| ------------- | -------------------------------------------------------------------------------------- |
| PUBLIC handle | **real** — name, description, member count, banner/avatar, via the internal card route |
| PRIVATE code  | **generic only** — "Private community invite"                                          |
| GROUP token   | **generic only** — "Group invite on AIMESS"                                            |

`og:url` is built from the **validated** target (`canonicalPath()`), never from raw input.

A link pasted into a group chat would otherwise leak the name and member count of a private
community to everyone in that chat.

---

## Security

- **Charset first.** Neither the handle nor the code/token charset permits `<`, `>`, `"`
  or `/`. Every path segment and every `/link?k=&v=` pair is re-validated through the same
  parser before anything is rendered. The middleware is a router, not a trust boundary.
- **No raw HTML.** The Next.js interstitial renders through JSX with values passed as
  props, so React escapes them. There is no `dangerouslySetInnerHTML` and no inline
  `<script>` carrying config — the gateway's `scriptJson()` `</script>`-escaping problem
  does not exist on this path. `scriptJson()` remains in `preview.ts`, which does build
  raw HTML.
- **No private metadata leakage.** Private codes and group tokens never reach the internal
  card lookup; `loadCard()` returns `null` for anything that is not a public handle.
- **No secret in the client bundle.** `INTERNAL_SHARED_SECRET` is read only in
  `src/server/publicCard.ts`, which is imported only from a server component.
- **Marketing routes preserved.** `detectFromPath()` returns `null` for anything outside
  the link path space; both the web middleware and the gateway catch-all hand those back
  untouched.
- **No auth bypass.** `/link` renders public-safe copy only; every actual join flow still
  lives behind `PrivateGuard` and the existing Bearer-authenticated endpoints.

---

## Authentication Redirect

"Continue on web" lands on the **target**, never a bare `/login`:

| Kind    | Web target                 |
| ------- | -------------------------- |
| public  | `/community/@<handle>`     |
| private | `/community/invite/<code>` |
| group   | `/message/invite/<token>`  |

All three live under `(layout-pages)`, wrapped by `PrivateGuard`. A logged-out visitor is
sent to `/login?redirect=<encoded path>`; `LoginView` reads `redirect`, accepts it only if
it starts with a single `/` (no protocol-relative `//`), and replaces to it after sign-in.
An already-signed-in visitor goes straight to the target and is not made to sign in again.

This behaviour is pre-existing and was not modified.

---

## Deferred Deep Links

The Play Store fallback carries `referrer=<token>`:

```
h_<handle>   p_<code>   g_<token>
```

`deferredToken()` exists in both `linkGrammar.ts` (web) and `detect-link.ts` (gateway).

**The Android app does not read the Play Install Referrer yet**, so a not-installed user
still has to find the community manually after installing. Emitting the referrer now costs
nothing and makes the app-side work a drop-in later. Do not describe deferred deep linking
as working until Install Referrer ships.

---

## Error States

| State                              | Web                               | App                                                                                |
| ---------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| Valid, not a member                | interstitial → preview + join CTA | preview screen + join CTA                                                          |
| Valid, already a member            | preview; join is idempotent       | community: straight to chat. group: shows "Join group" (no `isJoined` flag exists) |
| Private community, request pending | "Request pending"                 | "Request pending", CTA disabled                                                    |
| Invite expired                     | invalid-link page                 | `CHAT_INVITE_LINK_EXPIRED`                                                         |
| Invite revoked                     | invalid-link page                 | `CHAT_INVITE_LINK_NOT_FOUND`                                                       |
| Usage limit reached                | invalid-link page                 | `CHAT_INVITE_LINK_USAGE_LIMIT`                                                     |
| Community / group deleted          | 404 page                          | `CHAT_GROUP_NO_LONGER_EXISTS`                                                      |
| Viewer banned                      | generic invalid page              | server-authoritative error in-app                                                  |
| Handle/code fails charset          | 404 page (real 404 status)        | `parse()` returns null; in-app error, never a browser bounce                       |
| Private handle guessed             | 404, never revealed               | 404                                                                                |

All of these are produced by the pre-existing invite/join services — unchanged.

---

## Test Matrix

### Web — `aimess_website`

```bash
npm test
```

`node --test src/utils/linkGrammar.test.ts` — 9 tests, no test framework installed and none
added; the grammar module is dependency-free so Node's built-in runner suffices.

| Group               | Covers                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| public community    | `/handle`, `/community/handle`, `/community/@handle`, case folding                                                                                                                                                             |
| private invite      | `/+CODE`, `/%2BCODE`, `+`-collapsed-to-space                                                                                                                                                                                   |
| group invite        | `/g/TOKEN`                                                                                                                                                                                                                     |
| malformed           | `/g/`, `/g/a/b`, `/+`, `/community/@`, 2-char handle, hyphenated handle                                                                                                                                                        |
| marketing           | `/terms-of-service`, `/privacy-policy`, `/child-safety-standards`, `/delete-account`, `/login`, `/signup`, `/about`, `/support`, `/docs`, `/settings`, `/community`, `/community/create`, `/message/:id`, `/unknown/path`, `/` |
| XSS / traversal     | `<script>`, `"><script>`, `javascript:`, `%3C`, `%2F`, `../../`, 500-char, oversized token, `onerror=`                                                                                                                         |
| handoff payloads    | `deferredToken`, `appSchemeUrl`, `androidIntentExtra`                                                                                                                                                                          |
| `/link` entry point | `targetFromKindValue` re-validation                                                                                                                                                                                            |

### Backend — `apps/api-gateway`

```bash
cd apps/api-gateway && node ../../node_modules/jest/bin/jest.js --config jest.config.cjs tests/linkhost
```

26 tests (was 14). Adds group links, `/community/@handle`, the marketing fall-through, the
`%2B` form, the `aimess://joingroup` scheme forms, `deferredToken`, and an assertion that
the AASA file claims the namespaced prefixes and **not** `"/*"`.

### Live route matrix (dev server, `curl -o /dev/null -w '%{http_code}'`)

| URL                                                    | Status | Renders                                              |
| ------------------------------------------------------ | ------ | ---------------------------------------------------- |
| `/gokuldhamsociety`                                    | 200    | interstitial, `og:title` present                     |
| `/+5SNjriaRKO5kOX_lvh_7QQ`                             | 200    | generic private card, no metadata                    |
| `/%2B5SNjriaRKO5kOX_lvh_7QQ`                           | 200    | same target                                          |
| `/g/qBc4eEtQ6bopGcwU-HodCHCk`                          | 200    | generic group card, `S.token=`, `aimess://joingroup` |
| `/community/@gokuldhamsociety`                         | 200    | app community page (no interstitial)                 |
| `/community/create`                                    | 200    | app create page                                      |
| `/terms-of-service`                                    | 200    | Terms of Service (0 occurrences of "Open in app")    |
| `/privacy-policy`                                      | 200    | Privacy Policy                                       |
| `/child-safety-standards`, `/delete-account`, `/login` | 200    | unchanged                                            |
| `/.well-known/assetlinks.json`                         | 200    | `application/json`                                   |
| `/g`, `/g/`, `/unknown/path`, `/%3Cscript%3E`          | 404    | site 404                                             |
| `/link`, `/link?k=public&v=<script>`                   | 404    | site 404, payload never echoed                       |

### Device verification (not run here — needs a real device)

```bash
curl -sI https://ai5dev.tech/.well-known/assetlinks.json
```

```bash
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://ai5dev.tech&relation=delegate_permission/common.handle_all_urls"
```

```bash
adb shell pm get-app-links com.aifivetech.aimess.app
```

```bash
adb shell pm verify-app-links --re-verify com.aifivetech.aimess.app
```

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

Negative case — this one **must** open a browser:

```bash
adb shell am start -a android.intent.action.VIEW -d "https://ai5dev.tech/terms-of-service"
```

---

## Deployment Requirements

1. **Deploy the website.** `public/.well-known/assetlinks.json` ships with it. Verify:
   `200`, `content-type: application/json`, **no redirect**.
2. **Cloudflare.** `ai5dev.tech` is proxied. If Bot Fight Mode or a WAF rule challenges
   `/.well-known/*`, App Link verification fails with no visible error. Add a bypass rule
   for `/.well-known/*`. This cannot be done from the repository.
3. **`www.ai5dev.tech` 301s to the apex** (HAProxy `dev01.cfg`). Android does not follow
   redirects for `assetlinks.json`, so the Android manifest must claim the apex only, or
   `www` needs its own non-redirected copy.
4. **Live `.env.dev02`** is a separate file from the git template and is still stale. Set
   `ANDROID_PACKAGE_NAME`, `ANDROID_SHA256_CERT_FINGERPRINTS`, `ANDROID_STORE_APP_ID` and
   `INVITE_LINK_BASE_URL` by hand, then restart **chat-service and community-service** (one
   shared `env_file`, so one edit fixes both). Confirm a freshly created group invite comes
   back as `https://ai5dev.tech/g/<token>`.
5. **Website build-time env.** Add the `NEXT_PUBLIC_*` deep-link values to
   `.env.production` and rebuild the image — they are inlined, not read at runtime. Set
   `COMMUNITY_INTERNAL_URL` / `INTERNAL_SHARED_SECRET` in the container environment (these
   _are_ runtime).
6. **Network path.** The website (dev01) must be able to reach community-service (dev02) on
   the internal URL, or the public OG card silently degrades to the generic card. That is a
   graceful degradation, not an outage.
7. **Android client build.** App Link verification runs only on install/update, so existing
   installs will not pick up new claims until they update.

---

## Rollback Plan

Each piece is independently revertible; nothing shares state.

| Change                                                                    | Rollback                               | Blast radius if reverted                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `public/.well-known/assetlinks.json`                                      | delete the file                        | back to 404; App Links stop verifying. No other effect                                        |
| `src/middleware.ts`                                                       | `git checkout` the file                | canonical links go back to redirecting straight to the in-app page; no interstitial, no OG    |
| `src/app/link/*`, `src/server/publicCard.ts`, `src/utils/linkGrammar*.ts` | delete; revert `src/utils/deeplink.ts` | requires reverting middleware too (it imports the grammar)                                    |
| `src/configs/app.config.ts`                                               | revert                                 | `linkDomain` returns to `aimess.me`, so in-app AIMESS links stop being recognised             |
| gateway `linkhost/*` + routes                                             | `git checkout`                         | dead code in this environment; zero production impact today                                   |
| env defaults (3 services)                                                 | `git checkout`                         | only affects environments that leave the variable unset — all deployed envs set it explicitly |

The riskiest single change is `src/middleware.ts`, because it sits in front of every
request. Its failure mode is contained: any path the grammar does not claim returns
`NextResponse.next()` unchanged, and that path is covered by the marketing-route test.

---

## Remaining gaps

Not implemented. Do not report these as done.

1. **iOS Universal Links** — no associated-domains entitlement, `APPLE_APP_IDS` empty, no
   AASA served from the website. iOS uses the `aimess://` interstitial path only.
2. **Install Referrer** — the Android app does not read it, so deferred deep links do not
   resume after install. The web emits the referrer correctly; the app side is missing.
3. **Bare `/<handle>` costs one tap.** Structural (see the grammar section). Closing it
   means either moving public share URLs to `/community/@<handle>` (change
   `buildPublicShareUrl`) or moving the whole link space to a dedicated host
   (`link.ai5dev.tech`) DNS'd at the gateway. Neither is done.
4. **No `isJoined` on the group preview.** `GroupInviteLinkService.preview()` still returns
   `{token, groupId, groupName, groupAvatar, description, memberCount, memberLimit}`. An
   existing member tapping their own group link sees "Join group"; the join is idempotent
   and returns the room either way. Deliberately not added — it is a product decision, not
   a deep-linking requirement.
5. **`aimess://join-group` vs `aimess://joingroup`.** chat-service mints the _hyphenated_
   form in DM invitation payloads (`buildGroupInviteDeepLink`,
   `group-invite-link.service.ts:53`), while the guide's canonical scheme is `joingroup`.
   The backend was **not** changed — three tests assert the current shape and the Android
   parser could not be verified from this repository. The web parser accepts **both**
   forms. Confirm with the mobile team which one the app parses, then align.
6. **Android manifest still pre-claims `aimess.me`.** That domain does not resolve, so it
   is inert. If it is ever registered it needs its own `assetlinks.json`.
7. **Fingerprints unverified.** See the App Links section.
8. **Real-device verification not run.** No Android device was available in this
   environment; the `adb` commands above are unexecuted.
