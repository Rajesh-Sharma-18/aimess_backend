# AIMess Community Push Notification Contract

> **Canonical reference** for the shape of every community push notification produced by the backend. All client platforms (Web, Android, iOS) must consume this contract. Any deviation between this document and the backend code is a bug — fix the code, then update this doc.

---

## 1. Transport stack

```
Community action (REST / gRPC / socket)
  → community-service / chat-service persists the change
  → publishes domain event to RabbitMQ
  → notifications-service consumer receives event
  → notifications-service/push.service.ts:pushToUser()
      1. load notification settings (gRPC → Redis cache, 300 s TTL)
      2. evaluate per-category gate + quiet-hours
      3. apply showPreview masking
      4. persist inbox row (gRPC → chat-service CreateNotification)
      5. load all FCM tokens for this user (MongoDB DeviceToken)
      6. deduplicate tokens
      7. fan FCM data message to every token in parallel
      8. prune any invalid/expired tokens
```

Socket.IO (`/community`, `/chat`, `/notify` namespaces) delivers real-time updates to **connected** devices. FCM delivers push to **offline / backgrounded / terminated** devices. Both may fire for the same event — the client must deduplicate by `messageId` / event ID.

---

## 2. Device token model

| Field        | Type                          | Notes                                     |
| ------------ | ----------------------------- | ----------------------------------------- |
| `userId`     | string (UUID)                 | Owner                                     |
| `token`      | string                        | Globally unique FCM registration token    |
| `platform`   | `"ANDROID" \| "IOS" \| "WEB"` |                                           |
| `deviceId`   | string?                       | Client-generated stable device identifier |
| `lastSeenAt` | Date                          | Updated on each register call             |

One user may have many active device tokens (web + android + ios + multiple browser tabs). Every eligible token receives one FCM send per event — no per-user deduplication across platforms.

---

## 3. Canonical FCM payload shape

All community notifications share this structure. Values that are not applicable for a given event are omitted or empty strings.

```json
{
  "notification": {
    "title": "Tech Community",
    "body": "Alice: Hello everyone!"
  },
  "data": {
    "type": "MESSAGE",
    "notificationType": "COMMUNITY_MESSAGE",
    "communityId": "<communityId>",
    "communityName": "Tech Community",
    "roomId": "<communityId>",
    "messageId": "<messageId>",
    "senderId": "<senderId>",
    "senderName": "Alice",
    "senderAvatar": "https://cdn.example.com/avatar.jpg",
    "conversationAvatar": "https://cdn.example.com/community.jpg",
    "communityAvatarUrl": "https://cdn.example.com/community.jpg",
    "contentType": "TEXT",
    "preview": "Hello everyone!",
    "sentAt": "1750000000000",
    "idempotencyKey": "<messageId>",
    "deepLink": "aimess://community/<communityId>?msgId=<messageId>"
  },
  "collapseKey": "conv:<communityId>",
  "android": { "priority": "normal" },
  "apns": {
    "headers": { "apns-priority": "5" },
    "payload": { "aps": { "sound": "default" } }
  },
  "webpush": {
    "notification": {
      "icon": "/icons/icon-192.png",
      "badge": "/icons/badge-72.png"
    },
    "fcmOptions": {
      "link": "aimess://community/<communityId>?msgId=<messageId>"
    },
    "headers": { "Urgency": "normal", "TTL": "86400" }
  }
}
```

**Avatar fields — which image represents the notification:**

| Field                | Present for                                   | Meaning                                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `senderAvatar`       | every chat message                            | The ACTOR's photo. Correct tray image for a PRIVATE chat only (there the sender _is_ the conversation); never the tray image for a group/community message.                                                                                                          |
| `conversationAvatar` | GROUP + COMMUNITY messages                    | The conversation's own image — group avatar / community logo — read from the authoritative room row on every send, so a re-uploaded picture is live on the very next push. Canonical key; also promoted to `apns.fcm_options.image` and `webpush.notification.icon`. |
| `groupAvatarUrl`     | GROUP messages + group lifecycle events       | Same URL as `conversationAvatar`, under the group-specific name the lifecycle events already use.                                                                                                                                                                    |
| `communityAvatarUrl` | COMMUNITY messages + all `community.*` events | Same URL as `conversationAvatar`, under the community-specific name the lifecycle events already use.                                                                                                                                                                |

