# AIMess Backend — Consolidated Audit Report

**Date:** 2026-06-11 · **Scope:** all 7 services · **Method:** static review of routes,
validators, controllers, services, repositories, middleware and gRPC/consumer wiring
while deriving the test suite. Every finding is grounded in a `file:line`. Full detail
per service lives in each `apps/<service>/tests/AUDIT.md`.

> These are observations derived from reading the code, not exploited vulnerabilities.
> Severity reflects impact **if** the service is reachable as written. Several Highs are
> latent today only because a feature is unwired or dev-gated — they are flagged because
> the protective gate is the _only_ thing standing between them and production.

## Headline

**84 findings — 25 High · 31 Medium · 28 Low.**

| Service               |  High | Med | Low | Most serious theme                                          |
| --------------------- | ----: | --: | --: | ----------------------------------------------------------- |
| auth-service          |     6 |   4 |   3 | Auth routes unthrottled + login validation disabled         |
| user-service          |     2 |   5 |   4 | Privacy settings not enforced on write paths                |
| community-service     |     3 |   4 |   4 | Admin/taxonomy + member authz gaps; a dead route            |
| chat-service          | **8** |   5 |   5 | **Pervasive IDOR** across history/media/calls/notifications |
| notifications-service |     2 |   4 |   4 | Unauth push relay + silently-failing gRPC stubs             |
| backoffice-service    |     3 |   3 |   4 | No admin-login throttle; spoofable audit IP                 |
| api-gateway           |     1 |   6 |   4 | Unauth TURN-credential leak; in-memory limiters             |

## Cross-cutting themes (fix these classes, not just instances)

