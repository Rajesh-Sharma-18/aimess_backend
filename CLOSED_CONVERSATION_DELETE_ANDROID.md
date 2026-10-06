# Delete Conversation on a CLOSED group / community — Android notes

Backend fix (2026-10-05). The mobile code is not in this repository, so this is a checklist to verify and adjust if needed. No request or response shape changed.

## What the server does now

A group or community that is CLOSED keeps every membership, so it stays in each member's list. Removing it from that list is now a **per-user dismiss** for every role, the former admin included. It does not leave, does not transfer Admin, does not ask for "Assign an Admin", and does not change the group/community or anyone else's list.

| Call (list row "Delete Conversation") | Closed entity, any role (admin too) | Repeat call | Not a member |
|---|---|---|---|
| `POST /api/v1/communities/leave/bulk {communityIds}` | 200, item `status:"LEFT"` | 200, `LEFT` (no-op) | item `FAILED / NOT_MEMBER` |
| `DELETE /api/v1/communities {communityIds}` | 200, item `status:"REMOVED"` | item `SKIPPED` | item `SKIPPED` |
| `DELETE /api/v1/communities/:id/me` | 200 | 200 | 404 `COMMUNITY_MEMBER_NOT_FOUND` |
| `POST /api/v1/chat/conversations/leave/bulk {roomIds, groupAction}` (any `groupAction`) | 200, item `status:"DELETED"` | 200, `DELETED` | item `FAILED / NOT_MEMBER` |
| `DELETE /api/v1/chat/groups/rooms/:roomId` | 200, row removed (not just cleared) | 200 | 404 `CHAT_NOT_A_MEMBER` |

"Closed" here means:
- community: wire `status:"CLOSED"` (closed by its owner, or by Super Admin from Backoffice);
- group: room `status:"CLOSED"` (owner permanently banned by Super Admin). A group "closed" from Backoffice is disbanded and already leaves every list by itself.

The row stays gone after a refetch, a re-login, an app restart and a socket reconnect. If Super Admin reopens a community, it comes back for the members who dismissed it, with their role unchanged.

Realtime events reach only the caller's own devices:
- community: `community:membership:removed {communityId, reason:"dismissed"}` on `/community` and `/chat`;
- group: `conv:deleted {roomId, deletedBy, type:"GROUP"}` on `/chat`.

Nobody else gets anything. There is no system message, and the member count and roster stay the same.

## Check on Android

1. **No client-side Admin gate on a closed row.** If the list-row menu opens the "Assign an Admin" / transfer dialog for `role == ADMIN` before calling the API, skip that dialog when the entity is closed and go straight to the normal delete confirmation.
2. **Call a list-removal endpoint from the row**, i.e. one of the calls in the table above. `POST /communities/:id/leave` and `POST /chat/group-members/leave` are the explicit **Leave** action, not Delete Conversation. On a closed entity they still apply the Leave rules: an admin with other members gets `COMMUNITY_ADMIN_CANNOT_LEAVE` / `CHAT_OWNER_CANNOT_LEAVE`.
3. **Treat group bulk `status:"DELETED"` as success** even when the request sent `groupAction:"LEAVE"`. Anything other than `FAILED` means the row is gone.
4. **Handle `conv:deleted` with `type:"GROUP"`** by dropping the row, the same as for a private chat. Handle `community:membership:removed` with `reason:"dismissed"` by dropping the community row (this already happens for banned rows).
5. Copy: say "Conversation deleted", not "You left the group/community". The user is still a member of the closed entity.
