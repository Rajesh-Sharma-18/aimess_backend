# AsyncAPI Audit — `apps/api-gateway/asyncapi/asyncapi.yaml`

> Audit date: 2026-06-12. Source of truth = the actual Socket.IO implementation
> (`apps/api-gateway/src/sockets/`: `chat.ns.ts`, `community.ns.ts`,
> `notify.ns.ts`, `ack.ts`) and the Zod validators therein. Method: full read of
> all three namespace handlers + the ack helper, cross-referenced field-by-field
> against every documented message, schema, and example in `asyncapi.yaml`.
>
> Priority order on conflict: **(1) code → (2) Zod validator → (3) AsyncAPI schema
> → (4) example.** Documentation was changed to match reality; implementation was
> not changed to match docs.

---

## 1. Executive summary

| Area                                     | Result                                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Documented events that exist & match** | 49 of 49 documented events exist in code. No stale/phantom events.                                                                                                         |
| **Events in code but MISSING from docs** | **17** (5 friend client→server, 3 friend server→client, 1 `auth:refresh`, 1 `session:expired`, 7 community moderation client→server, 1 `community.deleted` server→client). |
| **Schema `required` mismatches**         | **7** (doc marks a field required that the validator treats as optional).                                                                                                  |
| **Numeric-bound mismatches**             | **2** (`community:catchup` room cap & per-room limit).                                                                                                                     |
| **Ack contract mismatches**              | **2** (`retryAfter` never emitted; `RATE_LIMITED` never emitted by any handler).                                                                                           |
| **Example-only defects**                 | **2** (typing broadcast missing `senderName`; rate-limited ack example shows a non-existent field).                                                                        |

**Headline:** the documentation is high-quality for the events it covers, but **three entire event families are undocumented** — friend management, socket auth-refresh/session-expiry, and community moderation — totalling 17 events. Plus several `required` arrays over-constrain payloads relative to the validators.

---

## 2. Events in code but MISSING from AsyncAPI (deliverable: Missing Events Report)

### 2.1 `/chat` — Friend management (8 events) — `chat.ns.ts:953–1112, 974–1083`

Client → server (all ack-only unless noted):

| Event                   | Validator (`chat.ns.ts`)    | Payload                  | Ack `data`      |
| ----------------------- | --------------------------- | ------------------------ | --------------- |
| `friend.request`        | `FriendRequestSchema`       | `{ addresseeId: uuid }`  | `{ requestId }` |
| `friend.accept`         | `FriendAcceptSchema`        | `{ requestId: uuid }`    | —               |
| `friend.reject`         | `FriendRejectSchema`        | `{ requestId: uuid }`    | —               |
| `friend.remove`         | `FriendRemoveSchema`        | `{ targetUserId: uuid }` | —               |
| `friend.cancel_request` | `FriendCancelRequestSchema` | `{ requestId: uuid }`    | —               |

Server → client (published to `user:<id>`, forwarded by the `user:*` psubscribe):

| Event              | Emit site         | Payload                                   |
| ------------------ | ----------------- | ----------------------------------------- |
| `friend.requested` | `chat.ns.ts:976`  | `{ requestId, requesterId, addresseeId }` |
| `friend.accepted`  | `chat.ns.ts:1016` | `{ requestId, acceptedBy, requesterId }`  |
| `friend.removed`   | `chat.ns.ts:1077` | `{ removedBy, userId }`                   |

> Note: the `info.tags` block already advertises behavior for chat/community/notify but there is **no `friend` channel/operation** anywhere. The `/notify` `NotificationItem` even lists `friend.requested`/`friend.accepted` as notification `type`s, so the realtime socket events are the missing half of an already-half-documented feature.

### 2.2 `/chat` — Session lifecycle (2 events) — `chat.ns.ts:632, 654–700`

| Direction | Event             | Payload                                                                         | Notes                                                                               |
| --------- | ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| receive   | `session:expired` | `{ reason: "TOKEN_EXPIRED", expiresAt: int, reconnect: true, gracePeriod: 60 }` | Emitted ~5 min before token expiry; 60 s grace then force-disconnect.               |
| send      | `auth:refresh`    | `{ refreshToken: string }` → ack `{ accessToken, expiresIn }`                   | Refreshes the access token without a transport reconnect; resets the expiry timers. |

