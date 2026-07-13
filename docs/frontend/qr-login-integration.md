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
- `apps/auth-service/src/api/routes/session.routes.ts` (+ controller/service/repository)
- `apps/api-gateway/src/sockets/namespaces/auth.ns.ts`
- `apps/api-gateway/src/sockets/session-revoke.ts`
- `apps/api-gateway/src/routes/v1/linked-devices.routes.ts`

All REST paths below are given **relative to the API gateway**, i.e. prefixed
with `/api/v1`. The gateway mounts `/api` → `/v1` → each service segment
(`apps/api-gateway/src/app.ts` + `src/routes/api.routes.ts` +
`src/routes/v1/index.ts`). The `auth` segment proxies `/api/v1/auth/*` to
auth-service's own `/api/auth/*` mount (`apps/auth-service/src/app.ts:46-57`).

---

## QR Login Overview

QR Login lets an already-signed-in mobile/app user approve a login for an
unauthenticated web/desktop browser by scanning a QR code. There are two ways
the browser can learn the outcome:

1. **Socket-driven (recommended)** — the browser subscribes to a Socket.IO
   room for its QR token and receives `auth:qr:scanned` / `auth:qr:approved` /
   `auth:qr:rejected` / `auth:qr:expired` in real time. No polling.
2. **Polling (legacy, still supported)** — the browser polls
   `GET /api/v1/auth/devices/link/status` with its `linkToken` + `pollSecret`.
   See [Polling vs. socket flow](#polling-vs-socket-flow-important) for an
   important caveat about the `SCANNED` state under this path.

```
   Browser (unauth)              Gateway / auth-service           Mobile (signed in)
        │                                  │                              │
        │  POST /auth/devices/link/initiate│                              │
        ├─────────────────────────────────►│                              │
        │  201 { linkToken, pollSecret,    │                              │
        │        expiresAt }               │                              │
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
        │                                  │  200 { scannedAt, device }   │
        │                                  ├──────────────────────────────►
        │  ◄── auth:qr:scanned {linkToken, device} ──────────────────────┤
        │  (show "Confirm login from <device>?" on mobile UI)             │
        │                                  │  POST /auth/devices/link/approve
        │                                  │◄─────────────────────────────┤
        │                                  │  200 { linkedAt, sessionId } │
        │                                  ├──────────────────────────────►
        │  ◄── auth:qr:approved {linkToken, tokens, user} ────────────────┤
        │                                  │                              │
        │  Store tokens, redirect to app   │                              │
        │                                  │                              │
        │  (later) GET /users/linked-devices → new browser session appears│
```

---

## Complete Login Flow

Chronological, with the exact API/socket call at each step.

### 1. Opening the login screen (browser)

No API call yet. The browser should immediately connect to the `/auth` Socket.IO
namespace (see [Socket Events](#socket-events)) so it is ready to receive events
the instant a QR is generated.

### 2. Generating the QR

```
POST /api/v1/auth/devices/link/initiate
```

No authentication. Rate-limited to **5 requests/minute/IP**
(`qrGenerationRateLimiter`). Returns `linkToken` (a UUID v4), `pollSecret`, and
`expiresAt` (ISO-8601 string, 60 seconds from now). The browser must:

- Encode **only `linkToken`** into the QR image (client-side; the backend does
  not generate a QR image or a fixed URI scheme — see [payload reference](#initiatedevicelinkresult)).
- Keep `pollSecret` in memory only, never in the QR — it is what authorizes
  polling `GET /devices/link/status`; the socket flow does not use it at all.

### 3. Subscribing to the socket

```
Socket.IO namespace: /auth
emit: auth:qr:subscribe  { token: linkToken }
```

No acknowledgement is sent by the server for this event (see
[`auth:qr:subscribe`](#client--server-authqrsubscribe)). The browser is now in
Socket.IO room `qr:<linkToken>` and will receive every subsequent event for
this session.

### 4. Scanning the QR (mobile, already authenticated)

The mobile app decodes the QR, extracts `linkToken`, and (optionally) previews
the session first:

```
GET /api/v1/auth/devices/link/{linkToken}      (auth required)
```

then marks it scanned:

```
POST /api/v1/auth/devices/link/scan            (auth required)
Body: { linkToken }
```

This flips the session `PENDING → SCANNED` and records **which user** scanned
it — only that same user may subsequently approve or reject it. The gateway
publishes `auth:qr:scanned` to the browser's socket room.

### 5. Approval or rejection (mobile)

The mobile app shows a confirmation screen ("Log in to &lt;device&gt;?") and calls
either:

```
POST /api/v1/auth/devices/link/approve   Body: { linkToken, deviceLabel? }
```

or

```
POST /api/v1/auth/devices/link/reject    Body: { linkToken }
```

Approval issues a brand-new access/refresh token pair for the browser's
session (via the same `issueAuthTokens` used by ordinary login — see
[Existing Reusable Features](#existing-reusable-features)) and creates a new
`Session` row (a "linked device").

### 6. Receiving tokens (browser)

The browser receives `auth:qr:approved` on its socket, containing
`accessToken`, `refreshToken`, and their expiry values, plus the logged-in
`user.userId` / `user.role`. It never sees these over any other event.

### 7. Browser login

The browser stores the tokens (see [Authentication](#authentication)) and
navigates to the authenticated app — the socket connection to `/auth` can be
closed at this point.

### 8. Linked device creation

The new browser session is now a row returned by
`GET /api/v1/users/linked-devices` (alias of `GET /api/v1/auth/sessions`) —
no separate "linked device" API exists; it is the same `Session` table every
login writes to.

### 9. Logout device

Any signed-in device — including the browser itself — can revoke the browser's
session:

```
DELETE /api/v1/users/linked-devices/{deviceId}
```

(`deviceId` here is the `sessionId` value from the list response). This
revokes the refresh token and immediately force-disconnects any LIVE socket
tied to that session (see [Linked Devices](#linked-devices)).

---

## REST APIs

All responses use the project's standard envelope (see
[Response Structure](#response-structure)): `{ success, message, data }` on
every success, `{ success: false, message }` on every error (no `code`/`errors`
keys anywhere in this feature).

### `POST /api/v1/auth/devices/link/initiate`

**Purpose**: Create a new QR login session.
**Authentication**: None (public).
**Headers**: `x-lang` (optional, `en`/`vi` — drives the localized `message`
returned; does not affect `data`).
**Rate limit**: 5 requests/minute/IP (`qrGenerationRateLimiter`). On the 6th
request within the window, see [Rate Limiting](#rate-limiting).

**Request body** (all fields optional):
| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `deviceName` | string | optional, trimmed, max 100 chars | Free-text label for the NEW (browser/desktop) device, e.g. `"Chrome on Windows"`. Falls back to a server-derived value from the User-Agent if omitted. |
| `deviceType` | string | optional, trimmed, max 100 chars | Free-text device type. Falls back to a server-derived value. Later mapped internally to `IOS`/`ANDROID`/`DESKTOP`/`WEB` (anything unrecognized becomes `WEB`). |
| `os` | string | optional, trimmed, max 100 chars | OS name/version string. |
| `appVersion` | string | optional, trimmed, max 100 chars | Client app/browser version string. |

**Path params**: none. **Query params**: none.

**Success response — `201 Created`**:

```json
{
  "success": true,
  "message": "Device linking initiated. Please approve on your existing device.",
  "data": {
    "linkToken": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "pollSecret": "9f2b7c1e4a8d3f6b0c5e7a1d9f4b2c8e6a0d3f7b1c9e5a2d8f4b6c0e3a7d1f9b",
    "expiresAt": "2026-07-14T10:31:00.000Z"
  }
}
```

| Field        | Type                                                             | Meaning                                                                        |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `linkToken`  | string (UUID v4)                                                 | Encode this into the QR. Single-use.                                           |
| `pollSecret` | string (opaque, ~43-char base64url)                              | Only needed for the legacy polling endpoint. Never put in the QR.              |
| `expiresAt`  | string, ISO-8601 (not epoch ms — see [note](#timestamp-formats)) | Session expires 60 seconds after creation (`QR_LINK_TTL_SECONDS`, default 60). |

**Error responses**:
| Status | Body `message` | Cause |
|---|---|---|
| 400 | one of the Zod messages, e.g. `"..."` (only fires if a field exceeds 100 chars) | Validation failure |
| 429 | `"Too many QR login sessions requested, please try again later."` | Rate limit exceeded — **not localized**, always this exact English string regardless of `x-lang` |

---

### `GET /api/v1/auth/devices/link/status`

**Purpose**: Legacy polling endpoint for the initiating browser to check/collect
its login result. **Prefer the socket flow** — see the
[polling caveat](#polling-vs-socket-flow-important).
**Authentication**: None (public — protected instead by knowledge of both
`linkToken` and `pollSecret`).
**Headers**: `x-lang` optional.

**Query params** (both required):
| Field | Type | Constraints |
|---|---|---|
| `linkToken` | string | non-empty (`.min(1)`) |
| `pollSecret` | string | non-empty (`.min(1)`) |

**Success response — `200 OK`** (message key `AUTH_DEVICE_LINK_STATUS` = "Device link status retrieved."):

```json
{
  "success": true,
  "message": "Device link status retrieved.",
  "data": {
    "state": "PENDING",
    "approvedDeviceLabel": null,
    "tokens": null
  }
}
```

| Field                 | Type                                             | Meaning                                                                                                                                      |
| --------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`               | `"PENDING" \| "APPROVED" \| "USED" \| "EXPIRED"` | See [state table](#devicelinkstatusresult) below — **`SCANNED`/`REJECTED` are never returned here**, they collapse to `"USED"` (see caveat). |
| `approvedDeviceLabel` | string \| null                                   | The `deviceLabel` the approver supplied (if any).                                                                                            |
| `tokens`              | object \| null                                   | Present **exactly once** — only on the poll immediately after approval. `null` on every other call.                                          |

**`tokens` object shape** (only when `state === "APPROVED"` and not yet
collected):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "9f2b7c1e4a8d...",
  "accessTokenExpiresIn": 3600,
  "refreshTokenExpiresIn": 604800
}
```

**Validation failure — `400`**: `linkToken` or `pollSecret` missing/empty.

**No 404 ever** — an unknown `linkToken` or a wrong `pollSecret` both return
`200` with `{ state: "EXPIRED", tokens: null }` deliberately (no enumeration
leak between "never existed" and "guessed a token").

---

### `GET /api/v1/auth/devices/link/{linkToken}`

**Purpose**: Let any authenticated user preview a pending QR's device info
before deciding to scan/approve/reject it.
**Authentication**: Required — `Authorization: Bearer <accessToken>`.
**Headers**: `x-lang` optional.

**Path params**:
| Field | Type | Constraints |
|---|---|---|
| `linkToken` | string | non-empty |

**Success response — `200 OK`** (message key `AUTH_DEVICE_LINK_STATUS`):

```json
{
  "success": true,
  "message": "Device link status retrieved.",
  "data": {
    "state": "PENDING",
    "device": {
      "deviceName": "Chrome on Windows",
      "deviceType": "WEB",
      "os": null,
      "appVersion": null
    },
    "createdAt": "2026-07-14T10:30:00.000Z",
    "expiresAt": "2026-07-14T10:31:00.000Z"
  }
}
```

`state` here reflects the ACTUAL current state
(`PENDING`/`SCANNED`/`APPROVED`/`REJECTED`/`USED`) — unlike the polling
endpoint above, this one does not collapse `SCANNED` into `USED`.

**Error responses**:
| Status | Message key | Cause |
|---|---|---|
| 401 | (see [Authentication errors](#authentication-error-responses)) | Missing/invalid/expired token |
| 404 | `AUTH_DEVICE_LINK_NOT_FOUND` — "Device link session not found or has expired." | `linkToken` doesn't exist (includes naturally TTL-expired keys) |

---

### `POST /api/v1/auth/devices/link/scan`

**Purpose**: The already-signed-in device marks the QR as scanned
(`PENDING → SCANNED`), recording who scanned it.
**Authentication**: Required.
**Rate limit**: 10 requests/minute/user (`qrScanRateLimiter`, keyed by
`req.auth.userId`).

**Request body**:
| Field | Type | Constraints |
|---|---|---|
| `linkToken` | string | non-empty |

**Success response — `200 OK`** (message key `AUTH_DEVICE_LINK_SCANNED` —
"QR code scanned. Approve or reject the login on this device."):

```json
{
  "success": true,
  "message": "QR code scanned. Approve or reject the login on this device.",
  "data": {
    "scannedAt": "2026-07-14T10:30:15.000Z",
    "device": {
      "deviceName": "Chrome on Windows",
      "deviceType": "WEB",
      "os": null,
      "appVersion": null
    }
  }
}
```

**Error responses**:
| Status | Message key | Cause |
|---|---|---|
| 400 | Zod message | Missing `linkToken` |
| 401 | — | Not authenticated |
| 404 | `AUTH_DEVICE_LINK_NOT_FOUND` | `linkToken` unknown |
| 404 | `AUTH_DEVICE_LINK_EXPIRED` — "This QR code has expired." | Past its `expiresAt` |
| 409 | `AUTH_DEVICE_LINK_ALREADY_SCANNED` — "This QR code has already been scanned." | State is not `PENDING` |
| 429 | `"Too many QR scan attempts, please try again later."` | Rate limit — **not localized** |

---

### `POST /api/v1/auth/devices/link/approve`

**Purpose**: The user who scanned the QR approves the login. Issues fresh
tokens for the browser and creates its `Session` (linked device).
**Authentication**: Required. **Must be the SAME user who called `/scan`.**

**Request body**:
| Field | Type | Constraints |
|---|---|---|
| `linkToken` | string | non-empty |
| `deviceLabel` | string | optional, trimmed, max 100 chars — a friendly label for this new device, e.g. `"Office iPad"`. Note: despite the name, this labels the NEW (browser) device being approved, not the approver's own device. |

**Success response — `200 OK`** (message key `AUTH_DEVICE_LINK_APPROVED` —
"Device linked successfully."):

```json
{
  "success": true,
  "message": "Device linked successfully.",
  "data": {
    "linkedAt": "2026-07-14T10:30:20.000Z",
    "sessionId": "b2c3d4e5-f6a7-8901-bcde-f12345678901"
  }
}
```

| Field       | Meaning                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | The new browser session's id. This is the same value that later appears as `sessionId` in `GET /users/linked-devices`, and is what you pass to `DELETE /users/linked-devices/{sessionId}` to instantly undo the link. |

**Error responses**:
| Status | Message key | Cause |
|---|---|---|
| 400 | Zod message | Missing `linkToken`, or `deviceLabel` &gt; 100 chars |
| 401 | — | Not authenticated |
| 403 | `AUTH_DEVICE_LINK_WRONG_USER` — "Only the user who scanned this QR code can approve or reject it." | A different user than the one who scanned tries to approve |
| 404 | `AUTH_DEVICE_LINK_NOT_FOUND` | `linkToken` unknown |
| 404 | `AUTH_DEVICE_LINK_EXPIRED` | Expired between scan and approve |
| 409 | `AUTH_DEVICE_LINK_NOT_SCANNED` — "This QR code must be scanned before it can be approved or rejected." | `/scan` was never called |
| 409 | `AUTH_DEVICE_LINK_ALREADY_APPROVED` — "This device link session has already been approved." | Already approved/rejected/used |

---

### `POST /api/v1/auth/devices/link/reject`

**Purpose**: The scanning user declines the login.
**Authentication**: Required. Must be the same user who scanned.

**Request body**:
| Field | Type | Constraints |
|---|---|---|
| `linkToken` | string | non-empty |

**Success response — `200 OK`** (message key `AUTH_DEVICE_LINK_REJECTED` —
"Device link request rejected."):

```json
{
  "success": true,
  "message": "Device link request rejected.",
  "data": { "rejectedAt": "2026-07-14T10:30:20.000Z" }
}
```

**Error responses**: identical status/message-key set as `approve` above
(`400`, `401`, `403 AUTH_DEVICE_LINK_WRONG_USER`, `404 AUTH_DEVICE_LINK_NOT_FOUND`,
`404 AUTH_DEVICE_LINK_EXPIRED`, `409 AUTH_DEVICE_LINK_NOT_SCANNED`,
`409 AUTH_DEVICE_LINK_ALREADY_APPROVED`).

---

### `GET /api/v1/users/linked-devices`

**Purpose**: List every active linked device/session for the current user.
**Authentication**: Required.
**Implementation note**: this is a thin gateway-level forwarding alias to
auth-service's `GET /api/auth/sessions` — see
[Existing Reusable Features](#existing-reusable-features). No new logic; the
response is relayed verbatim.

**Success response — `200 OK`** (message key `AUTH_SESSIONS_LISTED` — "Active
sessions retrieved successfully."):

```json
{
  "success": true,
  "message": "Active sessions retrieved successfully.",
  "data": {
    "sessions": [
      {
        "sessionId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        "deviceId": "b6b6a1e2c3d4e5f6",
        "deviceName": "Chrome on Windows",
        "deviceType": "WEB",
        "osVersion": null,
        "appVersion": null,
        "ipAddress": null,
        "countryCode": null,
        "lastActiveAt": "2026-07-14T10:30:20.000Z",
        "createdAt": "2026-07-14T10:30:20.000Z",
        "isCurrent": false
      }
    ]
  }
}
```

See [field reference](#activesessionitem) below.

**Error responses**: `401` if unauthenticated; `503` (`{success:false,
message:"Auth service temporarily unavailable. Please try again later."}`,
not localized) if the gateway can't reach auth-service.

---

### `DELETE /api/v1/users/linked-devices/{deviceId}`

**Purpose**: Revoke ("log out") one linked device.
**Authentication**: Required. Any of the user's own active sessions may be
targeted, **including the caller's own current session** (i.e. this also
serves as "log out this device").
**Path params**: `deviceId` — this IS the `sessionId` value from the list
response above (the alias forwards it straight through as the URL segment).

**Behavior on success**:

- Revokes the refresh token (`RefreshToken.revokedAt` set) — subsequent
  `POST /api/v1/auth/refresh` (existing endpoint) calls with that token fail.
- Marks the session revoked in the fast-path Redis cache used by
  `authenticateAccessToken`, so **already-issued but not-yet-expired access
  tokens for that session are rejected on their very next REST call** (401
  `AUTH_SESSION_ENDED`).
- Publishes a `session-revoke:<userId>` Redis event that the gateway relays
  to force-disconnect any LIVE Socket.IO connection (in `/chat`, `/community`,
  `/notify`, or `/stream`) whose `sessionId` matches — see
  [Socket disconnect on revoke](#socket-disconnect-on-revoke).
- Clears the device's FCM push token (existing behavior, via RabbitMQ
  `session.queue` → notifications-service).

**Success response — `200 OK`** (message key `AUTH_SESSION_REVOKED` — "Device
signed out successfully."):

```json
{ "success": true, "message": "Device signed out successfully.", "data": null }
```

**Error responses**:
| Status | Cause |
|---|---|
| 401 | Not authenticated |
| 404 | `AUTH_SESSION_NOT_FOUND` — "Session not found or already ended." — target session doesn't belong to caller, or was already revoked (IDOR-safe: same 404 for both cases) |
| 503 | Gateway → auth-service hop failed |

Note: this endpoint is a **direct forward** of `deviceId` into auth-service's
own `DELETE /api/auth/sessions/:sessionId` route, which validates it as
a UUID (`sessionIdParamsSchema`). A non-UUID `deviceId` therefore surfaces as
whatever auth-service's own validation returns for that route (400).

---

## Socket Events

**Namespace**: `/auth` (connect with Socket.IO client to
`<gateway-origin>/auth`, `path: "/socket.io/"`). **No authentication** on this
namespace — it carries no JWT and no privileged data flows through the join
itself.

### Client → Server: `auth:qr:subscribe`

|                 |                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction       | Browser → Server                                                                                                                                                                                                                             |
| Namespace       | `/auth`                                                                                                                                                                                                                                      |
| When to emit    | Immediately after receiving `linkToken` from `POST /devices/link/initiate` (and again if the browser regenerates a new QR after expiry)                                                                                                      |
| Payload         | `{ "token": "<linkToken>" }`                                                                                                                                                                                                                 |
| Field           | `token`: string, required, 1–200 chars                                                                                                                                                                                                       |
| Server behavior | Joins Socket.IO room `qr:<linkToken>`. If the socket had previously subscribed to a different token, it first leaves that old room. A malformed payload (missing/empty/too-long `token`) is **silently ignored** — no error is emitted back. |
| Acknowledgement | **None.** This event does not use a callback/ack.                                                                                                                                                                                            |
| Retry           | Not applicable — re-emitting with a new token safely replaces the old subscription.                                                                                                                                                          |

### Server → Client: `auth:qr:scanned`

|                 |                                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction       | Server → Browser                                                                                                                                                                                                                                                                               |
| Namespace       | `/auth`, room `qr:<linkToken>`                                                                                                                                                                                                                                                                 |
| When emitted    | Right after `POST /devices/link/scan` succeeds                                                                                                                                                                                                                                                 |
| Payload         | `{ "linkToken": "<uuid>", "device": { "deviceName": string\|null, "deviceType": string\|null, "os": string\|null, "appVersion": string\|null } }`                                                                                                                                              |
| Frontend action | Show "Confirm login from &lt;device&gt;" state; keep waiting for `auth:qr:approved`/`auth:qr:rejected`                                                                                                                                                                                         |
| Retry behavior  | None built in — if the socket disconnects and reconnects, re-emit `auth:qr:subscribe` with the same `linkToken`; if the QR is already past `SCANNED`, fall back to `GET /devices/link/{linkToken}` to read current state (see [pending-details endpoint](#get-apiv1authdeviceslinklinktoken)). |

### Server → Client: `auth:qr:approved`

|                 |                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction       | Server → Browser                                                                                                                                                                                                                                                                                                                                     |
| Namespace       | `/auth`, room `qr:<linkToken>`                                                                                                                                                                                                                                                                                                                       |
| When emitted    | Right after `POST /devices/link/approve` succeeds                                                                                                                                                                                                                                                                                                    |
| Payload         | `{ "linkToken": "<uuid>", "tokens": { "accessToken": string, "refreshToken": string, "accessTokenExpiresIn": number, "refreshTokenExpiresIn": number }, "user": { "userId": string, "role": "USER" \| "ADMIN" } }`                                                                                                                                   |
| Frontend action | Persist `tokens` (see [Authentication](#authentication)), then redirect to the authenticated app. This is the **only** `auth:qr:*` event that carries tokens or `userId` — never rely on any other event for credentials.                                                                                                                            |
| Retry behavior  | None — this fires exactly once (approve is single-use server-side). If missed (socket disconnected at the wrong instant), the browser has no way to re-fetch tokens via socket; it must fall back to the polling endpoint (`GET /devices/link/status` with the original `pollSecret`) to collect them, since `POST /approve` cannot be called twice. |

### Server → Client: `auth:qr:rejected`

|                 |                                                                                  |
| --------------- | -------------------------------------------------------------------------------- |
| Direction       | Server → Browser                                                                 |
| Namespace       | `/auth`, room `qr:<linkToken>`                                                   |
| When emitted    | Right after `POST /devices/link/reject` succeeds                                 |
| Payload         | `{ "linkToken": "<uuid>" }`                                                      |
| Frontend action | Show "Login rejected" state; offer "Generate a new QR" (re-run `POST /initiate`) |
| Retry behavior  | None applicable — terminal state.                                                |

### Server → Client: `auth:qr:expired`

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction       | Server → Browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Namespace       | `/auth`, room `qr:<linkToken>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| When emitted    | By the scheduler-driven expiry sweeper (`apps/auth-service/src/jobs/qr-link-expiry-sweeper.ts`), which ticks every `QR_LINK_SWEEPER_INTERVAL_MS` (default **30 000 ms**), for any session still `PENDING` or `SCANNED` whose `expiresAt` has passed                                                                                                                                                                                                                                           |
| Payload         | `{ "linkToken": "<uuid>" }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Frontend action | Show "QR expired" state; offer "Generate a new QR"                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Retry behavior  | The sweeper guarantees this fires **exactly once** per session (atomic claim across replicas), but because it's a 30-second sweep interval, there can be up to ~30s of latency between the logical 60s expiry and this event arriving. A frontend with a visible countdown should independently start its own "expired" UI state at the 60s mark (from `expiresAt` in the initiate response) rather than waiting on this event alone, and treat this event as the authoritative confirmation. |

### Polling vs. socket flow (important)

The legacy `GET /devices/link/status` endpoint was built before the
`SCANNED`/`REJECTED` states existed. Its state machine only distinguishes
`PENDING` / `APPROVED` / anything-else-→`USED`. **While a QR is `SCANNED` but
not yet approved/rejected, polling `GET /devices/link/status` returns
`"state": "USED"` — not `"SCANNED"`.** Only the socket event
(`auth:qr:scanned`) or the authenticated
`GET /devices/link/{linkToken}` endpoint correctly reports `"SCANNED"`. If you
must support polling-only clients, be aware a `"USED"` response can mean
either "actually consumed" or "currently scanned, awaiting approval" — prefer
the socket flow to avoid this ambiguity entirely.

### Socket disconnect on revoke

Separate from the QR-login flow itself: when any linked device is revoked
(`DELETE /users/linked-devices/{deviceId}`), the gateway also force-disconnects
that session's live socket in `/chat`, `/community`, `/notify`, and `/stream`
(via a `session-revoke:<userId>` Redis pub/sub event, matched against each
socket's `sessionId`). There is no client-visible event name for this — the
socket simply receives Socket.IO's native `disconnect` event. This does **not**
apply to the `/auth` namespace (which never authenticates a session in the
first place).

---

## Complete Payload Reference

### Timestamp formats

**Two different timestamp formats exist in this feature — read carefully:**

- `expiresAt`, `createdAt`, `scannedAt`, `linkedAt`, `rejectedAt` on every
  device-link endpoint, and `createdAt`/`lastActiveAt` on the sessions/linked-devices
  endpoints, are **ISO-8601 strings** (e.g. `"2026-07-14T10:30:00.000Z"`), NOT
  epoch milliseconds. This is what the actual service code returns
  (`new Date().toISOString()` throughout `device-link.service.ts` and
  `session.service.ts`).
- The project's shared `ApiResponse` wrapper (`packages/utils`) DOES convert
  any raw `Date` object found in `data` to epoch milliseconds automatically —
  but every timestamp in this feature is already serialized to a string
  before reaching `ApiResponse`, so that conversion never triggers here.

**Frontend implication**: parse these fields with `new Date(value)`, not
`new Date(value)` assuming a number. Do not treat them as epoch ms.

### `InitiateDeviceLinkResult`

```ts
{
  linkToken: string;
  pollSecret: string;
  expiresAt: string; /* ISO-8601 */
}
```

### `DeviceLinkPendingDetails` (GET .../devices/link/{linkToken})

```ts
{
  state: "PENDING" | "SCANNED" | "APPROVED" | "REJECTED" | "USED";
  device: {
    deviceName: string | null;
    deviceType: string | null; // free text as submitted at initiate, NOT the internal WEB/IOS/ANDROID/DESKTOP enum
    os: string | null;
    appVersion: string | null;
  }
  createdAt: string; // ISO-8601
  expiresAt: string; // ISO-8601
}
```

### `ScanDeviceLinkResult`

```ts
{
  scannedAt: string /* ISO-8601 */;
  device: DeviceLinkDeviceInfo;
}
```

### `RejectDeviceLinkResult`

```ts
{
  rejectedAt: string; /* ISO-8601 */
}
```

### `ApproveDeviceLinkResult`

```ts
{
  linkedAt: string /* ISO-8601 */;
  sessionId: string; /* UUID */
}
```

### `DeviceLinkStatusResult` (GET .../devices/link/status)

```ts
{
  state: "PENDING" | "APPROVED" | "USED" | "EXPIRED"; // never SCANNED/REJECTED — see caveat above
  approvedDeviceLabel: string | null;
  tokens: AuthTokens | null; // present exactly once
}
```

### `AuthTokens`

```ts
{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number; // seconds, e.g. 3600
  refreshTokenExpiresIn: number; // seconds, e.g. 604800
}
```

### `ActiveSessionItem` (one row in GET /users/linked-devices)

| Field          | Type                                       | Nullable | Meaning                                                                                                                                    |
| -------------- | ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessionId`    | string (UUID)                              | no       | Use this as `deviceId` in the revoke DELETE call                                                                                           |
| `deviceId`     | string                                     | no       | Client-generated stable device identifier (not the same as `sessionId`)                                                                    |
| `deviceName`   | string                                     | **yes**  | e.g. `"Chrome on Windows"`                                                                                                                 |
| `deviceType`   | `"IOS" \| "ANDROID" \| "WEB" \| "DESKTOP"` | no       | Internal enum (unlike the free-text `deviceType` in device-link payloads above)                                                            |
| `osVersion`    | string                                     | **yes**  |                                                                                                                                            |
| `appVersion`   | string                                     | **yes**  |                                                                                                                                            |
| `ipAddress`    | string                                     | **yes**  | Not currently populated for QR-approved sessions (`null` — the approve flow passes `ipAddress: null` for the synthetic new-device context) |
| `countryCode`  | string                                     | **yes**  | GeoIP; not currently populated for QR-approved sessions either                                                                             |
| `lastActiveAt` | string (ISO-8601)                          | no       |                                                                                                                                            |
| `createdAt`    | string (ISO-8601)                          | no       |                                                                                                                                            |
| `isCurrent`    | boolean                                    | no       | `true` only for the session tied to the access token making THIS request                                                                   |

### `RevokeSessionsResult` (POST /sessions/revoke-all — existing, unrelated to QR but shares the same session model)

```ts
{
  revokedCount: number;
}
```

### Enum values reference

- Device-link `state`: `PENDING` | `SCANNED` | `APPROVED` | `REJECTED` | `USED`
  (the last was renamed from the old `CONSUMED` — some very old in-flight
  records created before the rename may still momentarily normalize from
  `CONSUMED`, but the API always reports `USED`).
- Session/linked-device `deviceType`: `IOS` | `ANDROID` | `WEB` | `DESKTOP`.
- `user.role` (in `auth:qr:approved`): `USER` | `ADMIN`.

---

## Error Handling

Every error response in this feature is `{ "success": false, "message": "<string>" }`
— no `code`, `errors`, or `data` field.

| Scenario                                                                          | HTTP status                                                                                                                       | `message`                                                                                                                                                                        | Why                                                                 | Frontend behavior                                                                                                           |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Invalid/malformed QR data                                                         | 400                                                                                                                               | Zod validation text (e.g. missing `linkToken`)                                                                                                                                   | Client sent a malformed body/query                                  | Show a generic "invalid QR" error; regenerate                                                                               |
| Unknown `linkToken`                                                               | 404                                                                                                                               | "Device link session not found or has expired."                                                                                                                                  | Never existed, or Redis TTL already garbage-collected it            | Treat identically to expired — offer "Generate a new QR"                                                                    |
| Expired QR                                                                        | 404                                                                                                                               | "This QR code has expired." (`scan`/`approve`/`reject`) or, on the polling endpoint, `200` with `state:"EXPIRED"`                                                                | Past `expiresAt`                                                    | Show "expired", offer regenerate                                                                                            |
| Already scanned                                                                   | 409                                                                                                                               | "This QR code has already been scanned."                                                                                                                                         | A second scan attempt on an already-`SCANNED` QR                    | No-op / show current pending-approval state                                                                                 |
| Not yet scanned                                                                   | 409                                                                                                                               | "This QR code must be scanned before it can be approved or rejected."                                                                                                            | `approve`/`reject` called before `scan`                             | Should not happen if FE always scans first; if seen, re-scan                                                                |
| Already approved                                                                  | 409                                                                                                                               | "This device link session has already been approved."                                                                                                                            | Approve/reject called twice, or on a rejected/used session          | Refresh state via `GET .../devices/link/{linkToken}`                                                                        |
| Wrong approving user                                                              | 403                                                                                                                               | "Only the user who scanned this QR code can approve or reject it."                                                                                                               | A different signed-in user than the scanner tries to approve/reject | Should not be reachable from a correctly-implemented single-device mobile flow; if seen, show a permission error            |
| Unauthorized (missing/invalid/expired token)                                      | 401                                                                                                                               | See [Authentication errors](#authentication-error-responses)                                                                                                                     | Missing/expired/invalid access token, or session revoked            | Redirect to login / refresh token                                                                                           |
| Rate limit exceeded                                                               | 429                                                                                                                               | "Too many QR login sessions requested, please try again later." (initiate) or "Too many QR scan attempts, please try again later." (scan) — **hardcoded English, not localized** | More than 5 initiate/min/IP or 10 scan/min/user                     | Back off, show a "please wait" message                                                                                      |
| Validation error                                                                  | 400                                                                                                                               | The specific Zod message (e.g. `"Link token is required"`)                                                                                                                       | Missing/empty/oversized field                                       | Surface the message directly (already human-readable)                                                                       |
| Network failure                                                                   | (client-side)                                                                                                                     | n/a                                                                                                                                                                              | Fetch/socket connection failure                                     | Standard offline handling; for the socket, Socket.IO auto-reconnects — re-emit `auth:qr:subscribe` on `connect`/`reconnect` |
| Session revoked mid-flight (browser already logged in, another device revokes it) | 401 on next REST call, or the socket is disconnected immediately if a `/chat`/`/community`/`/notify`/`/stream` connection is open | `AUTH_SESSION_ENDED` — "This session has ended. Please sign in again."                                                                                                           | Someone called `DELETE /users/linked-devices/{thisSessionId}`       | Force logout, redirect to login                                                                                             |

---

## Authentication

### Public APIs (no token required)

- `POST /api/v1/auth/devices/link/initiate`
- `GET /api/v1/auth/devices/link/status`
- Socket namespace `/auth` (entirely unauthenticated)

### Authenticated APIs (`Authorization: Bearer <accessToken>` required)

- `GET /api/v1/auth/devices/link/{linkToken}`
- `POST /api/v1/auth/devices/link/scan`
- `POST /api/v1/auth/devices/link/approve`
- `POST /api/v1/auth/devices/link/reject`
- `GET /api/v1/users/linked-devices`
- `DELETE /api/v1/users/linked-devices/{deviceId}`

### Authentication error responses

`authenticateAccessToken` (shared middleware, reused unchanged from the rest
of the platform) returns **401** in every case below, with
`{ success:false, message: <localized text> }`:

| Cause                                    | Message key          | English text                                    |
| ---------------------------------------- | -------------------- | ----------------------------------------------- |
| Missing/malformed `Authorization` header | `AUTH_UNAUTHORIZED`  | "Authentication token is required."             |
| Invalid signature/shape                  | `AUTH_INVALID_TOKEN` | "Invalid authentication token."                 |
| Expired token                            | `AUTH_TOKEN_EXPIRED` | "Authentication token has expired."             |
| Token valid but session was revoked      | `AUTH_SESSION_ENDED` | "This session has ended. Please sign in again." |

### Token issuance and lifecycle (reused, not reinvented)

Tokens returned by `auth:qr:approved` (and by the polling endpoint's one-time
`tokens` field) are produced by the **exact same** `issueAuthTokens()` function
used by normal email/social login — see
[Existing Reusable Features](#existing-reusable-features). This means:

- **Access token**: short-lived JWT (`accessTokenExpiresIn` seconds, driven by
  `JWT_ACCESS_EXPIRES_IN`). Send as `Authorization: Bearer <accessToken>` on
  every authenticated request.
- **Refresh token**: longer-lived opaque token (`refreshTokenExpiresIn`
  seconds, driven by `JWT_REFRESH_EXPIRES_IN`). Store it securely
  (httpOnly cookie or secure storage — same guidance as the rest of the app;
  this feature does not change that contract).
- **When tokens are returned**: exactly once, at the moment of approval — via
  `auth:qr:approved` (socket) or the one poll immediately after approval
  (`GET /devices/link/status`). Never re-issued by any other device-link
  endpoint.
- **Refreshing**: use the platform's existing, unrelated-to-QR-login refresh
  endpoints (`POST /api/v1/auth/refresh` to rotate both tokens, or
  `POST /api/v1/auth/token` to mint just a new access token — both outside
  this feature's scope, unchanged).

---

## Linked Devices

There is no separate "linked device" entity — a linked device **is** a
`Session` row, the same one created by every login method (password, social,
or QR). `GET /api/v1/users/linked-devices` is a thin alias over the existing
`GET /api/v1/auth/sessions`.

| Field              | Where it comes from                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current device     | `isCurrent: true` — the row whose `sessionId` matches the access token used for the request                                                                                  |
| Last active        | `lastActiveAt` — updated on token refresh/session activity (existing session mechanism, unrelated to QR login)                                                               |
| Browser / Platform | `deviceName` / `deviceType` — for QR-approved devices, this is whatever the browser supplied to `POST /initiate` (or a server-derived fallback from its User-Agent)          |
| Location           | `countryCode` (GeoIP) — **not currently populated** for QR-approved sessions (`null`); the QR approval flow passes `ipAddress: null` for the new synthetic session context   |
| Session management | `DELETE /api/v1/users/linked-devices/{sessionId}` (revoke one), or the pre-existing `POST /api/v1/auth/sessions/revoke-all` (revoke all except the caller's current session) |

Revoking a device:

1. Sets `RefreshToken.revokedAt` (refresh calls fail from then on).
2. Marks the session revoked in the Redis session-active cache (next REST
   call with that session's access token gets `401 AUTH_SESSION_ENDED`).
3. Force-disconnects any live socket for that session (`/chat`, `/community`,
   `/notify`, `/stream`) — see [Socket disconnect on revoke](#socket-disconnect-on-revoke).
4. Clears the device's FCM push token.

---

## UI Flow

Recommended states and transitions for the browser-side QR screen:

| State                       | Trigger                                               | UI                                                                               |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Loading**                 | `POST /initiate` in flight                            | Spinner, no QR yet                                                               |
| **QR displayed / waiting**  | `initiate` succeeded, socket subscribed               | Show QR, start a visible 60s countdown from `expiresAt`                          |
| **Scanned**                 | `auth:qr:scanned` received                            | "Scanned on &lt;device&gt; — waiting for confirmation"                           |
| **Approved / success**      | `auth:qr:approved` received                           | Brief success animation, then redirect (tokens already stored)                   |
| **Rejected**                | `auth:qr:rejected` received                           | "Login rejected" + "Generate a new QR" button                                    |
| **Expired**                 | `auth:qr:expired` received, or local countdown hits 0 | "QR expired" + "Generate a new QR" button                                        |
| **Error / network failure** | fetch/socket error                                    | Generic retry banner; do not silently regenerate — let the user retry explicitly |

"Generate Again" always means: re-run `POST /initiate`, re-render the new
`linkToken` as a QR, and re-emit `auth:qr:subscribe` with the new token (the
old subscription can simply be replaced — the namespace handles leaving the
old room automatically).

---

## Validation Rules

| Rule                                                                  | Enforced by                                         | Result on failure                       |
| --------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| `linkToken` required (scan/approve/reject/status/pending-details)     | Zod, `.min(1)`                                      | 400                                     |
| `deviceName`/`deviceType`/`os`/`appVersion`/`deviceLabel` ≤ 100 chars | Zod, `.max(100)`                                    | 400                                     |
| `pollSecret` required (status endpoint)                               | Zod, `.min(1)`                                      | 400                                     |
| Session must exist                                                    | Redis lookup                                        | 404 `AUTH_DEVICE_LINK_NOT_FOUND`        |
| Session must not be expired                                           | `expiresAt` check inside the atomic Redis operation | 404 `AUTH_DEVICE_LINK_EXPIRED`          |
| Session must be `SCANNED` before approve/reject                       | Atomic state check                                  | 409 `AUTH_DEVICE_LINK_NOT_SCANNED`      |
| Session must not already be scanned (for `/scan`)                     | Atomic state check                                  | 409 `AUTH_DEVICE_LINK_ALREADY_SCANNED`  |
| Session must not already be approved/rejected/used                    | Atomic state check                                  | 409 `AUTH_DEVICE_LINK_ALREADY_APPROVED` |
| Approving/rejecting user must equal the scanning user                 | Atomic state check (`scannedByUserId`)              | 403 `AUTH_DEVICE_LINK_WRONG_USER`       |
| `sessionId` (linked-device revoke) must be a UUID                     | Zod `.uuid()` on the underlying auth-service route  | 400                                     |
| Rate limits (5/min/IP initiate, 10/min/user scan)                     | `express-rate-limit`                                | 429                                     |

---

## Response Structure

Every endpoint in this feature uses the project's shared `ApiResponse`
envelope, confirmed field-by-field against `packages/utils`:

**Success**: `{ "success": true, "message": "<string>", "data": <object|null> }`
**Error**: `{ "success": false, "message": "<string>" }`

No endpoint in this feature deviates from this structure — including the
`/api/v1/users/linked-devices` gateway alias, which relays auth-service's
response body verbatim (byte-for-byte), and the rate-limiter 429 responses,
which manually construct the same two-key error shape (though their `message`
is not run through the localization/`t()` pipeline — see
[Error Handling](#error-handling)).

---

## Existing Reusable Features

QR Login **reuses** the following pre-existing platform infrastructure rather
than duplicating it — do not expect separate, QR-specific versions of any of
these:

| Feature                         | Reused from                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT issuance (access + refresh) | `issueAuthTokens()` in `apps/auth-service/src/lib/token.ts` — same function used by password/social login                                                                                                                                                                                       |
| Session / linked-device storage | The same `Session` + `RefreshToken` Prisma models every login writes to                                                                                                                                                                                                                         |
| Linked devices list/revoke      | `GET/DELETE /api/v1/auth/sessions` (pre-existing endpoints; `/users/linked-devices` is a routing alias only)                                                                                                                                                                                    |
| Authentication middleware       | `authenticateAccessToken` — identical 401 behavior across the whole platform                                                                                                                                                                                                                    |
| Rate limiting                   | `express-rate-limit`, same library/pattern as `sensitiveAuthRateLimiter` elsewhere in auth-service                                                                                                                                                                                              |
| Socket infrastructure           | Same Socket.IO server, Redis adapter, and per-namespace Redis pub/sub relay pattern as `/chat`, `/community`, `/notify`                                                                                                                                                                         |
| Scheduler/cron                  | Same `setInterval` + Redis-lock + atomic-per-key-claim pattern as community-service's mute sweeper                                                                                                                                                                                              |
| Redis                           | Shared `ioredis` client/config already used platform-wide                                                                                                                                                                                                                                       |
| Response envelope               | `ApiResponse` from `packages/utils`, used by every endpoint on the platform                                                                                                                                                                                                                     |
| Error taxonomy                  | `NotFoundError`/`ConflictError`/`ForbiddenError`/`UnauthorizedError` from `packages/errors`, same status-code mapping platform-wide                                                                                                                                                             |
| Audit logging                   | A new `AuthAuditLog` table exists specifically because backoffice's `AuditLog` is admin-only (hard FK to `AdminUser`) and cannot record end-user events — this is additive, not a duplicate of an existing user-facing feature; it has **no REST read endpoint** (write-only, backend-internal) |

---

## FE Implementation Checklist

- [ ] `POST /api/v1/auth/devices/link/initiate` to get `linkToken` + `pollSecret` + `expiresAt`
- [ ] Render QR client-side, encoding only `linkToken`
- [ ] Connect Socket.IO to `/auth` namespace
- [ ] Emit `auth:qr:subscribe` with `{ token: linkToken }`
- [ ] Listen for `auth:qr:scanned` → show "confirm on device" state
- [ ] Listen for `auth:qr:approved` → save tokens, redirect
- [ ] Listen for `auth:qr:rejected` → show rejected state
- [ ] Listen for `auth:qr:expired` → show expired state
- [ ] Start a local 60-second countdown from `expiresAt` (don't rely solely on the sweeper's up-to-30s-delayed `auth:qr:expired`)
- [ ] "Generate again" re-runs `initiate` + re-subscribes the socket with the new token
- [ ] On socket reconnect, re-emit `auth:qr:subscribe` with the current token
- [ ] Handle all documented error responses (400/401/403/404/409/429/503)
- [ ] Persist `accessToken`/`refreshToken` per the platform's existing token-storage convention
- [ ] Implement `GET /api/v1/users/linked-devices` (device list screen)
- [ ] Implement `DELETE /api/v1/users/linked-devices/{sessionId}` (revoke/logout device)
- [ ] Handle `401 AUTH_SESSION_ENDED` globally (force logout if the current session is revoked elsewhere)
- [ ] On the mobile scanning app: call `GET /devices/link/{linkToken}` to preview device info before scanning (optional but recommended), then `POST /scan`, then `POST /approve` or `POST /reject`

---

## Testing Checklist

- [ ] QR generated — `initiate` returns a UUID v4 `linkToken`, valid `pollSecret`, `expiresAt` ~60s out
- [ ] QR generation rate-limited — 6th `initiate` within 60s from the same IP returns 429
- [ ] Scan rate-limited — 11th `scan` within 60s from the same user returns 429
- [ ] QR scanned — `auth:qr:scanned` arrives with correct `device` info
- [ ] QR approved — `auth:qr:approved` arrives with valid `tokens` + `user`; new session appears in `GET /users/linked-devices`
- [ ] QR rejected — `auth:qr:rejected` arrives; subsequent `approve` call on the same token returns 409
- [ ] QR expired — after 60s, `auth:qr:expired` eventually arrives (allow up to ~30s extra for the sweeper tick); `scan`/`approve`/`reject` on the expired token all return 404 `AUTH_DEVICE_LINK_EXPIRED`
- [ ] Reuse prevention — approving an already-approved/used token returns 409; scanning an already-scanned token returns 409
- [ ] Wrong-user approval — a second user attempting to approve/reject a QR scanned by someone else gets 403
- [ ] Invalid QR — `scan`/`approve`/`reject`/pending-details with an unknown `linkToken` return 404
- [ ] Network failure — socket disconnect mid-flow, then reconnect + re-subscribe still receives subsequent events
- [ ] Multiple browsers — two `initiate` calls produce two independent `linkToken`s; scanning one never affects the other
- [ ] Multiple devices — a user with several linked devices sees all of them in `GET /users/linked-devices`, each with correct `isCurrent`
- [ ] Refresh page — reloading the browser mid-flow requires re-subscribing the socket (state is NOT persisted client-side); the QR itself is still valid server-side until its `expiresAt`
- [ ] Reconnect socket — Socket.IO auto-reconnect + re-`auth:qr:subscribe` still delivers events emitted after reconnect (events emitted while disconnected are NOT redelivered/queued)
- [ ] Logout device — `DELETE /users/linked-devices/{sessionId}` removes it from the list, and a subsequent request using that session's access token returns 401 `AUTH_SESSION_ENDED`
- [ ] Session revoked — revoking a session with a LIVE socket connection in `/chat`/`/community`/`/notify`/`/stream` force-disconnects it immediately
