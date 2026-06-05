# WebSocket — 1-1 Call / WebRTC Signaling (/chat)

Signaling-only: media flows peer-to-peer / via TURN (`rtcConfig`). `call:initiate`/
`answer`/`decline`/`end` are ack'd gRPC events; `call:ice` is fire-and-forget,
relayed via Redis only (channel `call:<callId>`, re-emitted to room `call:<callId>`)
and **never persisted**. The `call:<callId>` room is joined implicitly via the
`call:*` Redis pattern fan-out, not an explicit join event.

**Source:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` (`call:*`
handlers + `redisPub.publish("call:<id>")`), `docs/SOCKET_EVENTS.md` §4, §7.5.

---

### TC-WS-200 — call:initiate happy path

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                                                                         |
| **API/Event Name**        | `client→server: call:initiate`                                                                     |
| **Test Scenario**         | Happy path — caller starts a video call                                                            |
| **Category**              | Happy Path                                                                                         |
| **Priority**              | High                                                                                               |
| **Preconditions**         | Caller and callee connected on `/chat`                                                             |
| **Request Payload**       | `{ calleeId, type:"VIDEO", privateRoomId? }`                                                       |
| **Expected Response**     | Ack `{ success:true, data:{ callId, status, rtcConfig } }`                                         |
| **Expected DB Changes**   | Call record created in chat-service (status ringing)                                               |
| **Expected Socket/Event** | `call:incoming { callId, callerId, type }` to `user:<calleeId>`                                    |
| **Notes**                 | `callerId` forced to authed user. `type` defaults `"AUDIO"`. `rtcConfig` carries ICE/TURN servers. |

### TC-WS-201 — call:initiate invalid type → INVALID_PAYLOAD

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Call signaling                                                                       |
| **API/Event Name**        | `client→server: call:initiate`                                                                   |
| **Test Scenario**         | Input validation — `type` not in AUDIO/VIDEO                                                     |
| **Category**              | Input Validation                                                                                 |
| **Priority**              | Medium                                                                                           |
| **Preconditions**         | Connected                                                                                        |
| **Request Payload**       | `{ calleeId, type:"SCREEN" }`                                                                    |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }`                                                 |
| **Expected DB Changes**   | None                                                                                             |
| **Expected Socket/Event** | None                                                                                             |
| **Notes**                 | `CallInitiateSchema.type` is `enum(["AUDIO","VIDEO"])`. Missing `calleeId` also INVALID_PAYLOAD. |

### TC-WS-202 — call:answer accepts a ringing call

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                         |
| **API/Event Name**        | `client→server: call:answer`                       |
| **Test Scenario**         | Happy path — callee accepts                        |
| **Category**              | Happy Path                                         |
| **Priority**              | High                                               |
| **Preconditions**         | A ringing call exists; emitter is the callee       |
| **Request Payload**       | `{ callId }`                                       |
| **Expected Response**     | Ack `{ success:true, data:{ … } }`                 |
| **Expected DB Changes**   | Call status → answered/connected                   |
| **Expected Socket/Event** | `call:answered { callId }` to room `call:<callId>` |
| **Notes**                 | `calleeId` forced to authed user.                  |

### TC-WS-203 — call:decline rejects a ringing call

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                    |
| **API/Event Name**        | `client→server: call:decline`                 |
| **Test Scenario**         | Happy path — callee rejects                   |
| **Category**              | Happy Path                                    |
| **Priority**              | Medium                                        |
| **Preconditions**         | Ringing call                                  |
| **Request Payload**       | `{ callId }`                                  |
| **Expected Response**     | Ack success                                   |
| **Expected DB Changes**   | Call status → declined                        |
| **Expected Socket/Event** | `call:declined { callId }` to `call:<callId>` |
| **Notes**                 | `calleeId` from token.                        |

### TC-WS-204 — call:end hangs up (caller or callee)

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                                       |
| **API/Event Name**        | `client→server: call:end`                                        |
| **Test Scenario**         | Happy path — either party ends the call                          |
| **Category**              | Happy Path                                                       |
| **Priority**              | High                                                             |
| **Preconditions**         | Active or ringing call                                           |
| **Request Payload**       | `{ callId }`                                                     |
| **Expected Response**     | Ack success                                                      |
| **Expected DB Changes**   | Call status → ended; duration computed                           |
| **Expected Socket/Event** | `call:ended { callId, endedBy, durationSec }` to `call:<callId>` |
| **Notes**                 | `userId` (either party) passed as `endCall({ callId, userId })`. |

### TC-WS-205 — call:ice relays candidate via Redis (no persist)

