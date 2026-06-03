# Notifications — Test Case Index

Module prefix: `TC-NOTIF-NNN`. Covers device-token registration (FCM), in-app notification feed,
mark-read / mark-all-read, unread counts & badge sync, notification preferences (per-conversation
mute), Firebase Admin FCM push delivery, and the dev-only test-push endpoints, plus the `/notify`
Socket.IO namespace.

## Files

| File                                               | Area                                                                                               | Cases                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------- |
| [`device-registration.md`](device-registration.md) | `POST /v1/devices`, `DELETE /v1/devices/:token` (notifications-service)                            | TC-NOTIF-001 … 019 (19) |
| [`list-notifications.md`](list-notifications.md)   | `GET /api/chat/notifications` + socket `notifications:fetch`                                       | TC-NOTIF-030 … 040 (11) |
| [`mark-read.md`](mark-read.md)                     | `POST /api/chat/notifications/read`, `/read-all` + socket `notifications:mark_read`                | TC-NOTIF-050 … 062 (13) |
| [`unread-counts.md`](unread-counts.md)             | `GET /api/chat/notifications/unread-count` + socket `notification:count` / forwarded `notify:<id>` | TC-NOTIF-070 … 079 (10) |
| [`preferences.md`](preferences.md)                 | `POST /api/chat/private/rooms/:roomId/mute` · `/unmute` (notification settings)                    | TC-NOTIF-130 … 138 (9)  |
| [`push-delivery.md`](push-delivery.md)             | `sendPush()` provider + dead-token prune (FCM)                                                     | TC-NOTIF-090 … 097 (8)  |
| [`test-push.md`](test-push.md)                     | dev `POST /test/push` (notifications-service & auth-service)                                       | TC-NOTIF-110 … 119 (10) |

**Total: 80 test cases.**

## Endpoints & events covered

REST:

- `POST /v1/devices` — register/upsert FCM token (auth)
- `DELETE /v1/devices/:token` — unregister own token (auth, scoped)
- `GET /api/chat/notifications` — list feed (auth, cursor paginated)
- `POST /api/chat/notifications/read` — mark one read (auth — **no ownership scope**)
- `POST /api/chat/notifications/read-all` — mark all read (auth, scoped)
- `GET /api/chat/notifications/unread-count` — unread count (auth)
- `POST /api/chat/private/rooms/:roomId/mute` · `/unmute` — conversation mute preference (auth)
- `POST /test/push` (notifications-service, dev-only, no auth) — token-list push
- `POST /test/push` (auth-service, dev-only, no auth) — by account; FCM "not configured"

Provider: `sendPush()` (Firebase Admin) + `pruneToken()` dead-token cleanup.

Socket `/notify`: `notifications:fetch` (ack), `notifications:mark_read` (ack), `notification:count`
(on connect), forwarded `notify:<userId>` events (verbatim, e.g. `notification:new`).

## Coverage by category

Happy Path · Input Validation (token len, platform enum, title/body bounds, datetime) · Optional
Params · AuthN · AuthZ (own notifications/tokens/rooms) · Business Rule (dedupe tokens, ownership
move, mute suppression, derived counters) · DB State (upsert, read flags, prune) · Error Handling
(invalid/transient FCM token, missing records, downstream unreachable) · Edge Case · Concurrency
(multi-device register race, mark-all-read vs new notification, ref-counted socket sub) · Pagination/
Filter/Sort (cursor, limit) · Security (IDOR mark-read, cross-user unregister, userId injection, dev
route prod exposure).

> Rate Limit: no notification-specific limiter found on these routes (the private message routes use
> `sendLimit` on send only, not on mute/notifications). No dedicated rate-limit cases authored —
> flagged as a gap.

## GAPS / ambiguities

1. **IDOR on mark-read (BUG).** `POST /api/chat/notifications/read` → `markRead(notificationId)`
   does `prisma.notification.update({ where:{ id } })` with **no `userId` scope**. Any authenticated
   user can mark any notification read by id. (TC-NOTIF-053.) The socket path passes `userId` to
   gRPC `markNotificationsRead` — verify that handler enforces ownership.
2. **markReadSchema not wired.** `markReadSchema` (and `getNotificationsSchema`) exist in
   `notification.validator.ts` but are **not applied** to the routes. So `POST /read` with missing/
   malformed `notificationId` yields a Prisma `500` instead of `400`, and `GET /notifications`
   `limit` is **uncapped** (validator's `max(100)` unused). The socket `notifications:fetch` DOES
   cap at 100. (TC-NOTIF-034, 038, 051.)
3. **No per-type / global notification preferences.** Only per-conversation mute exists. "Muted
   types suppressed before sending" is unimplemented. (preferences.md scope note.)
4. **Mute not honored in push path.** `sendPush` performs no preference/mute lookup; no production
   consumer wires `notificationSettings` → suppression. Mute suppression cases (TC-NOTIF-137/138) are
   expected-behavior specs to verify, not confirmed behavior.
5. **No production push consumer.** FCM is only reachable via DEV-ONLY `/test/push` routes;
   auth-service `/test/push` always returns "FCM push support is not configured yet" (no token store
   in auth). Dead-token pruning is defined (`pruneToken`) but no live caller invokes it.
6. **Notification creation path not in scope.** `NotificationRepository.create` /
   `findByEntityId` (dedupe-by-entity) exist but no analyzed route/consumer calls them — producer
   that emits `notify:<userId>` and writes rows was not in the provided sources. Forwarded event name
   (`notification:new`) is inferred from `docs/SOCKET_EVENTS.md` (events forwarded verbatim).
7. **Ownership-move side effect.** Re-registering an existing token transfers it to the new user
   (TC-NOTIF-004); re-register without `deviceId` overwrites stored `deviceId` with `null`
   (TC-NOTIF-005) — confirm both are intended.
8. **Rate limiting** absent on all notification/device endpoints — abuse surface for token spam and
   mark-read loops.
