# WebSocket — Rooms: Join / Leave

Room membership model. `user:<userId>` is joined automatically on connect (all
namespaces). `conv:<conversationId>` and `community:<communityId>` are joined via
explicit fire-and-forget client events. All join/leave events have **no ack** and
silently drop invalid payloads (`safeParse` fail → `return`).

**Source:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` (`conv:join`,
`conv:leave`), `community.ns.ts` (`community:join`, `community:leave`),
`docs/SOCKET_EVENTS.md` §2.

---

### TC-WS-020 — conv:join joins conv:<id>

| Field                     | Value                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | WebSocket / Rooms (`/chat`)                                                                                                                                                                      |
| **API/Event Name**        | `client→server: conv:join`                                                                                                                                                                       |
| **Test Scenario**         | Happy path — client joins a conversation room to receive its message events                                                                                                                      |
| **Category**              | Happy Path                                                                                                                                                                                       |
| **Priority**              | High                                                                                                                                                                                             |
| **Preconditions**         | Connected `/chat` socket                                                                                                                                                                         |
| **Request Payload**       | `{ conversationId: "<convId>" }`                                                                                                                                                                 |
| **Expected Response**     | No ack (fire-and-forget)                                                                                                                                                                         |
| **Expected DB Changes**   | None                                                                                                                                                                                             |
| **Expected Socket/Event** | Socket added to room `conv:<convId>`; now receives `message:new`, `message:edited`, `message:reaction`, `message:read`, `message:delivered`, `message:delete`, `typing:*` broadcast to that room |
| **Notes**                 | No server-side authorization that the user is a participant of the conversation — see TC-WS-024 (Security gap).                                                                                  |

### TC-WS-021 — conv:leave leaves conv:<id>

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Rooms (`/chat`)                                          |
| **API/Event Name**        | `client→server: conv:leave`                                          |
| **Test Scenario**         | Happy path — client stops receiving a conversation's events          |
| **Category**              | Happy Path                                                           |
| **Priority**              | Medium                                                               |
| **Preconditions**         | Socket joined `conv:<convId>`                                        |
| **Request Payload**       | `{ conversationId: "<convId>" }`                                     |
| **Expected Response**     | No ack                                                               |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | Removed from `conv:<convId>`; no further in-room broadcasts received |
| **Notes**                 | Leaving a room not joined is a no-op.                                |

### TC-WS-022 — conv:join with malformed payload silently dropped

| Field                     | Value                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Rooms (`/chat`)                                                               |
| **API/Event Name**        | `client→server: conv:join`                                                                |
| **Test Scenario**         | Input validation — empty/missing `conversationId`                                         |
| **Category**              | Input Validation                                                                          |
| **Priority**              | Medium                                                                                    |
| **Preconditions**         | Connected socket                                                                          |
| **Request Payload**       | `{}` or `{ conversationId: "" }` or `null`                                                |
| **Expected Response**     | Nothing — fire-and-forget, no ack, no error                                               |
| **Expected DB Changes**   | None                                                                                      |
| **Expected Socket/Event** | No room join                                                                              |
| **Notes**                 | `ConvJoinSchema` requires `conversationId: string().min(1)`; `safeParse` fail → `return`. |

### TC-WS-023 — Duplicate conv:join is idempotent

| Field                     | Value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Rooms (`/chat`)                                                     |
| **API/Event Name**        | `client→server: conv:join`                                                      |
| **Test Scenario**         | Edge — same `conv:join` emitted twice                                           |
| **Category**              | Edge Case                                                                       |
| **Priority**              | Low                                                                             |
| **Preconditions**         | Connected socket                                                                |
| **Request Payload**       | `{ conversationId: "<convId>" }` × 2                                            |
| **Expected Response**     | No ack                                                                          |
| **Expected DB Changes**   | None                                                                            |
| **Expected Socket/Event** | Socket is in room once; no duplicate event delivery (socket.io rooms are a Set) |
| **Notes**                 | Confirms broadcasts are not doubled to a re-joining socket.                     |

### TC-WS-024 — AuthZ: join a conv the user is NOT a participant of

| Field                     | Value                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Rooms (`/chat`)                                                                                                                                                                                                                                                                                                                                            |
| **API/Event Name**        | `client→server: conv:join`                                                                                                                                                                                                                                                                                                                                             |
| **Test Scenario**         | Security — attacker emits `conv:join` with a conversationId belonging to others to eavesdrop                                                                                                                                                                                                                                                                           |
| **Category**              | Security                                                                                                                                                                                                                                                                                                                                                               |
| **Priority**              | High                                                                                                                                                                                                                                                                                                                                                                   |
| **Preconditions**         | Valid socket; `convId` the user does not belong to                                                                                                                                                                                                                                                                                                                     |
| **Request Payload**       | `{ conversationId: "<someone-elses-conv>" }`                                                                                                                                                                                                                                                                                                                           |
| **Expected Response**     | No ack; **GAP:** join succeeds at the gateway (no membership check on `conv:join`)                                                                                                                                                                                                                                                                                     |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                                                                                                                                                   |
| **Expected Socket/Event** | Attacker socket joins `conv:<id>` and would receive future `message:new`/typing broadcasts for that room                                                                                                                                                                                                                                                               |
| **Notes**                 | Real mitigation is at chat-service: `message:send`/`messages:fetch`/`chat:catchup` are authorized server-side (e.g. `catchupRoom` returns `authorized:false`). But passive **eavesdropping** via room join is not blocked at the gateway. High-priority security finding — recommend membership check on `conv:join`. Room IDs are opaque IDs, mitigating enumeration. |

### TC-WS-025 — community:join joins community:<id>

| Field                     | Value                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Rooms (`/community`)                                                                                           |
| **API/Event Name**        | `client→server: community:join`                                                                                            |
| **Test Scenario**         | Happy path — join a community room to receive `community:message:new`                                                      |
| **Category**              | Happy Path                                                                                                                 |
| **Priority**              | High                                                                                                                       |
| **Preconditions**         | Connected `/community` socket                                                                                              |
| **Request Payload**       | `{ communityId: "<id>", roomId: "<roomId>" }`                                                                              |
| **Expected Response**     | No ack                                                                                                                     |
| **Expected DB Changes**   | None                                                                                                                       |
| **Expected Socket/Event** | Joins `community:<communityId>`; receives any event forwarded on the `community:<communityId>` Redis channel               |
| **Notes**                 | Both `communityId` and `roomId` are required by `CommunityJoinSchema`, though only `communityId` is used for the room key. |

### TC-WS-026 — community:join missing roomId silently dropped

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Rooms (`/community`)                                     |
| **API/Event Name**        | `client→server: community:join`                                      |
| **Test Scenario**         | Input validation — `roomId` omitted                                  |
| **Category**              | Input Validation                                                     |
| **Priority**              | Medium                                                               |
| **Preconditions**         | Connected socket                                                     |
| **Request Payload**       | `{ communityId: "<id>" }`                                            |
| **Expected Response**     | Nothing (fire-and-forget)                                            |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | No join (schema requires both fields)                                |
| **Notes**                 | Subtle: client must send `roomId` even though it is unused for join. |

### TC-WS-027 — community:leave leaves community:<id>

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | WebSocket / Rooms (`/community`)                    |
| **API/Event Name**        | `client→server: community:leave`                    |
| **Test Scenario**         | Happy path — stop receiving a community's events    |
| **Category**              | Happy Path                                          |
| **Priority**              | Medium                                              |
| **Preconditions**         | Joined `community:<id>`                             |
| **Request Payload**       | `{ communityId: "<id>" }`                           |
| **Expected Response**     | No ack                                              |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | Removed from `community:<communityId>`              |
| **Notes**                 | `CommunityLeaveSchema` requires only `communityId`. |

### TC-WS-028 — AuthZ: join a community the user is not a member of

| Field                     | Value                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Rooms (`/community`)                                                                                                                                                                          |
| **API/Event Name**        | `client→server: community:join`                                                                                                                                                                           |
| **Test Scenario**         | Security — non-member joins a community room to eavesdrop                                                                                                                                                 |
| **Category**              | Security                                                                                                                                                                                                  |
| **Priority**              | High                                                                                                                                                                                                      |
| **Preconditions**         | Valid socket; `communityId` user is not a member of                                                                                                                                                       |
| **Request Payload**       | `{ communityId: "<other>", roomId: "<other-room>" }`                                                                                                                                                      |
| **Expected Response**     | No ack; **GAP:** join succeeds (no membership check on `community:join`)                                                                                                                                  |
| **Expected DB Changes**   | None                                                                                                                                                                                                      |
| **Expected Socket/Event** | Socket would receive future `community:message:new` for that room                                                                                                                                         |
| **Notes**                 | Send-side `sendCommunityMessage` / `getCommunityMessages` are authorized server-side via `requesterId`/`senderId`, but passive listening is not gated at the gateway. Security finding mirrors TC-WS-024. |

### TC-WS-029 — Cross-namespace room isolation

| Field                     | Value                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | WebSocket / Rooms                                                                                                                                                                                                                              |
| **API/Event Name**        | room fan-out (Redis pmessage)                                                                                                                                                                                                                  |
| **Test Scenario**         | Security — `/community` socket cannot receive `/chat`-only events for the same `user:<id>` room and vice versa                                                                                                                                 |
| **Category**              | Security                                                                                                                                                                                                                                       |
| **Priority**              | High                                                                                                                                                                                                                                           |
| **Preconditions**         | User connected on both `/chat` and `/community`                                                                                                                                                                                                |
| **Request Payload**       | n/a (passive)                                                                                                                                                                                                                                  |
| **Expected Response**     | `conv:updated`/`community:updated`/`presence:status` delivered only on `/chat`; `community:message:new` only on `/community`                                                                                                                   |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                           |
| **Expected Socket/Event** | Each namespace re-emits only its own subscribed Redis patterns: `/chat` → `conv:*`,`call:*`,`user:*`; `/community` → `community:*`; `/notify` → `notify:<userId>`. Rooms with the same name in different namespaces are isolated by socket.io. |
| **Notes**                 | Confirms no cross-namespace leakage even though `user:<id>` exists in all three namespaces. `community:updated` is intentionally delivered on `/chat` (uses `user:*` pattern), not `/community`.                                               |
