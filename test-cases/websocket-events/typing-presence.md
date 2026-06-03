# WebSocket — Typing Indicators & Presence

Typing (`typing:start`/`typing:stop`) are fire-and-forget broadcasts emitted by
the gateway directly to `conv:<id>` (no gRPC, no persistence). Presence is
heartbeat + subscribe model: `presence:connect` runs on `/chat` connect,
`presence:heartbeat` keeps a user online, `presence:subscribe`/`unsubscribe`
joins/leaves other users' `user:<peerId>` rooms to receive `presence:status`.

**Source:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`,
`docs/SOCKET_EVENTS.md` §4, §7.2, §7.4.

---

### TC-WS-070 — typing:start broadcasts to conv room

| Field                     | Value                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                                                                                                       |
| **API/Event Name**        | `client→server: typing:start`                                                                                                            |
| **Test Scenario**         | Happy path — A starts typing; peers in the room are notified                                                                             |
| **Category**              | Happy Path                                                                                                                               |
| **Priority**              | Medium                                                                                                                                   |
| **Preconditions**         | A and B both in `conv:<id>`                                                                                                              |
| **Request Payload**       | `{ conversationId }`                                                                                                                     |
| **Expected Response**     | No ack (fire-and-forget)                                                                                                                 |
| **Expected DB Changes**   | None                                                                                                                                     |
| **Expected Socket/Event** | Gateway emits `typing:start { userId:A, conversationId }` to `conv:<id>` (including A — emitted to the whole room, not excluding sender) |
| **Notes**                 | Emitted directly by the gateway via `chat.to(...)`, not through Redis/chat-service. `userId` is the authed user, not from payload.       |

### TC-WS-071 — typing:stop broadcasts to conv room

| Field                     | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Typing                                        |
| **API/Event Name**        | `client→server: typing:stop`                              |
| **Test Scenario**         | Happy path — A stops typing                               |
| **Category**              | Happy Path                                                |
| **Priority**              | Low                                                       |
| **Preconditions**         | A in `conv:<id>`                                          |
| **Request Payload**       | `{ conversationId }`                                      |
| **Expected Response**     | No ack                                                    |
| **Expected DB Changes**   | None                                                      |
| **Expected Socket/Event** | `typing:stop { userId:A, conversationId }` to `conv:<id>` |
| **Notes**                 | Client should also auto-stop after a timeout.             |

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
