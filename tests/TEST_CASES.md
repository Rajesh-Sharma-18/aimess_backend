# AIMess Backend — Test Case Catalog (Master Index)

Generated 2026-06-11. Verified by running the full suite (`exit 0`).

Each service has a detailed per-endpoint catalog (Endpoint · Method · Description ·
Preconditions · Positive · Negative · Edge · Security · Expected status codes ·
Expected response structure) under `apps/<service>/tests/TEST_CASES.md`. This index
summarizes coverage and links to them.

## Suite at a glance

| Service               | Test files |               Tests | Detailed catalog                                                | Audit                                                 |
| --------------------- | ---------: | ------------------: | --------------------------------------------------------------- | ----------------------------------------------------- |
| auth-service          |         15 |             **183** | [TEST_CASES](../apps/auth-service/tests/TEST_CASES.md)          | [AUDIT](../apps/auth-service/tests/AUDIT.md)          |
| user-service          |          9 |             **137** | [TEST_CASES](../apps/user-service/tests/TEST_CASES.md)          | [AUDIT](../apps/user-service/tests/AUDIT.md)          |
| community-service     |         12 |   **224** (+1 skip) | [TEST_CASES](../apps/community-service/tests/TEST_CASES.md)     | [AUDIT](../apps/community-service/tests/AUDIT.md)     |
| chat-service          |         15 |             **212** | [TEST_CASES](../apps/chat-service/tests/TEST_CASES.md)          | [AUDIT](../apps/chat-service/tests/AUDIT.md)          |
| notifications-service |          4 |              **46** | [TEST_CASES](../apps/notifications-service/tests/TEST_CASES.md) | [AUDIT](../apps/notifications-service/tests/AUDIT.md) |
| backoffice-service    |         10 |             **197** | [TEST_CASES](../apps/backoffice-service/tests/TEST_CASES.md)    | [AUDIT](../apps/backoffice-service/tests/AUDIT.md)    |
| api-gateway           |          7 |              **71** | [TEST_CASES](../apps/api-gateway/tests/TEST_CASES.md)           | [AUDIT](../apps/api-gateway/tests/AUDIT.md)           |
| **Total**             |     **72** | **1,070** (+1 skip) |                                                                 |                                                       |

## Scenario taxonomy applied to every endpoint

The suite applies a consistent matrix (derived from real code, never assumed):

- **Positive** — valid payloads, happy-path CRUD, valid auth, valid RBAC, pagination /
  filtering / sorting / search, file-upload URL issuance, business-rule success.
- **Negative** — missing / empty / null / undefined fields, wrong types, invalid enums,
  invalid UUID / ObjectId, invalid query & path params, not-found (404), duplicate /
  conflict (409), unauthorized (401: missing / malformed / expired / forged token),
  forbidden / cross-role (403), malformed JSON.
- **Edge** — boundary string lengths (min/max from the Zod schema), unicode / emoji,
  special characters, empty & large collections, cursor / limit pagination edges,
  soft-deleted / archived / suspended / banned / blocked actors where code branches.
- **Security** — authn & authz bypass, **IDOR** (acting on another user's resource id),
  JWT tampering / forged signature / expiry, mass-assignment (privileged fields in body
  ignored), NoSQL/SQL-injection-shaped payloads (asserted rejected/safe), header
  manipulation, privilege escalation, sensitive-data exposure.

## Per-service module coverage

- **auth-service** — accounts/validate, register, login, refresh & token issuance,
  logout, sessions (list / revoke / revoke-all), password-reset (request / verify /
  reset), change-email, change-password, email-link, device-link, social login & link
  (google / apple), account-deletion. JWT matrix proven (valid/missing/malformed/
  expired/forged). _Uncovered (documented): gRPC admin methods, RabbitMQ consumers,
  real OAuth/JWKS verifiers, OTP throttle 429 path._
- **user-service** — profile (get/update/me), user-search & discovery (sections),
  username (availability / cooldown), settings (privacy / call-permissions),
  avatar-upload (storage seam), account, friends (request / accept / decline / cancel /
  remove / block / list / status), internal endpoints. _Uncovered: gRPC CheckFriendship,
  event consumers/handlers, MinIO branches, Redis cache layer._
- **community-service** — communities (create / update / delete / discover / mine /
  liked), categories (+ admin CRUD), channels, membership & roles, join / leave,
  invite-links, moderation & reports, mute / notification-prefs, community-chat
  provisioning. _Uncovered: service-layer role-gate ladder, report state machine,
  gRPC + consumers, DTO/media serialization._
- **chat-service** — private chat (inbox, conversation, send/edit/delete, reactions,
  read-receipts, unread, pins, forward, report), group chat (members, roles,
  invite-links, messages, pins), community chat (rooms, messages, react, delete),
  media upload/download, presence, calls (history / get / accept / decline / end).
  _Uncovered: socket/gRPC send paths (REST-only suite), edit-window expiry._
- **notifications-service** — device registration (register / unregister), list,
  mark-read, mark-all-read, unread-count, preferences, push-delivery, test-push (dev).
  _Uncovered: 5 RabbitMQ consumers, push.service orchestration, quiet-hours logic,
  FCM provider, gRPC stubs._
- **backoffice-service** — admin auth (login / refresh / logout), password-reset OTP,
  RBAC & permissions, user management (ban / suspend / unban / bulk), reports &
  moderation (resolve / dismiss / bulk), communities (close / reopen / bulk),
  livestreams (end / bulk), dashboard, audit log. Cross-role / privilege-escalation /
  RBAC-deny coverage emphasized. _Uncovered: refresh reuse-detection, OTP 429 paths,
  bulk partial-failure semantics, in-memory Phase-2 repos._
- **api-gateway** — middleware (JWT verify, app-version gate, versioning, rate-limit
  skip, request-id, CORS/helmet, admin-IP allowlist, admin-JWT), proxy routing &
  header forwarding, health, webrtc rtc-config, **Socket.IO connection-auth** (accept /
  reject) and namespace join. _Uncovered (documented): post-connect socket handlers
  (need a booted Socket.IO + Redis adapter), proxy 502 paths, docs routes._