A group/community push must render the CONVERSATION's avatar, not the sender's.
Android MESSAGE pushes are **data-only** (the app owns the tray card, see §3), so
the data map above is the only place a picture reaches an Android device — iOS
additionally gets it as an APNs attachment via `mutable-content` + the NSE.
When the entity has no avatar the fields are **omitted entirely** (never `""`),
and the client falls back to its own placeholder.

**Rules:**

- All FCM `data` values MUST be strings (epoch ms → `String(timestamp)`)
- `deepLink` is included in both `data.deepLink` AND `webpush.fcmOptions.link`
- `notification.title` is NEVER masked by `showPreview=false` — only `body` is
- When `showPreview=false`, `body` → `"New message in {communityName}"` (for messages) or a generic safe string for other event types

---

## 4. Deep-link format

```
aimess://community/{communityId}?msgId={messageId}
```

| Parameter     | Required     | Notes                                                         |
| ------------- | ------------ | ------------------------------------------------------------- |
| `communityId` | always       | community-service Community.id                                |
| `msgId`       | for messages | chat-service GeneralRoomMessage.id; omit for lifecycle events |

**Web route equivalent:**

```
/communities/{communityId}/chat?msgId={messageId}
```

On notification click/tap:

1. Parse `communityId` and optional `msgId` from the deep link
2. Restore / verify authentication session
3. Verify current membership and community access (may have been removed/banned since push was sent)
4. Navigate to community chat room
5. If `msgId` is present, scroll to / highlight that message; otherwise open at bottom
6. If community is inaccessible (deleted / banned / not a member): navigate to community list, show appropriate state, never crash or loop

---

## 5. Preference and mute precedence matrix

| Scenario                                 | Ordinary message push                      | Critical push (kick/ban/delete) |
| ---------------------------------------- | ------------------------------------------ | ------------------------------- |
| `communityEnabled = true`                | ✅ sent                                    | ✅ sent                         |
| `communityEnabled = false`               | ❌ suppressed                              | ✅ sent (`bypassSettings=true`) |
| Community muted (moderator-muted sender) | ❌ suppressed at consumer gate             | n/a (not a message)             |
| Quiet hours active                       | ❌ suppressed                              | ✅ sent (`bypassSettings=true`) |
| `showPreview = false`                    | ✅ sent, body masked                       | ✅ sent, body masked            |
| Sender == recipient                      | ❌ excluded at publish                     | ❌ excluded at publish          |
| User removed/banned                      | ❌ no longer has tokens for that community | ✅ sent once on ban event       |

**Mention override**: Not yet implemented as a separate preference. Mentions currently go through the same `communityEnabled` gate.

---

## 6. Community event push map

