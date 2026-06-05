# Auth — Device Link (QR sign-in)

Source: `apps/auth-service/src/api/routes/device-link.routes.ts`
(`POST /api/auth/devices/link/initiate`, `GET /api/auth/devices/link/status`, `POST /api/auth/devices/link/approve`)

QR-style cross-device login → `deviceLinkService`. The NEW device initiates (no auth) and polls status (no
auth, by `linkToken`+`pollSecret`). An already-signed-in device approves (auth required). Tokens are handed to
the new device **exactly once** (single-use APPROVED→CONSUMED). Link store is Redis-backed (`device-link-store`).

---

### TC-AUTH-143 — Initiate device link (happy path)

| Field                     | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Device Link                                                                         |
| **API/Event Name**        | `POST /api/auth/devices/link/initiate`                                                     |
| **Test Scenario**         | New device starts a link session                                                           |
| **Category**              | Happy Path                                                                                 |
| **Priority**              | High                                                                                       |
| **Preconditions**         | None (no auth)                                                                             |
| **Request Payload**       | `{ "deviceName":"Web Chrome", "deviceType":"WEB", "os":"Win11", "appVersion":"1.0" }`      |
| **Expected Response**     | `201` `{ data:{ linkToken, pollSecret, expiresAt }, message: AUTH_DEVICE_LINK_INITIATED }` |
| **Expected DB Changes**   | Link session created in Redis store (state PENDING); no Postgres write                     |
| **Expected Socket/Event** | None                                                                                       |
| **Notes**                 | All device fields optional; falls back to session context.                                 |

### TC-AUTH-144 — Initiate with all fields omitted (defaults)

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                             |
| **API/Event Name**        | `POST /api/auth/devices/link/initiate`         |
| **Test Scenario**         | Empty body uses request-derived device context |
| **Category**              | Optional Params                                |
| **Priority**              | Low                                            |
| **Preconditions**         | None                                           |
| **Request Payload**       | `{}`                                           |
| **Expected Response**     | `201` with linkToken/pollSecret/expiresAt      |
| **Expected DB Changes**   | Redis link session PENDING                     |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | `buildSessionContext(req)` fallback.           |

### TC-AUTH-145 — Initiate rejects oversized device field → 400

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Auth / Device Link                     |
| **API/Event Name**        | `POST /api/auth/devices/link/initiate` |
| **Test Scenario**         | deviceName > 100 chars                 |
| **Category**              | Input Validation                       |
| **Priority**              | Low                                    |
| **Preconditions**         | None                                   |
| **Request Payload**       | `{ "deviceName": "<101 chars>" }`      |
| **Expected Response**     | `400` VALIDATION_FAILED                |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | `optionalDeviceField.max(100)`.        |

### TC-AUTH-146 — Poll status PENDING before approval

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                                                                                            |
| **API/Event Name**        | `GET /api/auth/devices/link/status`                                                                           |
| **Test Scenario**         | Not yet approved                                                                                              |
| **Category**              | Happy Path                                                                                                    |
| **Priority**              | High                                                                                                          |
| **Preconditions**         | Link session created, not approved                                                                            |
| **Request Payload**       | query `linkToken=<t>&pollSecret=<s>`                                                                          |
| **Expected Response**     | `200` `{ data:{ state:"PENDING", approvedDeviceLabel:null, tokens:null }, message: AUTH_DEVICE_LINK_STATUS }` |
| **Expected DB Changes**   | None                                                                                                          |
| **Expected Socket/Event** | None                                                                                                          |
| **Notes**                 | —                                                                                                             |

### TC-AUTH-147 — Poll status with wrong pollSecret → EXPIRED (no enumeration)

| Field                     | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Device Link                                                                         |
| **API/Event Name**        | `GET /api/auth/devices/link/status`                                                        |
| **Test Scenario**         | Wrong pollSecret or unknown linkToken                                                      |
| **Category**              | Security                                                                                   |
| **Priority**              | High                                                                                       |
| **Preconditions**         | Either bad secret or missing token                                                         |
| **Request Payload**       | query `linkToken=<t>&pollSecret=<wrong>`                                                   |
| **Expected Response**     | `200` `{ data:{ state:"EXPIRED", approvedDeviceLabel:null, tokens:null } }`                |
| **Expected DB Changes**   | None                                                                                       |
| **Expected Socket/Event** | None                                                                                       |
| **Notes**                 | Missing record and wrong secret are indistinguishable (pollSecret hash compared). No leak. |

### TC-AUTH-148 — Poll status missing params → 400

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                            |
| **API/Event Name**        | `GET /api/auth/devices/link/status`           |
| **Test Scenario**         | Missing linkToken or pollSecret               |
| **Category**              | Required Params                               |
| **Priority**              | Medium                                        |
| **Preconditions**         | None                                          |
| **Request Payload**       | query `linkToken=<t>` (no pollSecret)         |
| **Expected Response**     | `400` VALIDATION_FAILED                       |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | `validateQuery(deviceLinkStatusQuerySchema)`. |

### TC-AUTH-149 — Approve device link (happy path)

