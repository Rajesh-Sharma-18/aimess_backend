# Calls — Initiate Call (1:1 WebRTC Signaling)

Source: `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` (`call:initiate` handler + `CallInitiateSchema`) → gRPC `messagingClient.initiateCall` → `apps/chat-service/src/grpc/server.ts` (`initiateCall`) → `apps/chat-service/src/services/call.service.ts` (`initiateCall`) → `apps/chat-service/src/repositories/call.repository.ts` (`create`).

Calling is **socket-only** for control plane: there is **no REST endpoint to start a call**. The caller emits `call:initiate` on the `/chat` namespace; the gateway derives `callerId` from the JWT (never trusts a client-sent id), validates with Zod, and forwards over gRPC. chat-service persists a `Call` row (`status: RINGING`) and publishes `call:incoming` to the callee's `user:<calleeId>` Redis channel. The ack returns `{ callId, status, rtcConfig }`. Only **1:1** calls exist — there is no group-call model, member cap, or conference logic in code.

Overlap: connection/auth handshake details and the namespace contract are also covered in `websocket-events/`. Cases here focus on call-specific payloads, rules, DB writes, and emissions.

Notes on validation: `CallInitiateSchema = { calleeId: string.min(1), type: enum["AUDIO","VIDEO"].default("AUDIO"), privateRoomId?: string }`. Invalid payload → ack `{ success:false, error:"INVALID_PAYLOAD" }`. Downstream gRPC failure → ack `{ success:false, error:"SERVICE_ERROR" }`.

---

### TC-CALL-001 — Initiate audio call (happy path)

| Field                     | Value                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                                                                                                                  |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                                                                                                  |
| **Test Scenario**         | Authenticated caller starts an audio call to a reachable peer                                                                                                     |
| **Category**              | Happy Path                                                                                                                                                        |
| **Priority**              | High                                                                                                                                                              |
| **Preconditions**         | Caller A and callee B both have accounts; A connected to `/chat` with valid JWT                                                                                   |
| **Request Payload**       | `{ "calleeId": "B", "type": "AUDIO" }`                                                                                                                            |
| **Expected Response**     | ack `{ success:true, data:{ callId, status:"RINGING", rtcConfig:{ iceServers, iceCandidatePoolSize, iceTransportPolicy:"all" } } }`                               |
| **Expected DB Changes**   | New `Call` row: `callId` (UUID), `callerId:A`, `calleeId:B`, `type:"AUDIO"`, `status:"RINGING"`, `initiatedAt:now`, `answeredAt/endedAt/durationSec/endedBy:null` |
| **Expected Socket/Event** | `call:incoming` → `user:B` room `{ callId, callerId:A, type:"AUDIO" }`                                                                                            |
| **Notes**                 | `callerId` comes from JWT, not the payload. `callId` is `randomUUID()`.                                                                                           |

### TC-CALL-002 — Initiate video call

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                     |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                     |
| **Test Scenario**         | `type:"VIDEO"` persisted and echoed in `call:incoming`               |
| **Category**              | Happy Path                                                           |
| **Priority**              | Medium                                                               |
| **Preconditions**         | A connected; B exists                                                |
| **Request Payload**       | `{ "calleeId": "B", "type": "VIDEO" }`                               |
| **Expected Response**     | ack `{ success:true, data:{ callId, status:"RINGING", rtcConfig } }` |
| **Expected DB Changes**   | `Call.type = "VIDEO"`                                                |
| **Expected Socket/Event** | `call:incoming` → `user:B` `{ callId, callerId:A, type:"VIDEO" }`    |
| **Notes**                 | —                                                                    |

### TC-CALL-003 — `type` defaults to AUDIO when omitted

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Calls / Initiate                                       |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                       |
| **Test Scenario**         | Omitting `type` defaults to AUDIO (Zod `.default`)     |
| **Category**              | Optional Params                                        |
| **Priority**              | Medium                                                 |
| **Preconditions**         | A connected; B exists                                  |
| **Request Payload**       | `{ "calleeId": "B" }`                                  |
| **Expected Response**     | ack `{ success:true, data:{ status:"RINGING", ... } }` |
| **Expected DB Changes**   | `Call.type = "AUDIO"`                                  |
| **Expected Socket/Event** | `call:incoming` `{ ..., type:"AUDIO" }`                |
| **Notes**                 | Default applied at the gateway Zod layer.              |

### TC-CALL-004 — Initiate with privateRoomId (block-check path)

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                     |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                     |
| **Test Scenario**         | `privateRoomId` supplied and caller is not blocked → call proceeds   |
| **Category**              | Happy Path                                                           |
| **Priority**              | Medium                                                               |
| **Preconditions**         | A `PrivateRoom` exists for A↔B; `blockedBy` does not include A       |
| **Request Payload**       | `{ "calleeId": "B", "type":"AUDIO", "privateRoomId": "room_AB" }`    |
| **Expected Response**     | ack `{ success:true, data:{ callId, status:"RINGING", rtcConfig } }` |
| **Expected DB Changes**   | `Call.privateRoomId = "room_AB"`                                     |
| **Expected Socket/Event** | `call:incoming` → `user:B`                                           |
| **Notes**                 | Service fetches room with projection `{ blockedBy:1 }` only.         |

