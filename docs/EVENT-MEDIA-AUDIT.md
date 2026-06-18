# Event History & Media-URL Audit

> Full-codebase audit performed 2026-06-12 across all 8 services + `packages/*` + docs.
> Method: 24-agent parallel sweep (two tracks) with an adversarial verification pass on
> every flagged media leak and a completeness critic. This document is the source of
> truth for the **System Event Messages in Chat History** and **Media-URL Standardization**
> initiatives. Keep it updated as fixes land.

---

## 1. Executive summary

| Initiative                         | Headline finding                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task 1 — System event messages** | Infra exists for **group rooms only**. **62** business events should appear in a chat timeline; community rooms produce **zero** system messages and structurally **cannot** (no schema columns). Calls never enter history. The `SystemEvent` enum is not centralized. |
| **Task 2 — Media URLs**            | A centralized resolver (`@aimess/storage` `toMediaObject`) exists but **chat paths never call it**. **41** confirmed raw-object-key leaks reach the FE (verified; 9 false positives cleared).                                                                           |

---

## 2. Current system-message infrastructure

| Timeline   | Message model        | System columns                                                        | Poster                                                                 | Status                                    |
| ---------- | -------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| Group      | `GroupMessage`       | `systemEvent`, `systemData`, `messageType:"SYSTEM"`, `sequenceNumber` | `GroupSystemMessageService.post()`                                     | ✅ working (9 event types)                |
| Private/DM | `PrivateMessage`     | `systemEvent`, `systemData`                                           | one hard-coded invite-DM path in `community-room-sync.consumer.ts:250` | ⚠️ partial, bypasses canonical serializer |
| Community  | `GeneralRoomMessage` | **none**                                                              | **none**                                                               | ❌ structurally incapable                 |

Key files:

- `apps/chat-service/src/services/group-system-message.service.ts` — the working group poster.
- `apps/chat-service/src/types/enums.ts:82` — `SystemEvent` enum (chat-service-local, **not** in `packages/`).
- `apps/chat-service/src/events/community-room-sync.consumer.ts` — consumes 5 `community.chat.sync.queue` events but only mutates room/member rows.
- `apps/chat-service/src/lib/chat-message.serializer.ts` — canonical wire serializer (`buildChatMessageEvent`).

---

## 3. Business-event inventory (deliverable 2)

158 distinct business events were inventoried platform-wide. **62 should become chat system messages.** The non-chat remainder (auth/account lifecycle, pure notifications) is intentionally excluded.

### 3.1 Community → community room (16) — **all currently missing**

| Event code                                   | Trigger (`community.service.ts`)                              | RabbitMQ                                                          | Consumed by                            | Template                                                                            |
| -------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `COMMUNITY_CREATED`                          | `:875`                                                        | `community.created` (chat.sync)                                   | chat consumer (provisions room only)   | `{actor} created the community`                                                     |
| `COMMUNITY_UPDATED`                          | `:921`/`:1000`                                                | **none**                                                          | —                                      | `{actor} renamed to "{name}" / updated the description / made it {public\|private}` |
| `COMMUNITY_AVATAR_CHANGED`                   | `:988`                                                        | **none**                                                          | —                                      | `{actor} changed the community photo`                                               |
| `COMMUNITY_MEMBER_JOINED`                    | `:2818` approve, `:4289` invite-redeem, `:3201` invite-accept | `community.member_added` / **none** / `community.invite_accepted` | notifications only                     | `{target} joined the community`                                                     |
| `COMMUNITY_MEMBER_ADDED`                     | `:1715`                                                       | `community.member_added`                                          | notifications only                     | `{actor} added {target}`                                                            |
| `COMMUNITY_MEMBER_LEFT`                      | `:1728` single / `:1901` bulk                                 | **none** / `community.member_left`                                | none                                   | `{actor} left the community`                                                        |
| `COMMUNITY_MEMBER_REMOVED`                   | `:1444` kick                                                  | `community.member_kicked`                                         | notifications only                     | `{actor} removed {target}`                                                          |
| `COMMUNITY_MEMBER_BANNED`                    | `:1542`                                                       | `community.member_banned`                                         | notifications only                     | `{actor} banned {target}`                                                           |
| `COMMUNITY_ROLE_CHANGED`                     | `:1311`                                                       | `community.member_role_changed`                                   | notifications only                     | `{actor} made {target} a {role}`                                                    |
| `COMMUNITY_OWNERSHIP_TRANSFERRED`            | `:2417`                                                       | `community.admin_transferred`                                     | notifications only                     | `{actor} transferred ownership to {target}`                                         |
| `COMMUNITY_SUSPENDED` / `COMMUNITY_RESTORED` | `:3940` (admin gRPC)                                          | `community.status.changed` (chat.sync)                            | chat consumer (flips room status only) | `This community has been suspended/reopened by moderators`                          |

