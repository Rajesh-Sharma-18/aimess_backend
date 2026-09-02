# AIMESS backend — security remediation log

Companion to `SECURITY_AUDIT.md` (89 findings, frontend + backend). This file tracks
only the **backend** work: what was re-opened against the live source, what was fixed,
how to verify it, and what risk is left over.

Frontend-only findings (AIM-02, 42, 43, 45, 46, 47, 78, 81, 82, 88) are out of scope
here and are not listed. Where a frontend fix needs a backend contract, the backend
half is recorded under the relevant row.

**No live secret value appears in this file.** Secrets are referred to by variable name
only. Operator rotation steps are in the *Secret rotation* section at the bottom.

## Baseline before any change

Full suite at the starting commit (`7c6d381c`, branch `rajesh-dev`), so a regression is
distinguishable from a pre-existing failure:

| Metric | Value |
|---|---|
| Test suites | 15 failed, 427 passed, 442 total |
| Tests | 60 failed, 5524 passed, 5584 total |

Pre-existing failing suites (must stay the *same set* — no additions):

```
apps/api-gateway/tests/sockets/stream-leave-idempotency.test.ts
apps/backoffice-service/tests/admin-accounts/admin-permission-resolution.test.ts
apps/backoffice-service/tests/groups/group-management.test.ts
apps/backoffice-service/tests/users/user-directory-status-filter.test.ts
apps/chat-service/tests/community/community-closed-write-guard.test.ts
apps/chat-service/tests/community/community-message-delivery.test.ts
apps/chat-service/tests/community/community-message.test.ts
apps/chat-service/tests/community/community-reaction-live-list.test.ts
apps/chat-service/tests/community/community-system-message-delivery.test.ts
apps/chat-service/tests/community/rest-community-reactions.test.ts
apps/chat-service/tests/grpc/service-impl.test.ts
apps/chat-service/tests/private/private-message.test.ts
apps/chat-service/tests/private/rest-reactions.test.ts
apps/chat-service/tests/services/admin-group-identity-search.test.ts
apps/stream-service/tests/comments/livestream-comment-broadcast-shape.test.ts
```

## Status legend

| Status | Meaning |
|---|---|
| `OPEN` | Re-verified against the live tree; defect still present; fix pending or in progress. |
| `FIXED` | Fixed in this pass. Row carries the files, the change and how to verify. |
| `PARTIAL` | Defect confirmed but only part of it is closable in-repo, or the fix is deliberately narrower. |
| `ALREADY_FIXED` | The audit's claim no longer holds against the live source. Proof in the notes. |
| `OPS_ONLY` | Nothing to change in code. Operator action (rotation, scoped credentials, network). See *Secret rotation*. |
| `WONT_FIX` | Deliberately not done in this pass. Reason and residual risk recorded. |
| `UNVERIFIED` | Not yet re-opened against the live source at the time of writing. |

## Phase 0 — backend inventory

79 backend findings. `Sev` is the audit's severity.

