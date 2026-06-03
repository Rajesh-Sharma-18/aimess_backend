# WebSocket — Connection & Handshake Auth

Handshake-time JWT authentication for all three namespaces (`/chat`, `/community`,
`/notify`). The same `gatewaySocketAuthMiddleware` runs as a `namespace.use(...)`
guard on every namespace. On success the socket carries server-derived
`{ userId, sessionId }`; the client never sends its own `userId`.

**Source:** `apps/api-gateway/src/sockets/auth.middleware.ts`,
`apps/api-gateway/src/sockets/index.ts`, `docs/SOCKET_EVENTS.md` §1.

---

### TC-WS-001 — Connect to /chat with a valid access token in handshake.auth.token

| Field                     | Value                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                                                                                                     |
| **API/Event Name**        | `connect` (`/chat` namespace)                                                                                                                                   |
| **Test Scenario**         | Happy path — valid JWT in `socket.handshake.auth.token` connects and auto-joins `user:<userId>`                                                                 |
| **Category**              | Happy Path                                                                                                                                                      |
| **Priority**              | High                                                                                                                                                            |
| **Preconditions**         | Valid, unexpired access token signed with `JWT_ACCESS_SECRET`                                                                                                   |
| **Request Payload**       | `io("<base>/chat", { auth: { token: accessToken } })`                                                                                                           |
| **Expected Response**     | `connect` fires; no `connect_error`; `socket.connected === true`                                                                                                |
| **Expected DB Changes**   | None directly; best-effort gRPC `presenceConnect({ userId, deviceId, platform, clientType, appState:"FOREGROUND" })` marks user online in chat-service presence |
| **Expected Socket/Event** | Socket auto-joins room `user:<userId>`; watched-peer subscribers may receive `presence:status` for this user                                                    |
| **Notes**                 | `deviceId = sessionId ?? socket.id`. Presence failure is swallowed (logged, connection still succeeds).                                                         |

### TC-WS-002 — Connect with token in Authorization Bearer header (fallback)

| Field                     | Value                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                                                                                                 |
| **API/Event Name**        | `connect` (any namespace)                                                                                                                                   |
| **Test Scenario**         | Token supplied only via `Authorization: Bearer <token>` header, not `auth.token`                                                                            |
| **Category**              | Happy Path                                                                                                                                                  |
| **Priority**              | High                                                                                                                                                        |
| **Preconditions**         | Valid access token                                                                                                                                          |
| **Request Payload**       | `io("<base>/chat", { extraHeaders: { Authorization: "Bearer <token>" } })`                                                                                  |
| **Expected Response**     | Connection succeeds; `socket.data` populated from token                                                                                                     |
| **Expected DB Changes**   | Same presence side effect as TC-WS-001 (on `/chat`)                                                                                                         |
| **Expected Socket/Event** | Joins `user:<userId>`                                                                                                                                       |
| **Notes**                 | `auth.token` takes precedence; header is only used when `auth.token` is absent. `extractBearerTokenSafe` swallows malformed-header throws and returns null. |

### TC-WS-003 — Connect with no token → rejected

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                         |
| **API/Event Name**        | `connect`                                                                           |
| **Test Scenario**         | AuthN — no `auth.token` and no Authorization header                                 |
| **Category**              | AuthN                                                                               |
| **Priority**              | High                                                                                |
| **Preconditions**         | None                                                                                |
| **Request Payload**       | `io("<base>/chat", {})`                                                             |
| **Expected Response**     | `connect_error` with `message === "Authentication required"`; socket never connects |
| **Expected DB Changes**   | None                                                                                |
| **Expected Socket/Event** | None; no room joins; no presence call                                               |
| **Notes**                 | Middleware calls `next(new Error("Authentication required"))`.                      |

### TC-WS-004 — Connect with expired access token → rejected

| Field                     | Value                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Connection Auth                                                                            |
| **API/Event Name**        | `connect`                                                                                              |
| **Test Scenario**         | AuthN — token is structurally valid but expired                                                        |
| **Category**              | AuthN                                                                                                  |
| **Priority**              | High                                                                                                   |
| **Preconditions**         | Access token whose `exp` is in the past                                                                |
| **Request Payload**       | `io("<base>/chat", { auth: { token: expiredToken } })`                                                 |
| **Expected Response**     | `connect_error` with `message === "Authentication failed"`                                             |
| **Expected DB Changes**   | None                                                                                                   |
| **Expected Socket/Event** | None                                                                                                   |
| **Notes**                 | `verifyAccessToken` throws → caught → `next(new Error("Authentication failed"))`; a warning is logged. |