### 2.3 `/community` — Moderation suite (8 events) — `community.ns.ts:478–666`

Client → server (server-side role-authorized; `actorId`/`reporterId` derived from the socket):

| Event                          | Validator                | Payload                                                     |
| ------------------------------ | ------------------------ | ----------------------------------------------------------- |
| `community.member.kick`        | `KickMemberSchema`       | `{ communityId, targetUserId, reason? ≤500 }`               |
| `community.member.ban`         | `BanMemberSchema`        | `{ communityId, targetUserId, reason? ≤500 }`               |
| `community.member.unban`       | `UnbanMemberSchema`      | `{ communityId, targetUserId }`                             |
| `community.admin.transfer`     | `TransferAdminSchema`    | `{ communityId, newAdminId }`                               |
| `community.member.role_change` | `ChangeMemberRoleSchema` | `{ communityId, targetUserId, newRole: MODERATOR\|MEMBER }` |
| `community.report.create`      | `CreateReportSchema`     | `{ communityId, reason: 1–1000, targetMessageId? }`         |
| `community.delete`             | `DeleteCommunitySchema`  | `{ communityId, reason? ≤500 }`                             |

Server → client:

| Event               | Emit site             | Payload                                                                     |
| ------------------- | --------------------- | --------------------------------------------------------------------------- |
| `community.deleted` | `community.ns.ts:655` | `{ communityId, deletedBy }` (broadcast to `community:<id>` before the ack) |

> These handlers return `FORBIDDEN` when the gRPC `result.ok` is false (role check failed) and `SERVICE_ERROR` on a downstream throw.

---

## 3. Schema `required` mismatches (deliverable: Schema Mismatch Report)

The validator treats these fields as **optional** (or defaulted), but the AsyncAPI schema lists them as **required**. A client that omits them is accepted by the gateway, so the docs over-constrain.

| Schema                          | Doc `required`                                   | Validator reality                                                             | Fix                                                      |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `MessageSendPayload`            | `[conversationId, clientMessageId, contentType]` | `clientMessageId` is `.optional()` (`chat.ns.ts:59`; "omit to auto-generate") | drop `clientMessageId` → `[conversationId, contentType]` |
| `CommunityJoinPayload`          | `[communityId, roomId]`                          | `roomId` is `.optional()` (`community.ns.ts:17`)                              | drop `roomId` → `[communityId]`                          |
| `CommunityMessageSendPayload`   | `[communityId, roomId, contentType]`             | `roomId` `.optional()` (`community.ns.ts:35`)                                 | drop `roomId` → `[communityId, contentType]`             |
| `CommunityMessageEditPayload`   | `[messageId, communityId, roomId, content]`      | `roomId` `.optional()` (`community.ns.ts:114`)                                | drop `roomId`                                            |
| `CommunityMessageDeletePayload` | `[messageId, communityId, roomId, type]`         | `roomId` `.optional()` (`community.ns.ts:121`)                                | drop `roomId`                                            |
| `CommunityMessagePinPayload`    | `[messageId, communityId, roomId]`               | `roomId` `.optional()` (`community.ns.ts:128`)                                | drop `roomId`                                            |
| `CommunityMessageUnpinPayload`  | `[messageId, communityId, roomId]`               | `roomId` `.optional()` (`community.ns.ts:134`)                                | drop `roomId`                                            |

> Server→client payloads that the gateway always stamps `roomId` on (`CommunityMessageEditedPayload`, `…PinnedPayload`, `…UnpinnedPayload`, `…DeletedPayload`) correctly keep `roomId` required — those are unchanged.

---

## 4. Numeric-bound mismatches

| Schema                                              | Doc   | Code (`community.ns.ts`)                       | Fix         |
| --------------------------------------------------- | ----- | ---------------------------------------------- | ----------- |
| `CommunityCatchupPayload.rooms.maxItems`            | `20`  | `CommunityCatchupSchema` `.max(10)` (:108)     | `20 → 10`   |
| `CommunityCatchupPayload.rooms.items.limit.maximum` | `200` | `CommunityCatchupRoomSchema` `.max(100)` (:96) | `200 → 100` |