| Event                  | Recipients                       | `bypassSettings` | Push Title                      | Push Body (preview on)                               | Push Body (preview off)      | Deep Link                               |
| ---------------------- | -------------------------------- | ---------------- | ------------------------------- | ---------------------------------------------------- | ---------------------------- | --------------------------------------- |
| New community message  | all active members except sender | false            | community name (or sender name) | `"SenderName: preview"`                              | `"New message in Community"` | `aimess://community/{id}?msgId={msgId}` |
| Join request (to mods) | admins + mods                    | false            | "New join request"              | `"Name requested to join Community."`                | `"New join request"`         | `aimess://community/{id}`               |
| Join request approved  | requester                        | false            | "Join request approved"         | `"Your request to join X was approved by Y."`        | `"Join request approved"`    | `aimess://community/{id}`               |
| Join request rejected  | requester                        | false            | "Join request declined"         | `"Your request to join X was declined."`             | `"Join request declined"`    | `aimess://communities`                  |
| Member added by admin  | target user                      | false            | "Welcome to the community"      | `"You were added to X."`                             | `"Welcome to the community"` | `aimess://community/{id}`               |
| Self-joined (public)   | joiner                           | false            | "Joined a community"            | `"You have joined X."`                               | `"Joined a community"`       | `aimess://community/{id}`               |
| Admin transferred      | new admin                        | false            | "You are now an admin"          | `"Community administration was transferred to you."` | same                         | `aimess://community/{id}`               |
| Role changed           | target user                      | false            | "Your role changed"             | `"Your role is now {role}."`                         | same                         | `aimess://community/{id}`               |
| Kicked                 | target user                      | **true**         | "Removed from community"        | `"You were removed from a community."`               | same                         | `aimess://communities`                  |
| Banned                 | target user                      | **true**         | "Banned from community"         | `"You were banned from a community."`                | same                         | `aimess://communities`                  |
| Unbanned               | target user                      | false            | "Ban lifted"                    | `"Your ban from a community has been lifted."`       | same                         | `aimess://communities`                  |
| Muted                  | target user                      | false            | "You have been muted"           | `"You were muted in a community."`                   | same                         | `aimess://community/{id}`               |
| Unmuted                | target user                      | false            | "You have been unmuted"         | `"You can post in the community again."`             | same                         | `aimess://community/{id}`               |
| Warned                 | target user                      | false            | "You received a warning"        | moderator's note text                                | same                         | `aimess://community/{id}`               |
| Invite sent            | invitee                          | false            | "Community invite"              | `"You were invited to join a community."`            | same                         | `aimess://community/{id}`               |
| Invite accepted        | inviter                          | false            | "Invite accepted"               | `"Your community invite was accepted."`              | same                         | `aimess://community/{id}`               |
| Report created         | admins + mods                    | false            | "New community report"          | `"A new report needs review."`                       | same                         | `aimess://community/{id}`               |
| Report actioned        | reporter                         | false            | "Report reviewed"               | `"Your report was reviewed by a moderator."`         | same                         | `aimess://community/{id}`               |
| Community deleted      | all former members               | **true**         | "Community deleted"             | `"A community you were in was deleted."`             | same                         | `aimess://communities`                  |
| Community closed       | all former members               | false            | "Community closed"              | `"A community you were in has been closed."`         | same                         | `aimess://communities`                  |
| Community reopened     | owner only                       | false            | "Community reopened"            | `"X is open again."`                                 | same                         | `aimess://community/{id}`               |

**Not yet implemented (not in current scope):**

- Mention push (separate preference + mention-specific title)
- Reaction push
- Pinned message push (explicitly deferred)

---

## 7. Idempotency

- Each push includes `idempotencyKey = messageId` in the FCM data map
- If the same event is delivered twice (RabbitMQ redelivery), the FCM send will fire twice — the client MUST deduplicate via `messageId`
- Invalid/expired tokens are pruned after the first failed send (no retry for invalid tokens)

---

## 8. TTL and collapse

| Parameter     | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| `ttl`         | 86 400 s (24 h) default                                           |
| `collapseKey` | `"conv:{communityId}"` for messages; omitted for lifecycle events |

When multiple community messages arrive while the device is offline, the collapse key ensures only the latest is delivered on wake (Android and Web). iOS does not collapse by default.

---

## 9. FCM token lifecycle

| Event                        | Action                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| Login / app launch           | `POST /api/v1/notifications/fcm-token` to register                 |
| Token refresh (FCM rotation) | `POST /api/v1/notifications/fcm-token` with new token              |
| Logout (current device)      | `DELETE /api/v1/notifications/fcm-token` — removes this token only |
| Logout all devices           | auth-service publishes `session.all_revoked` → all tokens deleted  |
| FCM reports token invalid    | token is pruned automatically after the send attempt               |

---

## 10. API endpoints

### Register / refresh token

```
POST /api/v1/notifications/fcm-token
Authorization: Bearer <access_token>

{
  "token": "<fcm_registration_token>",
  "platform": "ANDROID" | "IOS" | "WEB",
  "deviceId": "<stable_client_device_id>"
}

→ 200 { "success": true }
```

### Revoke current device token

```
DELETE /api/v1/notifications/fcm-token/{token}
Authorization: Bearer <access_token>

→ 200 { "success": true }
```

### Get notification preferences

```
GET /api/v1/notifications/preferences
Authorization: Bearer <access_token>

→ 200 {
  "chatEnabled": true,
  "callEnabled": true,
  "friendRequestEnabled": true,
  "systemEnabled": true,
  "communityEnabled": true,
  "liveStreamEnabled": true,
  "showPreview": true,
  "quietHoursEnabled": false,
  "quietHoursStart": "22:00",
  "quietHoursEnd": "08:00",
  "quietHoursDays": [1,2,3,4,5]
}
```

### Update notification preferences

```
PUT /api/v1/notifications/preferences
Authorization: Bearer <access_token>

{ "communityEnabled": false, "showPreview": false }

→ 200 { ...updated preferences }
```
