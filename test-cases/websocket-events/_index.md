# WebSocket Events — Test Case Index

Realtime Socket.IO contract for the AIMess **api-gateway** (`/chat`,
`/community`, `/notify` namespaces). All socket traffic terminates at the gateway;
it validates payloads (Zod), calls the owning microservice over gRPC, and fans
service-published events back out via Redis to the matching rooms.

**Sources:** `apps/api-gateway/src/sockets/{auth.middleware,index,redis}.ts`,
`apps/api-gateway/src/sockets/namespaces/{chat,community,notify}.ns.ts`,
`docs/SOCKET_EVENTS.md`.

ID prefix: `TC-WS-NNN`. Total cases: **115** (TC-WS-001 … TC-WS-236,
non-contiguous ranges per file).

## Files

| File                                                 | Range   | Cases | Focus                                                                                                                                              |
| ---------------------------------------------------- | ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [connection-auth.md](connection-auth.md)             | 001–013 | 13    | Handshake JWT auth (auth.token / Bearer), reject no/expired/forged/refresh token, CORS, 1 MB cap, state recovery, JWT replay gap                   |
| [rooms-join-leave.md](rooms-join-leave.md)           | 020–029 | 10    | `conv:join/leave`, `community:join/leave`, idempotent join, eavesdrop AuthZ gaps, cross-namespace isolation                                        |
| [chat-namespace.md](chat-namespace.md)               | 040–057 | 18    | `message:send/edit/forward/react/reactions:get`, `message:delete`, `messages:fetch`, idempotency, spoof senderId, SERVICE_ERROR, emit-before-join  |
| [typing-presence.md](typing-presence.md)             | 070–083 | 14    | `typing:start/stop`, `presence:connect/heartbeat/subscribe/unsubscribe`, `presence:status`, multi-device presence, typing flood + enumeration gaps |
| [read-receipts-unread.md](read-receipts-unread.md)   | 100–109 | 10    | `message:read/delivered`, `conv:updated`/`community:updated` bump-to-top, SYSTEM-message inbox bump, unread boolean hint, multi-device read sync   |
| [community-namespace.md](community-namespace.md)     | 120–130 | 11    | `community:message:send/fetch`, `community:message:new`, `community:member:joined`, verbatim forward, deletes on `/chat`, AuthZ/spoof              |
| [notify-namespace.md](notify-namespace.md)           | 150–159 | 10    | `notification:count`, `notifications:fetch/mark_read`, forwarded events, ref-counted subscribe lifecycle, isolation                                |
| [reconnect-catchup.md](reconnect-catchup.md)         | 170–180 | 11    | `chat:catchup` / `chat:catchup:result`, sinceSeq pagination, multi-room, tombstones, SYSTEM msgs, authorized:false, partial-failure batch          |
| [call-signaling.md](call-signaling.md)               | 200–210 | 11    | `call:initiate/answer/decline/end/ice`, `call:incoming/answered/declined/ended`, signaling-only, ICE injection gap, group-call gap                 |
| [scaling-redis-adapter.md](scaling-redis-adapter.md) | 230–236 | 7     | Redis adapter cross-instance fan-out, duplicate-delivery risk, namespace subscriber isolation, ICE cross-instance, sticky-session                  |

## Events covered

**Client → Server (26):** `conv:join` · `conv:leave` · `message:send` ·
`message:read` · `message:delivered` · `message:react` · `message:reactions:get` ·
`message:edit` · `message:forward` · `messages:fetch` · `chat:catchup` ·
`typing:start` · `typing:stop` · `presence:heartbeat` · `presence:subscribe` ·
`presence:unsubscribe` · `call:initiate` · `call:answer` · `call:decline` ·
`call:end` · `call:ice` · `community:join` · `community:leave` ·
`community:message:send` · `community:messages:fetch` · `notifications:fetch` ·
`notifications:mark_read`

**Server → Client (21):** `message:new` (incl. forward + SYSTEM) · `message:edited` ·
`conv:updated` · `community:updated` · `chat:catchup:result` · `message:read` ·
`message:delivered` · `message:reaction` · `message:delete` · `typing:start` ·
`typing:stop` · `presence:status` · `call:incoming` · `call:answered` ·
`call:declined` · `call:ended` · `call:ice` · `community:message:new` ·
`community:member:joined` · `notification:count` · _forwarded notify events_

