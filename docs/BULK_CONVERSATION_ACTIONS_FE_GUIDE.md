# Bulk Conversation Actions — Frontend Integration Guide

Multi-select **Leave / Delete**, **Mute / Unmute** and **Mark as Read** for the unified chat inbox
(private DMs **and** group chats), in one request per user action.

These are the chat counterparts of the Community bulk APIs
(`POST /communities/{leave,mute,read}/bulk`) and follow the same contract deliberately: same
`action` enum, same server-computed `durationMinutes`, same 50-item cap, same
skip-don't-fail semantics. If you already implemented the community bulk bar, this is the same
component with a different endpoint and `roomIds` instead of `communityIds`.

Audience: web, Android, iOS.

---

## 1. The one thing to get right first

There are **two unrelated features called "mute"** in this product. Mixing them up is the most
likely way to ship a bug here.

|                 | Conversation mute (**this guide**)   | Member moderation mute                        |
| --------------- | ------------------------------------ | --------------------------------------------- |
| Who does it     | You, to your own list row            | An admin/moderator, to someone else           |
| What it changes | **Push notifications only**          | The target's ability to **write**             |
| Endpoint        | `POST /chat/conversations/mute/bulk` | `POST /chat/group-members/mute-member`        |
| Inbox field     | `isMuted`                            | `isMemberMuted` / `memberMutedUntil`          |
| Socket event    | `conv:muted` / `conv:unmuted`        | `group:member:muted` / `group:member:unmuted` |

A conversation mute must **never** disable the composer, hide messages, or freeze the unread badge.

---

## 2. Endpoints

Base: `/api/v1/chat`. All require `Authorization: Bearer <accessToken>`.

`roomIds` is 1–50 conversation room ids taken straight from `GET /chat/inbox` (`item.roomId`).
**One call may mix both kinds** — the server reads the type from the id prefix (`prv_…` = private,
`grp_…` = group), so you never send a `type`. Duplicates are collapsed server-side.

Rate limit: 30 bulk calls per minute per user (`429` with `retryAfterSec`).

### 2.1 `POST /chat/conversations/leave/bulk`

```jsonc
{
  "roomIds": ["prv_abc", "prv_def", "grp_aaa", "grp_bbb"],
  "groupAction": "LEAVE", // or "DELETE" — default "LEAVE"
}
```

`groupAction` decides what the **group** rows mean. Private rows ignore it (a 1-to-1 room has no
membership, so they always run delete-for-me).

| `groupAction`     | Group behaviour                                                                                                                                                     | Equivalent single endpoint                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `LEAVE` (default) | Membership removed for real. MEMBER_LEFT system message, member count −1, remaining members get `group:member:removed`. **The group does not come back on reload.** | `POST /chat/group-members/{roomId}/leave` |
| `DELETE`          | Your own history is cleared, you stay a member, and the room reappears when a new message arrives.                                                                  | `DELETE /chat/groups/{roomId}`            |

> Wire your existing **"Delete Conversation"** control to `groupAction: "DELETE"` — that is what it
> has always done. Use `LEAVE` for an explicit "Leave group" control, and say so in the confirm
> dialog: leaving is not reversible without a new invite.

Response — always `200`, even when some items fail:

```jsonc
{
  "success": true,
  "data": {
    "results": [
      { "roomId": "prv_abc", "type": "PRIVATE", "status": "DELETED" },
      { "roomId": "grp_aaa", "type": "GROUP", "status": "LEFT" },
      {
        "roomId": "grp_bbb",
        "type": "GROUP",
        "status": "FAILED",
        "errorCode": "OWNER_CANNOT_LEAVE",
      },
    ],
    "summary": { "requested": 3, "succeeded": 2, "failed": 1 },
  },
}
```

| `errorCode`          | Meaning                                            | Suggested UI                                    |
| -------------------- | -------------------------------------------------- | ----------------------------------------------- |
| `OWNER_CANNOT_LEAVE` | You are the group's ADMIN and other members remain | "Transfer ownership or disband the group first" |
| `NOT_MEMBER`         | Already left / kicked / banned                     | Silently drop the row; it is gone anyway        |
| `NOT_FOUND`          | Room missing, or you were never in it              | Silently drop the row                           |

**Do not roll the whole batch back on a partial failure.** The successful items really are done.
Restore only the rows that came back `FAILED`.

### 2.2 `POST /chat/conversations/mute/bulk`

```jsonc
{ "action": "mute", "roomIds": ["prv_abc", "grp_aaa"], "durationMinutes": 480 }
```

```jsonc
{ "action": "unmute", "roomIds": ["prv_abc"] }
```

- `durationMinutes` — minutes from now, **resolved against the server's clock**. Omit or send
  `null` to mute indefinitely. Ignored on `unmute`. Send the minute count, not a timestamp: a
  client whose clock is behind would otherwise produce an already-expired mute.
- One expiry is computed for the whole batch, so a 50-room call cannot drift.

