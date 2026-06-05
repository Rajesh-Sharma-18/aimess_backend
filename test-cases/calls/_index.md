# Calls — Test Case Index

Module prefix: `TC-CALL-NNN`. Voice/video 1:1 call signaling (WebRTC). The control plane is **socket-only** on the `/chat` namespace; only call history and the RTC config are REST. Backend is **signaling-only** (media is P2P / TURN).

## Files

| File                    | Scope                                                           | IDs               |
| ----------------------- | --------------------------------------------------------------- | ----------------- |
| `initiate-call.md`      | `call:initiate` socket event — create RINGING call, ring callee | TC-CALL-001 … 017 |
| `accept-reject-call.md` | `call:answer` / `call:decline` socket events                    | TC-CALL-018 … 028 |
| `end-call.md`           | `call:end` socket event + disconnect edge cases                 | TC-CALL-029 … 037 |
| `call-history.md`       | `GET /api/chat/calls`, `GET /api/chat/calls/:callId` (REST)     | TC-CALL-038 … 050 |
| `webrtc-signaling.md`   | `call:ice` relay + `call:*` room/server→client events           | TC-CALL-051 … 059 |
| `turn-credentials.md`   | `GET /api/v1/webrtc/rtc-config` + inline rtcConfig (STUN/TURN)  | TC-CALL-060 … 068 |

Total: **68** test cases.

## Endpoints / events covered

REST (chat-service base `/api/chat`, gateway prefix `/api/chat`; webrtc on `/api/v1`):

- `GET /api/chat/calls` — paginated history (scoped to participant)
- `GET /api/chat/calls/:callId` — single call (NOT participant-scoped — AuthZ gap)
- `GET /api/v1/webrtc/rtc-config` — ICE/STUN/TURN config

Socket `/chat` (client→server): `call:initiate`, `call:answer`, `call:decline`, `call:end`, `call:ice`.
Socket `/chat` (server→client): `call:incoming`, `call:answered`, `call:declined`, `call:ended`, `call:ice`.

DB: single MongoDB `Call` model (chat-service Prisma). Lifecycle status: `RINGING → IN_PROGRESS → ENDED`, plus terminal `DECLINED`. Fields: `callId`(UUID), `callerId`, `calleeId`, `type`(AUDIO|VIDEO), `status`, `privateRoomId?`, `initiatedAt`, `answeredAt?`, `endedAt?`, `durationSec?`, `endedBy?`.

## Category coverage

Happy Path · Input Validation · Required/Optional Params · AuthN · AuthZ · Business Rule · DB State · Error Handling · Edge Case · Rate Limit · Pagination · Concurrency · Security. (No RBAC/File-Upload — N/A for calls.)

## Implementation maturity — GAPS & ambiguities

**The calling feature is thin/early-stage.** Persistence + the four control events + ICE relay exist, but most call-quality safeguards do not:

1. **No group calls.** Strictly 1:1. No conference model, member cap, or group-call events. (Task brief asks for group-call caps — none exist.)
2. **No SDP offer/answer signaling.** Only `call:ice` is implemented. There is no `call:offer`/`call:answer-sdp` event — clients must exchange SDP out-of-band. Major gap.
3. **`call:*` room is never joined (likely bug).** `chat.ns.ts` emits `call:answered`/`ended`/`ice` to room `call:<callId>` but no socket ever `join("call:<callId>")`. As read, these never reach the caller. **Verify wiring** (TC-CALL-059).
4. **Self-call allowed** (TC-CALL-012) — no `calleeId !== callerId` guard.
5. **No friendship/reachability check.** Block enforcement is opt-in (only if caller supplies `privateRoomId`) and bypassable by omitting it (TC-CALL-011). No callee-existence check (TC-CALL-013).
6. **No busy/already-in-call state.** Unlimited concurrent calls per user (TC-CALL-014).
7. **No ringing timeout / no disconnect→auto-end.** RINGING/IN_PROGRESS rows go stale forever on network drop (TC-CALL-037, 015). No sweeper job, no FCM missed-call fallback.
8. **No rate limiting** on call events — spam-able (TC-CALL-017).
9. **AuthZ gap on `GET /calls/:callId`** — any authed user can read any call's metadata (TC-CALL-049).
10. **`call:ice` has no participant check** — any authed user knowing a `callId` can inject ICE into a victim call; `candidate:z.unknown()` (no shape/size validation beyond 1 MB) (TC-CALL-055/056).
11. **TURN creds are static, long-lived, shared** — not ephemeral per-user Coturn HMAC. No TTL/scoping/rotation (TC-CALL-067). `webrtc.routes.ts` adds no per-route auth — **verify** global gateway auth on `/api/v1/webrtc` (TC-CALL-066).
12. **Concurrency races** — answer/decline/end use read-then-write without atomic conditional updates; double-accept / simultaneous-hangup can emit duplicate events or overwrite fields (TC-CALL-026/027/036). Clients must treat `call:*` as idempotent.
13. **Error code flattening** — gateway maps every downstream gRPC error to `SERVICE_ERROR`; specific codes (`CALL_BLOCKED`, `CALL_NOT_PARTICIPANT`, `CALL_NOT_RINGING`, `CALL_ALREADY_ENDED`, `CALL_NOT_FOUND`) are lost to socket clients.

## Overlap

Socket connection/auth handshake and the namespace contract overlap with `websocket-events/`. This module focuses on call-specific payloads, rules, DB writes, and emissions.
