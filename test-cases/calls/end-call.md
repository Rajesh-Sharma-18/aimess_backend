# Calls — End / Hangup

Source: `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` (`call:end`) → gRPC `messagingClient.endCall` → `apps/chat-service/src/grpc/server.ts` (`endCall`) → `apps/chat-service/src/services/call.service.ts` (`endCall`).

Schema `{ callId: string.min(1) }`. The gateway passes `{ callId, userId }` (JWT). Either **caller or callee** may end the call. Business rules:

- Call must exist (`CALL_NOT_FOUND`).
- Actor must be caller or callee (`CALL_NOT_PARTICIPANT`).
- Call must be `RINGING` or `IN_PROGRESS` (else `CALL_ALREADY_ENDED`).

On success: `status:ENDED, endedAt:now, endedBy:actor, durationSec` = `floor((endedAt - answeredAt)/1000)` when answered, else `0`. Publishes `call:ended` to `call:<callId>` with `{ callId, endedBy, durationSec }`. Ack data includes `durationSec`.

---

### TC-CALL-029 — End an in-progress call (happy path, duration computed)

| Field                     | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / End                                                                |
| **API/Event Name**        | `call:end` (socket `/chat`)                                                |
| **Test Scenario**         | Either participant hangs up an answered call                               |
| **Category**              | Happy Path                                                                 |
| **Priority**              | High                                                                       |
| **Preconditions**         | `Call{ status:IN_PROGRESS, answeredAt: T-30s }`; actor is caller or callee |
| **Request Payload**       | `{ "callId":"<callId>" }`                                                  |
| **Expected Response**     | ack `{ success:true, data:{ callId, status:"ENDED", durationSec:~30 } }`   |
| **Expected DB Changes**   | `status="ENDED"`, `endedAt=now`, `endedBy=actor`, `durationSec≈30`         |
| **Expected Socket/Event** | `call:ended` → `call:<callId>` `{ callId, endedBy, durationSec:~30 }`      |
| **Notes**                 | `durationSec = floor((endedAt-answeredAt)/1000)`.                          |

### TC-CALL-030 — End a still-ringing (unanswered) call → duration 0

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Calls / End                                                          |
| **API/Event Name**        | `call:end` (socket `/chat`)                                          |
| **Test Scenario**         | Caller cancels before callee answers                                 |
| **Category**              | Happy Path                                                           |
| **Priority**              | High                                                                 |
| **Preconditions**         | `Call{ status:RINGING, answeredAt:null }`; actor = caller            |
| **Request Payload**       | `{ "callId":"<callId>" }`                                            |
| **Expected Response**     | ack `{ success:true, data:{ status:"ENDED", durationSec:0 } }`       |
| **Expected DB Changes**   | `status="ENDED"`, `endedAt=now`, `endedBy=caller`, `durationSec=0`   |
| **Expected Socket/Event** | `call:ended` `{ durationSec:0 }`                                     |
| **Notes**                 | `answeredAt` null → duration 0. This is the "caller cancelled" flow. |

### TC-CALL-031 — Callee ends an in-progress call

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Calls / End                                                       |
| **API/Event Name**        | `call:end` (socket `/chat`)                                       |
| **Test Scenario**         | Callee B (not caller) hangs up                                    |
| **Category**              | AuthZ                                                             |
| **Priority**              | Medium                                                            |
| **Preconditions**         | `Call{ callerId:A, calleeId:B, status:IN_PROGRESS }`; B connected |
| **Request Payload**       | `{ "callId":"<callId>" }` (by B)                                  |
| **Expected Response**     | ack `{ success:true, data:{ status:"ENDED", endedBy:B? } }`       |
| **Expected DB Changes**   | `endedBy=B`                                                       |
| **Expected Socket/Event** | `call:ended` `{ endedBy:B }`                                      |
| **Notes**                 | Both participants are authorized to end.                          |

