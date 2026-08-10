# Private Chat (PCHAT) — Test Case Index

Module: **1:1 messaging in chat-service**. ID prefix `TC-PCHAT-NNN` (001–133).

> **Sources:** `apps/chat-service/src/api/routes/{private-message,inbox,media}.routes.ts` →
> controllers → validators → services → repositories; `docs/SOCKET_EVENTS.md` `/chat` namespace.
> 1:1 **message creation, reactions, read/delivery receipts, typing** are **Socket.IO** events
> (`/chat`), not REST — REST covers list/search/media/edit/delete/forward/report/reactions-GET/
> rooms/inbox/presence/upload.

## Files

| File                     | Surface(s) covered                                                          | Cases | Range   |
| ------------------------ | --------------------------------------------------------------------------- | ----- | ------- |
| `send-message.md`        | `message:send` (socket) + service rules, media/text caps, friendship gate   | 18    | 001–018 |
| `get-conversation.md`    | rooms get/create, timeline, search, conv-list, delete/mute/unmute, presence | 20    | 019–038 |
| `edit-message.md`        | `PATCH /messages/:id` + `message:edit`                                      | 11    | 039–049 |
| `delete-message.md`      | `DELETE /messages/:id` (forMe/forEveryone)                                  | 11    | 050–060 |
| `reactions.md`           | `message:react` / `GET …/reactions`                                         | 9     | 061–069 |
| `read-receipts.md`       | `message:read` / `message:delivered` (socket)                               | 8     | 070–077 |
| `unread-counts.md`       | unread via inbox + `conv:updated.unread`                                    | 6     | 078–083 |
| `inbox.md`               | `GET /api/v1/chat/inbox` + bump-to-top                                      | 11    | 084–094 |
| `attachments.md`         | gallery/files/location/contact/GIF/sticker/voice; `GET …/media`             | 15    | 095–109 |
| `media-upload.md`        | `POST /media/upload-url` & `/download-url` (presign)                        | 11    | 110–120 |
| `forward-report-pins.md` | forward, report, pins                                                       | 13    | 121–133 |
| `bulk-conversations.md`  | `POST /chat/conversations/{leave,mute,read}/bulk` (private **and** group)   | 20    | 134–153 |

**Total: 12 files, 153 test cases.**

> `bulk-conversations.md` spans both conversation kinds — one request may mix `prv_…` and `grp_…`
> ids — so it is filed here (with the unified inbox) rather than split across PCHAT and GCHAT.
> See also `group-chat/moderation-mute-warn.md`: that is the OTHER mute (an admin silencing a
> member), which these endpoints never touch.

## Endpoints / events covered

REST (`/api/v1/chat/…`): `GET /private/conversations`, `GET /private/presence/:userId`,
`POST /private/rooms/:peerId`, `DELETE /private/rooms/:roomId`, `POST …/mute`, `POST …/unmute`,
`GET …/messages/search`, `GET …/messages`, `GET …/media`, `PATCH /messages/:id`,
`POST /messages/:id/report`, `DELETE /messages/:id`, `GET …/pins`,
`POST …/messages/:id/forward`, `GET …/messages/:id/reactions`, `GET /inbox`,
`POST /media/upload-url`, `POST /media/download-url`.

Socket (`/chat`): `message:send`, `message:read`, `message:delivered`, `message:react`,
`message:reactions:get`, `message:edit`, `message:forward`; server→client `message:new`,
`message:edited`, `message:delete`, `message:reaction`, `message:read`, `message:delivered`,
`conv:updated`, `typing:*`, `presence:status`.

## Category coverage

Happy Path · Input Validation · Required/Optional Params · AuthN · AuthZ · Business Rule ·
DB State · Error Handling · Edge Case · Rate Limit · File Upload · Pagination/Filter/Sort ·
Concurrency · Security — all represented.

## GAPS & ambiguities (for follow-up)

1. **Friendship gate is ACTIVE** (not deferred): `sendMessage`, `forwardMessage`, and _new_ room
   creation call `userServiceClient.checkFriendship` → `403 CHAT_FRIENDSHIP_REQUIRED`. (Memory
   `friendship_gate_rewire` describes a _planned_ rewire to a user-service `check(a,b)` endpoint;
   the current gRPC check is live.) DM cases assume friends unless testing the gate.

2. **Timeline read AuthZ gap (TC-PCHAT-029):** `getMessagesTimeline` checks only that the room
   _exists_, not that the requester is a participant. `listMedia`, `catchup`, `report`, and `mute`
   correctly enforce participation — timeline and search appear not to. Likely **IDOR** on message
   history. High priority to confirm/fix.

3. **`deleteForMe` participant gap (TC-PCHAT-059):** no room-participation check; a non-participant
   knowing a messageId could set `deletedFor[self]` and trigger a spurious `message:delete` emit.
   (`deleteForEveryone` is protected by the sender check.)

4. **Download-URL IDOR (TC-PCHAT-118):** `POST /media/download-url` validates only the
   `chat-uploads/` prefix — **no per-user/room ownership check**. Any authed user can mint a view
   URL for any chat object whose key they know. **High-priority security gap.**

5. **GET reactions / GET pins AuthZ (TC-PCHAT-067, 132):** neither verifies participation; reactor
   identities / pinned content readable by any authed user with the ids. IDOR candidates.

6. **Reaction lost-update (TC-PCHAT-069):** `addReactions` is a read-modify-write of the full
   reactions map; concurrent reactions may drop one. Not atomic. Toggle/"can't react twice" logic
   lives at the gateway (not in chat-service `react`) — verify there.

7. **GIF enum mismatch (TC-PCHAT-100):** `GIF` is in `MEDIA_LIMITS` and the media-list type enum but
   **absent** from `sendPrivateMessageSchema.messageType`; GIFs are presumably sent as IMAGE with a
   gif mime. Confirm intended send path.

8. **Pin/unpin write paths:** `pinMessageSchema`/`unpinMessageSchema` validators exist but no REST
   route in these files — pin/unpin likely on another surface (socket/group). Only pins-GET is REST.

9. **Empty-content send (TC-PCHAT-011):** no service guard against a fully empty TEXT message; relies
   on client. Self-send (TC-PCHAT-018) has no explicit guard either.

10. **Socket send rate-limit (TC-PCHAT-014):** REST `sendLimit` (60/min, `pm:send`) covers
    forward/edit/report/delete; confirm a per-socket limiter exists for `message:send` itself.

## Attachment coverage note

All requested kinds covered: gallery (IMAGE), files (DOCUMENT), location, contact, GIF, sticker,
voice note (VOICE), plus video — with per-kind mime/size/count/duration caps from `MEDIA_LIMITS`
(IMAGE maxCount 10; VIDEO 180s; VOICE 300s; generic + video byte caps from env) and the presign
upload/download flow. STICKER requires objectKey OR url; LOCATION lat/lng bounds enforced.
