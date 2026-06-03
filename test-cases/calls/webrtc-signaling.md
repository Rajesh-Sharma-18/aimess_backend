# Calls — WebRTC Signaling (ICE relay & call rooms)

Source: `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` (`call:ice` handler, `CallIceSchema`, Redis psubscribe `call:*`) and `docs/SOCKET_EVENTS.md` §4 / §7.5.

The backend is **signaling-only** — media flows peer-to-peer / via TURN. The control plane (initiate/answer/decline/end) is covered in the sibling files; this file covers the **SDP/ICE relay** layer and the `call:<callId>` room mechanics.

Key facts:

- There is **no `offer`/`answer` SDP event in code**. The Socket.IO contract exposes only ICE relay (`call:ice`). SDP offer/answer exchange is **not implemented server-side** — clients are expected to exchange SDP out-of-band or via a not-yet-built event. This is a maturity gap.
- `call:ice` is **fire-and-forget** (no ack). Schema `{ callId: string.min(1), candidate: unknown }`. The gateway relays it via Redis `publish("call:<callId>", { event:"call:ice", data:{ callId, candidate, from:userId } })`.
- The gateway psubscribes `call:*` and re-emits any `call:*` channel message to the matching room. **Membership in `call:<callId>` is implicit** — the chat namespace forwards `call:*` Redis events; the `call:incoming`/`call:answered`/etc. events reach participants because they are in `user:<id>` / the call room is pattern-matched. (See note below on room join.)

---

### TC-CALL-051 — Relay an ICE candidate (happy path)

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Signaling                                                     |
| **API/Event Name**        | `call:ice` (socket `/chat`)                                           |
| **Test Scenario**         | Participant sends an ICE candidate; the peer receives it              |
| **Category**              | Happy Path                                                            |
| **Priority**              | High                                                                  |
| **Preconditions**         | Active call `callId`; both peers connected                            |
| **Request Payload**       | `{ "callId":"<callId>", "candidate": { ...RTCIceCandidateInit } }`    |
| **Expected Response**     | No ack (fire-and-forget)                                              |
| **Expected DB Changes**   | None — ICE is never persisted                                         |
| **Expected Socket/Event** | `call:ice` → `call:<callId>` `{ callId, candidate, from:<senderId> }` |
| **Notes**                 | `from` injected from JWT. Relayed via Redis only.                     |

### TC-CALL-052 — Invalid ICE payload silently dropped

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Signaling                                                     |
| **API/Event Name**        | `call:ice` (socket `/chat`)                                           |
| **Test Scenario**         | Missing `callId`                                                      |
| **Category**              | Input Validation                                                      |
| **Priority**              | Medium                                                                |
| **Preconditions**         | Connected                                                             |
| **Request Payload**       | `{ "candidate": {...} }` (no callId)                                  |
| **Expected Response**     | Nothing — `safeParse` fails → `return` (no ack, no error)             |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | None published                                                        |
| **Notes**                 | Fire-and-forget events drop bad input silently; validate client-side. |

### TC-CALL-053 — `candidate` accepts any shape (unknown)

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Signaling                                                             |
| **API/Event Name**        | `call:ice` (socket `/chat`)                                                   |
| **Test Scenario**         | `candidate` is a string / number / object — all pass                          |
| **Category**              | Edge Case                                                                     |
| **Priority**              | Low                                                                           |
| **Preconditions**         | Connected; valid `callId`                                                     |
| **Request Payload**       | `{ "callId":"<callId>", "candidate": "anything" }`                            |
| **Expected Response**     | No ack; relayed as-is                                                         |
| **Expected Socket/Event** | `call:ice` `{ candidate:"anything", from }`                                   |
| **Notes**                 | `candidate: z.unknown()` — no shape validation. See SDP-injection case below. |

### TC-CALL-054 — `from` is server-stamped, not client-controlled (security)

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Signaling                                                                |
| **API/Event Name**        | `call:ice` (socket `/chat`)                                                      |
| **Test Scenario**         | Client tries to set `from:"someoneElse"` in the payload                          |
| **Category**              | Security                                                                         |
| **Priority**              | High                                                                             |
| **Preconditions**         | Connected as A                                                                   |
| **Request Payload**       | `{ "callId":"<callId>", "candidate":{...}, "from":"B" }`                         |
| **Expected Response**     | Relayed with `from:A` (JWT), client `from` ignored                               |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | `call:ice` `{ from:A }`                                                          |
| **Notes**                 | Gateway hardcodes `from: userId`; `from` is not in the schema so it is stripped. |

### TC-CALL-055 — ICE relay to a call you are not part of (AuthZ gap)

