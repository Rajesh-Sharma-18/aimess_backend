# Calls — ICE / TURN Credential Issuance (RTC config)

Source: `apps/api-gateway/src/routes/v1/webrtc.routes.ts` (`GET /api/v1/webrtc/rtc-config`) → gRPC `messagingClient.getRtcConfig` → `apps/chat-service/src/grpc/server.ts` (`getRtcConfig`) → `apps/chat-service/src/services/webrtc-config.service.ts` (`getRtcConfiguration` / `buildIceServers`). Also issued **inline** in the `call:initiate` ack (`rtcConfig`, see `initiate-call.md`).

The RTC config is built **from static env vars** in chat-service:

- `WEBRTC_STUN_SERVERS` (comma list) → `{ urls:[...] }`
- `WEBRTC_TURN_SERVER` + `WEBRTC_TURN_USERNAME` + `WEBRTC_TURN_PASSWORD` → `{ urls:[turn], username, credential, credentialType:"password" }`
- `WEBRTC_ICE_CANDIDATE_POOL_SIZE` (default 10), `iceTransportPolicy:"all"`.

Maturity note: TURN credentials are **long-lived static shared secrets** (env username/password), **not** per-user time-limited Coturn HMAC (`turn-rest`/`coturn` ephemeral) credentials. No expiry, no per-call scoping, no rotation. The doc references Coturn but the implementation issues the same static credential to every user on every request. This is the headline security gap for this area.

---

### TC-CALL-060 — Get RTC config with STUN + TURN configured (happy path)

| Field                     | Value                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / RTC Config                                                                                                                                                                                             |
| **API/Event Name**        | `GET /api/v1/webrtc/rtc-config`                                                                                                                                                                                |
| **Test Scenario**         | Both STUN and TURN env vars set                                                                                                                                                                                |
| **Category**              | Happy Path                                                                                                                                                                                                     |
| **Priority**              | High                                                                                                                                                                                                           |
| **Preconditions**         | `WEBRTC_STUN_SERVERS` + TURN server/user/pass all set                                                                                                                                                          |
| **Request Payload**       | `GET /api/v1/webrtc/rtc-config`                                                                                                                                                                                |
| **Expected Response**     | `200 { success:true, data:{ iceServers:[{urls:[stun]},{urls:[turn],username,credential,credentialType:"password"}], iceCandidatePoolSize, iceTransportPolicy:"all" }, message:"RTC configuration retrieved" }` |
| **Expected DB Changes**   | None                                                                                                                                                                                                           |
| **Expected Socket/Event** | None                                                                                                                                                                                                           |
| **Notes**                 | Identical config returned for every caller — static.                                                                                                                                                           |

### TC-CALL-061 — STUN only (no TURN)

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Calls / RTC Config                                         |
| **API/Event Name**        | `GET /api/v1/webrtc/rtc-config`                            |
| **Test Scenario**         | Only STUN configured                                       |
| **Category**              | Optional Params                                            |
| **Priority**              | Medium                                                     |
| **Preconditions**         | `WEBRTC_STUN_SERVERS` set; `WEBRTC_TURN_SERVER` empty      |
| **Request Payload**       | `GET /api/v1/webrtc/rtc-config`                            |
| **Expected Response**     | `200` `iceServers:[{urls:[stun...]}]` (no TURN entry)      |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | Relay (TURN) unavailable; only host/srflx candidates work. |

### TC-CALL-062 — TURN server set but credentials missing → TURN skipped

| Field                     | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / RTC Config                                                                              |
| **API/Event Name**        | `GET /api/v1/webrtc/rtc-config`                                                                 |
| **Test Scenario**         | `WEBRTC_TURN_SERVER` set but username/password blank                                            |
| **Category**              | Edge Case                                                                                       |
| **Priority**              | Medium                                                                                          |
| **Preconditions**         | TURN url set, creds empty                                                                       |
| **Request Payload**       | `GET /api/v1/webrtc/rtc-config`                                                                 |
| **Expected Response**     | `200` with TURN entry **omitted**; warn logged "TURN server configured but missing credentials" |
| **Expected DB Changes**   | None                                                                                            |
| **Expected Socket/Event** | None                                                                                            |
| **Notes**                 | `buildIceServers` only adds TURN when url+user+pass all present.                                |

### TC-CALL-063 — No ICE servers configured at all

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Calls / RTC Config                                          |
| **API/Event Name**        | `GET /api/v1/webrtc/rtc-config`                             |
| **Test Scenario**         | Neither STUN nor TURN set                                   |
| **Category**              | Edge Case                                                   |
| **Priority**              | Low                                                         |
| **Preconditions**         | Both env vars empty                                         |
| **Request Payload**       | `GET /api/v1/webrtc/rtc-config`                             |
| **Expected Response**     | `200` `iceServers:[]`; warn "No ICE servers configured"     |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | WebRTC will only connect on the same LAN (host candidates). |

