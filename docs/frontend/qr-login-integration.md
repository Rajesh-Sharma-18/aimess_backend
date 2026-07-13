# QR Login (Linked Devices) — Frontend Integration Guide

This document is generated directly from the current implementation in
`apps/auth-service` and `apps/api-gateway`. Every field, status code, event
name, and validation rule below is taken verbatim from the code — nothing is
assumed. If the backend changes, this document must be re-verified against:

- `apps/auth-service/src/api/routes/device-link.routes.ts`
- `apps/auth-service/src/api/validators/device-link.validator.ts`
- `apps/auth-service/src/api/controllers/device-link.controller.ts`
- `apps/auth-service/src/services/device-link.service.ts`
- `apps/auth-service/src/lib/device-link-store.ts`
- `apps/api-gateway/src/sockets/namespaces/auth.ns.ts`
- `apps/api-gateway/src/routes/v1/linked-devices.routes.ts`

All REST paths below are given **relative to the API gateway**, i.e. prefixed
with `/api/v1`. The `auth` segment proxies `/api/v1/auth/*` to auth-service's
own `/api/auth/*` mount.

**Telegram-style, instant login:** scanning the QR IS logging in. There is no
confirmation screen, no approve/reject step, and no polling. One socket
subscription plus one authenticated call from the mobile device is the entire
flow.

---

## QR Login Overview

```
   Browser (unauth)              Gateway / auth-service           Mobile (signed in)
        │                                  │                              │
        │  POST /auth/devices/link/initiate│                              │
        ├─────────────────────────────────►│                              │
        │  201 { linkToken, expiresAt }    │                              │
        │◄─────────────────────────────────┤                              │
        │                                  │                              │
        │  Render QR (encodes linkToken)   │                              │
        │                                  │                              │
        │  connect /auth namespace          │                              │
        │  emit auth:qr:subscribe          │                              │
        ├─────────────────────────────────►│                              │
        │                                  │        (user scans QR,      │
        │                                  │         extracts linkToken) │
        │                                  │  POST /auth/devices/link/scan
        │                                  │◄─────────────────────────────┤
        │                                  │  200 { accessToken,          │
        │                                  │        refreshToken,         │
        │                                  │        sessionId, linkedAt } │
        │                                  ├──────────────────────────────►
        │  ◄── auth:qr:success {accessToken, refreshToken, deviceId, user} ┤
        │                                  │                              │
        │  Store tokens, redirect to app   │                              │
        │                                  │                              │
        │  (later) GET /users/linked-devices → new browser session appears│
```

---

## Complete Login Flow

### 1. Opening the login screen (browser)

No API call yet. Connect to the `/auth` Socket.IO namespace immediately so
the browser is ready to receive the login result the instant a QR is scanned.

### 2. Generating the QR

```
POST /api/v1/auth/devices/link/initiate
```

No authentication. Rate-limited to **5 requests/minute/IP**
(`qrGenerationRateLimiter`). Returns `linkToken` (a UUID v4) and `expiresAt`
(ISO-8601 string, 60 seconds from now).

- Encode **only `linkToken`** into the QR image (client-side; the backend
  does not generate a QR image or a fixed URI scheme). Recommended content:
  `aimess://login?token=<linkToken>`.

### 3. Subscribing to the socket

```
Socket.IO namespace: /auth
emit: auth:qr:subscribe  { token: linkToken }
```

No acknowledgement is sent for this event. The browser is now in Socket.IO
room `qr:<linkToken>` and will receive the login result (or expiry) for this
session.

### 4. Scanning the QR — instant login (mobile, already authenticated)

The mobile app decodes the QR, extracts `linkToken`, and immediately calls:

```
POST /api/v1/auth/devices/link/scan   (auth required — mobile's own Bearer token)
Body: { linkToken, appVersion?, deviceLabel? }
```

This single call:

1. Validates the QR (exists, `PENDING`, not expired).
2. Atomically claims it (single-use guarantee — a second concurrent call on
   the same token gets `409`).
3. Issues a **brand-new** web access/refresh token pair via the same
   `issueAuthTokens()` used by password/social login (mobile's own token is
   never reused).
4. Creates the new browser `Session` (linked device).
5. Marks the QR `USED` (terminal).
6. Publishes `auth:qr:success` to the browser's socket room.

No approve/reject step, no confirmation screen — the mobile call above IS
the login.

### 5. Receiving tokens (browser)

