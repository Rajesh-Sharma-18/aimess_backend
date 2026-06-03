# Calls — Accept / Reject (Answer & Decline)

Source: `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` (`call:answer`, `call:decline`) → gRPC `messagingClient.answerCall` / `declineCall` → `apps/chat-service/src/grpc/server.ts` → `apps/chat-service/src/services/call.service.ts` (`answerCall`, `declineCall`).

`callee Id` is derived from the JWT (`{ ...r.data, calleeId: userId }`). Both schemas are `{ callId: string.min(1) }`. Business rules (service layer):

- Call must exist (`NotFoundError("CALL_NOT_FOUND")`).
- Acting user must be the **callee** (`ForbiddenError("CALL_NOT_PARTICIPANT")`) — only the callee can answer/decline.
- Call must be in `RINGING` (`BadRequestError("CALL_NOT_RINGING")`).

answer → `status:IN_PROGRESS, answeredAt:now`, publishes `call:answered` to `call:<callId>`.
decline → `status:DECLINED, endedAt:now, endedBy:callee`, publishes `call:declined` to `call:<callId>`.

All three service errors surface at the gateway as ack `{ success:false, error:"SERVICE_ERROR" }` (gRPC INTERNAL) — the specific code/HTTP status is lost. This is a documented gap.

---

### TC-CALL-018 — Answer a ringing call (happy path)

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Answer                                                                                                |
| **API/Event Name**        | `call:answer` (socket `/chat`)                                                                                |
| **Test Scenario**         | Callee B accepts a RINGING call                                                                               |
| **Category**              | Happy Path                                                                                                    |
| **Priority**              | High                                                                                                          |
| **Preconditions**         | `Call{ callId, calleeId:B, status:RINGING }`; B connected                                                     |
| **Request Payload**       | `{ "callId": "<callId>" }`                                                                                    |
| **Expected Response**     | ack `{ success:true, data:{ callId, status:"IN_PROGRESS" } }`                                                 |
| **Expected DB Changes**   | `Call.status="IN_PROGRESS"`, `answeredAt=now`                                                                 |
| **Expected Socket/Event** | `call:answered` → `call:<callId>` `{ callId }` (caller, in `call:<callId>` via `call:*` pattern, receives it) |
| **Notes**                 | `answeredAt` later drives `durationSec` on end.                                                               |

### TC-CALL-019 — Decline a ringing call (happy path)

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Calls / Decline                                            |
| **API/Event Name**        | `call:decline` (socket `/chat`)                            |
| **Test Scenario**         | Callee B rejects a RINGING call                            |
| **Category**              | Happy Path                                                 |
| **Priority**              | High                                                       |
| **Preconditions**         | `Call{ callId, calleeId:B, status:RINGING }`; B connected  |
| **Request Payload**       | `{ "callId": "<callId>" }`                                 |
| **Expected Response**     | ack `{ success:true, data:{ callId, status:"DECLINED" } }` |
| **Expected DB Changes**   | `Call.status="DECLINED"`, `endedAt=now`, `endedBy=B`       |
| **Expected Socket/Event** | `call:declined` → `call:<callId>` `{ callId }`             |
| **Notes**                 | —                                                          |

### TC-CALL-020 — Answer non-existent callId → not found

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Calls / Answer                                                     |
| **API/Event Name**        | `call:answer` (socket `/chat`)                                     |
| **Test Scenario**         | `callId` does not exist                                            |
| **Category**              | Error Handling                                                     |
| **Priority**              | High                                                               |
| **Preconditions**         | No `Call` with that id                                             |
| **Request Payload**       | `{ "callId": "missing" }`                                          |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }`                     |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | `NotFoundError("CALL_NOT_FOUND")` → gRPC INTERNAL → SERVICE_ERROR. |

### TC-CALL-021 — Caller cannot answer their own call (AuthZ)

| Field                     | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Calls / Answer                                                                             |
| **API/Event Name**        | `call:answer` (socket `/chat`)                                                             |
| **Test Scenario**         | The caller A emits `call:answer` for their own call                                        |
| **Category**              | AuthZ                                                                                      |
| **Priority**              | High                                                                                       |
| **Preconditions**         | `Call{ callerId:A, calleeId:B, status:RINGING }`; A connected                              |
| **Request Payload**       | `{ "callId": "<callId>" }` (by A)                                                          |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }`                                             |
| **Expected DB Changes**   | None                                                                                       |
| **Expected Socket/Event** | None                                                                                       |
| **Notes**                 | `call.calleeId !== A` → `ForbiddenError("CALL_NOT_PARTICIPANT")`. Only the callee answers. |