> **Gaps with no publisher at all:** `community.updated` (rename/description/avatar/privacy/category), single-endpoint leave, join-request reject, unban, invite-redeem join.

### 3.2 Group → group room

- **Already posted (9):** `GROUP_CREATED`, `MEMBER_ADDED/JOINED/LEFT/REMOVED`, `ROLE_CHANGED`, `ROOM_RENAMED`, `AVATAR_CHANGED`, `DESCRIPTION_CHANGED`.
- **Enum exists but never posted (6):** `GROUP_DISBANDED` (`group-room.service.ts:144`), `MESSAGE_PINNED`/`MESSAGE_UNPINNED` (`group-pin.service.ts:22`), `INVITE_LINK_CREATED`, `ADMIN_ASSIGNED`/`ADMIN_REMOVED`, `MESSAGES_ENCRYPTED`.

### 3.3 Private/DM → private room

| Event                                | Trigger                                                              | Status                         |
| ------------------------------------ | -------------------------------------------------------------------- | ------------------------------ |
| `FRIEND_ACCEPTED`                    | `user-service friendship.service.ts:169/230/333` → `friend.accepted` | not in DM timeline (push only) |
| `USER_BLOCKED` / `USER_UNBLOCKED`    | **no write path exists** (Block model is read-only today)            | n/a until feature built        |
| `MESSAGES_ENCRYPTED`                 | no E2EE implemented                                                  | n/a                            |
| `CALL_STARTED/ENDED/MISSED/DECLINED` | `call.service.ts` (see 3.4)                                          | **never posted**               |

### 3.4 Calls → DM (highest-impact gap)

`apps/chat-service/src/services/call.service.ts` initiate/answer/decline/end only publish ephemeral Redis signals + write the `Call` row. **No call ever appears in the conversation.** `CALL_STARTED`/`CALL_ENDED` are in the enum with no poster; `CALL_MISSED`/`CALL_DECLINED` aren't even in the enum.

### 3.5 Livestream → community/group room (not yet implementable)

`LIVE_STARTED/ENDED/CANCELLED` — `LivestreamStatus.LIVE/ENDED/CANCELED` exist but **no producer code sets them**. Requires building the producer state transitions first.

---

## 4. Media-URL leaks (deliverables 5 & 6)

> **STATUS: RESOLVED (2026-06-12).** All 41 leaks below are closed via
> **resolve-on-read** at each owner service's output boundary (REST + gRPC +
> Redis broadcast + FCM push), reusing `@aimess/storage` `toMediaObject` and
> chat-service `src/lib/media-resolve.ts`. media-service `POST /media/upload-url`
> now also returns a ready `media.downloadUrl`. The gateway forwards
> already-resolved URLs; Swagger examples show full URLs. Verified green: chat
> 246, community 218, media 13, backoffice 37 jest + 15 node:test; all services
> typecheck clean. Stored snapshots keep the **raw key**; URLs are signed only on
> read and **never persisted**.

**41 confirmed** raw-object-key responses reaching the FE (adversarially verified) — **now resolved**.