The `community.catchup` **operation description** ("up to 20 rooms") is wrong for the same reason → change to 10.

`ChatCatchupPayload` (rooms `maxItems: 50`, per-room `limit.maximum: 200`) **matches** `CatchupSchema` (`.max(50)` / `.max(200)`) — left as-is. Don't conflate the two: chat allows 50 rooms / limit 200; community allows 10 rooms / limit 100.

---

## 5. Acknowledgement contract mismatches

The real ack envelope (`ack.ts`) is **exactly**:

```
success: { success: true, message }                  // no data
         { success: true, message, data }             // with data
failure: { success: false, error, retryable, message }
```

`ackError(callback, code, locale)` takes **no** `retryAfter` and never sets one. The error codes are the closed set `INVALID_PAYLOAD | SERVICE_ERROR | FORBIDDEN | NOT_FOUND | RATE_LIMITED | CONFLICT`.

| Finding                                         | Detail                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`retryAfter` never emitted**                  | Documented as an optional ack field and shown in the "rate limited" example, but no code path produces it.                                                                                                                                  | Remove `retryAfter` from the example; mark the schema field **"Reserved — not emitted in V1"** so clients don't wait on it.                                                                                                      |
| **`RATE_LIMITED` never emitted by any handler** | It's in the taxonomy (`retryable:true`) but **no `ackError(…, "RATE_LIMITED")` call exists** in any namespace. The documented "react returns RATE_LIMITED" is aspirational — a downstream rate-limit currently surfaces as `SERVICE_ERROR`. | Keep the enum value (valid, future-proof) but soften the react/REACT rate-limit notes to "enforced downstream; currently surfaces as `SERVICE_ERROR`". Keep one RATE*LIMITED example as the \_intended* shape, clearly labelled. |

---

## 6. Example-only defects

| Event                                      | Defect                                                                                                                                                                                                                                                                                                                                | Fix                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `typing:start` / `typing:stop` (broadcast) | `TypingBroadcastPayload` documents only `{ userId, conversationId }`, but the gateway re-emits `senderName` when the sender supplied it (`chat.ns.ts:725–731, 750–754`). The send-side `TypingStartRequest` (uses `ConversationRef`) also omits the optional `senderName` the validator accepts (`TypingSchema`, `chat.ns.ts:25–30`). | Add optional `senderName` to both the request schema and `TypingBroadcastPayload` + show it in one example. |
| `ack` "rate limited" example               | Shows `retryAfter: 1749465261234` — never emitted (see §5).                                                                                                                                                                                                                                                                           | Remove the field from the example.                                                                          |

---

## 7. Event-by-event status (deliverable: AsyncAPI Audit Report)

Legend: ✅ exists & matches · ⚠️ exists, schema/example fix · ➕ missing, to add.

### `/chat` client → server

| Event                                                           | Status | Issue                                             |
| --------------------------------------------------------------- | ------ | ------------------------------------------------- |
| `conv:join`, `conv:leave`                                       | ✅     | —                                                 |
| `message:send`                                                  | ⚠️     | `required` over-constrains `clientMessageId` (§3) |
| `message:read`, `message:delivered`                             | ✅     | —                                                 |
| `message:react`, `message:reactions:get`                        | ⚠️     | react rate-limit note inaccurate (§5)             |
| `message:edit`, `message:forward`                               | ✅     | —                                                 |
| `messages:fetch`, `chat:catchup`                                | ✅     | —                                                 |
| `typing:start`, `typing:stop`                                   | ⚠️     | optional `senderName` undocumented (§6)           |
| `presence:heartbeat/subscribe/unsubscribe/unsubscribe_all/list` | ✅     | —                                                 |
| `call:initiate/answer/decline/end/ice`                          | ✅     | —                                                 |
| `auth:refresh`                                                  | ➕     | undocumented (§2.2)                               |
| `friend.request/accept/reject/remove/cancel_request`            | ➕     | undocumented (§2.1)                               |