### TC-WS-005 — Connect with malformed / garbage token → rejected

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                           |
| **API/Event Name**        | `connect`                                             |
| **Test Scenario**         | AuthN — `auth.token = "not-a-jwt"`                    |
| **Category**              | AuthN                                                 |
| **Priority**              | High                                                  |
| **Preconditions**         | None                                                  |
| **Request Payload**       | `io("<base>/chat", { auth: { token: "not-a-jwt" } })` |
| **Expected Response**     | `connect_error` `"Authentication failed"`             |
| **Expected DB Changes**   | None                                                  |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | Covers JWT parse error and signature mismatch.        |

### TC-WS-006 — Connect with token signed by wrong secret → rejected

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                       |
| **API/Event Name**        | `connect`                                                         |
| **Test Scenario**         | Security — JWT signed by an attacker key, not `JWT_ACCESS_SECRET` |
| **Category**              | Security                                                          |
| **Priority**              | High                                                              |
| **Preconditions**         | Token forged with a different signing key but valid claims        |
| **Request Payload**       | `io("<base>/chat", { auth: { token: forgedToken } })`             |
| **Expected Response**     | `connect_error` `"Authentication failed"`                         |
| **Expected DB Changes**   | None                                                              |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | Confirms signature verification, not just structural JWT shape.   |

### TC-WS-007 — Refresh token presented instead of access token → rejected

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                   |
| **API/Event Name**        | `connect`                                                                     |
| **Test Scenario**         | Security — refresh token (or any non-access token type) used on handshake     |
| **Category**              | Security                                                                      |
| **Priority**              | High                                                                          |
| **Preconditions**         | A valid refresh token for a real session                                      |
| **Request Payload**       | `io("<base>/chat", { auth: { token: refreshToken } })`                        |
| **Expected Response**     | `connect_error` `"Authentication failed"` (different secret/type than access) |
| **Expected DB Changes**   | None                                                                          |
| **Expected Socket/Event** | None                                                                          |
| **Notes**                 | `verifyAccessToken` uses the access secret; refresh tokens fail verification. |

### TC-WS-008 — Same middleware enforced on /community

| Field                     | Value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                             |
| **API/Event Name**        | `connect` (`/community`)                                                                |
| **Test Scenario**         | AuthN — anonymous connect to `/community` rejected; valid connect joins `user:<userId>` |
| **Category**              | AuthN                                                                                   |
| **Priority**              | High                                                                                    |
| **Preconditions**         | One run with no token, one with a valid token                                           |
| **Request Payload**       | `io("<base>/community", { auth: { token } })`                                           |
| **Expected Response**     | No token → `connect_error`; valid → connect + auto-join `user:<userId>`                 |
| **Expected DB Changes**   | None (no presence call on `/community`)                                                 |
| **Expected Socket/Event** | Valid connect joins `user:<userId>` only                                                |
| **Notes**                 | `/community` has no `presenceConnect` side effect.                                      |

### TC-WS-009 — Same middleware enforced on /notify + unread count emit

| Field                     | Value                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                                                                        |
| **API/Event Name**        | `connect` (`/notify`)                                                                                                              |
| **Test Scenario**         | Happy path — valid connect to `/notify` joins `user:<userId>`, subscribes Redis channel, emits `notification:count`                |
| **Category**              | Happy Path                                                                                                                         |
| **Priority**              | High                                                                                                                               |
| **Preconditions**         | Valid token; notifications-service reachable over gRPC                                                                             |
| **Request Payload**       | `io("<base>/notify", { auth: { token } })`                                                                                         |
| **Expected Response**     | Connect; client receives `notification:count` `{ count }` once                                                                     |
| **Expected DB Changes**   | None (read-only `getNotifications({ limit:1 })` to compute unread count)                                                           |
| **Expected Socket/Event** | Server→client `notification:count { count: res.unreadCount }`; ref-counted `redisSub.subscribe("notify:<userId>")` on first socket |
| **Notes**                 | If the gRPC count fetch fails the connection still succeeds; `notification:count` is simply not emitted (logged).                  |