1. **Authorization is applied inconsistently per-endpoint → IDOR (the #1 risk).**
   Many read/write paths check only resource _existence_, not the caller's
   _relationship_ to it. Worst in **chat-service** (message history & search, media
   download, call read, notification mark-read, group add-member, invite-link listing).
   _Systemic fix:_ a single, centralized participation/membership/ownership guard reused
   by every handler, so it cannot drift endpoint-by-endpoint.

2. **Rate-limiting / brute-force protection is declared but not wired.** Auth-service
   defines a limiter that's never mounted (and computes its window in **milliseconds**);
   backoffice declares admin rate-limit env vars read by nothing; the gateway's limiters
   use an **in-memory store** that N replicas multiply by N. Login/register/OTP/admin-login
   are effectively unthrottled. _Fix:_ one Redis-backed limiter mounted on every sensitive
   POST surface, at the gateway **and** defense-in-depth in the auth/admin services.

3. **Dev/debug leftovers that leak data shipped to mainline.** Plaintext-password
   `console.log` in auth; an unauthenticated `/debug/snapshot` (chat) and `/test/push`
   (auth + notifications) gated only by `NODE_ENV`. _Fix:_ delete them; add a CI assertion
   that no router except `/health` mounts without an auth gate.

4. **Silent-failure logic bugs.** community `/leave` writes status `'active'` instead of
   `'left'` (leave is a no-op and member counts drift); notifications gRPC
   `getNotifications`/`markNotificationsRead` are hardcoded no-op stubs that return
   _success_ while persisting nothing; community `GET /liked` is unreachable due to route
   ordering. _Fix:_ the specific corrections below + tests that pin them.

5. **Spoofable trust-proxy / audit IP.** backoffice and gateway derive client IP from
   `X-Forwarded-For[0]` (client-controlled) and only `set('trust proxy')` when hops>0.
   The immutable admin audit trail can be written with attacker-chosen IPs. _Fix:_ always
   `set('trust proxy', hops)` and read `req.ip`.

---

## High-severity catalog (all 25)

### auth-service

- **[H] `/login` runs with NO request validation** — `validateBody(loginSchema)` is
  commented out (`auth.routes.ts:48-49`, import `:25`). Missing `account` throws in the
  service → **500 instead of 400**; an object `account` / non-string `password` reach the
  repo and `bcrypt`. _Fix: re-enable the validator (schema already exists & is tested)._
- **[H] Sensitive-auth rate limiter defined but never applied** — `rate-limiters.ts:8`
  is imported nowhere; login/register/forgot-password are HTTP-unthrottled despite the
  `SENSITIVE_AUTH_RATE_LIMIT_*` env knobs.
- **[H] Rate-limiter `windowMs` is 15 ms, not 15 min** — `rate-limiters.ts:10` passes raw
  minutes to a millisecond field (correct `*60*1000` left commented `:9`). Latent only
  because of the above.
- **[H] Debug `console.log` of credentials/PII** — `auth.controller.ts:34` logs the
  plaintext password; `auth.service.ts:24/40/69` log the full user row incl.
  `passwordHash`. Writes secrets to stdout in every environment.
- **[H] Username uniqueness is case-sensitive, contradicting its own invariant** —
  `.toLowerCase()` commented in `auth.validator.ts:6`; exact `findUnique` in
  `auth.repository.ts:297-299`; `login-identifier.ts:7-13` claims lowercase storage.
  `Alice`/`alice` become distinct accounts; availability checks unreliable.
- **[H] Password-reset request leaks account existence** — `password-reset.service.ts:60-62`
  returns 404 for unknown emails vs 200 for resettable ones (user enumeration). _Fix:
  generic 200 for both._

### user-service

- **[H] Call allow-list entries never validated as real friends** —
  `user-settings.service.ts:98-113` checks only UUID/≤500/not-self, then
  `createMany` (`:264-276`). A user can grant "selected friends may call me" to arbitrary
  strangers/blocked users. _Fix: validate against `findAcceptedFriendIdsForUser`._
- **[H] `whoCanCallMe=SELECTED_FRIENDS` accepted with an empty/missing list** —
  no cross-field refinement (`settings.validator.ts:50-59`); privacy state reads
  SELECTED_FRIENDS but behaves as NO_ONE and the two fields can drift.

### community-service

- **[H] Admin category CRUD has no authorization** — `community.routes.ts:135-158` gates
  POST/PATCH/DELETE `/categories` with only validation; any authenticated user can mutate
  the **global taxonomy**. _Fix: platform-admin gate._
- **[H] Friend-validation gate commented out in `addMembers`** —
  `community.service.ts:1575,1604-1607` disabled while create still enforces it
  (`:793-797`); a moderator/admin can add **any** userId. Inconsistent + dead `NOT_FRIEND`
  code.
- **[H] `GET /liked` is unreachable (route ordering)** — `/:id` (`:251`) is registered
  before static `/liked` (`:306`); the id validator rejects `"liked"` → 400. Dead endpoint.
  _Fix: register `/liked` before `/:id`._

### chat-service (highest concentration — treat as a unit)

- **[H] Unauthenticated `GET /debug/snapshot/:userId`** — `health.routes.ts:25-52`: no
  auth, enumerates identity via gRPC fan-out, and `redis.del`s the snapshot cache
  (cache-poison/DoS). Flagged "remove before production".
- **[H] Message timeline + search not gated on participation (IDOR on history)** — private
  (`private-message.service.ts:154-286`), group (`group-message.service.ts:189-237,363-373`)
  and community history/search (`community-message.service.ts:408-465,659-672`) read without
  a membership check. Anyone who learns a `roomId` can page & search the full text history.
- **[H] `addMember` does not authorize the actor** — `group-member.service.ts:21-69` never
  checks the caller is an admin/member; any user can inject anyone into any group.
- **[H] Invite-link listing exposes live join tokens** —
  `group-invite-link.service.ts:136-142` returns every active token to any authenticated
  caller; a token alone grants join.
- **[H] Community `/leave` writes status `'active'` not `'left'`** —
  `community-room.service.ts:60-65` passes the wrong status arg; leave is a no-op while
  `memberNumber` is decremented → count drift, no not-a-member guard.
- **[H] Notification mark-read is unscoped & unvalidated (IDOR)** — `notification.routes.ts:10`
  (no validator) + `notification.service.ts:14-16` (`markRead(notificationId)` with no
  userId). An existing `markReadSchema` is unused.
- **[H] Media download authorizes by key prefix only (attachment IDOR)** —
  `media.controller.ts:82-117` checks `startsWith('chat-uploads/')` but never compares the
  key's embedded `ownerId` to the caller; any known/guessed key yields a presigned URL.
- **[H] `GET /calls/:callId` returns any call to any user (IDOR)** —
  `call.controller.ts:22-27` / `call.service.ts:184-186` perform no participant check;
  exposes caller/callee/duration/room of arbitrary calls.

### notifications-service

- **[H] Dev `POST /test/push` has no authentication** — `test-push.routes.ts:12-53` sends
  an FCM push to attacker-supplied tokens with attacker text; gated only by `NODE_ENV`.
- **[H] gRPC `getNotifications`/`markNotificationsRead` are no-op stubs** —
  `grpc/server.ts:13-29` return empty/zero unconditionally though the server is started;
  mark-read **silently succeeds without persisting**. _Fix: implement or return UNIMPLEMENTED._

### backoffice-service

- **[H] No brute-force/rate-limit on admin login (or any admin route)** — the
  `ADMIN_*_RATE_LIMIT_*` env vars (`env.ts:44-50`) are read nowhere; `app.ts` mounts no
  limiter; `login()` does an unthrottled `findByEmail`+`bcrypt.compare`.
- **[H] `ADMIN_IP_WHITELIST` declared but not enforced in-service** — `env.ts:39-40`,
  consumed nowhere; no defense-in-depth if the gateway is bypassed.
- **[H] Audit-log client IP is unreliable/spoofable** — `request-context.ts:14-24` trusts
  `X-Forwarded-For[0]`; `app.ts:17-19` only sets trust-proxy when hops>0 (default 0), so the
  immutable audit trail records the proxy IP or an attacker-forged one.

### api-gateway

- **[H] `GET /api/v1/webrtc/rtc-config` has no auth → TURN credential leak** —
  `webrtc.routes.ts:11-27` mounts with no JWT; response can include TURN
  username/credential (`messaging.client.ts:198-209`). Anonymous callers can harvest
  static TURN creds and relay media at the operator's expense. _Fix: require a token /
  serve STUN-only anonymously / issue ephemeral creds._

---

## Medium & Low findings (by service)

Full detail (file:line, repro reasoning, recommendation) in each service's `AUDIT.md`.

**auth-service** — _M:_ dev `/test/push` unauth enumeration; no password-complexity policy
(length-only); social ID-token failures surface as **500 not 401**; gRPC admin/internal
methods have no per-call auth (insecure creds). _L:_ `validateBody` `console.error` leaks
Zod errors; dead/commented code; `mergeFcmTokens` builds uncapped token array.

**user-service** — _M:_ `section=all` excludes only users _I_ blocked, not those who
blocked me (presence leak); friendship counter `$transaction` can underflow/drift under
concurrency; `sendRequest` ignores addressee `whoCanSendFriendRequests`; old avatar object
not deleted on replace/clear (storage leak); recycle-to-PENDING skips profile-cache
invalidation. _L:_ generic P2002 always mapped to "username taken"; events fire-and-forget
(no outbox/retry); `bio.max(280)` counts UTF-16 units; bidirectional block check is
non-obvious.

**community-service** — _M:_ `/liked` has no query validation (unbounded limit); redeem
invite increments usage **before** adding member (no compensation); `/like` allows liking a
PRIVATE/non-joined community and leaks its metadata; error handler hard-codes
`COMMUNITY_NAME_TAKEN` for any P2002. _L:_ `/mine` ignores its documented "≥1 filter" rule;
`listLiked` membership N+1; member-count recompute outside a transaction; non-null
assertions on the snapshot map can 500.

**chat-service** — _M:_ private pin has no participation check (unlike unpin); group pin
lacks membership/role gate; community DELETE has no type validation and `deleteForMe` is
unguarded; community edit/react broadcast room is taken from the **client body** (cross-room
emit); community room search has no query validation. _L:_ group not-member uses 400 vs peers'
403; presence & member-list reads ungated; community reaction is a non-atomic
read-modify-write; `getMessagesAround` swallows a missing room while peers 404; react reuses
`CHAT_MESSAGE_EDITED` message key.

**notifications-service** — _M:_ device routes wired **without** session-revocation check
(revoked tokens still register/unregister ~1h); OTP/notification consumer "recovery"
**delete-and-recreates the live queue**, destroying in-flight OTP/email messages; no per-user
device-token cap (unbounded rows + fan-out); OTP/email HTML interpolated without escaping

- no email-shape validation. _L:_ responses diverge from the `{success,message,data}`
  envelope; dead 400 branch on `DELETE /v1/devices/:token`; inconsistent PushInput/`type`
  construction; `push.service` swallows all failures (silent inbox divergence).

**backoffice-service** — _M:_ admin password policy comment says "min 12" but schema is
`min(6)` (incl. bootstrap super-admin); moderation/community/livestream repos are in-memory
fixtures (non-persistent; not atomic with the real audit writes); `verify-otp` has no
per-IP/email throttle. _L:_ `verify-otp` early-return timing oracle; `notifyOwner` re-coalesced
after Zod default; stale step-up-TOTP TODOs on destructive actions (TOTP was dropped);
`flagFalseReport` accepted & audited but never persisted.

**api-gateway** — _M:_ RTC 503 path returns `success:true`; all rate limiters use in-memory
store (defeated by scale-out); global rate-limit skip uses unanchored `includes()`
(throttle-bypass surface); `requestIdMiddleware` overwrites inbound `x-request-id` (breaks
trace correlation); env semver regex accepts shapes the runtime parser rejects (→500); admin
IP allowlist trusts `X-Forwarded-For[0]` (spoofable). _L:_ app-version policy cached forever
(no TTL/invalidation → slow force-update kill-switch); CORS reflects any origin with
credentials in `development`; oversize body → 500 instead of 413; admin-JWT public-path skip
uses exact match + is duplicated in 3 places.

---

## Recommended remediation order

1. **chat-service IDOR cluster (8 High)** — centralize a participation/ownership guard;
   fix the `/leave` status bug; remove `/debug/snapshot`. Highest blast radius.
2. **Wire rate limiting everywhere it's declared** (auth, backoffice, gateway) with a
   shared Redis store; fix the auth `windowMs` ms-vs-min bug.
3. **Re-enable auth `/login` validation** and **delete all credential `console.log`s**.
4. **Authorize community admin-category CRUD** and re-enable the `addMembers` friend gate.
5. **notifications:** remove `/test/push`, and make the gRPC stubs implemented-or-UNIMPLEMENTED.
6. **Enforce privacy settings on write paths** (user-service call allow-list & friend-request
   scope) and **fix spoofable audit IPs** (backoffice + gateway trust-proxy).
7. Work the Medium/Low lists per service (envelope consistency, transactions/outbox,
   enumeration timing, validation gaps).

## What the executable suite does and does not cover

The suite is **REST/HTTP integration with mocked deps**. By design it does **not** exercise:
real databases & constraints, true cross-service gRPC, RabbitMQ consumer message flow,
Socket.IO post-connect handlers (only connection-auth is unit-tested at the gateway), the
real OAuth/JWKS verifiers, MinIO/FCM providers, or multi-replica concurrency. Each service's
`AUDIT.md` "uncovered areas" enumerates these gaps; they are the natural next layer
(contract tests + a docker-compose e2e tier) once the High findings above are addressed.
Several Highs (e.g. the IDORs) are **derived from code** and not yet pinned by a failing
test — adding red tests for them is the fastest way to drive and verify the fixes.
