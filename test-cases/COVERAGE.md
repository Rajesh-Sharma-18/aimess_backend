# AIMess Backend — Test Coverage Index & Gap Analysis

Generated from a full pass over the implemented codebase (`apps/*/src`, the Socket.IO namespaces,
and `docs/SOCKET_EVENTS.md`). **1,116 test cases** across **10 modules / 97 files**.

| Module               | Folder                                   | Files | Test cases | ID range         |
| -------------------- | ---------------------------------------- | ----: | ---------: | ---------------- |
| Auth                 | [`auth/`](auth/)                         |    16 |        159 | TC-AUTH-001…159  |
| Users                | [`users/`](users/)                       |     8 |        103 | TC-USER-001…103  |
| Friends              | [`friends/`](friends/)                   |     9 |         81 | TC-FRND-001…081  |
| Private chat         | [`private-chat/`](private-chat/)         |    12 |        133 | TC-PCHAT-001…133 |
| Group chat           | [`group-chat/`](group-chat/)             |    11 |        163 | TC-GCHAT-001…163 |
| Communities          | [`communities/`](communities/)           |    11 |        139 | TC-COMM-001…139  |
| Calls                | [`calls/`](calls/)                       |     7 |         68 | TC-CALL-001…068  |
| Notifications        | [`notifications/`](notifications/)       |     8 |         80 | TC-NOTIF-001…138 |
| WebSocket events     | [`websocket-events/`](websocket-events/) |    11 |        115 | TC-WS-001…236    |
| Livestream (partial) | [`livestream/`](livestream/)             |     3 |         75 | TC-LIVE-001…299  |

Each module's `_index.md` carries its own endpoint→file map. This document is the **cross-module
roll-up** and, more importantly, the **consolidated gap / defect register** the analysis produced.

---

## Transport reality (read this first)

Several "REST" features are actually **Socket.IO events**, not HTTP:

- **1:1 + group message creation, reactions, read/delivery receipts, typing** → `/chat` socket events
  (gateway → gRPC → chat-service). REST covers list/search/edit/delete/forward/report/media/inbox.
- **Call signaling** (`call:initiate/answer/decline/end/ice`) → `/chat` socket events; only call
  _history_ and _TURN config_ are REST.
- **Community realtime** → `/community` namespace; **notifications realtime** → `/notify` namespace.

The [`websocket-events/`](websocket-events/) module is the authoritative payload contract for events;
the chat/call/community/notification modules reference it rather than duplicating payloads.

---

## Module → surface coverage

| Module        | REST endpoints                                                                                                                                                                                | Socket events                                                                               | Notes                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Auth          | 24 endpoints (register, login, validate, refresh, token, logout, password-reset×3, google/apple, sessions, change-email, change-password, account, account-deletion, device-link, email-link) | None                                                                                        | —                                                                                         |
| Users         | 11 endpoints (profile get/patch, username generate/validate, settings get/patch, accounts/me, uploads/url, search, 2× internal)                                                               | None (RabbitMQ `profile.updated`/`settings.updated`)                                        | —                                                                                         |
| Friends       | request lifecycle (send/accept/decline/cancel/remove), block/unblock, lists, status, internal `friendship-check`                                                                              | notify/realtime friend events                                                               | `check(a,b)` gate **exists** (HTTP `/internal/friendship-check` + gRPC `CheckFriendship`) |
| Private chat  | rooms, timeline, search, media list, edit, delete, forward, report, pins, reactions-GET, inbox, presign                                                                                       | `message:new/edited/delete/reaction/read/delivered`, `conv:updated`                         | Friendship gate **active**                                                                |
| Group chat    | groups CRUD, members add/leave/kick/list, roles, invite-links×5, messages×9                                                                                                                   | `message:new` (incl. SYSTEM), `conv:updated`, lifecycle/system messages                     | RBAC owner/admin/moderator/member                                                         |
| Communities   | community-service (communities/members/roles/moderation/invites/reports/categories) + chat-service community room (10)                                                                        | `/community` namespace                                                                      | Channels **not implemented** (1 implicit room)                                            |
| Calls         | `GET /api/chat/calls`, `/calls/:id`, `GET /api/v1/webrtc/rtc-config`                                                                                                                          | `call:initiate/answer/decline/end/ice` + server `call:incoming/answered/declined/ended/ice` | 1:1 only; thin/early-stage                                                                |
| Notifications | `POST/DELETE /v1/devices`, list/read/read-all/unread-count, conversation mute, dev test-push                                                                                                  | `/notify`: `notification:count`, `notifications:fetch/mark_read`, forwarded events          | —                                                                                         |
| WebSocket     | —                                                                                                                                                                                             | 27 client→server + 21 server→client + connection lifecycle                                  | Doc and code in sync                                                                      |
| Livestream    | none wired                                                                                                                                                                                    | none wired                                                                                  | Comment logic is **dead code**; no stream-service                                         |

