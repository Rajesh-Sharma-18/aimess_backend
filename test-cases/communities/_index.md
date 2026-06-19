# Communities — Test Case Index

Module prefix: **`TC-COMM-NNN`** (IDs 001–139, unique & sequential). Covers the COMMUNITIES module across **two services**:

- **community-service** (MongoDB / Prisma) — owns communities, members/roles, join-requests, invites, invite-links, reports, mute settings, notification preferences, audit logs, categories, uploads. Base path `/api/v1/communities`. All endpoints require an access token.
- **chat-service** — owns the single community **chat room** (`GeneralRoom`, id === community.id) and its messages. Real-time via the gateway **`/community`** namespace; list-bump via **`/community`** (`community:updated`).

## Files

| File                            | Area                                                              | IDs             | Service           |
| ------------------------------- | ----------------------------------------------------------------- | --------------- | ----------------- |
| `create-community.md`           | Create + name/handle availability + get-by-id                     | TC-COMM-001–018 | community-service |
| `update-delete-community.md`    | Update (ADMIN), soft-delete                                       | TC-COMM-019–031 | community-service |
| `join-leave.md`                 | Join/leave, join-requests, invites, invite-links                  | TC-COMM-032–060 | community-service |
| `membership-roles.md`           | Members list/add, roles, transfer-admin, audit logs (RBAC matrix) | TC-COMM-061–077 | community-service |
| `moderation.md`                 | Kick/ban/unban, member-mute/warn, reports                         | TC-COMM-078–098 | community-service |
| `categories.md`                 | Seeded category listing                                           | TC-COMM-099–102 | community-service |
| `discovery-listing.md`          | Discover (page filter) + my communities (cursor)                  | TC-COMM-103–113 | community-service |
| `channels.md`                   | **GAP** — channels not implemented                                | TC-COMM-114–116 | (none)            |
| `community-chat.md`             | Rooms, messages, edit/delete, realtime                            | TC-COMM-117–130 | chat-service      |
| `mute-notifications-uploads.md` | Notification mute, prefs, presigned uploads                       | TC-COMM-131–139 | community-service |

**Total: 139 test cases.**

## Endpoint coverage

**community-service** (`community.routes.ts`): create, get, update, delete, name/handle-available, mine, discover, categories, uploads/url, members (list/add), member role (PUT), kick (DELETE), ban/unban, member mute/unmute + muted-members, warn + warnings, transfer-admin, audit-logs, join-requests (create/list/mine/approve/reject/cancel), invites (create/list/mine/accept/decline), reports (create/list/mine/review/action/dismiss/withdraw/delete), mute (get/put/delete), notification-preferences (get/put), invite-links (create/list/redeem/revoke). **All routes covered.**

**chat-service** (`community.routes.ts`, 10 endpoints): `/rooms`, `/rooms/search`, `/rooms/:roomId/join`, `/rooms/:roomId/leave`, `/rooms/:roomId/messages`, `/rooms/:roomId/messages/search`, `/rooms/:roomId/conversation`, `/rooms/:roomId/media`, `PATCH /messages/:messageId`, `DELETE /messages/:messageId`. **All covered.**

## `/community` namespace events referenced

- `community:message:new` (server→client, on `community:<id>`)
- `community:message:edited` (published by REST edit handler to `community:<id>`)
- `community:member:joined` (server→client)
- `message:delete` (community message deletes go to `conv:<roomId>`, NOT the community channel)
- `community:updated` (list-bump, delivered on **`/community`**, not `/chat`)

RabbitMQ domain events (community-service → notifications/chat consumers, not socket): `community.created.for-chat`, `community.deleted(.for-chat)`, `community.member.added/kicked/banned/muted/unmuted/warned`, `community.member.role.changed`, `community.admin.transferred`, `community.join.requested`, `community.invite.sent/accepted`, `community.report.created/actioned`.

## GAPS, ambiguities & split-brain

1. **Channels: NOT IMPLEMENTED.** No channel model, routes, types, or "default channel" rule in either service. The brief's channel CRUD / channel-types / can't-delete-default-channel do not exist. A community has exactly one implicit chat room. (TC-COMM-114–116 document the gap.)

2. **Split-brain membership (community-service vs chat-service).** chat-service `POST /rooms/:roomId/join|leave` upsert a chat-room membership and bump a separate count — they do **not** go through community-service's join-request/approval/role pipeline. A user can be a chat-room member without a community-service membership (and vice-versa). Source of truth for "is X a member" is ambiguous. Roles/bans are tracked independently in each store (chat-service has its own room ban; community-service has its own BANNED status).

3. **Unauthenticated chat-room listing.** `GET /rooms` and `/rooms/search` in chat-service have **no `authenticate` middleware** (userId is optional). Community-service `/communities/*` all require auth. Inconsistent surface — flag for review.

4. **PUBLIC join is request-only.** `POST /:id/join` never instant-joins; it always creates a PENDING join request (even for PUBLIC). The mutual-want auto-accept logic referenced in comments has been removed. UIs expecting instant join will see a pending state.

5. **Friend validation on add-members is disabled.** In `addMembers`, the `fetchAcceptedFriendIds` friend gate is commented out, so any UUID can be added by a MODERATOR+ (subject to ALREADY_MEMBER/BANNED skips). Create-community still enforces the friend gate. Inconsistent — flag.

6. **livestream discovery filters are no-ops.** `discover?filter=live|upcoming` returns an empty page until stream-service ships (TC-COMM-106).

7. **No interactive transactions (standalone Mongo).** Multi-step writes (create, delete, admin-handover, approve) are sequential with best-effort compensation. Concurrency cases (race join/redeem/role-edit) rely on DB unique indexes and atomic guards; last-write-wins for role edits. A few mid-sequence failures can leave drift (memberCount is recomputed defensively).

8. **Items to confirm in code (not fully traced here):** exact error codes for community-image ownership/HEAD failure (TC-COMM-012/138), and chat-service `editMessage`/`deleteForAll` ownership + 15-min-window + text-only enforcement and exact status codes (TC-COMM-126). `uploadUrlSchema` field constraints (TC-COMM-139).
