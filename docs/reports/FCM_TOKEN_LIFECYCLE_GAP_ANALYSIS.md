# FCM / Device-Token Lifecycle — Gap Analysis

**Date:** 2026-08-13 · **Branch:** `rajesh-dev`
**Scope:** `notifications-service`, `auth-service`, `api-gateway`, `aimess_website`
**Source brief:** `fcm-lifecycle-prompt.md`

**Verdict: every functional requirement in the brief is now met.** One verification
item is open (it needs test infrastructure the web repo does not have), five items
are met with a stated caveat rather than a code change, and there are three
deploy/ops actions to complete before this is live.

---

## 1. Requirement-by-requirement status

Legend — ✅ met · ⚠️ met with a stated caveat · ❌ open

### 1.1 Removal triggers

| #   | Requirement                                                                            | Status       | Where it is guaranteed                                                                                                                 |
| --- | -------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Manual logout removes the token server-side **and** clears the local FCM subscription  | ✅           | `useAuth.ts:105` runs `revokeFcmToken()` before `logoutSuccess()`; `/auth/logout` publishes `session.device_revoked` as a second cover |
| 2   | Teardown survives a failed call, a dead network, or a session already gone server-side | ✅           | `fcmToken.ts` catches the DELETE and still runs `deleteFirebaseToken()`; `useAuth.ts` wraps the whole flow in `try/finally`            |
| 3   | Revoking one session removes exactly that device's token(s), no others                 | ✅           | `deleteByUserIdAndSessionId(userId, sessionId)`                                                                                        |
| 4   | "Log out of all devices" removes every token                                           | ✅           | `deleteAllByUserId`, honouring `exceptSessionId` for the sign-out-others variant                                                       |
| 5   | Password change removes the tokens of every session it revokes                         | ✅ **fixed** | `auth-service/src/lib/revoke-password-sessions.ts`                                                                                     |
| 6   | Password reset removes the tokens of every session it revokes                          | ✅ **fixed** | Same helper, called with no `exceptSessionId`                                                                                          |
| 7   | Refresh-token reuse detection removes tokens                                           | ✅           | `session.service.ts:77` and `:155` — was already correct                                                                               |
| 8   | Admin force-logout / ban / suspend removes tokens                                      | ✅           | `admin-user-consumer.ts:91` — was already correct, now covered by a test                                                               |
| 9   | Account deletion removes tokens                                                        | ✅           | `account-deletion.service.ts:81` — was already correct                                                                                 |
| 10  | Fixed at the **shared** revocation point, not per caller                               | ✅           | Both password flows now route through one function that does DB revoke + Redis bust + token publish + socket kick                      |
| 11  | A device force-logged-out **while offline** ends with no server token                  | ✅           | Deletion is entirely server-side; the device is never consulted                                                                        |
| 12  | Account deletion leaves zero rows                                                      | ✅           | `deleteAllByUserId(userId)` with no exception                                                                                          |

### 1.2 Registration correctness

| #   | Requirement                                                                                                                             | Status       | Notes                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | One registration per (session, token) — no duplicate POST on re-render, remount, navigation, tab focus, Strict Mode, or unchanged token | ✅ **fixed** | The `registeredRef` guard **did not hold across remounts**. `FcmRegistrar` sits inside `PrivateGuard`, which swaps in a loader whenever the token is briefly absent, and inside the `(layout-pages)` route-group layout, which unmounts when navigation leaves the group — so it remounts during ordinary use and re-POSTed each time. The guard is now module-scoped and keyed `authToken:fcmToken`. |
| 14  | Logout → login in the same tab re-registers                                                                                             | ✅           | Guard resets to `null` on `!authToken`                                                                                                                                                                                                                                                                                                                                                                |
| 15  | FCM token rotation handled; old row for (user, device, tokenType) gone                                                                  | ⚠️           | See **G2**                                                                                                                                                                                                                                                                                                                                                                                            |
| 16  | Login as B where A logged out leaves no row for A                                                                                       | ✅           | A's logout deletes it; and the upsert is keyed on the unique `token`, so even an un-deleted token **transfers** to B rather than leaving A a row                                                                                                                                                                                                                                                      |
| 17  | Re-login on the same device re-registers; the token comes back                                                                          | ✅           | Ordering verified: logout runs `deleteToken()`; the cached `minted` value in `useFCMToken` is keyed on the auth token that produced it, so the next login cannot short-circuit on the dead value — `getToken` mints fresh                                                                                                                                                                             |