| Field                     | Value                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                                                                                                                                                                           |
| **API/Event Name**        | `client→server: call:ice`                                                                                                                                                                            |
| **Test Scenario**         | Happy path — ICE candidate relayed to the peer                                                                                                                                                       |
| **Category**              | Happy Path                                                                                                                                                                                           |
| **Priority**              | High                                                                                                                                                                                                 |
| **Preconditions**         | Both peers in `call:<callId>`                                                                                                                                                                        |
| **Request Payload**       | `{ callId, candidate }`                                                                                                                                                                              |
| **Expected Response**     | No ack (fire-and-forget)                                                                                                                                                                             |
| **Expected DB Changes**   | None (never persisted)                                                                                                                                                                               |
| **Expected Socket/Event** | Gateway publishes to Redis `call:<callId>` → re-emitted as `call:ice { callId, candidate, from:userId }` to room `call:<callId>`                                                                     |
| **Notes**                 | Relayed by the gateway directly to `redisPub` (not via gRPC). `from` is the authed user — cannot be spoofed. Note the emitter also receives its own candidate back (room broadcast includes sender). |

### TC-WS-206 — call:ice malformed → silently dropped

| Field                     | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                                                                   |
| **API/Event Name**        | `client→server: call:ice`                                                                    |
| **Test Scenario**         | Input validation — missing `callId`                                                          |
| **Category**              | Input Validation                                                                             |
| **Priority**              | Low                                                                                          |
| **Preconditions**         | Connected                                                                                    |
| **Request Payload**       | `{ candidate:{…} }`                                                                          |
| **Expected Response**     | Nothing (no ack)                                                                             |
| **Expected DB Changes**   | None                                                                                         |
| **Expected Socket/Event** | No publish                                                                                   |
| **Notes**                 | `CallIceSchema` requires `callId.min(1)`; `candidate` is `z.unknown()` (any shape accepted). |

### TC-WS-207 — AuthZ: call:ice into a call you're not part of

| Field                     | Value                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                                                                                                                                                                                                                          |
| **API/Event Name**        | `client→server: call:ice`                                                                                                                                                                                                                           |
| **Test Scenario**         | Security — attacker publishes ICE to a `callId` of a call they're not in                                                                                                                                                                            |
| **Category**              | Security                                                                                                                                                                                                                                            |
| **Priority**              | High                                                                                                                                                                                                                                                |
| **Preconditions**         | Valid socket; a known/guessed `callId`                                                                                                                                                                                                              |
| **Request Payload**       | `{ callId:"<foreign>", candidate:{…} }`                                                                                                                                                                                                             |
| **Expected Response**     | No ack; **GAP:** gateway publishes to `call:<callId>` without verifying the user is a participant                                                                                                                                                   |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                |
| **Expected Socket/Event** | Real participants receive a `call:ice { from:attacker }` — signaling injection / nuisance                                                                                                                                                           |
| **Notes**                 | `from:userId` is honest (not spoofed) but there is no participant check before relaying. Mitigated only by `callId` unguessability. Recommend membership check. Same risk applies to whether non-participants are even in the `call:<callId>` room. |

### TC-WS-208 — call:answer/end downstream error → SERVICE_ERROR

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                                        |
| **API/Event Name**        | `client→server: call:answer`                                      |
| **Test Scenario**         | Error handling — call already ended / not found                   |
| **Category**              | Error Handling                                                    |
| **Priority**              | Medium                                                            |
| **Preconditions**         | `callId` invalid or call already terminated                       |
| **Request Payload**       | `{ callId:"<stale>" }`                                            |
| **Expected Response**     | Ack `{ success:false, error:"SERVICE_ERROR" }`                    |
| **Expected DB Changes**   | None                                                              |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | Same envelope for `call:decline`/`call:end` on downstream errors. |

### TC-WS-209 — Concurrency: callee answers and declines near-simultaneously

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                                                                  |
| **API/Event Name**        | `call:answer` + `call:decline`                                                              |
| **Test Scenario**         | Concurrency — two devices of the callee race to answer vs decline                           |
| **Category**              | Concurrency                                                                                 |
| **Priority**              | Medium                                                                                      |
| **Preconditions**         | Callee on two devices; one answers, the other declines                                      |
| **Request Payload**       | concurrent `call:answer` and `call:decline` for the same `callId`                           |
| **Expected Response**     | First-write-wins in chat-service; the loser gets `SERVICE_ERROR` (invalid state transition) |
| **Expected DB Changes**   | Single terminal state                                                                       |
| **Expected Socket/Event** | Exactly one of `call:answered`/`call:declined` to `call:<callId>`                           |
| **Notes**                 | State machine consistency enforced server-side, not at the gateway.                         |

### TC-WS-210 — Group calls not implemented over /chat sockets

| Field                     | Value                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Call signaling                                                                                                                                  |
| **API/Event Name**        | (group call)                                                                                                                                                |
| **Test Scenario**         | Gap — only 1-1 call signaling exists on `/chat`; group calls have no socket events                                                                          |
| **Category**              | Edge Case                                                                                                                                                   |
| **Priority**              | Low                                                                                                                                                         |
| **Preconditions**         | n/a                                                                                                                                                         |
| **Request Payload**       | n/a                                                                                                                                                         |
| **Expected Response**     | n/a                                                                                                                                                         |
| **Expected DB Changes**   | n/a                                                                                                                                                         |
| **Expected Socket/Event** | None — no group-call socket events in `chat.ns.ts`                                                                                                          |
| **Notes**                 | Documented contract is 1-1 only. Group call (if any) is via REST `webrtc.routes` per README calls module — out of scope for the socket layer. GAP to track. |
