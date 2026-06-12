# notifications-service — AUDIT

Prioritized, code-grounded findings discovered while reading the real source for the
audit/test pass. Every item cites file:line. Nothing here is invented — each is what the
code actually does. Severities reflect impact in the context of an internal service that is
**proxied behind the API gateway** (the HTTP surface is not directly internet-exposed), so a
few risks are rated lower than they would be for an edge service.

Test status at audit time: **46/46 passing, green=true**.

---

## High

### H-1 — Dev-only `/test/push` route has NO authentication and sends arbitrary FCM pushes

- **Type:** Security (authz gap / abuse surface)
- **Endpoint:** `POST /test/push` — `src/routes/test-push.routes.ts:12-53`, mounted `src/app.ts:31-34`.
- **Detail:** The router has no JWT middleware. Anyone who can reach the service in
  `NODE_ENV === "development"` can send a push notification with attacker-chosen `title`/`body`
  to **any FCM token they supply** (`tokens: string[]`, up to the array size, each fired via
  `sendPush`). It is gated only by `NODE_ENV === "development"`, so it is correctly absent in
  `test`/`production`. The file header itself says "remove this file when normal FCM push is
  wired through the consumer." The risk is a dev/staging box left in `development` mode, or this
  guard being relaxed — it becomes an unauthenticated push-spam / phishing-push relay.
- **Recommendation:** Delete the route now that the consumer path exists, or at minimum require
  the shared `createAuthenticateAccessToken` gate and an internal-only network binding. Add a
  CI check that no router is mounted without auth except `/health`.

### H-2 — `markNotificationsRead` gRPC is a no-op stub → "mark read" silently fails

- **Type:** Bug / DataIntegrity
- **Endpoint:** gRPC `NotificationService.markNotificationsRead` / `getNotifications` — `src/grpc/server.ts:13-29`.
- **Detail:** Both RPCs return hardcoded empty/zero results (`getNotifications` → `{ notifications:[], unreadCount:0 }`;
  `markNotificationsRead` → `{ updatedCount:0, remainingUnread:0 }`). A caller (gateway/client)
  marking notifications read receives success with `updatedCount:0` and nothing is persisted —
  unread state never clears via this path. `server.ts` is started in `server.ts:57`
  (`startGrpcServer`). This is wired and reachable, not dead code.
- **Recommendation:** Either implement against the notification store or have the stub return a
  clear `UNIMPLEMENTED` gRPC status so callers don't treat a no-op as success. Track the gap in
  IMPLEMENTATION-NOTES.

---

## Medium

### M-1 — Auth middleware configured WITHOUT session-revocation check; revoked tokens still register devices

- **Type:** Security (stale-session acceptance)
- **Endpoint:** `POST /v1/devices`, `DELETE /v1/devices/:token` — `src/routes/device.routes.ts:13`.
- **Detail:** `createAuthenticateAccessToken(env.JWT_ACCESS_SECRET)` is called with the bare secret,
  so the optional `assertSessionActive` callback is unset (`packages/auth-jwt/src/middleware.ts:40-45`
  — the revocation branch only runs when the option is provided). A user who logged out / had a
  session revoked can still register or unregister device tokens with a not-yet-expired access
  token (up to the token TTL, ~1h). For a device-token store this means a logged-out device can
  keep itself registered to receive pushes. Other services in this repo wire the
  `assertSessionActive` form; notifications-service does not.
- **Recommendation:** Decide intentionally: if device registration should respect logout, pass
  `{ accessTokenSecret, assertSessionActive }` (gRPC/cache session check like the other services).
  If allow-by-TTL is acceptable, document it in IMPLEMENTATION-NOTES so it is a choice, not a gap.

### M-2 — OTP/notification consumer DLX/DLQ "recovery" can DELETE a queue that has bound consumers/messages

- **Type:** DataIntegrity
- **Endpoint:** consumer — `src/consumers/notification.consumer.ts:55-72,104-120`.
- **Detail:** On a `PRECONDITION_FAILED` (mismatched args) the helper `deleteQueue`/`deleteExchange`
  then re-asserts. If the queue already holds messages (e.g. an arg drift after a deploy), those
  in-flight OTP/email messages are destroyed — a user mid-flow loses their password-reset email.
  The same delete-and-recreate is applied to `QUEUE_NAME` (`notification.queue`), not just the DLQ.
  Note the precondition check matches AMQP code `406`, but the comment elsewhere references 406 vs
  "precondition" loosely — confirm the publisher and consumer assert byte-identical args so this
  branch never fires in normal operation.
- **Recommendation:** Restrict auto-delete recovery to genuinely empty infra (or dev only); in
  production prefer a controlled migration of queue args over destructive recreate.

### M-3 — No per-user device-token cap → unbounded growth / token-store flooding

- **Type:** DataIntegrity / Security (resource exhaustion)
- **Endpoint:** `POST /v1/devices` — `src/repositories/device-token.repository.ts:17-33`.
- **Detail:** `upsert` is keyed by globally-unique `token`. A client that rotates `token` values
  (e.g. a buggy or malicious app sending a fresh random token each call) creates a new row every
  time — there is no cap on rows per `userId` and no TTL/`lastSeenAt`-based pruning job in the
  service. The fan-out in `push.service.ts:79` then iterates **all** of a user's tokens on every
  push. `lastSeenAt` is written (`repository.ts:23`) but never read for cleanup.
- **Recommendation:** Cap tokens per user (evict oldest by `lastSeenAt`) on upsert, and/or add a
  scheduled prune of tokens older than N days. The unique-`token` design already handles
  legitimate re-registration; the gap is purely the unbounded distinct-token case.