**Connection-level:** handshake JWT auth, `connect_error`, `disconnect`,
`connectionStateRecovery`, presence connect/disconnect side effects.

Every documented event in `docs/SOCKET_EVENTS.md` §9 quick index is covered.

## Category coverage

Happy Path · Input Validation · AuthN · AuthZ · Business Rule · DB State ·
Error Handling · Edge Case · Rate Limit · File Upload · Pagination/Filter/Sort ·
Concurrency · Security — all represented.

## GAPS & ambiguities (findings)

1. **No room-membership authorization on join (HIGH).** `conv:join` (TC-WS-024) and
   `community:join` (TC-WS-028) succeed at the gateway with no check that the user
   belongs to the conversation/community. Send/fetch/catchup are authorized
   server-side (e.g. `catchupRoom` → `authorized:false`), but **passive
   eavesdropping** by joining a room and listening for `message:new`/`typing` is
   not blocked at the gateway. Mitigated only by opaque, unguessable room IDs.

2. **JWT replay after session revocation (HIGH).** `auth.middleware.ts` only
   verifies signature + expiry (`verifyAccessToken`); no session-revocation check
   (TC-WS-013). A revoked-but-unexpired access token still connects. Mitigation is
   short access-token TTL only.

3. **Presence enumeration / no visibility gate (MEDIUM).** `presence:subscribe`
   (TC-WS-080) lets a user watch up to 500 arbitrary userIds with no friendship/
   privacy check — leaks online/last-seen for non-contacts.

4. **call:ice has no participant check (HIGH).** `call:ice` (TC-WS-207) publishes to
   `call:<callId>` without verifying the user is in the call; signaling injection
   possible if `callId` is known. `from` is honest, so impact is limited, but a
   participant check is recommended.

5. **No rate limiting on fire-and-forget events (MEDIUM).** `typing:*`,
   `presence:heartbeat`, `call:ice` (TC-WS-073) have no throttle — fan-out
   amplification / DoS vector.

6. **Potential duplicate delivery under multi-instance (HIGH, needs verification).**
   Every gateway instance psubscribes `conv:*`/`call:*`/`community:*`; combined
   with the Redis adapter's cross-instance broadcast, a recipient on another
   instance may receive the same event twice (TC-WS-231). Most events are
   client-idempotent (keyed by `messageId`/`sequenceNumber`), and ICE tolerates
   duplicates (TC-WS-236), so impact is likely benign — but verify in a real
   2-instance deployment.

7. **`message:react` emoji allows empty string (LOW).** `MessageReactSchema.emoji`
   lacks `.min(1)` (TC-WS-052); empty emoji passes gateway validation and is left
   to chat-service.

8. **Community pure-media send requires non-empty `message` (LOW/UX).**
   `CommunityMsgSendSchema.message` is `.min(1)` (TC-WS-121/122), so a media-only
   community message must still carry a non-empty text — inconsistent with `/chat`
   `message:send` which allows empty `contentText`.

9. **Absolute unread count not emitted over sockets (PLANNED).** `conv:updated`/
   `community:updated` `unread` is a v1 boolean hint only (TC-WS-108); numeric
   count is a documented planned enhancement.

10. **Group call signaling absent on sockets (GAP).** Only 1-1 call events exist on
    `/chat` (TC-WS-210); group calls, if supported, go through REST `webrtc.routes`,
    not the socket layer.

11. **`/notify` mark_read does not re-push `notification:count` (MINOR).**
    TC-WS-153 — after marking read, the badge is not auto-refreshed via socket; the
    client must recompute or re-`notifications:fetch`.

12. **Doc vs code:** all events in `docs/SOCKET_EVENTS.md` §9 are implemented in
    code, and no implemented client→server event is undocumented — doc and code are
    in sync. `community:join` requiring an (unused) `roomId` field is a minor
    quirk worth noting in the doc (TC-WS-026).