### TC-CALL-032 — Uninvolved user cannot end a call (AuthZ)

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Calls / End                                    |
| **API/Event Name**        | `call:end` (socket `/chat`)                    |
| **Test Scenario**         | User C (not caller/callee) ends A↔B call       |
| **Category**              | AuthZ                                          |
| **Priority**              | High                                           |
| **Preconditions**         | `Call{ callerId:A, calleeId:B }`; C connected  |
| **Request Payload**       | `{ "callId":"<callId>" }` (by C)               |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }` |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | `CALL_NOT_PARTICIPANT`.                        |

### TC-CALL-033 — End an already-ended call → already ended

| Field                     | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Calls / End                                                                                |
| **API/Event Name**        | `call:end` (socket `/chat`)                                                                |
| **Test Scenario**         | Call status already ENDED/DECLINED                                                         |
| **Category**              | Business Rule                                                                              |
| **Priority**              | Medium                                                                                     |
| **Preconditions**         | `Call.status="ENDED"`                                                                      |
| **Request Payload**       | `{ "callId":"<callId>" }`                                                                  |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }`                                             |
| **Expected DB Changes**   | None                                                                                       |
| **Expected Socket/Event** | None                                                                                       |
| **Notes**                 | `activeStatuses = [RINGING, IN_PROGRESS]`; else `CALL_ALREADY_ENDED`. Prevents double-end. |

### TC-CALL-034 — End non-existent callId → not found

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Calls / End                                    |
| **API/Event Name**        | `call:end` (socket `/chat`)                    |
| **Test Scenario**         | `callId` does not exist                        |
| **Category**              | Error Handling                                 |
| **Priority**              | Medium                                         |
| **Preconditions**         | None                                           |
| **Request Payload**       | `{ "callId":"missing" }`                       |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }` |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | `CALL_NOT_FOUND`.                              |

### TC-CALL-035 — End rejects empty/missing callId (validation)

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Calls / End                                      |
| **API/Event Name**        | `call:end` (socket `/chat`)                      |
| **Test Scenario**         | `callId:""`                                      |
| **Category**              | Input Validation                                 |
| **Priority**              | Medium                                           |
| **Preconditions**         | Actor connected                                  |
| **Request Payload**       | `{ "callId":"" }`                                |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }` |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | —                                                |

### TC-CALL-036 — Simultaneous hangup by both participants (concurrency)

| Field                     | Value                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / End                                                                                                                   |
| **API/Event Name**        | `call:end` (socket `/chat`)                                                                                                   |
| **Test Scenario**         | Caller and callee both emit `call:end` at the same time                                                                       |
| **Category**              | Concurrency                                                                                                                   |
| **Priority**              | Medium                                                                                                                        |
| **Preconditions**         | `Call.status=IN_PROGRESS`                                                                                                     |
| **Request Payload**       | `{ "callId":"<callId>" }` from both                                                                                           |
| **Expected Response**     | One ack `success:true`; the other likely `SERVICE_ERROR` (CALL_ALREADY_ENDED) — or both succeed under a tight race            |
| **Expected DB Changes**   | Final `endedBy`/`durationSec` reflect the last write                                                                          |
| **Expected Socket/Event** | Potentially **two** `call:ended` emits (no atomic guard)                                                                      |
| **Notes**                 | GAP: read-check-then-update, not atomic; a duplicate `call:ended` is possible. Clients must treat `call:ended` as idempotent. |

### TC-CALL-037 — Network drop instead of explicit end (edge case)

| Field                     | Value                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / End                                                                                                                             |
| **API/Event Name**        | socket `disconnect` (no `call:end`)                                                                                                     |
| **Test Scenario**         | A participant's socket drops mid-call without sending `call:end`                                                                        |
| **Category**              | Edge Case                                                                                                                               |
| **Priority**              | High                                                                                                                                    |
| **Preconditions**         | `Call.status=IN_PROGRESS`; one participant disconnects                                                                                  |
| **Request Payload**       | n/a                                                                                                                                     |
| **Expected Response**     | No ack; `disconnect` handler only calls `presenceDisconnect`, not `endCall`                                                             |
| **Expected DB Changes**   | None — the `Call` row stays `IN_PROGRESS` forever                                                                                       |
| **Expected Socket/Event** | None; no `call:ended` emitted                                                                                                           |
| **Notes**                 | GAP: no disconnect→auto-end. Stale IN_PROGRESS/RINGING rows are never reconciled; no ringing-timeout sweeper. Significant maturity gap. |