### M-4 — OTP codes interpolated into HTML email without escaping (template injection surface)

- **Type:** Security (injection surface) / Inconsistency
- **Endpoint:** mail templates — `src/providers/mail/templates/auth-otp.ts:23-67` (`${code}`,
  `${title}`, `${intro}`, `${outro}` raw into HTML); fed by `notification.handler.ts:30-68`.
- **Detail:** Values from event payloads are placed directly into the HTML string with no
  encoding. Today `code`/`ttlSeconds` are service-generated numerics so the practical risk is low,
  but the pattern is unsafe by construction: if any interpolated field ever carries
  attacker-influenced text (e.g. a future template that injects a user-supplied name/email), it
  becomes stored/email HTML injection. There is also no validation that `data.email` is a
  well-formed address before `sendMail` (`handler` passes `data.email` straight through).
- **Recommendation:** HTML-escape all interpolated values in templates (a tiny `escapeHtml`
  helper), and validate `email`/`code` shape in the handler before building the message.

---

## Low

### L-1 — Health endpoint diverges from the standard response envelope

- **Type:** Inconsistency
- **Endpoint:** `GET /health` — `src/routes/health.routes.ts:8-16`.
- **Detail:** Returns `{ success, service, title, environment, timestamp }` — no `message`/`data`,
  unlike the repo-wide `{ success, message, data }` success contract. Device endpoints also return
  bare `{ success: true }` / `{ success: true, removed }` with no `message`/`data`
  (`device.controller.ts:32,59`). Minor but inconsistent for clients expecting a uniform envelope.
- **Recommendation:** Acceptable for a health probe; if a uniform envelope matters, wrap the
  device-success bodies in `{ success, message, data }`.

### L-2 — `DELETE /v1/devices/:token` params validator is effectively unreachable / dead

- **Type:** Bug (dead code) / Inconsistency
- **Endpoint:** `DELETE /v1/devices/:token` — `device.controller.ts:46-53`, `device.validator.ts:11-13`.
- **Detail:** The 400 branch on `unregisterDeviceParamsSchema.safeParse(req.params)` can't trigger:
  an empty `:token` makes Express not match the route (→ 404, verified by test), and any non-empty
  path segment satisfies `min(1)`; a segment over 4096 chars is not realistically routed as a single
  path param either. So the documented "params zod failure → 400" outcome has no reachable input.
- **Recommendation:** Either remove the unreachable validation (and its 400 contract) or, if a
  length cap matters, enforce it deliberately and document the 400.

### L-3 — Inconsistent push `category` typing: friend/chat consumers bypass the `base()` helper

- **Type:** Inconsistency
- **Endpoint:** consumers — `src/consumers/friend.consumer.ts:20-49` vs `community.consumer.ts:28-40`.
- **Detail:** Community events build `PushInput` via the `base()` helper that fixes
  `category:"communityEnabled"`; friend/chat consumers hand-assemble the object with the category
  inline. Functionally fine, but a future category rename or settings-gate change must be applied in
  several places — drift risk. `pushToUser`'s `type` field also mixes conventions (`"MESSAGE"`
  literal in chat vs the raw event `type` string in friend/community), which lands inconsistently on
  the persisted inbox row and FCM `data.type`.
- **Recommendation:** Centralize `PushInput` construction (one builder per category) and normalize
  the `type` value written to the inbox/FCM so clients see a consistent taxonomy.

### L-4 — `push.service` swallows all delivery failures; no metric/dead-letter on permanent inbox-write failure

- **Type:** DataIntegrity (observability gap)
- **Endpoint:** `src/services/push.service.ts:54-92`.
- **Detail:** Settings check, inbox `createNotification`, token load and per-token send are each
  wrapped so the function "never throws" (by design, to avoid DLQ poisoning). But a persistent
  failure of the chat-service inbox write (`push.service.ts:64-67`) is only `logger.warn`'d — the
  notification is then delivered as a push but never persisted to the inbox, and nothing surfaces
  the divergence. There is no counter/alert distinguishing "transient" from "always failing."
- **Recommendation:** Emit a metric on inbox-write failure (and on dead-token prune) so silent,
  permanent inbox divergence is observable; consider a bounded retry before giving up.

---

## Uncovered areas (no automated coverage; see TEST_CASES.md §4–5)

1. `POST /test/push` — unauthenticated dev route (absent in `test` env, so not exercisable here;
   manual/dev coverage only). Abuse surface per **H-1**.
2. All five RabbitMQ consumers (`notification`, `chat`, `community`, `friend`, `settings`) — no
   harness drives a message through them; payload-mapping, ack/nack-no-requeue and DLX topology are
   untested.
3. `push.service` orchestration (settings gate → inbox write → fan-out → dead-token prune) and
   `pushToUsers` dedup — untested.
4. `notification-settings.service` quiet-hours math (`isInQuietHours` midnight-wrap, ISO weekday,
   bad `HH:mm` parsing) and allow-on-failure fallback — untested despite being pure and easily unit-testable.
5. `sendPush` invalid-token-code → prune mapping (`providers/firebase/sendPush.ts:13-49`) — untested.
6. Mail templates / `sendMail` (OTP HTML, escaping per **M-4**, `messageId` logging) — untested.
7. gRPC server stubs (`getNotifications`/`markNotificationsRead`) — untested and unimplemented (**H-2**).
8. Body-size limit (1MB, `app.ts:23`) and malformed-JSON handling on `/v1/devices` — documented-only.
9. Session-revocation behaviour on the authed routes (**M-1**) — no test asserts whether a revoked
   session is rejected (it currently is not).
