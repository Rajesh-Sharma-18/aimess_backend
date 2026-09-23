# MESSAGE_DELETE_NOTIFICATION_SURFACE.md — what "Delete for Everyone" does to notifications

Inventory taken 2026-09-23 on `rajesh-dev` (backend) and the current
`aimess_website` checkout. Scope is the **notification lifecycle** of a message
deleted with *Delete for Everyone* — in-app Notification Center rows, the
coalesced push that has not left yet, and the push already sitting in a device's
tray. Delete-for-me is in scope only as the thing that must **not** trigger any
of it.

Status key: DONE · PARTIAL · MISSING.

---

## 0. Which notifications a message can produce

There is exactly **one** message-derived Notification Center row type, and it is
group-only:

| Row type | Produced by | Conversation types | Notes |
|---|---|---|---|
| `chat.mention` | `notifications-service` `chat.consumer.ts` → `writeMentionRows` | **GROUP only** | One row per mentioned recipient per message (`@username` and `@all`). `groupKey = mention:<messageId>` |

Everything else a chat message produces is **push-only**:

| Signal | Producer | Inbox row? |
|---|---|---|
| Coalesced chat push (`type: MESSAGE`) | `chat-push-coalescer.ts` → `pushToUser({ skipInbox: true })` | No |
| Mention push | same, with `notificationType: MENTION` | No (the row above is written separately) |

Private and community messages create **no** Notification Center row at all —
`INBOX_ALLOWED_TYPES` (`push.service.ts`) does not contain a private or a
community message type, and `community.mention` is reserved but has no producer
(community chat has no mention pipeline). Reply and forward create no row of
their own either: they are ordinary messages.

So "a stale notification after Delete for Everyone" can only be one of:

1. a `chat.mention` row (group), or
2. an already-delivered OS/browser push.

---

## 1. In-app Notification Center rows — DONE

```
delete for everyone (group)
  └─ GroupMessageService.deleteMessage()         all REST / socket / gRPC / auto-delete paths funnel here
     └─ only if messageRepo.deleteForEveryone() succeeded
        └─ publishMentionRetractedSafe()          chat.message.queue, durable
           └─ notifications-service chat.consumer → handleMentionRetracted
              └─ pushToUser({ type: "chat.mention_retracted", groupKey: mention:<id> })
                 └─ chat-service createNotification → DELETE transition
                    ├─ notificationRepo.deleteActiveByGroupKey()      ← backend-authoritative
                    ├─ notification:deleted  (one per row id, per recipient)
                    └─ notification:count_update (recomputed unread total)
```

* **Correlation** is `groupKey = mention:<messageId>` — an id, never rendered text.
* **Per recipient**: `@all` retracts against *every* membership row, not just
  today's roster, so a member who has since left/been kicked loses theirs too.
* **Idempotent**: a replayed retraction finds no active row and
  `isTerminalRemoval` returns without materialising anything.
* **Race-safe in the other direction**: a mention row racing ahead of its own
  delete is refused by `groupMentionStillStands` (the guard re-reads the message
  and drops the write if it is already tombstoned).
* **Unread count** is recomputed from the store, never decremented client-side.
* **Realtime / multi-device**: `notification:deleted` is published on the user's
  `user:<id>` channel, so every session of that account drops the row.
  `aimess_website` `CommunitySocketProvider` refetches the lists and applies the
  authoritative `unreadCount`; `useNotificationsInbox` additionally takes the
  removed row back out of the frozen open-snapshot chip count.
* **Pagination-proof**: the row is deleted in the database, so it cannot come
  back on page 5, after a reload, or in a new session.
* **Edit** follows the same lifecycle for the mentions an edit removes.
* **Delete for me** never reaches any of this — it is a different service method
  (`deleteForMe`) and publishes no retraction.

---

## 2. Not-yet-sent push (inside the coalesce window) — DONE