### TC-CALL-005 — Reject empty calleeId

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Calls / Initiate                                 |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                 |
| **Test Scenario**         | `calleeId:""` fails `min(1)`                     |
| **Category**              | Input Validation                                 |
| **Priority**              | High                                             |
| **Preconditions**         | A connected                                      |
| **Request Payload**       | `{ "calleeId": "", "type":"AUDIO" }`             |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }` |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | Gateway `safeParse` fails before gRPC call.      |

### TC-CALL-006 — Reject missing calleeId

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Calls / Initiate                                 |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                 |
| **Test Scenario**         | No `calleeId` key                                |
| **Category**              | Required Params                                  |
| **Priority**              | High                                             |
| **Preconditions**         | A connected                                      |
| **Request Payload**       | `{ "type":"VIDEO" }`                             |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }` |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | —                                                |

### TC-CALL-007 — Reject invalid call type

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Calls / Initiate                                 |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                 |
| **Test Scenario**         | `type:"SCREEN"` not in enum                      |
| **Category**              | Input Validation                                 |
| **Priority**              | Medium                                           |
| **Preconditions**         | A connected                                      |
| **Request Payload**       | `{ "calleeId":"B", "type":"SCREEN" }`            |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }` |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | Enum is `["AUDIO","VIDEO"]` only.                |

### TC-CALL-008 — Unauthenticated socket cannot initiate

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Calls / Initiate                                                                                 |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                                 |
| **Test Scenario**         | Handshake without/with invalid JWT                                                               |
| **Category**              | AuthN                                                                                            |
| **Priority**              | High                                                                                             |
| **Preconditions**         | Client connects without `auth.token`                                                             |
| **Request Payload**       | n/a — connection rejected before any emit                                                        |
| **Expected Response**     | `connect_error` `Authentication required` / `Authentication failed`; no socket, no handler bound |
| **Expected DB Changes**   | None                                                                                             |
| **Expected Socket/Event** | None                                                                                             |
| **Notes**                 | Auth enforced in `auth.middleware.ts`; see `websocket-events/`.                                  |

### TC-CALL-009 — Caller id cannot be spoofed via payload

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                                                              |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                                              |
| **Test Scenario**         | Client adds `callerId:"victim"` in payload; server ignores it                                                 |
| **Category**              | Security                                                                                                      |
| **Priority**              | High                                                                                                          |
| **Preconditions**         | A connected (JWT userId = A)                                                                                  |
| **Request Payload**       | `{ "calleeId":"B", "callerId":"victim" }`                                                                     |
| **Expected Response**     | ack `{ success:true }`; stored `callerId = A`                                                                 |
| **Expected DB Changes**   | `Call.callerId = A` (JWT), not "victim"                                                                       |
| **Expected Socket/Event** | `call:incoming` `{ callerId:A }`                                                                              |
| **Notes**                 | Gateway spreads `{ ...r.data, callerId: userId }` — schema has no `callerId`, so it would be stripped anyway. |

### TC-CALL-010 — Calling a blocked-by-self peer is forbidden

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                                                              |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                                              |
| **Test Scenario**         | `privateRoomId.blockedBy` includes the caller → ForbiddenError                                                |
| **Category**              | Business Rule                                                                                                 |
| **Priority**              | High                                                                                                          |
| **Preconditions**         | `PrivateRoom.blockedBy` contains A                                                                            |
| **Request Payload**       | `{ "calleeId":"B", "privateRoomId":"room_AB" }`                                                               |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }` (gRPC INTERNAL from `ForbiddenError("CALL_BLOCKED")`)          |
| **Expected DB Changes**   | None — error thrown before `create`                                                                           |
| **Expected Socket/Event** | None                                                                                                          |
| **Notes**                 | GAP: the gateway maps all downstream errors to `SERVICE_ERROR`; the specific `CALL_BLOCKED`/403 code is lost. |

### TC-CALL-011 — Block check skipped when privateRoomId omitted

| Field                     | Value                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Calls / Initiate                                                                                                                                                                           |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                                                                                                                           |
| **Test Scenario**         | Without `privateRoomId` the block check never runs                                                                                                                                         |
| **Category**              | Edge Case                                                                                                                                                                                  |
| **Priority**              | High                                                                                                                                                                                       |
| **Preconditions**         | A has blocked B (or vice-versa) but caller omits `privateRoomId`                                                                                                                           |
| **Request Payload**       | `{ "calleeId":"B" }`                                                                                                                                                                       |
| **Expected Response**     | ack `{ success:true, ... }` — call proceeds                                                                                                                                                |
| **Expected DB Changes**   | New RINGING `Call`                                                                                                                                                                         |
| **Expected Socket/Event** | `call:incoming` → `user:B`                                                                                                                                                                 |
| **Notes**                 | GAP/security: block enforcement is **opt-in** by the caller supplying `privateRoomId`. A blocked caller can bypass it by omitting the field. Also no friendship/reachability check exists. |

### TC-CALL-012 — Self-call is not prevented