| Service                     | Count | Representative leaks (`file:line`)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **chat-service**            | 17    | `user-service-client.ts:25` (avatar snapshot), `chat-message.serializer.ts:179` (`senderAvatar`+`content`), `community-message.service.ts:386/558` (`toWire`/sync attachments), `private-message.service.ts:687`, `private-room.service.ts:131`, `inbox.service.ts:176`, `group-message.service.ts:675` (reactions), `*-pin.service.ts` snapshots, `group-system-message.service.ts:90`, `admin-group.service.ts:203/211/226`, `community-room-sync.consumer.ts:137` (provisioned logo) |
| **api-gateway**             | 13    | forwards chat/community gRPC + socket payloads verbatim: `messaging.client.ts:60/185`, `community.client.ts:80/93/119`, `chat.ns.ts:31/53/79`, `community.ns.ts:22/57/63`; Swagger examples `schemas.ts:1325/1340/1370` literally show `"avatars/u_9f3a.webp"`                                                                                                                                                                                                                          |
| **backoffice-service**      | 6     | `community.grpc.repository.ts:42/230/243`, `group.grpc.repository.ts:22/30/41`                                                                                                                                                                                                                                                                                                                                                                                                          |
| **community-service**       | 3     | `grpc/server.ts:189` (`adminAvatarUrl`), `:272` (`adminAvatarUrl`), `:283` (`coverUrl`) — admin gRPC handlers skip `communityImageService`/`memberAvatarService`                                                                                                                                                                                                                                                                                                                        |
| **notifications-service**   | 2     | `chat.consumer.ts:27/59` (`senderAvatar` in FCM data map)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| auth / user / media-service | 0     | ✅ already resolve via `@aimess/storage`                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Root cause (fixed):** avatar/attachment object keys are stored in denormalized snapshots and were echoed verbatim; chat read/realtime paths never invoked the resolver. The `mediaUrlStrategy` (chat-service `config/storage.ts`) is now consumed across every read/serialize/broadcast path via `src/lib/media-resolve.ts` (`resolveMediaUrl` / `resolveMediaUrlMap` / `urlFromMap` / `applyUrlMapToFiles` / `resolveContentFiles` / `resolvePinsMedia`), and the gRPC realtime broadcasts + the FCM-push publisher resolve before emitting.

---

## 5. Architectural findings & recommendations (deliverable 11)

1. **Centralize `SystemEvent`** into `@aimess/constants` (or `shared-types`) with a centralized event→template map; every producer imports it. Today it's chat-service-local + stringly-typed literals.
2. **One shared `SystemMessageService`** for all three message models (group/private/community), replacing the divergent hand-built invite-DM payload.
3. **Migrate `GeneralRoomMessage`**: add `systemEvent`, `systemData`, `sequenceNumber` + `@@index([roomId, sequenceNumber])`. Prerequisite for any community system message.
4. **Resolve media on read, never cache** resolved URLs (presign URLs expire). Stop freezing raw keys into `lastMessagePreview`/`systemData.actorAvatar`/reaction avatars.
5. **Single media boundary** in owner-service serializers via `@aimess/storage`; gateway forwards already-resolved URLs.
6. **Reliability**: give system-message `post()` + the community consumer bounded retry/DLQ instead of swallowing errors / nack-no-requeue.
7. **Consistent SYSTEM unread/preview/ordering policy** across all three room types, with `sequenceNumber` ordering everywhere (not just groups).

---

## 6. Implementation plan

- **Phase 0 — Foundations:** centralize `SystemEvent` + template map (shared pkg); migrate `GeneralRoomMessage`; generalize `GroupSystemMessageService` → shared `SystemMessageService`; shared media-resolve-on-read helper.
- **Phase 1 — Media (Task 2):** apply the resolver across chat/community serializers + admin/notifications surfaces; fix Swagger examples + DTOs; tests (full URL / null / missing / invalid key).
- **Phase 2 — Community events:** add missing publishers + a chat-service consumer that posts community system messages.
- **Phase 3 — Calls + private + remaining group posters.**
- **Phase 4 — Livestream** (needs producer work) **+ Phase 5 — reliability/DLQ, pagination/ordering validation, docs.**

> Open item to confirm before the migration: the community timeline appears to be `GeneralRoom`/`GeneralRoomMessage`, but `GroupRoomType` also has a `COMMUNITY` value — verify the exact wiring first.