| Field                     | Value                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                                                                                                              |
| **API/Event Name**        | `POST /api/auth/devices/link/approve`                                                                                           |
| **Test Scenario**         | Signed-in device approves a pending link                                                                                        |
| **Category**              | Happy Path                                                                                                                      |
| **Priority**              | High                                                                                                                            |
| **Preconditions**         | Authed user; pending link session exists                                                                                        |
| **Request Payload**       | `{ "linkToken":"<t>", "deviceLabel":"My Laptop" }`                                                                              |
| **Expected Response**     | `200` `{ data:{ linkedAt, sessionId }, message: AUTH_DEVICE_LINK_APPROVED }`                                                    |
| **Expected DB Changes**   | New `Session` + `RefreshToken` for the NEW device (synthetic context, fresh random deviceId); link store → APPROVED with tokens |
| **Expected Socket/Event** | None                                                                                                                            |
| **Notes**                 | Fresh deviceId avoids wiping the approver's own session. `sessionId` lets approver later revoke the link.                       |

### TC-AUTH-150 — Approved tokens delivered to new device exactly once

| Field                     | Value                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                                                                                               |
| **API/Event Name**        | `GET /api/auth/devices/link/status`                                                                              |
| **Test Scenario**         | After approval, first poll returns tokens; second returns CONSUMED                                               |
| **Category**              | Security                                                                                                         |
| **Priority**              | High                                                                                                             |
| **Preconditions**         | Link approved                                                                                                    |
| **Request Payload**       | query `linkToken=<t>&pollSecret=<s>` twice                                                                       |
| **Expected Response**     | 1st: `200 { state:"APPROVED", approvedDeviceLabel, tokens:{...} }`; 2nd: `200 { state:"CONSUMED", tokens:null }` |
| **Expected DB Changes**   | `consumeTokensAtomic` flips APPROVED→CONSUMED                                                                    |
| **Expected Socket/Event** | None                                                                                                             |
| **Notes**                 | Single-use token hand-off; prevents token theft via replayed polling.                                            |

### TC-AUTH-151 — Approve unknown/expired link token → 404

| Field                     | Value                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                                                                                                                                                    |
| **API/Event Name**        | `POST /api/auth/devices/link/approve`                                                                                                                                 |
| **Test Scenario**         | linkToken not found                                                                                                                                                   |
| **Category**              | Error Handling                                                                                                                                                        |
| **Priority**              | Medium                                                                                                                                                                |
| **Preconditions**         | Authed user; no such link session                                                                                                                                     |
| **Request Payload**       | `{ "linkToken":"nonexistent" }`                                                                                                                                       |
| **Expected Response**     | `404` `AUTH_DEVICE_LINK_NOT_FOUND`                                                                                                                                    |
| **Expected DB Changes**   | None (any pre-issued session may exist — see notes)                                                                                                                   |
| **Expected Socket/Event** | None                                                                                                                                                                  |
| **Notes**                 | NOTE: approve issues tokens BEFORE `approveLinkSessionAtomic`; a NOT_FOUND there still leaves a created Session row. Possible orphan-session gap — flag for COVERAGE. |

### TC-AUTH-152 — Approve an already-approved link → 409

| Field                     | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                                                                     |
| **API/Event Name**        | `POST /api/auth/devices/link/approve`                                                  |
| **Test Scenario**         | Second approval of the same link                                                       |
| **Category**              | Concurrency                                                                            |
| **Priority**              | High                                                                                   |
| **Preconditions**         | Link already APPROVED                                                                  |
| **Request Payload**       | `{ "linkToken":"<t>" }`                                                                |
| **Expected Response**     | `409` `AUTH_DEVICE_LINK_ALREADY_APPROVED`                                              |
| **Expected DB Changes**   | None applied to link; a second Session may have been pre-issued (see TC-AUTH-151 note) |
| **Expected Socket/Event** | None                                                                                   |
| **Notes**                 | `approveLinkSessionAtomic` returns "ALREADY".                                          |

### TC-AUTH-153 — Approve without auth → 401

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                          |
| **API/Event Name**        | `POST /api/auth/devices/link/approve`       |
| **Test Scenario**         | No access token                             |
| **Category**              | AuthN                                       |
| **Priority**              | High                                        |
| **Preconditions**         | None                                        |
| **Request Payload**       | `{ "linkToken":"<t>" }`                     |
| **Expected Response**     | `401`                                       |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | Only initiate + status are unauthenticated. |

### TC-AUTH-154 — Approve missing linkToken → 400

| Field                     | Value                                       |
| ------------------------- | ------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                          |
| **API/Event Name**        | `POST /api/auth/devices/link/approve`       |
| **Test Scenario**         | Empty body                                  |
| **Category**              | Required Params                             |
| **Priority**              | Medium                                      |
| **Preconditions**         | Authed user                                 |
| **Request Payload**       | `{}`                                        |
| **Expected Response**     | `400` VALIDATION_FAILED                     |
| **Expected DB Changes**   | None                                        |
| **Expected Socket/Event** | None                                        |
| **Notes**                 | `approveDeviceLinkSchema.linkToken.min(1)`. |

### TC-AUTH-155 — New device tokens grant access; approver can revoke the link session

| Field                     | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Device Link                                                                     |
| **API/Event Name**        | end-to-end: approve → status (collect tokens) → `DELETE /api/auth/sessions/:sessionId` |
| **Test Scenario**         | Undo a device link by revoking the returned sessionId                                  |
| **Category**              | Business Rule                                                                          |
| **Priority**              | Medium                                                                                 |
| **Preconditions**         | Link approved; approver knows the returned sessionId                                   |
| **Request Payload**       | DELETE with `:sessionId` from approve response                                         |
| **Expected Response**     | `200` AUTH_SESSION_REVOKED; the new device's tokens stop working                       |
| **Expected DB Changes**   | New device `Session.revokedAt` set                                                     |
| **Expected Socket/Event** | None                                                                                   |
| **Notes**                 | Ties device-link to session revocation model.                                          |