Response:

```jsonc
{ "data": { "muted": ["prv_abc", "grp_aaa"], "skipped": [] } }
// unmute → { "data": { "unmuted": [...], "skipped": [] } }
```

`skipped` is **not an error**: it holds rooms you can no longer act on (left the group, room gone).
Leave those rows as they are.

### 2.3 `POST /chat/conversations/read/bulk`

```jsonc
{ "roomIds": ["prv_abc", "prv_def", "grp_aaa", "grp_bbb"] }
```

```jsonc
{ "data": { "updatedCount": 4 } }
```

You send **no message id**. Each room is read up to its own current last message, resolved
server-side — so you cannot accidentally mark a conversation read past a message that arrived
after your list rendered. `updatedCount` counts rooms whose pointer actually moved; an empty
conversation, one already fully read, or one you can no longer read is skipped and not counted.

This runs the complete read path per room, identical to `POST /chat/private/rooms/{roomId}/read`:
the sender's ticks turn blue, your other devices get `read_sync`, the nav badge is recomputed and
the tray notification is dismissed.

---

## 3. What mute does and does not do

This is the part most often implemented wrong. When a conversation is muted and a peer sends a
message, **everything still happens except the push**:

| Still happens                                                | Suppressed          |
| ------------------------------------------------------------ | ------------------- |
| `message:new` over the socket                                | FCM / APNs push     |
| Message persisted and returned by history                    | Notification sound  |
| **Unread count increments**                                  | Notification banner |
| **Row bumps to the top** (`conv:updated`), still highlighted | VoIP push           |
| Read receipts, typing, media, reactions                      |                     |

So: never gate rendering, unread, or ordering on `isMuted`. Render the bell icon and nothing else.

### Expiry is lazy

A timed mute is evaluated at push time. It lapses on its own — **no refresh, no re-login, no
reopening the app**, and no sweeper job. Consequences for the client:

- **No `conv:unmuted` event fires when a mute expires.** Nothing wrote a new state, so nothing is
  broadcast.
- Therefore do not cache `isMuted` as a permanent boolean. Derive "muted right now" from
  `mutedUntil`: `isMuted && (mutedUntil == null || new Date(mutedUntil) > new Date())`, and
  re-evaluate on render.

---

## 4. Multi-device sync

Every successful mute/unmute emits **one event per room** on the acting user's own socket
(`/chat` namespace), whether it came from the single-room route or the bulk route:

```jsonc
// conv:muted  /  conv:unmuted
{
  "roomId": "grp_aaa",
  "conversationId": "grp_aaa", // alias, for clients keyed on conversationId
  "type": "GROUP", // or "PRIVATE"
  "isMuted": true,
  "mutedUntil": "2026-08-07T18:00:00.000Z", // null = indefinite / unmuted
  "updatedAt": 1749465231234,
}
```

Mute on Android → web and iOS update with no refetch. These events are delivered to **your own
sessions only**; a peer watching your presence never sees them.

The other events a bulk action produces are the existing ones — nothing new to handle:

| Action                            | Events you already handle                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Leave (`LEAVE`)                   | `group:removed` (you), `group:member:removed` (remaining members)                   |
| Leave (`DELETE`) / private delete | `conv:deleted` (your devices)                                                       |
| Mark read                         | `message:read` (senders), `read_sync` (your devices), `chat:unread_summary` (badge) |

---

## 5. Suggested client flow

1. Enter multi-select mode; collect `roomId`s from the inbox rows.
2. Apply the change optimistically to the visible rows.
3. Fire **one** bulk request.
4. On success:
   - leave → restore only the rows listed as `FAILED`, and surface their `errorCode`;
   - mute → leave `skipped` rows untouched;
   - read → refresh the list (or trust the incoming `read_sync` / `chat:unread_summary`).
5. On a rejected request (network / 4xx / 429) → roll the whole optimistic change back.
6. Exit multi-select and clear the selection.

Route your **single-row** menu actions through the same bulk endpoints with one id. One code path
means a row action and a multi-select action can never diverge in what they send or how they
recover — and you get the server-computed mute expiry for free.

---

## 6. Sanity checklist

- [ ] Selecting a mix of DMs and groups issues exactly **one** request per action.
- [ ] A muted conversation still receives messages, still increments unread, still jumps to the top.
- [ ] A muted conversation produces **no** push on a backgrounded device.
- [ ] A 1-minute mute stops suppressing pushes on its own, with the app left untouched.
- [ ] Muting on one device updates the other two without a refetch.
- [ ] Leaving a group with `LEAVE` keeps it gone after a full reload.
- [ ] "Delete Conversation" on a group still keeps you a member (uses `DELETE`).
- [ ] An admin-owned group in the selection fails alone; the other items stay done.
- [ ] Bulk mark-as-read zeroes the badge and turns the sender's ticks blue.
- [ ] Marking read does not delete messages, change timestamps, or reorder the list.