### 1.3 Client-side state

| #   | Requirement                                                                             | Status                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18  | Local cached token / flag / `deviceId` consistent after logout                          | ✅                           | Nothing clears `localStorage` wholesale; the registration guard resets on sign-out; the remembered-token key is cleared by `revokeFcmToken`                                                                                                                                                                                                                                                                                                                                        |
| 19  | `deviceId` survives logout or is regenerated — **decide and justify**                   | ✅ **decision: it survives** | It is the key for the upsert's one-row-per-device dedupe. Regenerating it would make every logout→login cycle look like a new device and accumulate a stale row per cycle until FCM pruned it. It is **never** used for revocation matching (that is `sessionId`), so a stable value carries no revocation risk.                                                                                                                                                                   |
| 20  | No foreground `onMessage` listener or service worker left running for a signed-out user | ✅                           | The `onMessage` effect is gated on `authToken` and unsubscribes on cleanup. `deleteToken()` drops the push subscription, so the browser's push service stops delivering to the worker entirely. The worker is deliberately left **registered** — it is also the PWA's worker; unregistering it would break offline shell caching. A `notificationclick` arriving while signed out routes to a private path, which `PrivateGuard` redirects to sign-in: correct behaviour, no leak. |
| 21  | Permission revoked in browser settings → logout still unregisters server-side           | ✅ **fixed**                 | Confirmed the guard was the bug: `revokeFcmToken` early-returned on `Notification.permission !== "granted"`, so the DELETE was never sent. The client now remembers the last **successfully registered** token in `localStorage["aimess:fcm-token"]` and unregisters by that value when `getToken` cannot produce one.                                                                                                                                                             |

### 1.4 Reliability

| #   | Requirement                                                                                 | Status         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22  | Cross-service cleanup not silently lost when RabbitMQ is unavailable                        | ✅ **fixed**   | Root cause was worse than a lost message: `getChannel()` memoized the channel promise and **never reset it**, so after one broker blip every subsequent publish resolved to a dead socket and failed silently for the life of the process. Mitigation and trade-off in §2.                                                                                                                                                   |
| 23  | Consumer idempotent and safe to replay                                                      | ✅             | `deleteMany` on an empty match is a no-op                                                                                                                                                                                                                                                                                                                                                                                    |
| 24  | `nack(requeue=false)` on a transient DB error — confirm or change                           | ✅ **changed** | Two defects: the DLX had **no queue bound to it**, so a dead-lettered delete was _discarded_ by RabbitMQ, not retained; and a one-second Mongo blip permanently lost the delete. A durable `session.queue.dlq` is now bound, and a transient failure requeues once (via `message.fields.redelivered`) before dead-lettering. A malformed body still dead-letters immediately — retrying unparseable bytes can never succeed. |
| 25  | Backstop for tokens no event will cover; use `lastSeenAt`; state N and where the sweep runs | ✅ **added**   | `lastSeenAt` existed but was written only at registration and read by nothing. See §3.                                                                                                                                                                                                                                                                                                                                       |
| 26  | Send path prunes tokens both providers report permanently dead                              | ✅             | Terminal-code sets reviewed; two added, three deliberately excluded — see **G5**                                                                                                                                                                                                                                                                                                                                             |
| 27  | Pruning runs for **every** failed recipient in a multicast/batch send                       | ✅             | Verified there is no multicast path at all: `push.service.ts:420` sends each token individually inside `Promise.all`, so each failure is evaluated on its own. `sendEachForMulticast` appears only in a test mock, never in `src/`.                                                                                                                                                                                          |

### 1.5 Security and API

