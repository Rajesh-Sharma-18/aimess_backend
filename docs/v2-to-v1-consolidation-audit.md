# V2 → V1 Consolidation Audit

**Branch:** `refactor/v1-to-v2-migration`
**Date:** 2026-08-07
**Goal:** fold every V2 capability into the existing V1 endpoints, then delete the V2 surface entirely. No V1 endpoint is removed. No duplicate V1/V2 implementation is left behind.

---

## 1. Surface inventory

All route registrations under `apps/*/src` — 388 total.

| Surface                      | Public prefix | Endpoints                                      |
| ---------------------------- | ------------- | ---------------------------------------------- |
| **V1** (client-facing)       | `/api/v1/*`   | ~276                                           |
| **V2**                       | `/api/v2/*`   | **12**                                         |
| Backoffice admin             | `/admin/v1/*` | 62 (separate surface, never had a v1/v2 split) |
| Health / internal / webhooks | unversioned   | ~38                                            |

V2 is not a competing implementation of the API. It is a **pagination-contract variant** of 12 endpoints, declared as such in `apps/api-gateway/src/versioning/registry.ts:86` ("V2 is a PARALLEL, additive surface"). Only two services host V2 routes: `chat-service` (11) and `community-service` (1).

Sockets are **not** versioned — the `/chat`, `/community`, `/notify`, `/stream` namespaces have no v1/v2 split. gRPC, queue consumers, background jobs and notification services carry no version segment either. **This migration touches REST only.**

---

## 2. V2 → V1 mapping

Legend for **Action**:

- **MERGE** — the V1 endpoint already exists; V2's extra capability is added to it additively.
- **PORT** — no V1 equivalent exists; the route moves onto the V1 router unchanged.
- **DROP** — pure duplicate of V1; delete the V2 route, no other work.