| Field                     | Value                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                                                    |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                                    |
| **Test Scenario**         | `calleeId == callerId`                                                                              |
| **Category**              | Business Rule                                                                                       |
| **Priority**              | Medium                                                                                              |
| **Preconditions**         | A connected                                                                                         |
| **Request Payload**       | `{ "calleeId":"A" }` (A's own id)                                                                   |
| **Expected Response**     | ack `{ success:true, ... }` — a `Call` is created                                                   |
| **Expected DB Changes**   | `Call{ callerId:A, calleeId:A, status:RINGING }`                                                    |
| **Expected Socket/Event** | `call:incoming` → `user:A` (the caller rings themselves)                                            |
| **Notes**                 | GAP: no self-call guard in code. Documented as a known defect; expected behavior _should_ be a 400. |

### TC-CALL-013 — Calling a non-existent / unknown user still succeeds

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                                    |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                    |
| **Test Scenario**         | `calleeId` is not a real user id                                                    |
| **Category**              | Edge Case                                                                           |
| **Priority**              | Medium                                                                              |
| **Preconditions**         | A connected; `"ghost"` is not a user                                                |
| **Request Payload**       | `{ "calleeId":"ghost" }`                                                            |
| **Expected Response**     | ack `{ success:true, ... }`                                                         |
| **Expected DB Changes**   | `Call` row created with `calleeId:"ghost"`                                          |
| **Expected Socket/Event** | `call:incoming` published to `user:ghost` — no socket joined, so nobody receives it |
| **Notes**                 | GAP: no callee-existence/reachability validation. The publish is best-effort.       |

### TC-CALL-014 — Busy / already-in-call state not enforced

| Field                     | Value                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                                              |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                              |
| **Test Scenario**         | B is already IN_PROGRESS on another call; A initiates                                         |
| **Category**              | Business Rule                                                                                 |
| **Priority**              | Medium                                                                                        |
| **Preconditions**         | An existing `Call` with `calleeId:B, status:IN_PROGRESS`                                      |
| **Request Payload**       | `{ "calleeId":"B" }`                                                                          |
| **Expected Response**     | ack `{ success:true, ... }` — second RINGING call created                                     |
| **Expected DB Changes**   | A new independent `Call` row (no busy rejection)                                              |
| **Expected Socket/Event** | `call:incoming` → `user:B`                                                                    |
| **Notes**                 | GAP: no busy-state check; multiple concurrent RINGING/IN_PROGRESS calls per user are allowed. |

### TC-CALL-015 — Callee offline (no socket in user room)

| Field                     | Value                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                                                                           |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                                                           |
| **Test Scenario**         | B has no active `/chat` socket                                                                                             |
| **Category**              | Edge Case                                                                                                                  |
| **Priority**              | Medium                                                                                                                     |
| **Preconditions**         | B not connected                                                                                                            |
| **Request Payload**       | `{ "calleeId":"B" }`                                                                                                       |
| **Expected Response**     | ack `{ success:true, data:{ status:"RINGING" } }`                                                                          |
| **Expected DB Changes**   | RINGING `Call` persisted                                                                                                   |
| **Expected Socket/Event** | `call:incoming` published to `user:B` but delivered to nobody                                                              |
| **Notes**                 | GAP: no push/FCM fallback for missed-call ring when callee offline; no ringing-timeout job to auto-expire the RINGING row. |

### TC-CALL-016 — Redis publish failure does not fail the call

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- | ------------ | --------------------- |
| **Feature/Module**        | Calls / Initiate                                              |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                              |
| **Test Scenario**         | Redis `publish` rejects                                       |
| **Category**              | Error Handling                                                |
| **Priority**              | Low                                                           |
| **Preconditions**         | Redis pub channel errors                                      |
| **Request Payload**       | `{ "calleeId":"B" }`                                          |
| **Expected Response**     | ack `{ success:true, ... }` — call still created              |
| **Expected DB Changes**   | RINGING `Call` persisted                                      |
| **Expected Socket/Event** | None delivered; warn logged `CallService                      | initiateCall | redis publish failed` |
| **Notes**                 | Publish is `.catch`-swallowed; the callee simply never rings. |

### TC-CALL-017 — Call-spam / rate limiting

| Field                     | Value                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Initiate                                                                                                          |
| **API/Event Name**        | `call:initiate` (socket `/chat`)                                                                                          |
| **Test Scenario**         | A fires 100 `call:initiate` in a burst                                                                                    |
| **Category**              | Rate Limit                                                                                                                |
| **Priority**              | Medium                                                                                                                    |
| **Preconditions**         | A connected                                                                                                               |
| **Request Payload**       | repeated `{ "calleeId":"B" }`                                                                                             |
| **Expected Response**     | All acked `success:true`; 100 `Call` rows created                                                                         |
| **Expected DB Changes**   | One `Call` per emit                                                                                                       |
| **Expected Socket/Event** | 100 `call:incoming` to `user:B`                                                                                           |
| **Notes**                 | GAP: no rate limiter on socket call events. Documented spam risk — expected behavior _should_ throttle per caller/callee. |