### `/chat` server → client

| Event                                                               | Status | Issue                     |
| ------------------------------------------------------------------- | ------ | ------------------------- |
| `message:new/edited/delete`, `conv:updated`, `community:updated`    | ✅     | —                         |
| `chat:catchup:result`, `message:read/delivered`, `message:reaction` | ✅     | —                         |
| `read_sync`, `pin:updated`, `presence:status`                       | ✅     | —                         |
| `typing:start/stop` (broadcast)                                     | ⚠️     | missing `senderName` (§6) |
| `call:incoming/answered/declined/ended/ice`                         | ✅     | —                         |
| `session:expired`                                                   | ➕     | undocumented (§2.2)       |
| `friend.requested/accepted/removed`                                 | ➕     | undocumented (§2.1)       |

### `/community` client → server

| Event                                         | Status | Issue                              |
| --------------------------------------------- | ------ | ---------------------------------- |
| `community:join`                              | ⚠️     | `roomId` wrongly required (§3)     |
| `community:leave`                             | ✅     | —                                  |
| `community:message:send`                      | ⚠️     | `roomId` wrongly required (§3)     |
| `community:messages:fetch`                    | ✅     | —                                  |
| `community:message:react`                     | ✅     | —                                  |
| `community:catchup`                           | ⚠️     | room cap 20→10, limit 200→100 (§4) |
| `community:message:edit/delete/pin/unpin`     | ⚠️     | `roomId` wrongly required (§3)     |
| `community.member.kick/ban/unban`             | ➕     | undocumented (§2.3)                |
| `community.admin.transfer`                    | ➕     | undocumented (§2.3)                |
| `community.member.role_change`                | ➕     | undocumented (§2.3)                |
| `community.report.create`, `community.delete` | ➕     | undocumented (§2.3)                |

### `/community` server → client

| Event                                                       | Status | Issue                                                     |
| ----------------------------------------------------------- | ------ | --------------------------------------------------------- |
| `community:message:new`                                     | ✅     | —                                                         |
| `community:member:joined`                                   | ✅     | (schema reserved — no producer yet; already noted in doc) |
| `community:catchup:result`                                  | ✅     | —                                                         |
| `community:message:reaction/edited/deleted/pinned/unpinned` | ✅     | —                                                         |
| `community.deleted`                                         | ➕     | undocumented (§2.3)                                       |

### `/notify` (both directions)

| Event                                                                 | Status | Issue |
| --------------------------------------------------------------------- | ------ | ----- |
| `notifications:fetch`, `notifications:mark_read`                      | ✅     | —     |
| `notification:count`, `notification:count_update`, `notification:new` | ✅     | —     |

`/notify` is **fully synchronized** — no changes needed.

---

## 8. Final updates applied to `asyncapi.yaml`

See the changelog at the bottom of this file as edits land. Summary of intended changes:

- **Examples fixed:** remove `retryAfter` from the rate-limited ack example; add `senderName` to a typing broadcast example.
- **Schemas fixed:** 7 `required`-array corrections (§3); 2 numeric bounds (§4); mark ack `retryAfter` reserved; soften react rate-limit notes.
- **Events added:** 17 (friend ×8, auth/session ×2, community moderation ×8 — see §2). Each gets a channel message ref, an operation, a component message with a realistic example, and a payload schema.
- **Events removed:** none — no phantom/stale events were found.

---

## Changelog

- 2026-06-12 — Initial audit; findings above. **All fixes applied in the same pass** and the
  spec re-validated clean: `pnpm --filter @aimess/api-gateway asyncapi:validate` →
  _"File asyncapi/asyncapi.yaml is valid"_ (0 errors, 0 warnings; only an info note suggesting
  AsyncAPI 3.1.0). Net: +17 events documented (friend ×8, auth/session ×2, community moderation ×8),
  7 `required`-array corrections, 2 catchup numeric bounds, `retryAfter` marked reserved + removed
  from the example, `RATE_LIMITED` react notes softened, typing `senderName` added. 0 events removed.