### TC-CALL-022 — Third party cannot answer/decline (AuthZ)

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Answer & Decline                                                                    |
| **API/Event Name**        | `call:answer` / `call:decline` (socket `/chat`)                                             |
| **Test Scenario**         | Uninvolved user C tries to answer/decline A↔B call                                          |
| **Category**              | AuthZ                                                                                       |
| **Priority**              | High                                                                                        |
| **Preconditions**         | `Call{ callerId:A, calleeId:B }`; C connected                                               |
| **Request Payload**       | `{ "callId": "<callId>" }` (by C)                                                           |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }`                                              |
| **Expected DB Changes**   | None                                                                                        |
| **Expected Socket/Event** | None                                                                                        |
| **Notes**                 | `CALL_NOT_PARTICIPANT`. C never learns the call exists otherwise (not in `call:<id>` room). |

### TC-CALL-023 — Answer an already-answered call → not ringing

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Calls / Answer                                                |
| **API/Event Name**        | `call:answer` (socket `/chat`)                                |
| **Test Scenario**         | Call already `IN_PROGRESS`                                    |
| **Category**              | Business Rule                                                 |
| **Priority**              | High                                                          |
| **Preconditions**         | `Call.status="IN_PROGRESS"`                                   |
| **Request Payload**       | `{ "callId": "<callId>" }`                                    |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }`                |
| **Expected DB Changes**   | None                                                          |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | `status !== RINGING` → `BadRequestError("CALL_NOT_RINGING")`. |

### TC-CALL-024 — Decline an already-ended/declined call → not ringing

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Calls / Decline                                |
| **API/Event Name**        | `call:decline` (socket `/chat`)                |
| **Test Scenario**         | Call already `DECLINED`/`ENDED`                |
| **Category**              | Business Rule                                  |
| **Priority**              | Medium                                         |
| **Preconditions**         | `Call.status="DECLINED"`                       |
| **Request Payload**       | `{ "callId": "<callId>" }`                     |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }` |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | Same `CALL_NOT_RINGING` guard.                 |

### TC-CALL-025 — Answer rejects empty/missing callId (validation)

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Calls / Answer                                          |
| **API/Event Name**        | `call:answer` (socket `/chat`)                          |
| **Test Scenario**         | `callId:""` or missing                                  |
| **Category**              | Input Validation                                        |
| **Priority**              | Medium                                                  |
| **Preconditions**         | B connected                                             |
| **Request Payload**       | `{ "callId": "" }`                                      |
| **Expected Response**     | ack `{ success:false, error:"INVALID_PAYLOAD" }`        |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | `min(1)` Zod guard at gateway; same for `call:decline`. |

### TC-CALL-026 — Double-accept race (concurrency)

| Field                     | Value                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Answer                                                                                                                |
| **API/Event Name**        | `call:answer` (socket `/chat`)                                                                                                |
| **Test Scenario**         | B (e.g. two devices) emits `call:answer` twice nearly simultaneously                                                          |
| **Category**              | Concurrency                                                                                                                   |
| **Priority**              | Medium                                                                                                                        |
| **Preconditions**         | `Call.status=RINGING`; two B sockets                                                                                          |
| **Request Payload**       | `{ "callId":"<callId>" }` ×2                                                                                                  |
| **Expected Response**     | One ack `success:true (IN_PROGRESS)`; the other likely `SERVICE_ERROR` (CALL_NOT_RINGING) — but a true race may let both pass |
| **Expected DB Changes**   | `status` ends IN_PROGRESS; `answeredAt` may be overwritten by the 2nd write                                                   |
| **Expected Socket/Event** | Possibly **two** `call:answered` emits                                                                                        |
| **Notes**                 | GAP: status transition is read-then-write without an atomic conditional update; no row lock. Both may emit `call:answered`.   |

### TC-CALL-027 — Answer + decline race (concurrency)

| Field                     | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Answer & Decline                                                     |
| **API/Event Name**        | `call:answer` + `call:decline` (socket `/chat`)                              |
| **Test Scenario**         | B answers on one device while declining on another                           |
| **Category**              | Concurrency                                                                  |
| **Priority**              | Low                                                                          |
| **Preconditions**         | `Call.status=RINGING`; two B sockets                                         |
| **Request Payload**       | `call:answer{callId}` and `call:decline{callId}` interleaved                 |
| **Expected Response**     | One wins (success); the loser gets SERVICE_ERROR if the status already moved |
| **Expected DB Changes**   | Final status non-deterministic under a tight race                            |
| **Expected Socket/Event** | One of `call:answered`/`call:declined`; possibly both under race             |
| **Notes**                 | GAP: no atomic guard; documented inconsistency risk.                         |

### TC-CALL-028 — Answer/decline downstream service failure

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Calls / Answer & Decline                                |
| **API/Event Name**        | `call:answer` / `call:decline` (socket `/chat`)         |
| **Test Scenario**         | chat-service gRPC unreachable / throws                  |
| **Category**              | Error Handling                                          |
| **Priority**              | Medium                                                  |
| **Preconditions**         | chat-service down or circuit open                       |
| **Request Payload**       | `{ "callId":"<callId>" }`                               |
| **Expected Response**     | ack `{ success:false, error:"SERVICE_ERROR" }`          |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None; warn logged at gateway                            |
| **Notes**                 | Gateway `.catch` maps all gRPC errors to SERVICE_ERROR. |