| ID | Sev | Issue | Status |
|---|---|---|---|
| AIM-01 | critical | backoffice admin API publicly routed, no IP allowlist, no rate limit | FIXED |
| AIM-03 | high | socket `message:send` bypasses every chat send rate limit | FIXED |
| AIM-04 | high | community socket send unlimited, fans out to whole community | FIXED |
| AIM-05 | high | community `addMembers` friend check commented out | FIXED |
| AIM-06 | high | session revocation not enforced in community/stream/media services | FIXED |
| AIM-07 | high | Apple sign-up trusts client-supplied unverified email | FIXED |
| AIM-08 | high | client-controlled `X-Forwarded-For` used as rate-limit key and session IP | FIXED |
| AIM-09 | high | message edit persists unverified `content.files[]`, read path presigns any key | FIXED |
| AIM-10 | high | `admin:group:subscribe` accepts any room id (live DM wiretap) | FIXED |
| AIM-11 | high | CORS reflects any origin with credentials when `NODE_ENV` is not production | FIXED |
| AIM-12 | high | presigned upload URL does not bind `Content-Length` | FIXED |
| AIM-13 | high | RabbitMQ + MinIO consoles published publicly, no IP allowlist | FIXED |
| AIM-14 | high | HAProxy trusts `CF-Connecting-IP` from any source | FIXED |
| AIM-15 | high | unvalidated `/admin` socket payloads crash the gateway process | FIXED |
| AIM-16 | high | livestream publish credential embedded in every viewer's playback URL | OPEN |
| AIM-17 | high | live SRS hook secret committed in `docker/srs/aimess.conf` | FIXED |
| AIM-18 | high | LiveKit API secret has a working committed default | FIXED |
| AIM-19 | high | admin JWT secret is a placeholder; gateway declares it optional | FIXED |
| AIM-20 | high | Firebase service-account private key in plaintext `.env` | OPS_ONLY |
| AIM-21 | high | APNs VoIP signing key in plaintext `.env` | OPS_ONLY |
| AIM-22 | high | Google Workspace app password for a staff mailbox in two `.env` files | OPS_ONLY |
| AIM-23 | high | bootstrap super-admin seeded on a public disposable-mail inbox | PARTIAL |
| AIM-24 | high | Mongo/Redis without auth, ports published (production templates) | PARTIAL |
| AIM-25 | high | every service holds MinIO root credentials | OPS_ONLY |
| AIM-26 | medium | unthrottled typing/recording events cause uncached gRPC + DB fan-out | FIXED |
| AIM-27 | medium | `presence:subscribe` joins attacker-named rooms before authorization | FIXED |
| AIM-28 | medium | no Socket.IO connection cap per user or IP | FIXED |
| AIM-29 | medium | global limiter keyed on the bearer token; rotation buys a fresh quota | FIXED |
| AIM-30 | medium | admin login has no per-account lockout | FIXED |
| AIM-31 | medium | account-availability endpoint unauthenticated, unthrottled, enumerable | PARTIAL |
| AIM-32 | medium | `community:join` fails open on a membership-check error | FIXED |
| AIM-33 | medium | `GET /streams` lists any community's streams, no membership or ban check | FIXED |
| AIM-34 | medium | gateway forwards the SRS shared secret in the public URL query | FIXED |
| AIM-35 | medium | admin IP allowlist reads the leftmost XFF hop | FIXED |
| AIM-36 | medium | LiveKit webhook secret has a working hardcoded default | FIXED |
| AIM-37 | medium | audit source and client IP taken from client-controlled input | FIXED |
| AIM-38 | medium | socket JWT expiry unenforced on `/notify`, `/stream`, `/admin` | FIXED |
| AIM-39 | medium | three gateway rate limiters defined but never mounted | FIXED |
| AIM-40 | medium | deploy compose template publishes internal services on 0.0.0.0 | FIXED |
| AIM-41 | medium | attachment/sticker/thumbnail URLs stored with no scheme restriction | FIXED |
| AIM-44 | medium | account deletion anonymizes nothing; no purge job | OPEN |
| AIM-48 | medium | livestream publish key logged verbatim before the secret check | FIXED |
| AIM-49 | medium | antivirus disabled in the production template; `SKIPPED` is downloadable | FIXED |
| AIM-50 | medium | Swagger + OpenAPI served publicly everywhere, exempt from rate limiting | FIXED |
| AIM-51 | medium | no Content-Security-Policy anywhere (helmet CSP disabled) | FIXED |
| AIM-52 | medium | cross-host DB/cache/object-store traffic in plaintext in production | FIXED |
| AIM-53 | medium | admin IP allowlist empty in the production template; empty = allow all | FIXED |
| AIM-54 | medium | one `JWT_ACCESS_SECRET` copied into eight `.env` files | OPS_ONLY |
| AIM-55 | medium | internal gRPC service token is a committed placeholder | FIXED |
| AIM-56 | medium | shared Postgres/Mongo/RabbitMQ credentials in the root `.env` | OPS_ONLY |
| AIM-57 | medium | SRS HTTP API basic-auth credentials in `stream-service/.env` | OPS_ONLY |
| AIM-58 | low | registration needs no verified contact, no captcha, issues tokens at once | WONT_FIX |
| AIM-59 | low | offset pagination accepts an unbounded `page` on every paged endpoint | FIXED |
| AIM-60 | low | community invite links never expire, default to unlimited uses | WONT_FIX |
| AIM-61 | low | livestream creation unthrottled; `PENDING` exempt from concurrency caps | FIXED |
| AIM-62 | low | Redis-backed limiters in three services fail open on any cache error | FIXED |
| AIM-63 | low | per-socket presence maps grow unbounded from attacker-supplied ids | FIXED |
| AIM-64 | low | password-reset request is a user-enumeration oracle | FIXED |
| AIM-65 | low | access tokens carry no issuer or audience claim | WONT_FIX |
| AIM-66 | low | `POST /auth/token` mints access tokens without rotating the refresh token | PARTIAL |
| AIM-67 | low | password policy is length-only, 8 characters | WONT_FIX |
| AIM-68 | low | debug logging decodes the unverified JWT payload on every request | FIXED |
| AIM-69 | low | attachment guard passes any http(s) value through unchecked | FIXED |
| AIM-70 | low | attachment ownership/scope/scan gate disabled by a flag, no prod guard | FIXED |
| AIM-71 | low | request body size unbounded on proxied routes (parsers mounted after) | FIXED |
| AIM-72 | low | gateway limiters use an in-process store, not shared across replicas | OPEN |
| AIM-73 | low | `POST /auth/refresh` has no dedicated rate limiter | FIXED |
| AIM-74 | low | link-host router and SRS hook route mounted before the rate limiter | FIXED |
| AIM-75 | low | `/api/v1/media` (presigned upload minting) has no dedicated limiter | FIXED |
| AIM-76 | low | `RATE_LIMIT_ENABLED` disables the global backstop with no prod assertion | FIXED |
| AIM-77 | low | Swagger `servers` built from `X-Forwarded-Host` | FIXED |
| AIM-79 | low | every user's email written to the production log on every mail | FIXED |
| AIM-80 | low | SMTP transport does not require TLS on non-465 ports | FIXED |
| AIM-83 | low | api-gateway defaults `NODE_ENV` to development | FIXED |
| AIM-84 | low | JWT signing secrets validated as bare `z.string()` in three services | FIXED |
| AIM-85 | low | `INTERNAL_SHARED_SECRET` documented as a guard but never read | FIXED |
| AIM-86 | low | unauthenticated backoffice health endpoints leak env and DB reachability | FIXED |
| AIM-87 | low | AsyncAPI docs page loads third-party JS from a floating major version | FIXED |
| AIM-89 | low | QR device-link token written to logs verbatim | FIXED |

### Refuted in the audit — left closed

Not re-investigated: local docker-compose Mongo/Redis as a production finding,
media-service CORS `*`, livestream comment membership, lightbox `innerHTML`,
unbounded pins `take`, `validateQuery` merge, media download-url echo,
html2canvas/redux-persist, assetlinks debug package.

## Re-open notes (what was found at verification time)

Recorded as each finding was re-opened against the live source, BEFORE it was fixed. They
are kept as the evidence that each defect was real and still present, and as the reasoning
behind the fix that followed. Line numbers are from the live tree, not the audit.

**The status table above is authoritative** — most of the findings described below have
since been fixed, and each carries a row in the phase tables that follows.