| #   | V2 endpoint                                           | V1 target                                             | Action | V2-only capability being moved                                                      |
| --- | ----------------------------------------------------- | ----------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| 1   | `GET /api/v2/communities/mine`                        | `GET /api/v1/communities/mine`                        | MERGE  | opaque compound `cursor` (`<ms>_<communityId>`), exclusive keyset                   |
| 2   | `GET /api/v2/chat/private/rooms/:roomId/messages`     | `GET /api/v1/chat/private/rooms/:roomId/messages`     | MERGE  | `pinnedMessage` in response                                                         |
| 3   | `GET /api/v2/chat/private/rooms/:roomId/changes`      | `GET /api/v1/chat/private/rooms/:roomId/changes`      | PORT   | whole endpoint (zero-loss revision feed)                                            |
| 4   | `POST /api/v2/chat/private/messages/:messageId/react` | `POST /api/v1/chat/private/messages/:messageId/react` | PORT   | whole endpoint (room-inferred SET reaction)                                         |
| 5   | `GET /api/v2/chat/group/rooms/:roomId/messages`       | `GET /api/v1/chat/groups/:roomId/messages`            | MERGE  | `pinnedMessage` in response                                                         |
| 6   | `GET /api/v2/chat/group/rooms/:roomId/changes`        | `GET /api/v1/chat/groups/:roomId/changes`             | PORT   | whole endpoint                                                                      |
| 7   | `DELETE /api/v2/chat/group/messages/:messageId`       | `DELETE /api/v1/chat/groups/messages/:messageId`      | PORT   | whole endpoint (path-param delete; V1's body-carried `POST /messages/delete` stays) |
| 8   | `POST /api/v2/chat/group/messages/:messageId/react`   | `POST /api/v1/chat/groups/messages/:messageId/react`  | PORT   | whole endpoint                                                                      |
| 9   | `GET /api/v2/chat/inbox`                              | `GET /api/v1/chat/inbox`                              | MERGE  | `before_cursor`/`after_cursor` compound exclusive keyset                            |
| 10  | `GET /api/v2/chat/community/rooms/:roomId/messages`   | `GET /api/v1/chat/community/rooms/:roomId/messages`   | MERGE  | `before_seq`/`after_seq` sequence keyset                                            |
| 11  | `GET /api/v2/chat/community/rooms/:roomId/changes`    | `GET /api/v1/chat/community/rooms/:roomId/changes`    | PORT   | whole endpoint                                                                      |
| 12  | `GET /api/v2/chat/community/rooms/:roomId/sync`       | `GET /api/v1/chat/community/rooms/:roomId/sync`       | DROP   | none — identical handler and validator already on V1                                |

**Path-shape note (#5–#8):** V2 chat used the singular `/group/rooms/:roomId/...`; V1 uses the plural `/groups/:roomId/...`. Per the agreed decision, **plural `/groups` wins** — the V1 shape is canonical and no V1 path is renamed.

---

## 3. Per-endpoint detail

### 3.1 MERGE #1 — `/communities/mine`

|                    | V1 today                                                                                                                                       | V2 today                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Joined-mode cursor | `before_ts` / `after_ts`, bare epoch-ms, **inclusive** boundary (pages share the boundary row on `lastActivityAt` ties; clients de-dupe by id) | single opaque `cursor` = `<ms>_<id>`, **exclusive** compound keyset             |
| Mode inference     | a pagination param present → joined mode; otherwise search/discover mode                                                                       | `q`/`categoryId` present → search; **default (no params) → joined newest page** |
| Response envelope  | `PaginatedResponse<CommunityListItem>`                                                                                                         | identical                                                                       |
| Service            | `communityService.listMine`                                                                                                                    | `communityService.listMineV2`                                                   |
| Repository         | `listMineByActivity`                                                                                                                           | `listMineByActivityKeyset`                                                      |

**Merge:** add `cursor` to `myCommunitiesQuerySchema`; in `listMyCommunities`, branch on `cursor != null` → keyset path. The `before_ts`/`after_ts` branch and the existing mode-inference rule are untouched, so every current caller is byte-identical. `listMineV2` is renamed `listMineKeyset` (implementation kept, V2 naming dropped).

### 3.2 MERGE #2 / #5 — private + group message timelines

|                                              | V1 today                                                                                                          | V2 today                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Pagination params                            | `before_ts` / `after_ts` (compound `<ms>_<objectId>`), `before_seq` / `after_seq`, `around`, `limit` (default 30) | `before_seq` / `after_seq`, `around`, `limit` (default 40) — `.strict()`, everything else 400s |
| Envelope                                     | `{ pagination, data, hasMore, nextCursor, …cursors, roomRevision }`                                               | `{ items, page: { limit, hasMoreOlder, hasMoreNewer, olderSeq, newerSeq } }`                   |
| `pinnedMessage`                              | ✗ **missing**                                                                                                     | ✓                                                                                              |
| `peerReadSeq` / `peerDeliveredSeq` (private) | ✓                                                                                                                 | ✓                                                                                              |
| `memberReadSeq` (group)                      | ✓                                                                                                                 | ✗ **missing**                                                                                  |
| `totalCount`                                 | ✓ (`countMessages`)                                                                                               | ✗ (skipped for cost)                                                                           |
| Enrichment                                   | `enrichMessages` (private) / `enrichForWire` (group)                                                              | same                                                                                           |

> The OpenAPI v2 spec (`docs/openapi/versions/v2/index.ts`) still documents `before_cursor`/`after_cursor` for these two endpoints. **The code does not accept them** — `timelineV2QuerySchema` is `.strict()` and seq-only. The published V2 doc is wrong today; it is deleted as part of this work.

**Merge:** the only V1 gap is `pinnedMessage`, added additively to the V1 response. The V1 envelope is kept as-is — adopting V2's `items`/`page` shape would break every existing V1 client. V1 is already the richer surface on every other axis (it keeps `memberReadSeq`, `totalCount`, and the timestamp cursors V2 dropped).

### 3.3 MERGE #9 — unified inbox

|            | V1 today                                                                                            | V2 today                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Params     | `before_ts` / `after_ts`, bare epoch-ms, **inclusive**                                              | `before_cursor` / `after_cursor` = `<ms>_<roomId>`, **exclusive** compound keyset |
| Envelope   | `{ pagination, data, hasMore, nextCursor }`                                                         | `{ items, page, totalCount }`                                                     |
| Service    | one `InboxService.getInbox`, already parameterised by `boundaryId` / `inclusive` / `compoundCursor` | same                                                                              |
| Rate limit | `inbox:list` 120/min per user                                                                       | separate `inbox:list:v2` instance, same budget                                    |

**Merge:** add `before_cursor`/`after_cursor` to `inboxQuerySchema`; when either is present, pass `boundaryId` + `inclusive:false` + `compoundCursor:true` through to the single existing service call. V1 envelope kept. The duplicate `inboxV2Limit` limiter is deleted (V1's route already carries the equivalent).

The `roomId` tiebreaker is a **string** (`prv_`/`grp_` + nanoid), so the cursor regex is `^\d+(_[A-Za-z0-9_-]{1,64})?$` and `parseTsCursor` must keep splitting on the **first** `_` so the `prv_`/`grp_` prefix survives.

### 3.4 MERGE #10 — community message timeline

|                                 | V1 today                                                             | V2 today                                      |
| ------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| History cursor                  | `before_ts` — bare epoch-ms **or** compound `<ms>_<objectId>`        | same keyset, via `getMessagesSeqV2`'s ts path |
| Incremental sync                | `after_ts` → `getMessagesSince` (`updatedAt >=`, returns tombstones) | ✗                                             |
| Sequence keyset                 | ✗ **missing**                                                        | `before_seq` / `after_seq`                    |
| `around`                        | ✓                                                                    | ✓ (+ `roomRevision` on the around branch)     |
| `pinnedMessage`, `roomRevision` | ✓                                                                    | ✓                                             |

**Merge:** add `before_seq`/`after_seq` to `communityTimelineQuerySchema` and a seq branch to the V1 handler. Precedence becomes `around` → seq → `after_ts` (sync) → `before_ts`/newest. Existing callers send none of the new params, so their path is unchanged. `getMessagesSeqV2` / `getMessagesAroundV2` are renamed to drop the V2 suffix; they already delegate to the shared cores in `lib/timeline-pagination.ts` that V1 uses, so there is no duplicated logic to collapse.

### 3.5 PORT #3 / #6 / #11 — the `/changes` zero-loss feed

Exists on V2 only, for all three room kinds. Envelope is identical across them (`items`, `roomRevision`, `resetRequired`, `hasMore`, `nextRevisionCursor`; private adds `peerReadSeq`/`peerDeliveredSeq`, community adds `pinnedMessage`).

**Port:** register the route on each V1 router at the V1 path shape. Controllers (`getChanges`) and services are unchanged. `chatChangesV2QuerySchema` / `communityChangesV2QuerySchema` are renamed without the V2 suffix (they are byte-identical to each other — collapsed into one shared schema).

### 3.6 PORT #4 / #8 — `POST /messages/:messageId/react`

V2-only shape: the room is resolved **from the message**, so an offline queue can drain a reaction with only `(messageId, emoji)` and no conversation-type special case. Semantics are `op:"set"` (single-write SET), not V1's `add`/`remove` toggle pair.

V1's room-scoped `POST /:roomId/messages/:messageId/reactions` and `DELETE …/reactions/:emoji` are **kept** — they are a different operation, not a duplicate. Both call the same `orchestrator.reactDirect`.

Route-ordering verified: `/messages/:messageId/react` (3 segments) collides with nothing on either the private or group router.

### 3.7 PORT #7 — `DELETE /groups/messages/:messageId`

V2-only path shape. V1's `POST /groups/messages/delete` (body-carried `messageId` + `roomId`) is **kept**. Both handlers already share the private `runDelete` core — no duplication.

Route-ordering verified: `DELETE /messages/:messageId` (2 segments) does not collide with `group-room.routes.ts`'s `DELETE /:roomId` (1 segment), even though that router is mounted first.

---

## 4. Deletion set

31 files reference V2. After the merge:

**Files deleted outright**

- `apps/chat-service/src/api/routes/chat-v2.routes.ts`
- `apps/chat-service/src/api/routes/community-v2.routes.ts`
- `apps/community-service/src/api/routes/community-v2.routes.ts`
- `apps/api-gateway/src/routes/v2/index.ts`
- `apps/api-gateway/src/docs/openapi/versions/v2/` (whole directory)

**Code removed**

- chat-service `routes/index.ts` — the four `/api/v2/chat/*` mounts
- community-service `app.ts` — the `/api/v2` mount
- gateway `versioning/registry.ts` — `v2Services` + both `v2Services.push` blocks
- gateway `versioning/types.ts` — `API_VERSIONS` becomes `["v1"]`
- gateway `routes/api.routes.ts` — `apiRouter.use("/v2", …)` and the `createV2Router` import
- gateway `docs/openapi/openapi-document.ts` — `versionSpecs.v2` + the v2 import
- controllers: `getMessagesV2`, `listMessagesV2` (private + group), `getInboxV2`, `listMyCommunitiesV2`
- validators: `timelineV2QuerySchema`, `privateTimelineV2QuerySchema`, `groupTimelineV2QuerySchema`, `communityTimelineV2QuerySchema`, `inboxV2QuerySchema`, `myCommunitiesV2QuerySchema`, `MyCommunitiesV2Query`, `V2_TIMELINE_LIMIT`
- `lib/pagination.ts` — `buildTimelinePageV2`, `buildListPageV2`, `TimelineResponseV2`, `ListResponseV2`, `ListPage` (verified: only the deleted V2 handlers call them)
- the `inbox:list:v2` rate limiter

**Renamed (V2 suffix dropped, implementation kept)**

- `communityService.listMineV2` → `listMineKeyset`
- `communityMessageService.getMessagesSeqV2` → `getMessagesSeqKeyset`
- `communityMessageService.getMessagesAroundV2` — **deleted, not renamed.** It had no
  caller even before this work (the V2 `around` branch called the TIMESTAMP-anchored
  `getMessagesAround`), so it was already dead code.
- `deleteMessageV2` → `deleteMessageByPath`
- `setReactionV2` → `setReaction`
- `chatChangesV2QuerySchema` + `communityChangesV2QuerySchema` → one shared `roomChangesQuerySchema`

**Docs**

- OpenAPI v1 spec gains the ported paths (`/changes` ×3, react ×2, group delete) and the new query params (`cursor` on `/communities/mine`, `before_cursor`/`after_cursor` on `/chat/inbox`, `before_seq`/`after_seq` on the community timeline, `pinnedMessage` in the private/group timeline responses)
- `/docs/versions` collapses to a single version
- `docs/CLIENT_V2_MIGRATION_RULEBOOK.md` — retired, superseded by the frontend guide

**Tests**

- `apps/chat-service/tests/lib/chat-cursor-v2.test.ts` — retargeted to V1 paths/params
- `apps/chat-service/tests/community/community-message-v2-controller.test.ts` — retargeted
- `apps/community-service/tests/community/community-mine-keyset-pagination.test.ts` — retargeted to `/api/v1/communities/mine?cursor=`
- `apps/api-gateway/tests/proxy/routing.test.ts` — v2 proxy cases removed
- `community-seq-pagination.test.ts`, `group-message-seq-read-access.test.ts` — incidental V2 references cleaned

---

## 5. Backward-compatibility guarantees

Every V1 request that works today produces a byte-identical response after this change, because:

1. No V1 route, controller, service, validator or DTO is removed.
2. Every new query param is **optional** with no default that alters an existing code path (`cursor`, `before_cursor`, `after_cursor`, `before_seq`, `after_seq`).
3. No V1 schema gains `.strict()` — unknown params keep being stripped, not rejected.
4. Response changes are **additive only** (`pinnedMessage` on the private/group timelines). No field is renamed or removed.
5. V1 mode-inference rules (`/communities/mine` joined-vs-search, community `after_ts` sync-vs-history) are preserved exactly; new params are checked _after_ the existing ones.

**Clients currently on V2 must change** — that is the intended breaking surface, and it is limited to those 12 endpoints. The path change plus the envelope difference (`items`/`page` → `data`/`pagination`) is documented in `docs/frontend-v2-to-v1-migration-guide.md`.