| #   | Requirement                                                                                         | Status | Notes                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 28  | `DELETE /v1/devices/:token` only ever deletes a token owned by the caller                           | ✅     | `deleteByUserAndToken(req.auth.userId, token)` — the `userId` comes from the JWT, never the URL. Covered by an explicit IDOR test.                                                                                                                                                                 |
| 29  | Token not leaked in logs or URLs where it should not be                                             | ⚠️     | See **G3**                                                                                                                                                                                                                                                                                         |
| 30  | `POST /v1/devices` validates platform / tokenType / token shape and rejects unauthenticated callers | ✅     | Zod: `token` 1–4096 chars, `platform` enum, `tokenType` enum defaulting to `FCM`, `deviceId` ≤256. Route is behind JWT + active-session assertion. 15 existing cases cover 401 (missing, malformed, expired, forged, broken), mass-assignment of `userId`/`sessionId`, and injection-shaped input. |
| 31  | Logout with an expired/invalid access token can still clean up                                      | ✅     | Ordering was already right, and `BaseService` refreshes on 401 and retries. The residual case (refresh token also dead) is now covered server-side by the send-time guard and the sweeper, so the client never has to be the one that succeeds.                                                    |

### 1.6 Verification

| #   | Requirement                                        | Status       | Notes                                                                                                 |
| --- | -------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| 32  | Test: session consumer device/all-revoked handling | ✅           | `notifications-service/tests/consumers/session-consumer.test.ts` — 8 cases                            |
| 33  | Test: device repository scoped delete              | ✅           | `notifications-service/tests/devices/unregister-device.test.ts` — pre-existing, includes an IDOR case |
| 34  | Test: revocation publish on password change        | ✅ **added** | `auth-service/tests/account/change-password.test.ts`                                                  |
| 35  | Test: revocation publish on admin force-logout     | ✅ **added** | `auth-service/tests/messaging/admin-force-logout.test.ts` — 6 cases                                   |
| 36  | Test: web client logout ordering                   | ❌ **open**  | See **G1**                                                                                            |
| 37  | Run the existing suites and report actual output   | ✅           | §5                                                                                                    |
| 38  | Reason through the two-device scenario             | ✅           | Published report, "The required scenario, reasoned through"                                           |

---

## 2. Broker-down mitigation — chosen approach and trade-off

The brief asked for retry, an outbox, a synchronous gRPC fallback, or a periodic
reconciliation, with the trade-off stated.

**Chosen: bounded retry on a self-healing channel + a send-time re-check.**

- **Retry** — `publish-session-revoked.ts` clears the memoized channel on `close`,
  `error`, and dial failure, and each publish retries once on a fresh channel. This
  covers the common case (an idle broker restart) and, more importantly, fixes the
  much larger bug that a single blip disabled _all_ future publishes.
- **Send-time guard** — the real safety net. `push.service.ts` re-checks the shared
  Redis active-session cache for every token carrying a `sessionId`, and deletes the
  row instead of sending when the session is explicitly marked revoked. Even if the
  event is lost entirely, the first push after a logout removes the token rather than
  delivering it.
- **Fails open by design.** Only an explicit revoked marker drops a token. A missing
  key, a legacy row with no `sessionId`, and a Redis outage all still deliver — a
  Redis blip must never silence push for live devices.
- To give that guard a useful window, the revoked marker's TTL moved from the
  access-token lifetime (1 h) to the refresh lifetime (7 d) in
  `auth-service/src/lib/session-active-cache.ts`. Session ids are never reused, so a
  long-lived revoked marker cannot deny a live session. See **G7** for the capacity
  implication.

**Rejected — and why.** An outbox table means a new table, a new poller, and a second
delivery mechanism to keep correct, all to protect one event type. A synchronous gRPC
fallback puts a network call on a path that must never block logout. Neither buys
anything the send-time guard does not already cover.

---

## 3. Stale-token backstop — parameters

`notifications-service/src/jobs/device-token-sweeper.ts`, started from `server.ts`.

| Parameter         | Value                                                                                                                                                                             | Env var                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Token TTL (**N**) | **60 days** unseen                                                                                                                                                                | `DEVICE_TOKEN_TTL_DAYS`            |
| Sweep interval    | 6 hours                                                                                                                                                                           | `DEVICE_TOKEN_SWEEPER_INTERVAL_MS` |
| Where it runs     | In-process in notifications-service, Redis-locked (`notifications:device-token-sweeper:lock`) so replicas do not duplicate the tick; `unref`'d so it never holds the process open |

**Why 60 days.** The refresh token lives 7 days, so a device that has stopped signing
in is long dead well before then, while an app that launches — or receives a push —
even once every two months keeps its registration.

**`lastSeenAt` is now a real liveness signal**, not just a creation stamp: it is
refreshed on every _accepted_ push, throttled to at most one write per token per day,
so a long-lived open tab that never reloads is not reaped.

---

## 4. Open gaps and accepted caveats