`chat-push-coalescer.ts` holds a push for `PUSH_COALESCE_WINDOW_MS` (2s, max
hold 10s). `pending-push-sync.ts` subscribes to the tombstone channels
(`conv:*`, `community:*`) and calls `dropPendingChatMessage(messageId)`, so a
message deleted inside the window is never pushed at all.

**Fixed 2026-09-23:** this used to run for *delete-for-me* as well — both scopes
publish the same event — so one user hiding their own copy cancelled every other
recipient's queued notification. The handler now reads the scope
(`type` / `deleteType` / `deletedForEveryone`) and ignores for-me tombstones.

---

## 3. Already-delivered push — PARTIAL (server DONE, clients vary)

`push-retraction.ts`:

* `recordPushedMessages()` — the coalescer records, per message id, which users
  it actually pushed (`push:msg:{<messageId>}`, Redis set, 24h TTL = the FCM
  message TTL).
* `retractMessagePush()` — on a for-everyone tombstone, claims that set with a
  `DEL` (so replays and multiple service replicas retract exactly once) and
  sends each recipient a **data-only** `MESSAGE_DELETED` push carrying
  `messageId` and `conversationId`. Same mechanical, settings-bypassing shape as
  the existing `MESSAGE_READ` dismiss push.

| Client | Can it remove a delivered notification? | Status |
|---|---|---|
| **Web** | Yes. The service worker owns data-only pushes; `registration.getNotifications()` + `close()`, matched on `messageId` / the coalesced `messageIds` list. Same mechanism as the shipped `CALL_CANCELLED` ring retraction. | **DONE** (`public/firebase-messaging-sw.js`) |
| **Android** | Yes in principle — every chat push is data-only there and the app draws (and therefore owns the id of) the tray entry, so `NotificationManager.cancel()` applies. | **MISSING** — needs the `MESSAGE_DELETED` branch in the client's FCM service. Until then the card stays. |
| **iOS** | Yes in principle — `UNUserNotificationCenter.removeDeliveredNotifications(withIdentifiers:)` from the background wake (`apns-push-type: background`, priority 5). | **MISSING** — needs the client-side handler. Note APNs background pushes are throttled by the system and are **not guaranteed**, so iOS retraction can never be relied on. |

Because of that, an OS-level card **may** outlive its message on mobile. The
fallback is the existing one and is safe: delete-for-everyone leaves a
**tombstone** in the conversation, so tapping a stale push still opens the right
room and the jump/highlight lands on "This message was deleted" — no crash, no
endless load, no unrelated message.

---

## 4. What is deliberately NOT removed

* Unrelated notifications, including other messages in the same room — every
  removal is keyed on the deleted `messageId`.
* Group/community lifecycle rows (member added/removed, role changed, join
  approved, announcement, livestream) — they are not message-derived.
* Anything at all on **delete for me**.

---

## 5. Privacy

A `chat.mention` row stores the actor and the group name, never the message
text, and the row is deleted outright (not just hidden). The retraction push
carries only ids. The recipient set in Redis holds user ids and expires in 24h.

---

## 6. Tests

| Area | File |
|---|---|
| Who is retracted on delete-for-everyone / edit, failed delete, delete-for-me | `apps/chat-service/tests/groups/group-message-mention-retraction.test.ts` |
| Terminal-removal transition, create-racing-delete guard | `apps/chat-service/tests/grpc/create-notification-mention-guard.test.ts` |
| Retraction event shape | `apps/chat-service/tests/events/publish-message-sent.test.ts` |
| Delete scope (for-me vs for-everyone) on the tombstone channels | `apps/notifications-service/tests/consumers/pending-push-delete-scope.test.ts` |
| Recording recipients, claim-once retraction, failure tolerance | `apps/notifications-service/tests/services/push-retraction.test.ts` |
| Coalescer drop/edit inside the window | `apps/notifications-service/tests/services/chat-push-coalescer.test.ts` |
| Web service-worker tray retraction | `aimess_website/__tests__/services/messageDeletedPushRetraction.spec.ts` |