### TC-CALL-064 — Multiple STUN URLs parsed from CSV

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / RTC Config                                                               |
| **API/Event Name**        | `GET /api/v1/webrtc/rtc-config`                                                  |
| **Test Scenario**         | `WEBRTC_STUN_SERVERS="stun:a,stun:b, stun:c "`                                   |
| **Category**              | Input Validation                                                                 |
| **Priority**              | Low                                                                              |
| **Preconditions**         | CSV with spaces/empties                                                          |
| **Request Payload**       | `GET /api/v1/webrtc/rtc-config`                                                  |
| **Expected Response**     | `200` single `{ urls:["stun:a","stun:b","stun:c"] }` (trimmed, empties filtered) |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | None                                                                             |
| **Notes**                 | `.split(",").map(trim).filter(Boolean)`.                                         |

### TC-CALL-065 — RTC config service unavailable → 503

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Calls / RTC Config                                                 |
| **API/Event Name**        | `GET /api/v1/webrtc/rtc-config`                                    |
| **Test Scenario**         | chat-service gRPC down / circuit open                              |
| **Category**              | Error Handling                                                     |
| **Priority**              | Medium                                                             |
| **Preconditions**         | chat-service unreachable                                           |
| **Request Payload**       | `GET /api/v1/webrtc/rtc-config`                                    |
| **Expected Response**     | `503 { data:null, message:"RTC service temporarily unavailable" }` |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | Gateway `try/catch` returns 503 on any gRPC failure.               |

### TC-CALL-066 — rtc-config requires authentication?

| Field                     | Value                                                                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / RTC Config                                                                                                                                                                                                                                               |
| **API/Event Name**        | `GET /api/v1/webrtc/rtc-config`                                                                                                                                                                                                                                  |
| **Test Scenario**         | Request without a Bearer token                                                                                                                                                                                                                                   |
| **Category**              | AuthN                                                                                                                                                                                                                                                            |
| **Priority**              | High                                                                                                                                                                                                                                                             |
| **Preconditions**         | None                                                                                                                                                                                                                                                             |
| **Request Payload**       | `GET /api/v1/webrtc/rtc-config` (no token)                                                                                                                                                                                                                       |
| **Expected Response**     | Depends on gateway-level v1 middleware — the route itself adds **no** `authenticate`                                                                                                                                                                             |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                             |
| **Expected Socket/Event** | None                                                                                                                                                                                                                                                             |
| **Notes**                 | GAP/ambiguity: `webrtc.routes.ts` has no per-route auth. **Verify** whether `/api/v1/webrtc` is behind global gateway auth. If not, TURN credentials are unauthenticated-public — combined with static creds (header gap) this exposes the TURN relay to anyone. |

### TC-CALL-067 — TURN credential scoping & expiry (security)

| Field                     | Value                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Calls / RTC Config                                                                                                                                                                                                                                                       |
| **API/Event Name**        | `GET /api/v1/webrtc/rtc-config` + `call:initiate` ack                                                                                                                                                                                                                    |
| **Test Scenario**         | Inspect whether issued TURN creds are per-user / time-limited                                                                                                                                                                                                            |
| **Category**              | Security                                                                                                                                                                                                                                                                 |
| **Priority**              | High                                                                                                                                                                                                                                                                     |
| **Preconditions**         | TURN configured                                                                                                                                                                                                                                                          |
| **Request Payload**       | call rtc-config from two different users                                                                                                                                                                                                                                 |
| **Expected Response**     | Both receive the **same** static `username`/`credential`; no TTL/expiry field                                                                                                                                                                                            |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                                     |
| **Expected Socket/Event** | None                                                                                                                                                                                                                                                                     |
| **Notes**                 | GAP: credentials are not scoped to a user or call and never expire (no Coturn `turn_rest_api` HMAC `timestamp:user` scheme). A leaked credential grants unlimited TURN relay until env rotation. Expected behavior _should_ issue ephemeral HMAC creds with a short TTL. |

### TC-CALL-068 — rtcConfig from call:initiate matches REST config (consistency)

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Calls / RTC Config                                                                 |
| **API/Event Name**        | `call:initiate` ack `.rtcConfig` vs `GET /webrtc/rtc-config`                       |
| **Test Scenario**         | Both paths return the same ICE config                                              |
| **Category**              | Happy Path                                                                         |
| **Priority**              | Low                                                                                |
| **Preconditions**         | TURN/STUN configured                                                               |
| **Request Payload**       | initiate a call; fetch rtc-config                                                  |
| **Expected Response**     | `rtcConfig` shape (iceServers, iceCandidatePoolSize, iceTransportPolicy) identical |
| **Expected DB Changes**   | None                                                                               |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | Both call `webRtcConfigService.getRtcConfiguration()`.                             |
