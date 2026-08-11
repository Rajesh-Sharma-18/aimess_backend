# Group REST routes now use a `/rooms` segment

**Audience:** mobile (iOS + Android) and any other API client.
**Date:** 2026-08-11
**Type:** breaking path change. No behaviour, payload, query-param, status-code, or socket-event change.
**Cutover:** hard. The old paths return **404** as soon as this build is deployed — there is no alias or deprecation window.

---

## 1. What changed, in one sentence

Every **room-scoped** group endpoint gained a `rooms` segment, so the room id is
addressed as `/chat/groups/rooms/{roomId}` instead of `/chat/groups/{roomId}`.

```
BEFORE   /api/v1/chat/groups/grp_rcxbatb8BK9QT-7w
AFTER    /api/v1/chat/groups/rooms/grp_rcxbatb8BK9QT-7w
```

## 2. Why

Private chat has always addressed rooms as `/api/v1/chat/private/rooms/{roomId}`.
Group chat addressed them as `/api/v1/chat/groups/{roomId}` — the same concept
with a different shape, which meant a client could not build a room URL from
`(conversationType, roomId)` without a per-type branch. Group now matches
private, so one helper covers both:

```
/api/v1/chat/private/rooms/{roomId}/...
/api/v1/chat/groups/rooms/{roomId}/...
```

## 3. Migration rule

Three rules cover every group endpoint. Apply them mechanically.

| Rule                                                                                                          | Old                                      | New                               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------- |
| 1. Paths where the next segment is a **room id** → insert `rooms`                                             | `/chat/groups/{roomId}/...`              | `/chat/groups/rooms/{roomId}/...` |
| 2. Paths where the next segment is `messages` (**message-scoped**, room resolved server-side) → **unchanged** | `/chat/groups/messages/...`              | `/chat/groups/messages/...`       |
| 3. Collection paths → **unchanged**                                                                           | `/chat/groups`, `/chat/groups/my-groups` | same                              |

If your client stores group URLs as a single format string per endpoint, this is
a find-and-replace of `chat/groups/{roomId}` → `chat/groups/rooms/{roomId}`.

## 4. Full endpoint table

All paths below are relative to the API base, e.g. `https://<host>/api/v1`.

### 4.1 Changed — room-scoped