### TC-WS-010 — Connection state recovery within 2-minute window

| Field                     | Value                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                                                             |
| **API/Event Name**        | `connect` (reconnect)                                                                                                   |
| **Test Scenario**         | Edge — transport drop then reconnect inside `maxDisconnectionDuration` (2 min) recovers session/rooms                   |
| **Category**              | Edge Case                                                                                                               |
| **Priority**              | Medium                                                                                                                  |
| **Preconditions**         | `connectionStateRecovery` enabled (it is); socket was connected and in rooms                                            |
| **Request Payload**       | Auto reconnect by socket.io-client                                                                                      |
| **Expected Response**     | `socket.recovered === true`; previously joined rooms restored without re-emitting `conv:join`                           |
| **Expected DB Changes**   | None                                                                                                                    |
| **Expected Socket/Event** | Buffered events during the gap may be delivered on recovery                                                             |
| **Notes**                 | After 2 min the session is not recovered — client must re-join rooms and run `chat:catchup` (see reconnect-catchup.md). |

### TC-WS-011 — CORS origin not in allow-list → handshake blocked

| Field                     | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                                     |
| **API/Event Name**        | `connect` (CORS preflight)                                                                      |
| **Test Scenario**         | Security — browser client from an origin not in `CORS_ALLOWED_ORIGINS`                          |
| **Category**              | Security                                                                                        |
| **Priority**              | Medium                                                                                          |
| **Preconditions**         | Origin header not in `getCorsAllowedOrigins()`                                                  |
| **Request Payload**       | Browser `io()` from disallowed origin                                                           |
| **Expected Response**     | Handshake blocked by CORS; `connect_error`; `io.engine` `connection_error` logged               |
| **Expected DB Changes**   | None                                                                                            |
| **Expected Socket/Event** | None                                                                                            |
| **Notes**                 | `credentials: true`, methods `GET, POST`. Native (non-browser) clients are not subject to CORS. |

### TC-WS-012 — Payload over 1 MB rejected by transport

| Field                     | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                                              |
| **API/Event Name**        | any emit (`maxHttpBufferSize`)                                                                           |
| **Test Scenario**         | Edge — emit a frame larger than `1e6` bytes                                                              |
| **Category**              | Edge Case                                                                                                |
| **Priority**              | Medium                                                                                                   |
| **Preconditions**         | Connected socket                                                                                         |
| **Request Payload**       | e.g. `message:send` with a multi-MB `contentText`                                                        |
| **Expected Response**     | Engine closes the connection; `io.engine` `connection_error` logged; no ack delivered                    |
| **Expected DB Changes**   | None                                                                                                     |
| **Expected Socket/Event** | None                                                                                                     |
| **Notes**                 | `maxHttpBufferSize: 1e6`. Large media should travel via object storage (`mediaKey`/`files`), not inline. |

### TC-WS-013 — JWT replay after session revocation

| Field                     | Value                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Connection Auth                                                                                                                                                |
| **API/Event Name**        | `connect`                                                                                                                                                                  |
| **Test Scenario**         | Security — a still-unexpired access token whose session was revoked is replayed on handshake                                                                               |
| **Category**              | Security                                                                                                                                                                   |
| **Priority**              | High                                                                                                                                                                       |
| **Preconditions**         | Session logged out/revoked in auth-service but the short-lived access token has not yet expired                                                                            |
| **Request Payload**       | `io("<base>/chat", { auth: { token: revokedSessionToken } })`                                                                                                              |
| **Expected Response**     | **GAP:** middleware only verifies signature+expiry (`verifyAccessToken`); it does **not** check session revocation → connection currently SUCCEEDS until the token expires |
| **Expected DB Changes**   | Presence may mark user online                                                                                                                                              |
| **Expected Socket/Event** | Joins `user:<userId>`                                                                                                                                                      |
| **Notes**                 | Document as a known limitation. Mitigation relies on short access-token TTL. No per-socket revocation check exists in `auth.middleware.ts`.                                |