---

## ⚠️ Consolidated gap & defect register

Findings surfaced during analysis, grouped by severity. Each maps to test cases written as the
**expected (correct)** behavior, so they double as a defect backlog. Verify against current code
before treating any single item as a confirmed bug.

### 🔴 High — security / data-integrity

| #   | Area          | Finding                                                                                                                                                                                                          | TC ref                 |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---- | ------------------------------------- | -------------------- |
| H1  | Users         | `/api/internal` endpoints are **unauthenticated** and trust a query-supplied `callerId` — any network-reachable caller can enumerate any user's friends/profiles. Needs service-token/mTLS or network isolation. | TC-USER-101/102        |
| H2  | Private chat  | **Download-URL IDOR** — presign download only checks the `chat-uploads/` prefix, not ownership/participation; any authed user can mint a view URL for any chat object. _(follow-up task spawned)_                | media-upload.md        |
| H3  | Private chat  | Timeline/search read **AuthZ gap** — `getMessagesTimeline` checks room existence but not participation (history IDOR), unlike `listMedia`/`catchup`/`report`.                                                    | get-conversation.md    |
| H4  | Group chat    | `addMember` has **no RBAC/membership check on the inviter** — any authed user can add members to any group (IDOR + privilege escalation).                                                                        | members.md             |
| H5  | Group chat    | Inconsistent membership gating leaks data (incl. **active invite tokens**) to non-members on `GET /groups/:id`, `/group-members/:id`, `/messages                                                                 | search                 | pins | reactions`, `/invite-links/room/:id`. | roles-permissions.md |
| H6  | Notifications | **IDOR** — `POST .../notifications/read` calls `prisma.update({where:{id}})` with no `userId` scope; any user can mark any notification read by id.                                                              | TC-NOTIF-053           |
| H7  | Calls         | `call:ice` has **no participant check** and `candidate: z.unknown()` → ICE injection into a victim call by `callId`.                                                                                             | TC-CALL-059            |
| H8  | Calls         | `GET /calls/:callId` is **not participant-scoped** — any authed user reads any call record.                                                                                                                      | call-history.md        |
| H9  | WebSocket     | **JWT replay after revocation** — `auth.middleware.ts` validates signature+expiry only, no session-revocation check.                                                                                             | TC-WS connection-auth  |
| H10 | WebSocket     | No room-membership check on `conv:join`/`community:join` → passive eavesdropping on `message:new`/typing (mitigated only by opaque room IDs).                                                                    | TC-WS rooms-join-leave |
| H11 | Calls         | TURN creds are **static/shared/long-lived** (env user/pass), not ephemeral Coturn HMAC — no TTL/scoping/rotation.                                                                                                | turn-credentials.md    |

### 🟠 Medium — correctness / robustness

