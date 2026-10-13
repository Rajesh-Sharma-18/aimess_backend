# Public vs Private groups — join via invite link

- **Public** (default, `settings.joinApproval` absent/false): anyone with the link joins instantly (unchanged).
- **Private** (`settings.joinApproval: true`): a link join creates a join request; only a group **ADMIN** can approve or reject it. Moderators and members cannot.

## Privacy flag
`PATCH /api/v1/chat/groups/rooms/:roomId` with body `{ "joinApproval": boolean }` (top-level field, ADMIN only; the server merges it into `GroupRoom.settings`). It comes back as `settings.joinApproval` in the PATCH response and in `GET /chat/groups/rooms/:roomId`.
Switching a group back to public does not auto-approve anything. Pending requests stay actionable.

## Invite link (`/api/v1/chat/invite-links/*`, alias `/api/v1/chat/group-invite-links/*`)
- `POST /join {token}` returns:
  - `{ status: "JOINED", room }` for a public group (same as before), or
  - `{ status: "PENDING", request: GroupJoinRequestDto }` for a private group. No membership is created. The call is idempotent: a re-tap returns the existing PENDING row and sends no new notification.
  - Already a member → `409 CHAT_ALREADY_MEMBER` (unchanged).
- `GET /preview/:token` adds:
  - `requiresApproval: boolean`
  - `pendingRequestId: string | null`
  - a new state, `REQUEST_PENDING`: the group is private and the signed-in viewer already has a PENDING request. It replaces `CAN_JOIN`.
  - The in-chat invitation card returns the same `state`, because it uses the same loader.

## Join requests (`/api/v1/chat/group-join-requests`, authenticated)
| Route | Who | Response `data` |
|---|---|---|
| `GET /room/:roomId?cursor=&limit=` | ADMIN | `{ items: GroupJoinRequestDto[], nextCursor: string \| null, total }`. PENDING only, newest first, limit 1–50 (default 20). |
| `GET /mine` | anyone | `{ items: GroupJoinRequestDto[] }`: the caller's own PENDING requests |
| `POST /:requestId/approve` | ADMIN | `{ request }`. Adds the member through the link (`invitedBy` = link creator, `joinedViaToken`), marks the request APPROVED and counts one use of the link. If the requester is already an active member, it returns `AUTO_RESOLVED` as a no-op. Capacity, closed-group and block rules still apply. |
| `POST /:requestId/reject` | ADMIN | `{ request }` → REJECTED |
| `POST /:requestId/cancel` | requester | `{ request }` → CANCELLED (someone else's request returns 404) |

Errors: `404 CHAT_GROUP_JOIN_REQUEST_NOT_FOUND`, `400 CHAT_GROUP_JOIN_REQUEST_NOT_PENDING`, `403 CHAT_INSUFFICIENT_PERMISSIONS` (not an ADMIN), `403 CHAT_NOT_A_MEMBER`.

If a user with a PENDING request becomes a member any other way (direct add, or a link join after the group went public), their request is resolved as `AUTO_RESOLVED`. The admin list also self-heals this on read.

```jsonc
// GroupJoinRequestDto
{ "id": "…", "roomId": "…", "userId": "…",
  "status": "PENDING|APPROVED|REJECTED|CANCELLED|AUTO_RESOLVED",
  "createdAt": "ISO",
  "user":  { "userId": "…", "displayName": "…", "username": "…", "avatarUrl": "…" },
  "group": { "roomId": "…", "name": "…", "avatarUrl": "…" } }
```

## Realtime (socket, `user:<id>` rooms)
- `group:join_request:new` goes to every active ADMIN: `{ roomId, request }`.
- `group:join_request:resolved` goes to every active ADMIN: `{ roomId, requestId, status, decidedBy }`. It fires on approve, reject, cancel and auto-resolve.
- `group:join_request:rejected` goes to the requester: `{ roomId, requestId }`.
- On approval the requester gets the existing `group:added` event.

## Notifications (inbox + push; COMMUNITY category tab)
| `type` | To | Notes |
|---|---|---|
| `GROUP_JOIN_REQUESTED` | ADMINs | Actionable card. Push actions are `group_join_request_accept` and `group_join_request_reject`; APNs category `GROUP_JOIN_REQUEST`. Data fields: `roomId, groupName, requestId, joinRequestId, requesterId, requesterDisplayName, tag`. Navigation: `{screen:"GROUP_REQUESTS", roomId, conversationType:"GROUP", requestId, userId}`. There is one card per (group, requester): a new attempt replaces the previous card. |
| `GROUP_JOIN_REQUEST_RETRACTED` | ADMINs | Data-only. Deletes the card (`groupKey group:<roomId>:join_request:<requesterId>`) once the request is settled by anyone. Web closes the tray card by `tag` (`group_join_request_<roomId>_<requesterId>`). |
| `GROUP_JOIN_REQUEST_APPROVED` | requester | "Your request to join {group} was approved". Navigation is `GROUP_CHAT`. |
| `GROUP_JOIN_REQUEST_REJECTED` | requester | Push only. Navigation is `NOTIFICATIONS`. |

Accept/Decline (from the card or the push) call `POST /chat/group-join-requests/:requestId/approve|reject`.

## Communities
Community join requests are now ADMIN-only too: list, approve, reject, bulk approve and bulk reject all refuse moderators with `403 COMMUNITY_FORBIDDEN`.