### G1 — Web client has no test framework ❌ OPEN

**Severity: low (process, not correctness).**
`aimess_website` has no Jest, no Vitest, no `test` script and no test files. The
brief's "test the web client's logout ordering" cannot be satisfied without first
introducing a test runner, React Testing Library, and a Firebase mocking layer —
a larger change than the fix it would cover.

_Mitigation in place:_ the ordering is guaranteed structurally — `revokeFcmToken()`
is awaited before `dispatch(logoutSuccess())`, and the server-side session revocation
covers the same ground a second time. `tsc` and `eslint` pass on both changed files.

_Recommendation:_ separate ticket to stand up Vitest + RTL for `aimess_website`. Worth
doing on its own merits, not just for this.

### G2 — Web FCM token rotation is detected only on the next mount ⚠️ ACCEPTED

**Severity: low.**
The Firebase JS SDK v9+ has **no** `onTokenRefresh` listener — it was removed from the
API. On web, rotation is observed only when `getToken` returns a new value on the next
mount. The stale row is then removed by the upsert's `(userId, deviceId, tokenType)`
dedupe, so no duplicate ever persists.

_Why accepted:_ web sessions reload frequently, and in the interim the stale token is
pruned by FCM on the next send anyway (`registration-token-not-registered`). Native
clients do receive a delegate callback and re-register immediately, so this is
web-only. Adding a focus/visibility re-check would trade a real cost (an extra
`getToken` per tab focus) for a window that already closes itself.

### G3 — Device token travels in the URL path ⚠️ ACCEPTED

**Severity: low.**
`DELETE /v1/devices/:token` puts the token in the path. Verified it is **not** written
anywhere today: notifications-service mounts no HTTP request logger, and the gateway
proxy does not log full URLs.

_Why accepted:_ moving it to a request body would break the iOS and Android contract
for no present benefit. **Revisit if** an access-log or APM middleware that records
full URLs is ever added to notifications-service or the gateway — at that point the
token becomes a logged secret.

### G4 — Admin ban/suspend does not force-disconnect live sockets ⚠️ OUT OF SCOPE

**Severity: medium — but not an FCM defect.**
`admin-user-consumer.ts` revokes sessions and drops push tokens correctly, but unlike
every other revocation path it never publishes the Redis `session-revoke` signal, so a
banned user's already-connected socket stays live until its access token expires (up to
1 hour).

_Not fixed here_ because the brief scopes the diff to the FCM/device-token lifecycle,
and adding the kick would surface a new client-facing `auth:session_terminated` notice
on ban — a product decision, not a bug fix.

_Recommendation:_ separate ticket. The fix is three lines mirroring
`session.service.ts:369-372`.

### G5 — `messaging/invalid-argument` remains in the prune set ⚠️ ACCEPTED

**Severity: low.**
FCM raises this code for a malformed _payload_ as well as a malformed token, so it can
in principle prune a live token.

_Why accepted:_ payloads here are constructed identically for every recipient, so a
payload bug fails every send rather than one token — which makes a bad token by far the
more likely cause. Now documented in the code so the next reader does not re-derive it.

**Deliberately NOT added to the prune set:** `messaging/mismatched-credential`,
`messaging/third-party-auth-error`, `messaging/authentication-error`. These are _server_
misconfigurations; treating them as dead tokens would wipe the entire table the moment a
service account or APNs certificate is rotated wrong.

**Added:** `messaging/sender-id-mismatch`, `messaging/invalid-recipient`.
**APNs VoIP verified complete and unchanged:** `BadDeviceToken`, `Unregistered`,
`DeviceTokenNotForTopic`.

---

## 5. Actions required before this is live

| #      | Action                                                                                 | Owner            | Why                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | Run `prisma db push` for notifications-service                                         | Backend / deploy | The schema gained `@@index([lastSeenAt])`. Without it the 6-hourly sweep is a full collection scan. MongoDB — this repo uses no SQL migration files.                    |
| **A2** | Add `DEVICE_TOKEN_TTL_DAYS` and `DEVICE_TOKEN_SWEEPER_INTERVAL_MS` to the deployed env | Deploy           | Both have safe defaults (60 / 21600000), so this is optional — set them only to tune. Documented in `.env.example`.                                                     |
| **A3** | Monitor or drain the new `session.queue.dlq`                                           | Ops              | Messages that fail twice now **accumulate** there instead of being silently discarded. That is the point — but an unwatched DLQ is a silent backlog. Add a depth alarm. |