| Field                     | Value                                                                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Signaling                                                                                                                                                                                                                                                    |
| **API/Event Name**        | `call:ice` (socket `/chat`)                                                                                                                                                                                                                                          |
| **Test Scenario**         | User C, not a participant, emits `call:ice` for A↔B's `callId`                                                                                                                                                                                                       |
| **Category**              | AuthZ                                                                                                                                                                                                                                                                |
| **Priority**              | High                                                                                                                                                                                                                                                                 |
| **Preconditions**         | C knows/guesses A↔B's `callId`; C connected                                                                                                                                                                                                                          |
| **Request Payload**       | `{ "callId":"<A_B_callId>", "candidate":{...} }`                                                                                                                                                                                                                     |
| **Expected Response**     | No ack; candidate **is** published to `call:<callId>`                                                                                                                                                                                                                |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                                 |
| **Expected Socket/Event** | `call:ice` `{ candidate, from:C }` delivered to the call room                                                                                                                                                                                                        |
| **Notes**                 | GAP/security: `call:ice` does **not** verify the sender is a call participant. Any authed user who knows a `callId` (a UUID) can inject ICE candidates into someone else's call. No DB lookup on the relay path. Expected behavior _should_ reject non-participants. |

### TC-CALL-056 — SDP / candidate injection (security)

| Field                     | Value                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Signaling                                                                                                                                                                     |
| **API/Event Name**        | `call:ice` (socket `/chat`)                                                                                                                                                           |
| **Test Scenario**         | Malicious/oversized `candidate` payload injected                                                                                                                                      |
| **Category**              | Security                                                                                                                                                                              |
| **Priority**              | Medium                                                                                                                                                                                |
| **Preconditions**         | Connected; valid `callId`                                                                                                                                                             |
| **Request Payload**       | `{ "callId":"<callId>", "candidate": { huge/nested/script-like blob } }`                                                                                                              |
| **Expected Response**     | Relayed verbatim (bounded only by `maxHttpBufferSize` 1 MB)                                                                                                                           |
| **Expected DB Changes**   | None                                                                                                                                                                                  |
| **Expected Socket/Event** | `call:ice` forwards the blob to the peer                                                                                                                                              |
| **Notes**                 | GAP: no `candidate` schema/size validation beyond the 1 MB socket buffer; the peer client must sanitize. Combined with TC-CALL-055 this allows candidate spoofing into a victim call. |

### TC-CALL-057 — Server→client signaling events round-trip (scenario)

| Field                     | Value                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Signaling                                                                                           |
| **API/Event Name**        | `call:incoming`/`call:answered`/`call:declined`/`call:ended`/`call:ice`                                     |
| **Test Scenario**         | Full 1:1 WebRTC handshake (initiate→answer→ICE→end)                                                         |
| **Category**              | Happy Path                                                                                                  |
| **Priority**              | High                                                                                                        |
| **Preconditions**         | A and B connected to `/chat`                                                                                |
| **Request Payload**       | sequence: `call:initiate`→`call:answer`→`call:ice`×N→`call:end`                                             |
| **Expected Response**     | acks as per each event; B rings, both exchange ICE, both see `call:ended`                                   |
| **Expected DB Changes**   | RINGING→IN_PROGRESS→ENDED lifecycle on one `Call`                                                           |
| **Expected Socket/Event** | `call:incoming`(user:B) → `call:answered`(call:id) → `call:ice`(call:id, both ways) → `call:ended`(call:id) |
| **Notes**                 | Mirrors `docs/SOCKET_EVENTS.md` §7.5. No SDP offer/answer events exist — see file header gap.               |

### TC-CALL-058 — `call:incoming` delivered to callee's user room

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Signaling                                                     |
| **API/Event Name**        | `call:incoming` (server→client)                                       |
| **Test Scenario**         | Callee receives the ring on `user:<calleeId>`                         |
| **Category**              | Happy Path                                                            |
| **Priority**              | High                                                                  |
| **Preconditions**         | B joined `user:B` on connect                                          |
| **Request Payload**       | n/a (triggered by A's `call:initiate`)                                |
| **Expected Response**     | B receives `call:incoming { callId, callerId, type }`                 |
| **Expected DB Changes**   | None (already created at initiate)                                    |
| **Expected Socket/Event** | `call:incoming` → `user:B`                                            |
| **Notes**                 | Published to channel `user:<calleeId>`; gateway psubscribes `user:*`. |

### TC-CALL-059 — `call:answered`/`ended`/`declined` reach the caller via call room

| Field                     | Value                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / Signaling                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **API/Event Name**        | `call:answered`/`call:declined`/`call:ended` (server→client)                                                                                                                                                                                                                                                                                                                                                                                      |
| **Test Scenario**         | Caller learns the call's outcome                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Category**              | Happy Path                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Priority**              | High                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Preconditions**         | An active call `callId`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Request Payload**       | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Expected Response**     | Caller receives the matching `call:*` event on `call:<callId>`                                                                                                                                                                                                                                                                                                                                                                                    |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Expected Socket/Event** | `call:answered`/`declined`/`ended` → `call:<callId>`                                                                                                                                                                                                                                                                                                                                                                                              |
| **Notes**                 | GAP/ambiguity: code never calls `socket.join("call:<callId>")` for these events. The gateway psubscribes `call:*` and re-emits to a room of the same name — but participants are not explicitly joined to `call:<callId>` anywhere in `chat.ns.ts`. Delivery of `call:answered`/`ended`/`ice` to the caller relies on a join that is not present in the read code. **Verify room membership wiring** — likely a real bug or an undocumented join. |