The browser receives `auth:qr:success` on its socket, containing
`accessToken`, `refreshToken`, `deviceId` (the new session id), and `user`.
It never sees these over any other event.

### 6. Browser login

The browser stores the tokens (see [Authentication](#authentication)) and
navigates to the authenticated app — the socket connection to `/auth` can be
closed at this point.

### 7. Linked device creation

The new browser session is now a row returned by
`GET /api/v1/users/linked-devices` (alias of `GET /api/v1/auth/sessions`) —
no separate "linked device" API exists; it is the same `Session` table every
login writes to.

### 8. Logout device

Any signed-in device — including the browser itself — can revoke the browser's
session:

```
DELETE /api/v1/users/linked-devices/{deviceId}
```

See [`linked-devices.md`](./linked-devices.md) for the full device-management
API (list, revoke one, revoke all).

---

## REST APIs

All responses use the project's standard envelope: `{ success, message, data }`
on every success, `{ success: false, message }` on every error.

### `POST /api/v1/auth/devices/link/initiate`

**Purpose**: Create a new QR login session.
**Authentication**: None (public).
**Headers**: `x-lang` (optional).
**Rate limit**: 5 requests/minute/IP (`qrGenerationRateLimiter`).

**Request body** (all fields optional):
| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `deviceName` | string | optional, trimmed, max 100 chars | Free-text label for the NEW (browser/desktop) device. Falls back to a server-derived value from the User-Agent if omitted. |
| `deviceType` | string | optional, trimmed, max 100 chars | Free-text device type. Later mapped internally to `IOS`/`ANDROID`/`DESKTOP`/`WEB`. |
| `os` | string | optional, trimmed, max 100 chars | |
| `appVersion` | string | optional, trimmed, max 100 chars | |

**Success response — `201 Created`**:

```json
{
  "success": true,
  "message": "Device linking initiated. Please approve on your existing device.",
  "data": {
    "linkToken": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "expiresAt": "2026-07-14T10:31:00.000Z"
  }
}
```

| Field       | Type             | Meaning                                                            |
| ----------- | ---------------- | ------------------------------------------------------------------ |
| `linkToken` | string (UUID v4) | Encode this into the QR. Single-use.                               |
| `expiresAt` | string, ISO-8601 | Session expires 60 seconds after creation (`QR_LINK_TTL_SECONDS`). |

**Error responses**:
| Status | `message` | Cause |
|---|---|---|
| 400 | Zod validation text | A field exceeds 100 chars |
| 429 | "Too many QR login sessions requested, please try again later." (not localized) | Rate limit exceeded |

---

### `POST /api/v1/auth/devices/link/scan`

**Purpose**: The already-signed-in device scans the QR — this call IS the
login. Validates, claims, issues fresh tokens, creates the session, marks the
QR used, and pushes `auth:qr:success`.
**Authentication**: Required — `Authorization: Bearer <mobile's own access token>`.
**Rate limit**: 10 requests/minute/user (`qrScanRateLimiter`, keyed by `req.auth.userId`).

**Request body**:
| Field | Type | Constraints |
|---|---|---|
| `linkToken` | string | non-empty |
| `appVersion` | string | optional, trimmed, max 100 chars |
| `deviceLabel` | string | optional, trimmed, max 100 chars — friendly label for the NEW (browser) device, e.g. `"Office iPad"` |

**Success response — `200 OK`**:

```json
{
  "success": true,
  "message": "Device linked successfully.",
  "data": {
    "linkedAt": "2026-07-14T10:30:20.000Z",
    "sessionId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "9f2b7c1e4a8d...",
    "accessTokenExpiresIn": 3600,
    "refreshTokenExpiresIn": 604800
  }
}
```

| Field                                     | Meaning                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`                               | The new browser session's id — same value that later appears as `sessionId` in `GET /users/linked-devices`, and what you pass to `DELETE /users/linked-devices/{sessionId}`.                                                                                |
| `accessToken`/`refreshToken`/`*ExpiresIn` | The SAME tokens delivered to the browser via `auth:qr:success` — the mobile caller also receives them in this REST response as a durable fallback in case the browser's socket dropped mid-flow (the mobile app itself does not need to store or use them). |

**Error responses**:
| Status | Message key | Cause |
|---|---|---|
| 400 | Zod message | Missing `linkToken`, or a field too long |
| 401 | — | Not authenticated |
| 404 | `AUTH_DEVICE_LINK_NOT_FOUND` — "Device link session not found or has expired." | `linkToken` unknown |
| 404 | `AUTH_DEVICE_LINK_EXPIRED` — "This QR code has expired." | Past `expiresAt` (checked both at claim time and again at finalize time) |
| 409 | `AUTH_DEVICE_LINK_ALREADY_SCANNED` — "This QR code has already been scanned." | QR already claimed/used — single-use enforced atomically in Redis |
| 429 | "Too many QR scan attempts, please try again later." (not localized) | Rate limit |

---

## Socket Events

**Namespace**: `/auth`. **No authentication** on this namespace — it carries
no JWT and no privileged data flows through the join itself.

### Client → Server: `auth:qr:subscribe`

|                 |                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload         | `{ "token": "<linkToken>" }`, 1–200 chars                                                                                                   |
| Server behavior | Joins Socket.IO room `qr:<linkToken>`. Re-emitting with a new token replaces the old subscription. A malformed payload is silently ignored. |
| Acknowledgement | None.                                                                                                                                       |

### Server → Client: `auth:qr:success`

|                 |                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When emitted    | Right after `POST /devices/link/scan` succeeds                                                                                                                                                                                           |
| Payload         | `{ "linkToken": "<uuid>", "accessToken": string, "refreshToken": string, "deviceId": "<uuid>", "user": { "userId": string, "role": "USER" \| "ADMIN" } }`                                                                                |
| Frontend action | Persist `accessToken`/`refreshToken`, then redirect to the authenticated app. This is the **only** `auth:qr:*` event that ever carries tokens or `userId`. `deviceId` is the new session's id (same as the REST response's `sessionId`). |
| Retry behavior  | Fires exactly once (login is single-use server-side). If missed (socket disconnected at the wrong instant), there is no polling fallback by design — regenerate a new QR.                                                                |

### Server → Client: `auth:qr:expired`

|                 |                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| When emitted    | By the scheduler-driven expiry sweeper (`apps/auth-service/src/jobs/qr-link-expiry-sweeper.ts`), ticking every `QR_LINK_SWEEPER_INTERVAL_MS` (default 30 000 ms), for any session still `PENDING` whose `expiresAt` has passed |
| Payload         | `{ "linkToken": "<uuid>" }`                                                                                                                                                                                                    |
| Frontend action | Show "QR expired"; offer "Generate a new QR"                                                                                                                                                                                   |
| Retry behavior  | Fires exactly once per session. Up to ~30s latency between the logical 60s expiry and this event — a frontend with a visible countdown should independently start its own "expired" UI state at the 60s mark from `expiresAt`. |

### Server → Client: `auth:qr:failed`

Reserved for a scan attempt that fails for a reason other than expiry (e.g. a
transient error after the QR was already claimed). Not currently emitted by
any code path — `scan` failures surface as REST error responses to the
mobile caller instead, and the browser has nothing to act on until either
`auth:qr:success` or `auth:qr:expired` arrives. Included here so the FE can
wire a handler defensively without a future backend change requiring a
socket-contract update.

---

## Complete Payload Reference

### Timestamp formats

`expiresAt`, `createdAt`, `linkedAt` are **ISO-8601 strings**
(`new Date().toISOString()`), NOT epoch milliseconds. Parse with
`new Date(value)`.

### `InitiateDeviceLinkResult`

```ts
{
  linkToken: string;
  expiresAt: string; /* ISO-8601 */
}
```

### `LoginDeviceLinkResult` (POST .../devices/link/scan)

```ts
{
  linkedAt: string; /* ISO-8601 */
  sessionId: string; /* UUID */
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number; // seconds
  refreshTokenExpiresIn: number; // seconds
}
```

### `auth:qr:success` payload

```ts
{
  linkToken: string;
  accessToken: string;
  refreshToken: string;
  deviceId: string; // the new session's id
  user: {
    userId: string;
    role: "USER" | "ADMIN";
  }
}
```

---

## Error Handling

Every error response is `{ "success": false, "message": "<string>" }`.

| Scenario                          | HTTP status   | `message`                                                                                                     | Frontend behavior                                                                                                               |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Invalid/malformed request         | 400           | Zod validation text                                                                                           | Show a generic error; regenerate                                                                                                |
| Unknown `linkToken`               | 404           | "Device link session not found or has expired."                                                               | Treat identically to expired — offer "Generate a new QR"                                                                        |
| Expired QR                        | 404           | "This QR code has expired."                                                                                   | Show "expired", offer regenerate                                                                                                |
| Already scanned/used (single-use) | 409           | "This QR code has already been scanned."                                                                      | Should not happen from a correctly-implemented mobile flow (one scan per QR); if seen, the QR was already consumed — regenerate |
| Unauthorized                      | 401           | See [Authentication errors](#authentication-error-responses)                                                  | Redirect to login / refresh token                                                                                               |
| Rate limit exceeded               | 429           | "Too many QR login sessions requested..." (initiate) or "Too many QR scan attempts..." (scan) — not localized | Back off, show a "please wait" message                                                                                          |
| Network failure                   | (client-side) | n/a                                                                                                           | Socket.IO auto-reconnects — re-emit `auth:qr:subscribe` on reconnect                                                            |

---

## Authentication

### Public APIs (no token required)

- `POST /api/v1/auth/devices/link/initiate`
- Socket namespace `/auth` (entirely unauthenticated)

### Authenticated APIs

- `POST /api/v1/auth/devices/link/scan` — mobile's own Bearer token; `userId` is always derived from the JWT, never from the request body

### Authentication error responses

`authenticateAccessToken` returns **401** with `{ success:false, message: <localized text> }`:

| Cause                                    | Message key          | English text                                    |
| ---------------------------------------- | -------------------- | ----------------------------------------------- |
| Missing/malformed `Authorization` header | `AUTH_UNAUTHORIZED`  | "Authentication token is required."             |
| Invalid signature/shape                  | `AUTH_INVALID_TOKEN` | "Invalid authentication token."                 |
| Expired token                            | `AUTH_TOKEN_EXPIRED` | "Authentication token has expired."             |
| Token valid but session was revoked      | `AUTH_SESSION_ENDED` | "This session has ended. Please sign in again." |

### Token issuance and lifecycle (reused, not reinvented)

Tokens returned by `auth:qr:success` (and the `scan` REST response) are
produced by the **exact same** `issueAuthTokens()` function used by normal
email/social login:

- **Access token**: short-lived JWT, `accessTokenExpiresIn` seconds.
- **Refresh token**: longer-lived opaque token, `refreshTokenExpiresIn` seconds.
- **When tokens are returned**: exactly once, at the moment of the scan call.
- **Refreshing**: `POST /api/v1/auth/refresh` or `POST /api/v1/auth/token` — unchanged, unrelated to QR login.

---

## UI Flow

| State                   | Trigger                                               | UI                                                             |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| Loading                 | `POST /initiate` in flight                            | Spinner, no QR yet                                             |
| QR displayed / waiting  | `initiate` succeeded, socket subscribed               | Show QR, start a visible 60s countdown from `expiresAt`        |
| Logged in / success     | `auth:qr:success` received                            | Brief success animation, then redirect (tokens already stored) |
| Expired                 | `auth:qr:expired` received, or local countdown hits 0 | "QR expired" + "Generate a new QR" button                      |
| Error / network failure | fetch/socket error                                    | Generic retry banner                                           |

"Generate Again" always means: re-run `POST /initiate`, re-render the new
`linkToken` as a QR, and re-emit `auth:qr:subscribe` with the new token.

---

## Validation Rules

| Rule                                                                  | Enforced by                                      | Result on failure                      |
| --------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- |
| `linkToken` required (scan)                                           | Zod, `.min(1)`                                   | 400                                    |
| `deviceName`/`deviceType`/`os`/`appVersion`/`deviceLabel` ≤ 100 chars | Zod, `.max(100)`                                 | 400                                    |
| Session must exist                                                    | Redis lookup                                     | 404 `AUTH_DEVICE_LINK_NOT_FOUND`       |
| Session must not be expired                                           | `expiresAt` check, both at claim and at finalize | 404 `AUTH_DEVICE_LINK_EXPIRED`         |
| Session must be `PENDING` (single-use claim)                          | Atomic Redis state check                         | 409 `AUTH_DEVICE_LINK_ALREADY_SCANNED` |
| Rate limits (5/min/IP initiate, 10/min/user scan)                     | `express-rate-limit`                             | 429                                    |

---

## Response Structure

**Success**: `{ "success": true, "message": "<string>", "data": <object|null> }`
**Error**: `{ "success": false, "message": "<string>" }`

---

## Existing Reusable Features

QR Login **reuses** the following pre-existing platform infrastructure rather
than duplicating it:

| Feature                         | Reused from                                                                                                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT issuance (access + refresh) | `issueAuthTokens()` in `apps/auth-service/src/lib/token.ts` — same function used by password/social login                                                                                                                                             |
| Session / linked-device storage | The same `Session` + `RefreshToken` Prisma models every login writes to                                                                                                                                                                               |
| Linked devices list/revoke      | `GET/DELETE /api/v1/auth/sessions` (pre-existing endpoints; `/users/linked-devices` is a routing alias only) — see [`linked-devices.md`](./linked-devices.md)                                                                                         |
| Authentication middleware       | `authenticateAccessToken` — identical 401 behavior across the whole platform                                                                                                                                                                          |
| Rate limiting                   | `express-rate-limit`, same library/pattern as `sensitiveAuthRateLimiter` elsewhere in auth-service                                                                                                                                                    |
| Socket infrastructure           | Same Socket.IO server, Redis adapter, and per-namespace Redis pub/sub relay pattern as `/chat`, `/community`, `/notify`                                                                                                                               |
| Scheduler/cron                  | Same `setInterval` + Redis-lock + atomic-per-key-claim pattern as community-service's mute sweeper                                                                                                                                                    |
| Response envelope               | `ApiResponse` from `packages/utils`, used by every endpoint on the platform                                                                                                                                                                           |
| Error taxonomy                  | `NotFoundError`/`ConflictError`/`UnauthorizedError` from `packages/errors`, same status-code mapping platform-wide                                                                                                                                    |
| Audit logging                   | `AuthAuditLog` table (auth-service's own; write-only, no REST read endpoint) — events: `QR_CREATED`, `QR_LOGIN_ATTEMPT`, `QR_LOGIN_SUCCESS`, `QR_REUSED_ATTEMPT`, `QR_EXPIRED`, `BROWSER_LOGGED_IN`, `LINKED_DEVICE_CREATED`, `LINKED_DEVICE_REVOKED` |

---

## FE Implementation Checklist

- [ ] `POST /api/v1/auth/devices/link/initiate` to get `linkToken` + `expiresAt`
- [ ] Render QR client-side, encoding only `linkToken`
- [ ] Connect Socket.IO to `/auth` namespace
- [ ] Emit `auth:qr:subscribe` with `{ token: linkToken }`
- [ ] Listen for `auth:qr:success` → save tokens, redirect
- [ ] Listen for `auth:qr:expired` → show expired state
- [ ] Start a local 60-second countdown from `expiresAt` (don't rely solely on the sweeper's up-to-30s-delayed `auth:qr:expired`)
- [ ] "Generate again" re-runs `initiate` + re-subscribes the socket with the new token
- [ ] On socket reconnect, re-emit `auth:qr:subscribe` with the current token
- [ ] Handle all documented error responses (400/401/404/409/429)
- [ ] Persist `accessToken`/`refreshToken` per the platform's existing token-storage convention
- [ ] On the mobile scanning app: call `POST /devices/link/scan` immediately on scan — no preview/confirmation step, no separate approve call
- [ ] Implement `GET /api/v1/users/linked-devices` and `DELETE /api/v1/users/linked-devices/{sessionId}` — see [`linked-devices.md`](./linked-devices.md)

---

## Testing Checklist

- [ ] QR generated — `initiate` returns a UUID v4 `linkToken`, `expiresAt` ~60s out
- [ ] QR generation rate-limited — 6th `initiate` within 60s from the same IP returns 429
- [ ] Scan rate-limited — 11th `scan` within 60s from the same user returns 429
- [ ] Instant login — `scan` returns tokens + `sessionId` in one call; `auth:qr:success` arrives on the browser's socket with matching tokens
- [ ] New session appears in `GET /users/linked-devices` immediately after scan
- [ ] Used QR — a second `scan` call on the same token returns 409
- [ ] Expired QR — after 60s, `scan` returns 404 `AUTH_DEVICE_LINK_EXPIRED`; `auth:qr:expired` eventually arrives on the browser's socket (allow up to ~30s extra for the sweeper tick)
- [ ] Invalid QR — `scan` with an unknown `linkToken` returns 404
- [ ] Invalid JWT — `scan` without/with an invalid mobile access token returns 401
- [ ] Network failure — socket disconnect mid-flow, then reconnect + re-subscribe still receives `auth:qr:expired` for events emitted after reconnect
- [ ] Multiple browsers — two `initiate` calls produce two independent `linkToken`s; scanning one never affects the other
- [ ] Reload mid-flow — reloading the browser requires re-subscribing the socket (state is NOT persisted client-side); the QR itself is still valid server-side until its `expiresAt`