### G6 — iOS client action

Nothing is **required**; no existing contract changed shape. Two things became
available:

1. `DELETE /api/v1/notifications/fcm-token/{token}` **now exists**. This is the logout
   step already written in `docs/push/ios-fcm-integration.md §13` and the Android
   guide — it previously had **no route on the gateway** and returned 404, silently
   relying on `/auth/logout` to clean up.
2. `tokenType: "VOIP"` is now forwarded through that alias. Previously the gateway
   dropped it, so a PushKit token registered via `/notifications/fcm-token` was stored
   as `FCM` and its call rings were sent over FCM — which never reaches PushKit.

**iOS should verify it sends `tokenType: "VOIP"` for its PushKit token.** A client
already using the canonical `POST /api/v1/devices` was always correct and nothing
changes for it.

### G7 — Redis capacity note

Revoked session markers now live for the refresh TTL (7 days) instead of the access TTL
(1 hour). Each is one short string key per revoked session. At a rough order of
magnitude — 10k logouts/day × 7 days ≈ 70k keys ≈ a few MB — this is negligible, but it
is a **~168× increase in retention** for that key class and worth noting before a
capacity review.

---

## 6. Test evidence

Baseline captured by stashing the change and re-running the identical command.

```
FULL BACKEND SUITE — node node_modules/jest/bin/jest.js

baseline (clean tree)
  Test Suites: 27 failed, 332 passed, 359 total
  Tests:       77 failed, 4259 passed, 4336 total

with this change
  Test Suites: 27 failed, 334 passed, 361 total
  Tests:       77 failed, 4289 passed, 4366 total
  Time:        109.32 s
```

Identical failure counts — **zero regressions**. The delta is exactly **+30 passing
tests and +2 suites**, all added here.

```
PER SERVICE

notifications-service   Test Suites: 19 passed, 19 total    Tests: 175 passed, 175
auth-service            Test Suites:  1 failed, 29 passed   Tests: 258 passed, 258
api-gateway             Test Suites:  1 failed, 34 passed   Tests: 1 failed, 373 passed, 374
```

Both failing suites are **pre-existing and unrelated**, confirmed by stashing:

- `auth-service/tests/lib/session-context.test.ts` — fails to parse. Prisma 7's
  generated client uses `import.meta`, which CJS-mode Jest cannot read.
- `api-gateway/tests/admin/admin-edge.test.ts` — depends on a reachable backoffice
  service.

Every auth-service **test** passes (258/258, up from 249).

```
STATIC CHECKS

tsc --noEmit   notifications-service    No errors found
tsc --noEmit   auth-service             No errors found
tsc --noEmit   api-gateway              No errors found
tsc --noEmit   aimess_website           No errors found
eslint         changed backend files    No issues found
eslint         changed website files    clean (exit 0)
```

### New tests added

| File                                                                | Cases | Covers                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications-service/tests/services/push-revoked-session.test.ts` | 11    | Send-time guard (drop, spare the live device, fail open on missing key, fail open on Redis down, skip legacy rows), `lastSeenAt` refresh, sweeper (lock won/lost, Redis down, DB failure) |
| `auth-service/tests/messaging/admin-force-logout.test.ts`           | 6     | Ban and suspend publish `session.all_revoked`; `forceLogout: false` and unban publish nothing; replay safety; transient failure dead-letters                                              |
| `notifications-service/tests/consumers/session-consumer.test.ts`    | +3    | DLQ binding, requeue-once on transient failure, dead-letter on redelivery                                                                                                                 |
| `auth-service/tests/account/change-password.test.ts`                | +1    | Publishes with `exceptSessionId`; silent on a wrong password                                                                                                                              |
| `auth-service/tests/password-reset/password-reset.test.ts`          | +2    | Publishes with no `exceptSessionId` plus a socket kick per session; silent on a rejected token                                                                                            |
| `api-gateway/tests/notifications/fcm-token-alias.test.ts`           | +4    | DELETE alias (forward, URL-encoding, 503) and `tokenType` passthrough                                                                                                                     |

---

## 7. Files changed

**Note:** this repo's `.gitignore` has blanket rules for `*.md` and `docs/` — commit
this file with `git add -f docs/reports/FCM_TOKEN_LIFECYCLE_GAP_ANALYSIS.md`.

### auth-service

| File                                            | Why                                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/revoke-password-sessions.ts` **(new)** | The single revocation point for both password flows: DB revoke, Redis cache bust, `session.all_revoked`, per-session socket kick |
| `src/services/change-password.service.ts`       | Calls the helper — was doing the DB revoke and socket kick but never the device-token publish                                    |
| `src/services/password-reset.service.ts`        | Calls the helper — was doing neither                                                                                             |
| `src/messaging/publish-session-revoked.ts`      | Channel promise cleared on `close`/`error`/dial failure; shared publish helper retries once                                      |
| `src/lib/session-active-cache.ts`               | Revoked markers live for the refresh TTL so the send-time guard has a 7-day window                                               |

