# WebSocket — Typing Indicators & Presence

Typing (`typing:start`/`typing:stop`) are fire-and-forget broadcasts emitted by
the gateway directly to `conv:<id>` (`/chat`) and `community:<communityId>`
(`/community`) — no gRPC at emit time, no persistence. Each broadcast is
**enriched** with server-authoritative sender identity:
`{ conversationId, userId, userDetails:{ userId, username, displayName, avatarUrl|null }, timestamp, senderName }`
(community broadcasts also carry `communityId`). `userDetails` is resolved **once
per namespace connection** at handshake (gRPC `UserService.BulkGetUserSnapshots` +
media avatar presign) and cached on `socket.data.userDetails` — never per typing
event. `userId` is always `socket.data.userId` (never client-trusted);
`senderName == userDetails.displayName`. The same enriched shape is emitted on the
server's 6 s auto-expiry stop and the disconnect-flush stop. Presence is heartbeat

- subscribe model: `presence:connect` runs on `/chat` connect,
  `presence:heartbeat` keeps a user online, `presence:subscribe`/`unsubscribe`
  joins/leaves other users' `user:<peerId>` rooms to receive `presence:status`.

**Source:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`,
`apps/api-gateway/src/sockets/namespaces/community.ns.ts`,
`apps/api-gateway/src/sockets/user-details.ts`,
`docs/SOCKET_EVENTS.md` §4, §5, §7.2, §7.4, §8.6.

---

### TC-WS-070 — typing:start broadcasts to conv room

| Field                     | Value                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                                                                                                                                                                                                                                                                                                                                                            |
| **API/Event Name**        | `client→server: typing:start`                                                                                                                                                                                                                                                                                                                                                                 |
| **Test Scenario**         | Happy path — A starts typing; peers in the room are notified                                                                                                                                                                                                                                                                                                                                  |
| **Category**              | Happy Path                                                                                                                                                                                                                                                                                                                                                                                    |
| **Priority**              | Medium                                                                                                                                                                                                                                                                                                                                                                                        |
| **Preconditions**         | A and B both in `conv:<id>`                                                                                                                                                                                                                                                                                                                                                                   |
| **Request Payload**       | `{ conversationId }` (optional `senderName`, legacy)                                                                                                                                                                                                                                                                                                                                          |
| **Expected Response**     | No ack (fire-and-forget)                                                                                                                                                                                                                                                                                                                                                                      |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                                                                                                                                                          |
| **Expected Socket/Event** | Gateway emits enriched `typing:start { conversationId, userId:A, userDetails:{ userId:A, username, displayName, avatarUrl\|null }, timestamp:ISO-8601, senderName }` to `conv:<id>` (including A — whole room, not excluding sender). Assert `userId === A` (server-authoritative, ignores any client-sent userId), `senderName === userDetails.displayName`, `timestamp` parses as ISO-8601. |
| **Notes**                 | Emitted directly by the gateway via `chat.to(...)`, not through Redis/chat-service. `userDetails` comes from `socket.data.userDetails` (resolved once at connect), not fetched per event. `userId` is the authed user, not from payload.                                                                                                                                                      |

### TC-WS-071 — typing:stop broadcasts to conv room

| Field                     | Value                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                                                                                                     |
| **API/Event Name**        | `client→server: typing:stop`                                                                                                           |
| **Test Scenario**         | Happy path — A stops typing                                                                                                            |
| **Category**              | Happy Path                                                                                                                             |
| **Priority**              | Low                                                                                                                                    |
| **Preconditions**         | A in `conv:<id>`                                                                                                                       |
| **Request Payload**       | `{ conversationId }` (optional `senderName`, legacy)                                                                                   |
| **Expected Response**     | No ack                                                                                                                                 |
| **Expected Socket/Event** | Enriched `typing:stop { conversationId, userId:A, userDetails, timestamp, senderName }` to `conv:<id>` — same shape as `typing:start`. |
| **Expected DB Changes**   | None                                                                                                                                   |
| **Notes**                 | Client should also auto-stop after a timeout. `userDetails` from the cached `socket.data.userDetails`.                                 |

### TC-WS-072 — typing:start malformed payload silently dropped

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                                            |
| **API/Event Name**        | `client→server: typing:start`                                                 |
| **Test Scenario**         | Input validation — missing `conversationId`                                   |
| **Category**              | Input Validation                                                              |
| **Priority**              | Low                                                                           |
| **Preconditions**         | Connected                                                                     |
| **Request Payload**       | `{}`                                                                          |
| **Expected Response**     | Nothing (no ack)                                                              |
| **Expected DB Changes**   | None                                                                          |
| **Expected Socket/Event** | No broadcast                                                                  |
| **Notes**                 | `TypingSchema` requires `conversationId.min(1)`; `safeParse` fail → `return`. |

### TC-WS-073 — Typing flood (rate / event spam)

| Field                     | Value                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                                                                                                                         |
| **API/Event Name**        | `client→server: typing:start`                                                                                                                              |
| **Test Scenario**         | Rate limit — client emits `typing:start` hundreds of times per second                                                                                      |
| **Category**              | Rate Limit                                                                                                                                                 |
| **Priority**              | Medium                                                                                                                                                     |
| **Preconditions**         | A in `conv:<id>`                                                                                                                                           |
| **Request Payload**       | rapid repeated `{ conversationId }`                                                                                                                        |
| **Expected Response**     | **GAP:** no server-side throttle/rate-limit on typing events; every emit fans out to the room                                                              |
| **Expected DB Changes**   | None                                                                                                                                                       |
| **Expected Socket/Event** | Each emit broadcasts `typing:start`, amplifying fan-out to all room members                                                                                |
| **Notes**                 | Recommend client-side debounce + server-side rate guard. Document as a known DoS-amplification gap (no rate limiting on any fire-and-forget socket event). |

### TC-WS-074 — AuthZ: typing into a conv you're not a member of

| Field                     | Value                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                                                            |
| **API/Event Name**        | `client→server: typing:start`                                                                 |
| **Test Scenario**         | Security — emit typing with a conversationId; sender need not even be in the room             |
| **Category**              | Security                                                                                      |
| **Priority**              | Medium                                                                                        |
| **Preconditions**         | Connected; arbitrary `conversationId`                                                         |
| **Request Payload**       | `{ conversationId:"<arbitrary>" }`                                                            |
| **Expected Response**     | No ack; **GAP:** gateway broadcasts to `conv:<id>` regardless of sender membership            |
| **Expected DB Changes**   | None                                                                                          |
| **Expected Socket/Event** | Members in that room receive a spoof `typing:start { userId:attacker }`                       |
| **Notes**                 | No membership check before broadcasting typing. Low data-impact but enables nuisance/probing. |

### TC-WS-075 — presence:connect on /chat connect

| Field                     | Value                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Presence                                                                                                                             |
| **API/Event Name**        | `connect` side effect (presenceConnect gRPC)                                                                                                     |
| **Test Scenario**         | Happy path — connecting `/chat` marks user online                                                                                                |
| **Category**              | Happy Path                                                                                                                                       |
| **Priority**              | Medium                                                                                                                                           |
| **Preconditions**         | Valid `/chat` connect                                                                                                                            |
| **Request Payload**       | handshake query `platform`, `clientType` (optional)                                                                                              |
| **Expected Response**     | None to client                                                                                                                                   |
| **Expected DB Changes**   | chat-service presence records user online with `{ deviceId, platform, clientType, appState:"FOREGROUND" }`                                       |
| **Expected Socket/Event** | Peers subscribed to this `user:<id>` may receive `presence:status { isOnline:true }`                                                             |
| **Notes**                 | `platform`/`clientType` resolved from query or `x-platform`/`x-client-type` headers, default `"unknown"`. Best-effort; failure logged not fatal. |

### TC-WS-076 — presence:heartbeat keeps user online

| Field                     | Value                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Presence                                                                                                 |
| **API/Event Name**        | `client→server: presence:heartbeat`                                                                                  |
| **Test Scenario**         | Happy path — periodic heartbeat refreshes online TTL                                                                 |
| **Category**              | Happy Path                                                                                                           |
| **Priority**              | Medium                                                                                                               |
| **Preconditions**         | Connected `/chat`                                                                                                    |
| **Request Payload**       | `{ appState:"FOREGROUND" }` (or `{}` → defaults FOREGROUND)                                                          |
| **Expected Response**     | No ack (fire-and-forget)                                                                                             |
| **Expected DB Changes**   | Presence TTL refreshed in chat-service                                                                               |
| **Expected Socket/Event** | May emit `presence:status` to watchers on state transitions (e.g. BACKGROUND)                                        |
| **Notes**                 | `deviceId = sessionId ?? socket.id`. No payload validation schema — `appState` read loosely, defaults to FOREGROUND. |

### TC-WS-077 — presence:subscribe joins peers' rooms

| Field                     | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Presence                                                          |
| **API/Event Name**        | `client→server: presence:subscribe`                                           |
| **Test Scenario**         | Happy path — watch peers' presence                                            |
| **Category**              | Happy Path                                                                    |
| **Priority**              | Medium                                                                        |
| **Preconditions**         | Connected `/chat`                                                             |
| **Request Payload**       | `{ peerIds:["<B>","<C>"] }`                                                   |
| **Expected Response**     | Ack `{ success:true }`                                                        |
| **Expected DB Changes**   | None                                                                          |
| **Expected Socket/Event** | Socket joins `user:<B>`, `user:<C>`; receives their `presence:status` updates |
| **Notes**                 | `peerIds` array capped at 500 (`.max(500)`).                                  |

### TC-WS-078 — presence:subscribe over 500 peers → INVALID_PAYLOAD

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Presence                                   |
| **API/Event Name**        | `client→server: presence:subscribe`                    |
| **Test Scenario**         | Input validation — `peerIds` length > 500              |
| **Category**              | Input Validation                                       |
| **Priority**              | Low                                                    |
| **Preconditions**         | Connected                                              |
| **Request Payload**       | `{ peerIds: [501 ids] }`                               |
| **Expected Response**     | Ack `{ success:false, error:"INVALID_PAYLOAD" }`       |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | No rooms joined                                        |
| **Notes**                 | Caps the fan-out / blast radius of a single subscribe. |

### TC-WS-079 — presence:unsubscribe leaves peers' rooms

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | WebSocket / Presence                               |
| **API/Event Name**        | `client→server: presence:unsubscribe`              |
| **Test Scenario**         | Happy path — stop watching peers                   |
| **Category**              | Happy Path                                         |
| **Priority**              | Low                                                |
| **Preconditions**         | Subscribed to `user:<B>`                           |
| **Request Payload**       | `{ peerIds:["<B>"] }`                              |
| **Expected Response**     | Ack `{ success:true }`                             |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | Leaves `user:<B>`; no more `presence:status` for B |
| **Notes**                 | Same schema/cap as subscribe.                      |

### TC-WS-080 — Security: subscribe to arbitrary peers (presence enumeration)

| Field                     | Value                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Presence                                                                                                     |
| **API/Event Name**        | `client→server: presence:subscribe`                                                                                      |
| **Test Scenario**         | Security — subscribe to 500 unrelated userIds to harvest online/last-seen status                                         |
| **Category**              | Security                                                                                                                 |
| **Priority**              | Medium                                                                                                                   |
| **Preconditions**         | Connected; list of target userIds                                                                                        |
| **Request Payload**       | `{ peerIds:[…non-friends…] }`                                                                                            |
| **Expected Response**     | Ack `{ success:true }`; **GAP:** no friendship/visibility check — `presence:status` for any subscribed peer is delivered |
| **Expected DB Changes**   | None                                                                                                                     |
| **Expected Socket/Event** | Attacker receives `presence:status` for arbitrary users they have no relationship with                                   |
| **Notes**                 | Privacy gap: presence visibility is not gated by friendship or privacy settings. Recommend authorization on subscribe.   |

### TC-WS-081 — presence:status delivered on peer state change

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Presence                                                                               |
| **API/Event Name**        | `server→client: presence:status`                                                                   |
| **Test Scenario**         | DB state — watched peer goes online/offline                                                        |
| **Category**              | DB State                                                                                           |
| **Priority**              | Medium                                                                                             |
| **Preconditions**         | A subscribed to `user:<B>`; B connects/disconnects                                                 |
| **Request Payload**       | n/a                                                                                                |
| **Expected Response**     | n/a                                                                                                |
| **Expected DB Changes**   | B presence row toggles                                                                             |
| **Expected Socket/Event** | A receives `presence:status { userId:B, isOnline, lastActiveAt, lastSeen }` on the `user:<B>` room |
| **Notes**                 | Published by chat-service to `user:<B>` via Redis `user:*` and re-emitted on `/chat`.              |

### TC-WS-082 — presence:disconnect on socket close

| Field                     | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Presence                                                                                     |
| **API/Event Name**        | `disconnect` side effect (presenceDisconnect gRPC)                                                       |
| **Test Scenario**         | DB state — closing the `/chat` socket marks the device offline                                           |
| **Category**              | DB State                                                                                                 |
| **Priority**              | Medium                                                                                                   |
| **Preconditions**         | Connected `/chat` socket                                                                                 |
| **Request Payload**       | n/a                                                                                                      |
| **Expected Response**     | n/a                                                                                                      |
| **Expected DB Changes**   | `presenceDisconnect({ userId, deviceId })` — device removed; user offline only when no remaining devices |
| **Expected Socket/Event** | Watchers may receive `presence:status { isOnline:false }` when last device disconnects                   |
| **Notes**                 | Best-effort; error logged. Multi-device: see concurrency cases.                                          |

### TC-WS-083 — Concurrency: multi-device presence (one device offline, user stays online)

| Field                     | Value                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Presence                                                                                                                                                                   |
| **API/Event Name**        | `connect`/`disconnect` (multi-device)                                                                                                                                                  |
| **Test Scenario**         | Concurrency — same user connected on phone + web; phone disconnects                                                                                                                    |
| **Category**              | Concurrency                                                                                                                                                                            |
| **Priority**              | Medium                                                                                                                                                                                 |
| **Preconditions**         | Two `/chat` sockets for same `userId`, distinct `deviceId` (`sessionId`)                                                                                                               |
| **Request Payload**       | n/a                                                                                                                                                                                    |
| **Expected Response**     | n/a                                                                                                                                                                                    |
| **Expected DB Changes**   | Phone device removed; user still online via web device                                                                                                                                 |
| **Expected Socket/Event** | No premature `presence:status { isOnline:false }` while another device remains                                                                                                         |
| **Notes**                 | Distinct `deviceId` per session is required for correct multi-device presence. If two sessions share a `sessionId` (and socket.id differs), the model still keys on `sessionId` first. |

### TC-WS-084 — Typing auto-expiry stop carries userDetails

| Field                     | Value                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                                                                                                                                                                                                    |
| **API/Event Name**        | `server→client: typing:stop` (6 s auto-expiry)                                                                                                                                                                                        |
| **Test Scenario**         | Reliability — A emits `typing:start` then never sends `typing:stop` (crash/drop); server auto-broadcasts stop after 6 s                                                                                                               |
| **Category**              | Reliability                                                                                                                                                                                                                           |
| **Priority**              | Medium                                                                                                                                                                                                                                |
| **Preconditions**         | A and B in `conv:<id>`; A's `socket.data.userDetails` resolved                                                                                                                                                                        |
| **Request Payload**       | `{ conversationId }` on `typing:start` only                                                                                                                                                                                           |
| **Expected Response**     | No ack                                                                                                                                                                                                                                |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                  |
| **Expected Socket/Event** | After ~6 s with no fresh `typing:start`, B receives enriched `typing:stop { conversationId, userId:A, userDetails, timestamp, senderName }` — the **same** enriched shape as a manual stop (NOT a thin `{ userId, conversationId }`). |
| **Notes**                 | Driven by the per-socket `typingTimers` 6 s `setTimeout`; the timeout callback uses `typingPayload(conversationId)`. Re-emitting `typing:start` resets the window.                                                                    |

### TC-WS-085 — Typing disconnect-flush stop carries userDetails

| Field                     | Value                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                                                                                                                                                                |
| **API/Event Name**        | `disconnect` side effect → `typing:stop` flush                                                                                                                                                    |
| **Test Scenario**         | Reliability — A is typing (active timer) in one or more convs, then the socket disconnects; server flushes a stop per active conv                                                                 |
| **Category**              | Reliability                                                                                                                                                                                       |
| **Priority**              | Medium                                                                                                                                                                                            |
| **Preconditions**         | A typing in `conv:<id1>` (and optionally `conv:<id2>`); A and B both in those rooms                                                                                                               |
| **Request Payload**       | n/a (disconnect)                                                                                                                                                                                  |
| **Expected Response**     | n/a                                                                                                                                                                                               |
| **Expected DB Changes**   | None                                                                                                                                                                                              |
| **Expected Socket/Event** | On `disconnect`, for every conversation with a pending timer, B receives enriched `typing:stop { conversationId, userId:A, userDetails, timestamp, senderName }`; `typingTimers` is then cleared. |
| **Notes**                 | The disconnect handler loops `typingTimers` and emits `typingPayload(conversationId)` per entry — no stuck "typing…" after the socket closes.                                                     |

### TC-WS-086 — Degraded fallback when user-service breaker is open

| Field                     | Value                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                                                                                                                                                                                                                                  |
| **API/Event Name**        | `client→server: typing:start` (identity resolution degraded)                                                                                                                                                                                                        |
| **Test Scenario**         | Resilience — `UserService.BulkGetUserSnapshots` breaker is open (or user-service down) at connect; typing must still broadcast with a safe degraded identity                                                                                                        |
| **Category**              | Resilience / Negative                                                                                                                                                                                                                                               |
| **Priority**              | High                                                                                                                                                                                                                                                                |
| **Preconditions**         | A connects while user gRPC is unavailable (`resolveSocketUserDetails` returns the degraded shape); A and B in `conv:<id>`                                                                                                                                           |
| **Request Payload**       | `{ conversationId }`                                                                                                                                                                                                                                                |
| **Expected Response**     | No ack                                                                                                                                                                                                                                                              |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                                |
| **Expected Socket/Event** | B receives `typing:start { conversationId, userId:A, userDetails:{ userId:A, username:"", displayName:"", avatarUrl:null }, timestamp, senderName:"" }`. The socket is **NOT** disconnected; no error is thrown; the breaker `.catch(() => null)` degrades cleanly. |
| **Notes**                 | `resolveSocketUserDetails` never throws and never blocks the socket (fire-and-forget at connect with a safe default already set). Same degraded behaviour when the snapshot is missing or the avatar presign fails (avatarUrl stays null).                          |

### TC-WS-087 — /community typing:start broadcasts to community room

| Field                     | Value                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community Typing                                                                                                                                                                                                                            |
| **API/Event Name**        | `client→server: typing:start` (`/community`)                                                                                                                                                                                                            |
| **Test Scenario**         | Happy path — A starts typing in a community; members in the room are notified                                                                                                                                                                           |
| **Category**              | Happy Path                                                                                                                                                                                                                                              |
| **Preconditions**         | A and B both in `community:<communityId>`; A's `socket.data.userDetails` resolved                                                                                                                                                                       |
| **Priority**              | Medium                                                                                                                                                                                                                                                  |
| **Request Payload**       | `{ communityId }` (optional `roomId`, `senderName`)                                                                                                                                                                                                     |
| **Expected Response**     | No ack (fire-and-forget)                                                                                                                                                                                                                                |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                    |
| **Expected Socket/Event** | Gateway emits enriched `typing:start { conversationId:(==communityId), communityId, userId:A, userDetails, timestamp, senderName }` to `community:<communityId>`. Assert both `conversationId` and `communityId` equal the communityId; `userId === A`. |
| **Notes**                 | Mirrors `/chat` typing; emitted via `community.to('community:'+communityId)`. Validated by `CommunityTypingSchema` (`communityId` required). `userId` server-authoritative.                                                                             |

### TC-WS-088 — /community typing:stop broadcasts to community room

| Field                     | Value                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community Typing                                                                                                                       |
| **API/Event Name**        | `client→server: typing:stop` (`/community`)                                                                                                        |
| **Test Scenario**         | Happy path — A stops typing in a community                                                                                                         |
| **Category**              | Happy Path                                                                                                                                         |
| **Priority**              | Low                                                                                                                                                |
| **Preconditions**         | A in `community:<communityId>`                                                                                                                     |
| **Request Payload**       | `{ communityId }` (optional `roomId`, `senderName`)                                                                                                |
| **Expected Response**     | No ack                                                                                                                                             |
| **Expected DB Changes**   | None                                                                                                                                               |
| **Expected Socket/Event** | Enriched `typing:stop { conversationId:(==communityId), communityId, userId:A, userDetails, timestamp, senderName }` to `community:<communityId>`. |
| **Notes**                 | `clearTyping(communityId)` cancels any pending auto-expiry timer for that community.                                                               |

### TC-WS-089 — /community typing malformed payload silently dropped

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community Typing                                                        |
| **API/Event Name**        | `client→server: typing:start` (`/community`)                                        |
| **Test Scenario**         | Input validation — missing `communityId`                                            |
| **Category**              | Input Validation                                                                    |
| **Priority**              | Low                                                                                 |
| **Preconditions**         | Connected `/community`                                                              |
| **Request Payload**       | `{}` (or `{ roomId }` with no `communityId`)                                        |
| **Expected Response**     | Nothing (no ack)                                                                    |
| **Expected DB Changes**   | None                                                                                |
| **Expected Socket/Event** | No broadcast                                                                        |
| **Notes**                 | `CommunityTypingSchema` requires `communityId.min(1)`; `safeParse` fail → `return`. |

### TC-WS-090 — /community typing auto-expiry stop carries userDetails

| Field                     | Value                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community Typing                                                                                                                                                        |
| **API/Event Name**        | `server→client: typing:stop` (`/community`, 6 s auto-expiry)                                                                                                                        |
| **Test Scenario**         | Reliability — A emits community `typing:start`, never sends stop; server auto-broadcasts stop after 6 s                                                                             |
| **Category**              | Reliability                                                                                                                                                                         |
| **Priority**              | Medium                                                                                                                                                                              |
| **Preconditions**         | A and B in `community:<communityId>`                                                                                                                                                |
| **Request Payload**       | `{ communityId }` on `typing:start` only                                                                                                                                            |
| **Expected Response**     | No ack                                                                                                                                                                              |
| **Expected DB Changes**   | None                                                                                                                                                                                |
| **Expected Socket/Event** | After ~6 s, B receives enriched `typing:stop { conversationId, communityId, userId:A, userDetails, timestamp, senderName }` — same shape as a manual stop.                          |
| **Notes**                 | Per-socket community `typingTimers` 6 s `setTimeout`, callback uses `communityTypingPayload(communityId)`. Disconnect also flushes a stop per active community (mirrors TC-WS-085). |

### TC-WS-091 — /community typing degraded fallback (user-service breaker open)

| Field                     | Value                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Community Typing                                                                                                                                                                             |
| **API/Event Name**        | `client→server: typing:start` (`/community`)                                                                                                                                                             |
| **Test Scenario**         | Resilience — user gRPC unavailable at `/community` connect; typing still broadcasts a safe degraded identity                                                                                             |
| **Category**              | Resilience / Negative                                                                                                                                                                                    |
| **Priority**              | High                                                                                                                                                                                                     |
| **Preconditions**         | A connects to `/community` while user gRPC is down; A and B in `community:<communityId>`                                                                                                                 |
| **Request Payload**       | `{ communityId }`                                                                                                                                                                                        |
| **Expected Response**     | No ack                                                                                                                                                                                                   |
| **Expected DB Changes**   | None                                                                                                                                                                                                     |
| **Expected Socket/Event** | B receives `typing:start { conversationId, communityId, userId:A, userDetails:{ userId:A, username:"", displayName:"", avatarUrl:null }, timestamp, senderName:"" }`. Socket NOT disconnected; no throw. |
| **Notes**                 | Same `resolveSocketUserDetails` degraded path as TC-WS-086, on the `/community` namespace.                                                                                                               |