### AIM-05 — community `addMembers` friend gate
Both blocks are still commented out in `apps/community-service/src/services/community.service.ts`
(the `fetchAcceptedFriendIds` call and the `NOT_FRIEND` skip). The surrounding comments and
the `AddMemberSkipReason` union still describe the gate as active. `fetchAcceptedFriendIds`
in `lib/user-client.ts` already fails closed to an empty set on a gRPC error, and
`create()` uses it exactly that way, so restoring the gate is an uncomment plus test-mock
fixes: three suites mock the helper as an array (`[]`) and would throw on `friendSet.has`.
`PATCH /communities/:id` with `memberIds` routes through the same function and inherits
the gate. Client impact: a non-friend moves from `added[]` to `skipped[{reason:"NOT_FRIEND"}]`,
a value already in the published contract.

### AIM-06 — session revocation in community/stream/media
All three middlewares still omit `assertSessionActive`; auth, user, chat and notifications
pass it. The shared reader (`getActiveSessionFromCache`) already lives in `packages/redis`,
and the gateway socket handshake already consults it, so the hole is REST-only in those
three services. Fix is one factory in `packages/redis/src/session-active.ts` with the exact
truth table the existing per-service helpers use (cache not ready → allow, `"1"` → allow,
`"0"` → deny, missing key → allow, Redis throws → allow) plus one line per middleware.
community-service and stream-service expose a readiness flag; media-service does not, and
does not need one because the shared client rejects fast when Redis is down.
Client impact: a revoked session now gets `401 AUTH_SESSION_ENDED` from `/communities/*`,
`/streams/*` and `/media/*`, the same code those clients already handle elsewhere.
Sibling gap found while verifying: `community-service/src/middleware/optional-authenticate-access-token.ts`
verifies the JWT with neither a session nor a ban check.

### AIM-16 — livestream ingest vs playback
Unchanged. One random value is simultaneously the SRS published stream name, the sole
`on_publish` credential, and the path segment of the HLS/FLV/DASH URLs handed to every
viewer. The schema has no `playbackId`. SRS serves media strictly under the *published*
name and its hooks can only allow or deny, never rename, so a plain "playback under a
different name" split would need an SRS topology change. The compatible design is the
inverse: publish under the new public `playbackId`, and carry the secret as a query
parameter on the RTMP/WHIP publish URL, which SRS passes to the hook. Existing rows are
backfilled `playbackId = streamKey` so in-flight streams keep working and are recognisable
as legacy until they end.

### AIM-33 — `GET /streams` authorization
The controller still passes only the parsed query, and `communityId` is optional, so
omitting it enumerates every community's streams with playable URLs. Neither the
per-stream ban check used by `getStream` nor the community ban check used by `checkAccess`
runs. The membership RPC the service already calls returns `is_member` and
`is_public_community` on the wire; only the TypeScript client type drops them, so no
proto change is needed.

### AIM-34 / AIM-48 — SRS secret in the URL, stream key in logs
The gateway still copies the request query verbatim onto the upstream call, and forwards
the `x-srs-secret` header only when SRS already sent one, which SRS cannot do. In
stream-service two log lines run *before* the shared-secret guard, so an unauthenticated
caller can write attacker-chosen strings into the log, and every authenticated hook logs
the raw stream name, which today is the publish credential.

### AIM-59 — unbounded `page`
No page schema in any service has an upper bound. community-service has one shared
`pageSchema` covering 18 endpoints; user-service has three literals; chat-service two;
backoffice-service 17 (admin-token only). No shared pagination schema exists in `packages/`.

### AIM-60 — invite link expiry, needs product sign-off
Confirmed as described, but this is a recorded product decision rather than drift: a 1-hour
TTL shipped in August was deliberately retired, the shared TTL module was deleted, and
about eight test assertions pin "links never expire". Implementing a default expiry
reverses that decision and changes the invite-card contract. Recommendation is to leave it
open pending the product owner, with the exact diff recorded below in the fix notes.

### AIM-61 — livestream creation throttle
Creation still has no throttle and `PENDING` rows still do not count toward either cap, but
the `PENDING` sweeper the audit asked for already exists (10-minute timeout), and the
community-wide fan-out fires on publish, not on create, so the blast radius is smaller than
stated: unbounded `PENDING` rows per creator plus admin-panel events.

### AIM-68 — unverified-JWT debug logging
Both leftovers are live and still labelled temporary. The investigation they were added for
is closed and covered by tests. They are the only `[auth-debug]` sites in the repo.

### AIM-85 — dead `INTERNAL_SHARED_SECRET`
The variable is declared in community-service and documented in three env templates and the
deploy template, and is read by nothing. The `/internal` route it once guarded was
deliberately replaced by a public-card route in August. The same retired design also left
`COMMUNITY_INTERNAL_URL` dead. Implementing the header check would guard data the gateway
already serves publicly on the same path, so the honest fix is to delete the variable and
the comments that claim a control exists.

### AIM-57 — SRS API credentials
In-repo state: the real values live only in the gitignored, untracked service `.env`. The
`.env.example` does not carry the keys at all, so a fresh checkout has no template for them.
The local SRS `http_api` has no auth block, contradicting a comment that says the same
credentials are configured there.

## Phase 1 — secret hygiene and boot guards (landed)

The theme: every one of these was a control that existed in code and was switched off, or
weakened, by configuration — with nothing refusing the boot. They are grouped because they
share a fix shape: make the unsafe configuration impossible to start with.