### notifications-service

| File                                                 | Why                                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/jobs/device-token-sweeper.ts` **(new)**         | Redis-locked periodic delete of tokens unseen past the TTL                                                            |
| `src/services/push.service.ts`                       | Send-time revoked-session guard (fail-open) that deletes instead of sending; `lastSeenAt` refresh on an accepted push |
| `src/repositories/device-token.repository.ts`        | `sessionId` in the selected row shape; `touchLastSeen` (throttled) and `deleteStale`                                  |
| `src/services/device-token.service.ts`               | Service-layer `touchToken` / `sweepStaleTokens`                                                                       |
| `src/consumers/session.consumer.ts`                  | Binds a durable `session.queue.dlq`; splits parse failure (drop) from transient failure (requeue once)                |
| `src/providers/firebase/sendPush.ts`                 | Two terminal codes added; three server-misconfiguration codes documented as excluded                                  |
| `prisma/schema.prisma`                               | `@@index([lastSeenAt])`                                                                                               |
| `src/config/env.ts`, `.env.example`, `src/server.ts` | Sweeper config and startup wiring                                                                                     |

### api-gateway

| File                                      | Why                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/routes/v1/notifications.routes.ts`   | Adds `DELETE /notifications/fcm-token/:token`; forwards `tokenType` on POST; both share one relay helper |
| `src/docs/openapi/paths/devices.paths.ts` | Spec for the new DELETE alias and the `tokenType` field                                                  |

### aimess_website

| File                                    | Why                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/fcmToken.ts`              | Remembers the last registered token; falls back to it when `getToken` is unavailable. Local teardown now runs unconditionally          |
| `src/component/common/FcmRegistrar.tsx` | Writes that remembered value on a **successful** registration only; registration guard hoisted to module scope so it survives remounts |

---

## 8. What the brief suspected, and what was actually wrong

The brief named the `deviceId` mismatch as "the single most likely cause" and asked for
it to be confirmed or refuted specifically.

**Confirmed as a fact.** `Session.deviceId` is `sha256(userAgent + "|" + ip)`, computed
server-side at `auth-service/src/lib/session-context.ts:70`. `DeviceToken.deviceId` is a
client-generated `randomUUID()` from `localStorage`. A 64-char hex digest never equals a
UUID, so `deleteByUserIdAndDeviceId` deletes exactly zero rows.

**Refuted as the cause.** The code already knows this and does not rely on it.
Registration stamps the JWT's `sessionId` onto the row (`device.controller.ts:35`), and
the consumer matches on `sessionId` first (`session.consumer.ts:29`). The `deviceId`
sweep is a documented no-op fallback for rows predating that field. **Remote and
other-device logout always worked.**

The real leaks were:

1. **Password change and password reset revoked sessions and published nothing.**
   Reset published nothing at all — not even the socket kick every other path has.
2. **A memoized dead AMQP channel.** One broker blip permanently disabled every
   subsequent publish from that auth-service process.
3. **A dead-letter exchange with no queue bound to it.** RabbitMQ discards a message
   routed to an exchange with no binding, so a failed delete was gone for good rather
   than retained for replay.
4. **Nothing ever removed a token whose session merely expired.** `lastSeenAt` existed,
   was written only at registration, and was read by nothing.
5. **The gateway dropped `tokenType`**, and the native logout endpoint had no route.
6. **The web client skipped the unregister entirely** when notification permission had
   been revoked in browser settings.
7. **The registration guard did not survive a remount**, so ordinary navigation re-POSTed.