| #   | Area          | Finding                                                                                                                                                                                                            | TC ref                                                                                                                       |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| M1  | Calls         | **`call:<callId>` room is never `join()`ed** in `chat.ns.ts`, yet gateway emits `answered/ended/ice` to it → those events may never reach the caller. Likely real bug.                                             | TC-CALL-059                                                                                                                  |
| M2  | Calls         | No self-call guard, no friendship/reachability check, no busy-state check; block enforcement only runs when caller supplies `privateRoomId`.                                                                       | initiate-call.md                                                                                                             |
| M3  | Calls         | No ringing timeout / disconnect→auto-end → stale `RINGING`/`IN_PROGRESS` rows leak; no missed-call FCM fallback.                                                                                                   | end-call.md                                                                                                                  |
| M4  | Group chat    | No ownership transfer; `updateRole` allows a **second OWNER** (no single-owner invariant). No **ban enforcement** (kicked users freely re-addable).                                                                | roles-permissions.md                                                                                                         |
| M5  | Notifications | Validators (`markReadSchema`, `getNotificationsSchema`) defined but **not wired** → bad input yields 500 not 400; HTTP `limit` is **uncapped**.                                                                    | list-notifications.md                                                                                                        |
| M6  | Notifications | No per-type/global notification **preferences** (only per-conversation mute); mute **not honored in push path**; no production push consumer (FCM only via dev test-push).                                         | preferences.md / push-delivery.md                                                                                            |
| M7  | Communities   | **Split-brain membership** — chat-service `/rooms/:id/join                                                                                                                                                         | leave` bypass community-service's join-request/role pipeline; user can be a chat-room member without a community membership. | join-leave.md |
| M8  | Communities   | Unauthenticated chat-room listing (`GET /rooms`, `/rooms/search` lack auth). PUBLIC join is request-only (no instant join).                                                                                        | community-chat.md                                                                                                            |
| M9  | Users         | Username PATCH not atomic (check-then-write, no retry); verify P2002 → `409` not `500`. One-directional block filter in `section=all`.                                                                             | username.md / user-search.md                                                                                                 |
| M10 | Private chat  | Reaction lost-update race (`addReactions` non-atomic full-map replace); `deleteForMe`/GET reactions/GET pins lack participation checks; GIF enum mismatch (allowed in media list, absent from send `messageType`). | reactions.md / attachments.md                                                                                                |
| M11 | Group chat    | Non-atomic concurrency: member-cap race (add & join-by-link can exceed `memberLimit`), single-use invite-link race, double-decrement on concurrent kick.                                                           | invite-links.md / members.md                                                                                                 |
| M12 | WebSocket     | Possible **multi-instance duplicate delivery** — every gateway psubscribes `conv:*`/`call:*`/`community:*` plus Redis adapter fan-out. Likely benign (client-idempotent by id) — verify in 2-instance setup.       | scaling-redis-adapter.md                                                                                                     |

### 🟡 Low / quirks

- Group: disband emits no event/system message; forward idempotency double-fans-out `message:new`; several `SystemEvent` codes + pin/unpin write path unwired.
- WebSocket: `message:react` allows empty emoji; community pure-media send still requires non-empty `message`; absolute unread count is planned (not yet emitted); group-call signaling absent; `community:join` requires an unused `roomId`.
- Communities: `discover?filter=live|upcoming` returns empty (stream-service not shipped); no interactive Mongo transactions (standalone) → compensation-based writes.
- Calls: gateway flattens all gRPC errors to `SERVICE_ERROR`, losing specific codes for socket clients.
- Users: avatars validated by MIME string + size only — no magic-byte/dimension checks (bucket is private/presigned, limiting risk).

---

## Not implemented (test cases are placeholders)

| Capability                                              | Status                                                                                               | Where documented                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Livestream / stream-service** (port 3007)             | Schema + dead comment service only; no routes/sockets/transport, no RTMP/OSSRS/HLS, no viewer counts | [`livestream/gaps-and-planned.md`](livestream/gaps-and-planned.md)         |
| **Community channels**                                  | Not modeled — a community = 1 implicit chat room                                                     | [`communities/channels.md`](communities/channels.md)                       |
| **Group calls**                                         | Not implemented — calling is strictly 1:1                                                            | [`calls/_index.md`](calls/_index.md)                                       |
| **SDP offer/answer signaling**                          | Only `call:ice` exists; SDP must travel out-of-band                                                  | [`calls/webrtc-signaling.md`](calls/webrtc-signaling.md)                   |
| **Production push (FCM) consumer**                      | FCM only via dev `/test/push`; auth-service variant returns "not configured"                         | [`notifications/push-delivery.md`](notifications/push-delivery.md)         |
| **Group mute/warn/notification-prefs + HTTP mark-read** | That moderation commit landed in community-service, not group chat                                   | [`group-chat/moderation-mute-warn.md`](group-chat/moderation-mute-warn.md) |

---

## How to use this repository

1. **Manual QA** — work a module's `_index.md` top to bottom; each case is self-contained.
2. **Automation** — the table fields map cleanly to a test runner (Preconditions → setup,
   Request Payload → call, Expected Response/DB/Socket → assertions).
3. **Defect triage** — start with the 🔴 High table above; each links to its expected-behavior case.
4. **Keep in sync** — when an endpoint/event changes, update its module file and this index.
   Mirror socket changes into `docs/SOCKET_EVENTS.md` (project standing instruction).