| ID | Files | Change | Verify | Client impact |
|---|---|---|---|---|
| AIM-83 | `apps/api-gateway/src/config/env.ts`, `apps/media-service/src/config/env.ts` | `NODE_ENV` is required, with no `"development"` default, matching the other seven services. | `tests/config/env-guards.test.ts` → "requires NODE_ENV to be set at all". | None. Both services already receive `NODE_ENV` in every compose file. |
| AIM-11 | `apps/api-gateway/src/config/env.ts` | Deleted the `NODE_ENV === "development"` short-circuit in `isCorsOriginAllowed`. Origins now come only from the allowlist, or from the new explicit `CORS_ALLOW_ANY_ORIGIN` flag, which production refuses to boot with. Applies to REST and Socket.IO alike, since both call this one function. | Same file → the `isCorsOriginAllowed` block and the two CORS boot cases. | Any environment relying on the old implicit bypass must now either list its origins in `CORS_ALLOWED_ORIGINS` or set `CORS_ALLOW_ANY_ORIGIN=true` (non-production only). |
| AIM-76 | `apps/api-gateway/src/config/env.ts` | Production boot fails when `RATE_LIMIT_ENABLED=false`. | Same file → "refuses to start with rate limiting disabled". | None in a correctly configured deployment. |
| AIM-19 | `apps/api-gateway/src/config/env.ts` | `JWT_ADMIN_SECRET` is `min(32)`, an empty value counts as unset, and production refuses to boot when `BACKOFFICE_SERVICE_URL` is set without it — the admin proxy can no longer be mounted without its verifier. | Same file → "refuses to mount the admin proxy without its token verifier". | None. Rotation is an operator step, below. |
| AIM-53 | `apps/api-gateway/src/config/env.ts` | Production refuses to boot with an empty `ADMIN_IP_WHITELIST` while an admin surface is configured, because an empty list means allow-all. | Same file → "refuses an empty admin IP allowlist". | Operators must populate the allowlist before the next production start. Non-production is unchanged. |
| AIM-18, AIM-36 | `apps/chat-service/src/config/env.ts`, `apps/api-gateway/src/config/env.ts`, both `.env.example` files, `docker/livekit/config.yaml` | Removed the `.default()` on `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in both services (secret now `min(32)`), blanked the published pair in the examples, and replaced the literal webhook `api_key` in the LiveKit config with a `__LIVEKIT_API_KEY__` placeholder. | `tests/config/env-guards.test.ts` → "requires the LiveKit webhook pair". | Any deployment that relied on the default must now set both variables. Calls and call webhooks are unaffected once set. |
| AIM-84 | `apps/auth-service/src/config/env.ts`, `apps/chat-service/src/config/env.ts`, `apps/notifications-service/src/config/env.ts`, plus `apps/api-gateway` and `apps/media-service` for parity | Every JWT signing secret is now `z.string().min(32)`; three of them were bare `z.string()`, so `""` or `"x"` passed boot validation. | `tests/config/env-guards.test.ts` → "rejects a short JWT_ACCESS_SECRET". | None — the real secrets already exceed 32 characters. |
| AIM-70 | `apps/chat-service/src/config/env.ts` | Production refuses to boot with `CHAT_MEDIA_VERIFY_ENABLED=false`, which disables attachment ownership, scope and scan verification on every send path. The escape hatch remains outside production. | Boot chat-service with `NODE_ENV=production CHAT_MEDIA_VERIFY_ENABLED=false`. | None in a correctly configured deployment. |
| AIM-49 | `apps/media-service/src/config/env.ts`, `packages/constants/src/media/classification.ts`, `apps/media-service/src/services/media.service.ts`, `apps/media-service/src/grpc/handlers/media.handler.ts` | Two halves. Production refuses to boot with `CLAMAV_ENABLED=false`. And `SKIPPED` — "no engine ever looked at this object" — left the default downloadable allow-list: `isDownloadableScanStatus` now takes an explicit `allowUnscanned` opt-in that only media-service passes, and only when it is knowingly running without a scanner. Both the REST download gate and the gRPC `downloadable` flag chat-service consumes go through it, so the two surfaces cannot drift. | `packages/constants/tests/media-scan-downloadable.test.ts` (11 cases). | **See residual risk below** — this one has a real migration consequence. |
| AIM-55 | `packages/grpc-utils/src/index.ts`, all ten `.env.example` files | `withServiceAuth` now also refuses to start in production when the service token is a value published in this repository, not just when it is missing. The examples ship blank with a generation hint. | `packages/grpc-utils/tests/placeholder-service-token.test.ts`. | None. |
| AIM-17 | `docker/srs/aimess.conf`, `docker-compose.yml` | Restored the `__SRS_HOOK_SECRET__` placeholder the file's own comment always claimed was there. A new one-shot `config-render` service substitutes both the SRS hook secret and the LiveKit webhook key into a named volume at start-up; SRS and LiveKit read the rendered copies and neither secret is in git. The renderer refuses to run with either secret unset, so it cannot emit a config that accepts unauthenticated hooks. | `docker compose config` parses; `docker compose up config-render` renders or fails loudly. | None for clients. Operators must have `SRS_HOOK_SECRET` and `LIVEKIT_API_KEY` in their root `.env`. |

### Verification

Every suite touched by Phase 1 was run against the pre-existing baseline above.

| Project | Result |
|---|---|
| api-gateway, media-service | 62 suites pass; only `stream-leave-idempotency` fails, which is on the baseline list |
| chat-service | only the 10 baseline failures |
| auth-service, community-service, stream-service, backoffice-service, user-service | only the 4 baseline failures |
| packages | 48 pass, including the 14 new cases |

One suite outside the baseline is failing, and it is **not** caused by this work:
`apps/notifications-service/tests/consumers/chat-consumer.test.ts` throws
`ReferenceError: isGroupMutedMock is not defined` at its own line 177. The working tree
carries an in-flight group-mute feature from separate work (new `messaging.proto` method,
`chat-messaging.client.ts`, `notification-eligibility.service.ts`), and that test file
references a mock it never declares. Confirmed by stashing the tree: the suite passes at
`HEAD` and fails with the concurrent changes applied, independently of the Phase 1 diff.

### Residual risk from AIM-49

Removing `SKIPPED` from the default downloadable set is correct, but it has a migration
consequence that must not be discovered in production. Any environment that has been
running with `CLAMAV_ENABLED=false` has stored objects whose only verdict is `SKIPPED`.
While that environment stays scanner-less nothing changes, because media-service opts in.
The moment ClamAV is switched on — which production now requires — those legacy objects
stop being served, and they are real user attachments and avatars.

Before enabling ClamAV on an environment that ran without it, do one of:

1. Re-run the scan pipeline over rows whose `scanStatus` is `SKIPPED`, letting each settle
   to `CLEAN` or a terminal reject. This is the correct option.
2. Accept the gap knowingly and migrate `SKIPPED` to `CLEAN` for objects older than the
   cutover. This re-admits never-scanned content and should be a deliberate, recorded
   decision, not a default.

Already-`CLEAN` media is unaffected in every case.

## Phase 2 — identity, authorization and abuse limits (landed)

| ID | Files | Change | Verify | Client impact |
|---|---|---|---|---|
| AIM-01 | `apps/backoffice-service/src/middleware/edge-guards.ts` (new), `src/app.ts`, `src/config/env.ts` | The admin API now carries its own whole-surface limiter, source allowlist and tighter credential limiter, mirroring the gateway's numbers, because the dedicated admin vhost routes straight here and bypassed all of it. Production refuses to boot with an empty allowlist, a short admin secret, or no CORS origins. | `tests/auth/edge-guards.test.ts` (9 cases). | Operators must populate `ADMIN_IP_WHITELIST` before the next production start. Admin clients see 429 on credential floods, as they already would through the gateway. |
| AIM-08, AIM-35, AIM-37 | `apps/auth-service/src/lib/session-context.ts`, `src/app.ts`, `apps/api-gateway/src/middleware/admin-ip-allowlist.ts`, `src/app.ts`, `src/sockets/audit-context.ts`, `apps/backoffice-service/src/lib/request-context.ts`, `src/app.ts`, `packages/constants/src/audit-source.ts` | Every hand-rolled `X-Forwarded-For` parse is gone; `req.ip` is the one source of client identity, and `app.set("trust proxy", …)` is applied unconditionally in all three services (auth-service never applied it at all, so `req.ip` was the socket address there). The socket handshake, which has no `req`, counts hops from the RIGHT. The audit source can no longer be `ADMIN_PANEL` from a public header, and the `?platform=` query fallback is gone. | `apps/api-gateway/tests/sockets/handshake-client-ip.test.ts`, updated cases in `apps/auth-service/tests/lib/session-context.test.ts` and `apps/backoffice-service/tests/audit-logs/audit-logs.test.ts`. | None for honest clients. Rate-limit buckets and recorded IPs become correct rather than caller-chosen. |
| AIM-06 | `packages/redis/src/session-active.ts`, the three `authenticate*` middlewares in community, stream and media | One shared `createSessionActiveGuard`, with the exact truth table the four services that already checked revocation use, wired into the three that did not. | `packages/redis/tests/session-active-guard.test.ts` (7 cases). | A revoked session now gets `401 AUTH_SESSION_ENDED` from `/communities/*`, `/streams/*` and `/media/*` — a code these clients already handle from the other services. |
| AIM-05 | `apps/community-service/src/services/community.service.ts` | Restored the friend gate that was commented out while every comment around it, and the `NOT_FRIEND` value in the published contract, still described it as live. | `tests/members/add-members-friend-gate.test.ts` (5 cases). | A non-friend moves from `added[]` to `skipped[{reason:"NOT_FRIEND"}]`. Pickers that offer non-friends will see those entries skipped. |
| AIM-07 | `apps/auth-service/src/services/social-auth.service.ts`, `src/api/validators/social-auth.validator.ts` | Apple's account email comes only from the signed identity token. The client-supplied `email` is still accepted by the schema (so shipped apps do not start failing validation) and ignored. | Updated + new cases in `tests/auth/social-auth.test.ts`. | A first-time Apple sign-up is unaffected. An Apple sign-in with no token email and no existing link is refused with `AUTH_SOCIAL_EMAIL_REQUIRED` instead of creating an account on a claimed address. |
| AIM-64 | `apps/auth-service/src/services/password-reset.service.ts` | Forgot-password answers identically whether or not the address resolves, matching the backoffice equivalent. | Updated + new cases in `tests/password-reset/password-reset.test.ts`, including a body-equality check. | **`POST /auth/forgot-password/request` no longer returns 404.** A client that branched on 404 to say "no such account" must drop that branch; the neutral 200 is the point. |
| AIM-10, AIM-15 | `apps/api-gateway/src/sockets/namespaces/admin.ns.ts`, `src/server.ts` | All six `/admin` handlers validate with zod. Group subscribe requires a `grp_` room id, so `groups.moderate` can no longer mirror a private conversation; community and stream subscribes require an object id. Process-level `uncaughtException` / `unhandledRejection` handlers log and exit deliberately instead of dying silently. | `tests/sockets/admin-subscribe-gate.test.ts` (16 cases). | Malformed subscribes get `INVALID_PAYLOAD` rather than crashing the edge. |
| AIM-32 | `apps/api-gateway/src/sockets/namespaces/community.ns.ts` | `community:join` fails closed on a membership-check error, matching `conv:join`. | Read the handler; the catch now acks `SERVICE_ERROR` and returns. | During a community-service outage a join is refused instead of silently admitting the caller to a private community's live traffic. |
| AIM-03, AIM-04, AIM-62 (partial) | `apps/chat-service/src/middleware/rate-limit.ts`, `src/grpc/service-impl.ts` | The limiter core is now shared: `consumeRateLimit` backs both the REST middleware and a new `assertSendAllowed`, called at the top of the gRPC `sendMessage` and `sendCommunityMessage` handlers. Same key, same window, same ceiling, so the socket path is no longer an unmetered door to the identical write. Send and sensitive buckets degrade to an in-process counter on a Redis error instead of failing fully open. | `tests/middleware/send-limit-shared.test.ts` (9 cases). | A socket send past the ceiling now acks `RATE_LIMITED` (gRPC `RESOURCE_EXHAUSTED` already mapped to that code), instead of succeeding. |

## Phase 3 — edge controls (landed)

| ID | Files | Change | Client impact |
|---|---|---|---|
| AIM-74 | `apps/api-gateway/src/app.ts` | The rate limiter moved above the link-host router and the SRS hook mount, both of which were previously uncounted. | None. |
| AIM-71 | `apps/api-gateway/src/middleware/body-size-limit.ts` (new), `src/app.ts` | A real body cap ahead of the proxies: `Content-Length` refused up front, and chunked bodies metered as they arrive so the header check cannot be skipped. 1 MB, 2 MB on `/api/v1/chat`. | A body over the cap gets `413 PAYLOAD_TOO_LARGE` instead of being streamed upstream. |
| AIM-50 | `apps/api-gateway/src/app.ts`, `src/middleware/rate-limit.ts` | Swagger and AsyncAPI are non-production only, `/docs` is no longer exempt from the limiter, and the version-check exemption is an exact suffix match rather than a substring test anyone could construct a path around. | `/docs` returns 404 in production. |
| AIM-51 | `apps/api-gateway/src/app.ts` | Helmet's CSP is enabled for the whole edge with a restrictive API policy; the exemption now covers only the `/docs` mount instead of the entire origin. | None for API clients. |
| AIM-39, AIM-73, AIM-75, AIM-31 (partial) | `apps/api-gateway/src/routes/v1/index.ts`, `src/middleware/rate-limit.ts` | `searchRateLimiter`, `readRateLimiter` and `forgotPasswordRateLimiter` are mounted on real paths for the first time. The OTP limiter's paths were `/auth/verify-otp` and `/auth/resend-otp`, neither of which exists in auth-service — it now covers the real link-email and change-email endpoints. `/auth/refresh`, `/auth/token` and `/auth/accounts` joined the sensitive list, and `/media` got a dedicated write-shaped limiter. | Throttles where there were none. Ceilings are generous. |
| AIM-59 | 15 validator files across user, community, chat and backoffice | `page` is capped at 1000 everywhere, including community-service's one shared `pageSchema` covering 18 endpoints. | `page > 1000` returns 400 instead of an empty 200. That is more than 10k rows deep on every affected list. |
| AIM-79, AIM-80 | `packages/utils/src/mail-recipient.ts` (new), both SMTP transports, both mailers | Recipients are logged as a stable digest plus domain. Both transports set `requireTLS` and a TLS 1.2 floor on non-465 ports, so a relay that does not advertise STARTTLS fails the send instead of relaying an OTP in cleartext. Loopback relays (MailHog) are exempt so local development still works. | None. |
| AIM-86 | `apps/backoffice-service/src/routes/health.routes.ts` | Liveness answers `{success:true}` and nothing else. Readiness returns per-dependency detail only to a loopback probe or an allowlisted address. | The smoke test's assertions on `service` / `environment` were inverted to assert their absence. |

## Phase 4 — remaining backend work (landed)

| ID | Files | Change | Client impact |
|---|---|---|---|
| AIM-12 | `packages/storage/src/presign.ts`, `upload.ts` | `ContentLength` is signed into the presigned PUT, and both it and `Content-Type` are in `signableHeaders`. The declared size was validated and then never enforced, so the URL accepted an arbitrary number of gigabytes. | **The PUT must now send a `Content-Length` matching the declared `contentLength`.** Browsers and the mobile SDKs always set it on a PUT with a known body, and the value is returned explicitly in `headers`. A client that streams a body without it will be refused by object storage. |
| AIM-09 | both chat edit validators | `files` is dropped from the TEXT edit schemas. It was persisted wholesale with none of the send path's verification, and the read path re-signs whatever is stored — so a user could inject another user's object key and read back a presigned URL for it. Zod strips the field, so an older client that still sends it succeeds as a text edit. | None. Both edit paths already refused anything but TEXT. |
| AIM-41, AIM-69 | `packages/utils/src/http-url.ts` (new), chat validators, `lib/attachment-guard.ts`, `media-service/src/services/media.service.ts` | URL fields are http(s)-only (Zod's `.url()` applies no scheme constraint, so `javascript:` and `data:` passed), and the attachment guard's blanket `^https?://` bypass became a provider host allowlist. Both the send guard and the media download path use the same list. | An attachment on a host outside the allowlist is refused with `MEDIA_NOT_VERIFIED`. Giphy/Tenor stickers and GIFs are unaffected. |
| AIM-27, AIM-63 | `chat.ns.ts` | `presence:subscribe` resolves visibility BEFORE joining any room, and per-socket presence rooms and typing hints are capped. Both maps were previously grown from arbitrary client-supplied ids before authorization ran. | None below the caps, which are far above real client usage. |
| AIM-26 | `sockets/presence-indicator.ts` | Roster resolution is cached for 3 s per socket. Every typing frame previously cost a gRPC call plus a database read plus a socket enumeration, and typing is unthrottled. The TTL-fired stop still re-resolves, because membership may have changed. | None. |
| AIM-28 | `sockets/auth.middleware.ts` | Concurrent sockets per account are capped at 40, counted from the server's own registry (so a dead socket leaves no stale reservation). | None below the cap. Per node, which is the resource being protected; a per-IP ceiling belongs at the edge proxy. |
| AIM-29 | `middleware/rate-limit.ts` | The global limiter keys on the VERIFIED `sub` claim, falling back to a token digest when the token does not verify. Keying on the token made the quota a property of the credential, so one refresh bought a fresh 100. | None. |
| AIM-30 | `lib/admin-login-lockout.ts` (new), `services/admin-auth.service.ts`, `config/env.ts` | Per-account admin lockout (5 failures / 15 min), keyed by email so an address that is not an admin is counted too — otherwise "never locks" answers "not an admin". | A locked address gets 429 with `Retry-After`, the same shape an IP throttle produces. |
| AIM-33 | stream-service controller, service, ban repository, community client | The listing is scoped to the caller: a `communityId` is required, community bans and private-community non-membership are refused, and per-stream bans are filtered out. The membership RPC already returned `is_public_community`; only the TypeScript type dropped it. | **`GET /api/v1/streams` without `communityId` now returns 400 for user callers.** The internal gRPC path is unchanged. |
| AIM-34, AIM-48 | gateway SRS router, stream-service internal routes and services | The gateway forwards the SRS secret as a header and sends no query string upstream; both sides refuse before logging, and every stream name is logged as a digest. The name is the publish credential, so log access was broadcast-takeover access. | None. |
| AIM-38 | `notify.ns.ts`, `stream.ns.ts`, `admin.ns.ts` | Token expiry is enforced mid-connection on all three. `/notify` and `/stream` use the shared timers; `/admin` disconnects instead, because the shared helper offers a USER refresh that an admin credential cannot satisfy. | An expired socket is disconnected and the client reconnects, which it already does on a drop. |
| AIM-61 | stream-service service, repository, env | `PENDING` streams count toward a per-creator cap (default 2). They were exempt from every cap, so `POST /streams` in a loop wrote unbounded rows, each minting a key and publishing an event. | A third concurrent PENDING stream gets 409. |
| AIM-62 | `packages/utils/src/fallback-counter.ts` (new), chat rate-limit, community invite limiter, auth OTP limiter | Write-path limiters degrade to a per-process counter with the same ceiling instead of failing fully open. Reads still fail open. OTP issuance also sends mail, so forfeiting its cap turned a Redis blip into an unmetered mail-sending primitive. | None. |
| AIM-13, AIM-14 | `deploy/haproxy/dev01.cfg`, `dev02.cfg`, two new `.lst.example` files | `X-Forwarded-For` is only rewritten from `CF-Connecting-IP` for sources in a Cloudflare list, and both headers are stripped from everyone else. The MinIO and RabbitMQ console vhosts deny by default via an empty `ops_ip` list. | Operators must create `/etc/haproxy/cloudflare-ips.lst` (HAProxy refuses to start without it — the correct direction to fail) and populate `ops-ips.lst` before the consoles are reachable. |
| AIM-40 | `docker/compose.deploy.example.yml` | The gateway binds to loopback; auth-service and user-service publish no ports. The example told operators to expose them on 0.0.0.0, which routes around every gateway-only control. | None (template). |
| AIM-52, AIM-24 | `deploy/dev02/compose.yml`, `.env.dev02.example`, `packages/redis/src/client.ts`, all eight service configs | Cross-host Postgres uses `sslmode=require`, Mongo `tls=true`, MinIO `https`, and the Redis client gained a `REDIS_TLS` option wired through every service. Redis pub/sub is the realtime fan-out, so plaintext exposed the AUTH password and every message body. | None until enabled. Local development is unchanged (TLS defaults off). |
| AIM-85 | community env, three env templates, `deploy/dev02/compose.yml` | `INTERNAL_SHARED_SECRET` and `COMMUNITY_INTERNAL_URL` are removed. Both were read by no code, describing a control that did not exist. | None. |
| AIM-87 | `docs/asyncapi.ts` | The AsyncAPI component is pinned to an exact version instead of a floating major. | None (non-production only). |
| AIM-23 | `lib/disposable-email.ts` (new), admin password-reset service, seed | Public disposable-mail domains are refused for admin password reset and at seed time. The shipped bootstrap admin was on `yopmail.com`, whose inbox anyone can read — so the reset path handed over super-admin without guessing anything. | The reset refusal is silent (a distinct error would be an enumeration signal). The seed now exits non-zero rather than creating such an account. |
| AIM-89 | `sockets/namespaces/auth.ns.ts` | The QR device-link token is logged as a digest. It is a bearer credential redeemable for a full session on an unauthenticated namespace, and it was logged verbatim in three places. | None. |

### Final verification

Full suite after all changes:

| Metric | Baseline | After |
|---|---|---|
| Test suites | 15 failed / 442 | 15 failed / 454 |
| Tests | 60 failed / 5584 | 60 failed / 5702 |

The failing set is the **same 15 suites** as the baseline, with the same 60 tests — no
regression — and 118 net new passing tests.

One caveat on the very last run: `apps/api-gateway/tests/sockets/session-recovery.integration.test.ts`
began failing with `ReplyError: CLUSTERDOWN Hash slot not served`. That is environmental,
not a code change: it is a real-Redis integration test, and a Redis **cluster** was started
on this machine by concurrent work partway through the session and had not finished
allocating hash slots. The suite passes when that cluster is healthy or absent, and no
change in this pass touches cluster configuration or that code path.

The working tree also carries unrelated in-flight work from another change (a group-mute
feature: `messaging.proto`, `chat-messaging.client.ts`, `notification-eligibility.service.ts`
and their tests). `apps/notifications-service/tests/consumers/chat-consumer.test.ts` failed
at one point with `ReferenceError: isGroupMutedMock is not defined` — a mock that file
references but never declares. That belongs to the other change and is not caused by, nor
fixed by, this one.

## Residual risk — not fixed in this pass

| ID | Why | What is left |
|---|---|---|
| AIM-16 | Needs a schema migration plus a change to how SRS names streams — too large to land safely alongside everything else, and a partial version would break in-flight broadcasts. | The publish credential is still the playback path segment, so any viewer can read it out of the player URL and hijack the broadcast. **Design worked out and recorded in the re-open notes above:** publish under a new public `playbackId`, carry the secret as a `?secret=` parameter on the RTMP/WHIP URL (SRS passes it to the hook as `param`), backfill `playbackId = streamKey` so existing streams keep working and are recognisable as legacy. Highest-value remaining item. |
| AIM-44 | A correct implementation is an anonymize job plus consumers in six services; stubs would be worse than nothing because they would look complete. | Account deletion still erases and anonymizes nothing. Personal data (email, phone, hash) persists indefinitely after a user deletes their account. This is a GDPR exposure, not only a security one. |
| AIM-72 | Adding `rate-limit-redis` is a new dependency and a store swap; the deployment runs a single gateway container today, so the practical gap is counters wiped by a restart. | Gateway limiters remain in-process. **Do this before adding a second gateway replica** — with two, every limit doubles, and the nginx `ip_hash` config lets a client pick its replica. |
| AIM-66 | Rotating the refresh token on `/auth/token` risks logging out clients that do not expect a new token in that response. | `/auth/token` is now covered by the sensitive limiter, so the endpoint is no longer a free oracle, but a stolen refresh token still never trips reuse detection. Rotation needs a client-contract check first. |
| AIM-65 | Adding `iss`/`aud` safely needs a dual-verify window (accept tokens without them for one TTL) coordinated with a deploy. Shipping it wrong logs every user out. | Access tokens still carry no issuer or audience, and the secret is shared by eight services. Do it together with a short access-token TTL and dual verification. |
| AIM-58, AIM-67 | Product decisions, explicitly out of scope for a security pass: requiring verified contact details or a captcha at registration, and raising the password minimum, all change onboarding and would break existing clients and stored credentials. | Registration still issues full tokens with no verified contact and no captcha; the password policy is length-only at 8 characters. |
| AIM-60 | Reverses a deliberate product decision from August (the 1-hour TTL was retired, its shared module deleted, and about eight tests pin "links never expire"). | Community invite links still never expire and default to unlimited uses. Needs the product owner, not a security judgement. The exact diff is recorded in the re-open notes. |
| AIM-31 | Changing the response to a uniform 200 would break the sign-up UX that reads 409 to say "that handle is taken". | The endpoint is now rate-limited at the edge, but still confirms whether a handle exists. Uniforming the response needs product sign-off. |
| AIM-30 | Lockout state lives in Redis rather than on `AdminUser`, to avoid a migration on the highest-privilege table. | A full Redis flush clears lockout counters. Moving them to the database would make them durable. |
| AIM-24 | The local `docker-compose.yml` still runs Mongo and Redis without auth. | Deliberate, and the audit's own reviewer refuted this as a production finding: it is the local-dev compose, and the production deployment uses authenticated managed instances. The production templates now document Redis auth and TLS. |

## Secret rotation (operator actions)

Every secret below must be treated as public and rotated before launch. No values are
recorded here or anywhere in the repository. The code guards above stop a *new* deployment
from starting with a published placeholder; they cannot un-leak a value that already exists.

| What | Where it lives | Action |
|---|---|---|
| `SRS_HOOK_SECRET` (AIM-17) | root `.env`, `apps/stream-service/.env` | Rotate now — the previous value was committed in `docker/srs/aimess.conf` and is in git history. It is the only authenticator on a publicly-routable hook endpoint. Consider purging it from history. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (AIM-18, AIM-36) | root `.env`, chat-service, api-gateway | Generate a new pair per environment (`openssl rand -base64 32` for the secret) and update the LiveKit server config together with both services. The old pair was published in this repo. |
| `JWT_ADMIN_SECRET`, `JWT_ADMIN_REFRESH_SECRET` (AIM-19) | backoffice-service, api-gateway, media-service, root `.env` | Replace the self-describing placeholder with 32+ random bytes per environment. All copies must change together. |
| `GRPC_SERVICE_TOKEN` (AIM-55) | all nine services | Generate one random token per environment. The old value is in every committed `.env.example` in git history. |
| Firebase service-account key (AIM-20) | `apps/notifications-service/.env` | Delete the key id in the Google Cloud console and issue a new one. Confirm the service account holds only `roles/firebasemessaging.admin`, not a broad project role. Move the new key to a secret manager or a root-owned mounted file. |
| APNs VoIP `.p8` key (AIM-21) | `apps/notifications-service/.env` | Revoke in the Apple Developer portal (Certificates, Identifiers & Profiles → Keys) and issue a replacement. The key signs pushes for every app under the team, not just this one. |
| SMTP app password (AIM-22) | notifications-service, backoffice-service | Revoke at `myaccount.google.com/apppasswords`. Move to a transactional-mail provider account with a `no-reply` sender identity rather than a named employee's mailbox — that mailbox currently sends admin password-reset codes. |
| Bootstrap super-admin (AIM-23) | `apps/backoffice-service/.env` | Delete or rename the seeded account in every environment that ran the seed. Its address is on a public disposable-mail service, so anyone can read its password-reset codes. Point at a controlled corporate mailbox with a generated password, or leave both variables unset and provision the first admin out of band. |
| MinIO credentials (AIM-25) | six services | Create a per-service MinIO service account scoped to that service's buckets and operations, and rotate `MINIO_ROOT_PASSWORD` to a generated value kept out of every application `.env`. |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` (AIM-54) | eight services | Rotate. The structural fix — asymmetric signing so only auth-service can mint — is recorded as residual, not done in this pass. |
| Postgres / Mongo / RabbitMQ credentials (AIM-56) | root `.env` and four connection strings | Issue one role per service scoped to its own database or vhost, and rotate the shared passwords. |
| SRS HTTP API credentials (AIM-57) | `apps/stream-service/.env` | Rotate to a generated value under a service account name rather than a personal mailbox, and restrict the SRS `http_api` to the stream-service source address at the reverse proxy. |