| Method | Old path                                                       | New path                                                             |
| ------ | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/chat/groups/{roomId}`                                        | `/chat/groups/rooms/{roomId}`                                        |
| PATCH  | `/chat/groups/{roomId}`                                        | `/chat/groups/rooms/{roomId}`                                        |
| DELETE | `/chat/groups/{roomId}`                                        | `/chat/groups/rooms/{roomId}`                                        |
| POST   | `/chat/groups/{roomId}/disband`                                | `/chat/groups/rooms/{roomId}/disband`                                |
| POST   | `/chat/groups/{roomId}/clear`                                  | `/chat/groups/rooms/{roomId}/clear`                                  |
| PATCH  | `/chat/groups/{roomId}/archive`                                | `/chat/groups/rooms/{roomId}/archive`                                |
| PATCH  | `/chat/groups/{roomId}/unarchive`                              | `/chat/groups/rooms/{roomId}/unarchive`                              |
| GET    | `/chat/groups/{roomId}/messages`                               | `/chat/groups/rooms/{roomId}/messages`                               |
| POST   | `/chat/groups/{roomId}/messages`                               | `/chat/groups/rooms/{roomId}/messages`                               |
| GET    | `/chat/groups/{roomId}/messages/search`                        | `/chat/groups/rooms/{roomId}/messages/search`                        |
| GET    | `/chat/groups/{roomId}/conversation`                           | `/chat/groups/rooms/{roomId}/conversation`                           |
| GET    | `/chat/groups/{roomId}/changes`                                | `/chat/groups/rooms/{roomId}/changes`                                |
| GET    | `/chat/groups/{roomId}/media`                                  | `/chat/groups/rooms/{roomId}/media`                                  |
| POST   | `/chat/groups/{roomId}/read`                                   | `/chat/groups/rooms/{roomId}/read`                                   |
| GET    | `/chat/groups/{roomId}/pins`                                   | `/chat/groups/rooms/{roomId}/pins`                                   |
| POST   | `/chat/groups/{roomId}/messages/{messageId}/pin`               | `/chat/groups/rooms/{roomId}/messages/{messageId}/pin`               |
| DELETE | `/chat/groups/{roomId}/messages/{messageId}/pin`               | `/chat/groups/rooms/{roomId}/messages/{messageId}/pin`               |
| POST   | `/chat/groups/{roomId}/messages/{messageId}/forward`           | `/chat/groups/rooms/{roomId}/messages/{messageId}/forward`           |
| POST   | `/chat/groups/{roomId}/messages/{messageId}/report`            | `/chat/groups/rooms/{roomId}/messages/{messageId}/report`            |
| GET    | `/chat/groups/{roomId}/messages/{messageId}/read-by`           | `/chat/groups/rooms/{roomId}/messages/{messageId}/read-by`           |
| GET    | `/chat/groups/{roomId}/messages/{messageId}/reactions`         | `/chat/groups/rooms/{roomId}/messages/{messageId}/reactions`         |
| POST   | `/chat/groups/{roomId}/messages/{messageId}/reactions`         | `/chat/groups/rooms/{roomId}/messages/{messageId}/reactions`         |
| DELETE | `/chat/groups/{roomId}/messages/{messageId}/reactions/{emoji}` | `/chat/groups/rooms/{roomId}/messages/{messageId}/reactions/{emoji}` |

### 4.2 Unchanged — do not touch

| Method | Path                                      | Note                                              |
| ------ | ----------------------------------------- | ------------------------------------------------- |
| POST   | `/chat/groups`                            | create a group                                    |
| GET    | `/chat/groups/my-groups`                  | the caller's group list                           |
| POST   | `/chat/groups/messages/delete`            | body-carried delete                               |
| DELETE | `/chat/groups/messages/{messageId}`       | path-param delete, room resolved from the message |
| PATCH  | `/chat/groups/messages/{messageId}`       | edit                                              |
| POST   | `/chat/groups/messages/{messageId}/react` | single-write SET reaction                         |

Also unchanged: everything under `/chat/group-members/...` (add, kick, leave,
role, mute, report, member list) and `/chat/invite-links/...`. Those routers were
never mounted under `/chat/groups` and are unaffected.

### 4.3 Not affected at all

- Private chat (`/chat/private/rooms/...`) — already had `rooms`.
- Community (`/chat/community/...`).
- The unified inbox (`/chat/inbox`) and bulk conversation actions
  (`/chat/conversations/{leave,mute,read}/bulk`) — these take room ids in the
  **body**, not the path.
- Every Socket.IO event on `/chat`, `/community`, and `/notify`. Room names
  (`conv:<roomId>`, `user:<id>`, `pin:<roomId>`) are unchanged.

## 5. What did NOT change

- Request bodies, query parameters, and response envelopes are byte-identical.
- Status codes and error codes are identical.
- `roomId` format is unchanged (`grp_...`).
- Rate limits are unchanged.
- Authentication is unchanged.

## 6. How to verify your build

```bash
# Should be 200 for a member
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/chat/groups/rooms/grp_rcxbatb8BK9QT-7w"

# Should now be 404
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/chat/groups/grp_rcxbatb8BK9QT-7w"
```

Then grep your codebase for any surviving old-shape URL:

```bash
grep -rnE 'chat/groups/(\{|:|\$)' . | grep -v '/rooms/'
```

A clean run means every room-scoped call was migrated. Swagger at
`/api-docs` reflects the new paths.

## 7. Rollout checklist

- [ ] Update the group URL builders / endpoint constants in the app.
- [ ] Re-run the group chat regression pass: open a group, scroll history,
      send, edit, delete, react, pin, forward, report, mark-read, view media,
      view read-by, archive/unarchive, clear chat, delete conversation, disband.
- [ ] Confirm reconnect catch-up still works (`/chat/groups/rooms/{roomId}/changes`).
- [ ] Ship together with the backend deploy — old paths stop working immediately.

Questions: raise them against the backend repo before the deploy window, since
there is no compatibility shim to fall back on.
