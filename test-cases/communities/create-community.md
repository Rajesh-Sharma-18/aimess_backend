# Communities — Create

**Source:** `apps/community-service/src/api/routes/community.routes.ts` (`POST /`), `controllers/community.controller.ts` (`createCommunity`), `validators/community.validator.ts` (`createCommunitySchema`), `services/community.service.ts` (`create`), `repositories/community.repository.ts`, `lib/community-image.service.ts`, `lib/user-client.ts`.

> **Service:** community-service (MongoDB / Prisma). All endpoints require a valid access token (`authenticateAccessToken`). The community's chat room is provisioned asynchronously in chat-service via `publishCommunityCreatedForChatSafe` (GeneralRoom id === community.id).

Base path: `/api/v1/communities` (gateway routes to community-service).

---

### TC-COMM-001 — Create community with all valid fields

| Field                     | Value                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Create                                                                                                                                                        |
| **API/Event Name**        | `POST /api/v1/communities`                                                                                                                                                  |
| **Test Scenario**         | Happy path — name, handle, type, valid categoryId, description, avatar key, member list                                                                                     |
| **Category**              | Happy Path                                                                                                                                                                  |
| **Priority**              | High                                                                                                                                                                        |
| **Preconditions**         | Authenticated user; `categoryId` is an active seeded category (`pnpm db:setup:community`); `avatarObjectKey` was returned by `POST /uploads/url` and owned by caller        |
| **Request Payload**       | `{ "name": "Rust Devs", "handle": "rust_devs", "type": "PUBLIC", "categoryId": "<24hex>", "description": "Hi", "avatarObjectKey": "<key>", "memberIds": ["<friendUuid>"] }` |
| **Expected Response**     | `201` `{ data: { id, name, handle, type, category, creatorId, adminId, memberCount, avatarUrl, myRole: "ADMIN", myIsMuted:false, ... } }`                                   |
| **Expected DB Changes**   | New `Community` (deletedAt null); creator `CommunityMember` role=ADMIN status=ACTIVE; friend members created role=MEMBER status=ACTIVE; `memberCount` recomputed            |
| **Expected Socket/Event** | RabbitMQ `community.created.for-chat` (provisions chat room). No `/community` socket event.                                                                                 |
| **Notes**                 | Name/handle normalized; name+handle availability cache invalidated.                                                                                                         |

### TC-COMM-002 — Create with minimal required fields only

| Field                     | Value                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Communities / Create                                                                       |
| **API/Event Name**        | `POST /api/v1/communities`                                                                 |
| **Test Scenario**         | name + handle + type + categoryId; no description/avatar/memberIds                         |
| **Category**              | Required Params                                                                            |
| **Priority**              | High                                                                                       |
| **Preconditions**         | Valid category                                                                             |
| **Request Payload**       | `{ "name": "Solo Hub", "handle": "solo_hub", "type": "PRIVATE", "categoryId": "<24hex>" }` |
| **Expected Response**     | `201`; `memberCount: 1`, `myRole: "ADMIN"`, `description: null`, `avatarUrl: null`         |
| **Expected DB Changes**   | Community + single ADMIN member row                                                        |
| **Expected Socket/Event** | RabbitMQ `community.created.for-chat`                                                      |
| **Notes**                 | `memberIds` defaults to `[]`.                                                              |

### TC-COMM-003 — Name too short (<3 chars)

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Feature/Module**        | Communities / Create                                                           |
| **API/Event Name**        | `POST /api/v1/communities`                                                     |
| **Test Scenario**         | `name: "ab"`                                                                   |
| **Category**              | Input Validation                                                               |
| **Priority**              | Medium                                                                         |
| **Preconditions**         | —                                                                              |
| **Request Payload**       | `{ "name": "ab", "handle": "abc", "type": "PUBLIC", "categoryId": "<24hex>" }` |
| **Expected Response**     | `400` validation error ("Name must be at least 3 characters")                  |
| **Expected DB Changes**   | None                                                                           |
| **Expected Socket/Event** | None                                                                           |
| **Notes**                 | name 3–50; description ≤500.                                                   |

### TC-COMM-004 — Handle with invalid chars

| Field                     | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Create                                                                         |
| **API/Event Name**        | `POST /api/v1/communities`                                                                   |
| **Test Scenario**         | Handle contains spaces/uppercase/symbols → normalized then regex-checked                     |
| **Category**              | Input Validation                                                                             |
| **Priority**              | Medium                                                                                       |
| **Preconditions**         | —                                                                                            |
| **Request Payload**       | `{ "name": "Cool Club", "handle": "Cool Club!", "type": "PUBLIC", "categoryId": "<24hex>" }` |
| **Expected Response**     | `400` ("Handle may only contain lowercase letters, numbers, and underscores")                |
| **Expected DB Changes**   | None                                                                                         |
| **Expected Socket/Event** | None                                                                                         |
| **Notes**                 | Handle normalized via `normalizeHandle`, then min 3 / max 32 / `^[a-z0-9_]+$`.               |

### TC-COMM-005 — Invalid type enum

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Create                                                                |
| **API/Event Name**        | `POST /api/v1/communities`                                                          |
| **Test Scenario**         | `type: "SECRET"` not in PUBLIC/PRIVATE                                              |
| **Category**              | Input Validation                                                                    |
| **Priority**              | Medium                                                                              |
| **Preconditions**         | —                                                                                   |
| **Request Payload**       | `{ "name": "X Hub", "handle": "x_hub", "type": "SECRET", "categoryId": "<24hex>" }` |
| **Expected Response**     | `400`                                                                               |
| **Expected DB Changes**   | None                                                                                |
| **Expected Socket/Event** | None                                                                                |
| **Notes**                 | —                                                                                   |

### TC-COMM-006 — categoryId not a 24-hex ObjectId

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Communities / Create                                     |
| **API/Event Name**        | `POST /api/v1/communities`                               |
| **Test Scenario**         | Malformed categoryId                                     |
| **Category**              | Input Validation                                         |
| **Priority**              | Medium                                                   |
| **Preconditions**         | —                                                        |
| **Request Payload**       | `{ ..., "categoryId": "123" }`                           |
| **Expected Response**     | `400` ("categoryId must be a 24-character hex ObjectId") |
| **Expected DB Changes**   | None                                                     |
| **Expected Socket/Event** | None                                                     |
| **Notes**                 | —                                                        |

### TC-COMM-007 — categoryId well-formed but does not exist / inactive

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Communities / Create                                |
| **API/Event Name**        | `POST /api/v1/communities`                          |
| **Test Scenario**         | 24-hex ObjectId that is not an active category      |
| **Category**              | Business Rule                                       |
| **Priority**              | High                                                |
| **Preconditions**         | categoryId not present in seeded active categories  |
| **Request Payload**       | `{ ..., "categoryId": "ffffffffffffffffffffffff" }` |
| **Expected Response**     | `400` `COMMUNITY_CATEGORY_INVALID`                  |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | `findActiveCategoryById` must return a row.         |

### TC-COMM-008 — Duplicate name conflict

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Communities / Create                                         |
| **API/Event Name**        | `POST /api/v1/communities`                                   |
| **Test Scenario**         | Name (normalized) already used by another community          |
| **Category**              | Business Rule                                                |
| **Priority**              | High                                                         |
| **Preconditions**         | A community already exists with normalized name              |
| **Request Payload**       | `{ "name": "Rust Devs", "handle": "different_handle", ... }` |
| **Expected Response**     | `409` `COMMUNITY_NAME_TAKEN`                                 |
| **Expected DB Changes**   | None (P2002 → conflict mapped by target)                     |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | Uniqueness on normalized name.                               |

### TC-COMM-009 — Duplicate handle conflict

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Create                                                 |
| **API/Event Name**        | `POST /api/v1/communities`                                           |
| **Test Scenario**         | Handle already taken                                                 |
| **Category**              | Business Rule                                                        |
| **Priority**              | High                                                                 |
| **Preconditions**         | A community uses the normalized handle                               |
| **Request Payload**       | `{ "name": "Brand New", "handle": "rust_devs", ... }`                |
| **Expected Response**     | `409` `COMMUNITY_HANDLE_TAKEN`                                       |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | `uniqueViolationToConflict` inspects P2002 meta target for "handle". |

### TC-COMM-010 — Non-friend memberIds silently dropped

| Field                     | Value                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Communities / Create                                                                                         |
| **API/Event Name**        | `POST /api/v1/communities`                                                                                   |
| **Test Scenario**         | memberIds includes UUIDs the creator is NOT accepted friends with                                            |
| **Category**              | Business Rule                                                                                                |
| **Priority**              | Medium                                                                                                       |
| **Preconditions**         | Some memberIds are not ACCEPTED friends                                                                      |
| **Request Payload**       | `{ ..., "memberIds": ["<friend>", "<stranger>"] }`                                                           |
| **Expected Response**     | `201`; only friend added; stranger silently excluded (no error)                                              |
| **Expected DB Changes**   | Member rows for creator + valid friends only                                                                 |
| **Expected Socket/Event** | RabbitMQ `community.created.for-chat`                                                                        |
| **Notes**                 | `fetchAcceptedFriendIds`; on user-service failure returns empty set → only creator. Decision B3 no override. |

### TC-COMM-011 — memberIds includes creator's own id

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Create                                                 |
| **API/Event Name**        | `POST /api/v1/communities`                                           |
| **Test Scenario**         | Self-id in memberIds                                                 |
| **Category**              | Edge Case                                                            |
| **Priority**              | Low                                                                  |
| **Preconditions**         | —                                                                    |
| **Request Payload**       | `{ ..., "memberIds": ["<creatorId>"] }`                              |
| **Expected Response**     | `201`; creator added once as ADMIN, not duplicated as MEMBER         |
| **Expected DB Changes**   | Single creator row (ADMIN)                                           |
| **Expected Socket/Event** | RabbitMQ `community.created.for-chat`                                |
| **Notes**                 | Self-excluded before friend validation. memberIds deduped + max 500. |

### TC-COMM-012 — Avatar object key not owned by caller

| Field                     | Value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Create                                                            |
| **API/Event Name**        | `POST /api/v1/communities`                                                      |
| **Test Scenario**         | avatarObjectKey belongs to another user / does not exist (HEAD fails)           |
| **Category**              | File Upload                                                                     |
| **Priority**              | Medium                                                                          |
| **Preconditions**         | Object key not owned / missing in storage                                       |
| **Request Payload**       | `{ ..., "avatarObjectKey": "<foreign-or-missing-key>" }`                        |
| **Expected Response**     | `400`/`403` from `resolveObjectKeyForCommunity` (ownership + HEAD before write) |
| **Expected DB Changes**   | None (validated before community write)                                         |
| **Expected Socket/Event** | None                                                                            |
| **Notes**                 | Confirm exact error code in `community-image.service.ts`.                       |

### TC-COMM-013 — Unauthenticated create

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Communities / Create                            |
| **API/Event Name**        | `POST /api/v1/communities`                      |
| **Test Scenario**         | No / invalid bearer token                       |
| **Category**              | AuthN                                           |
| **Priority**              | High                                            |
| **Preconditions**         | —                                               |
| **Request Payload**       | valid body, no `Authorization` header           |
| **Expected Response**     | `401`                                           |
| **Expected DB Changes**   | None                                            |
| **Expected Socket/Event** | None                                            |
| **Notes**                 | `communityRoutes.use(authenticateAccessToken)`. |

### TC-COMM-014 — Partial-create rollback on member write failure

| Field                     | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Create                                                    |
| **API/Event Name**        | `POST /api/v1/communities`                                              |
| **Test Scenario**         | Community row created but member/snapshot write throws                  |
| **Category**              | DB State                                                                |
| **Priority**              | Medium                                                                  |
| **Preconditions**         | Inject failure after community insert (e.g. user-service snapshot down) |
| **Request Payload**       | valid body                                                              |
| **Expected Response**     | `5xx`; no orphaned community remains                                    |
| **Expected DB Changes**   | `cleanupFailedCreate` hard-deletes members + community                  |
| **Expected Socket/Event** | None                                                                    |
| **Notes**                 | No `$transaction` (standalone Mongo) — compensating cleanup by hand.    |

### TC-COMM-015 — Name availability check (helper endpoint)

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ | ---------- |
| **Feature/Module**        | Communities / Create helpers                           |
| **API/Event Name**        | `GET /api/v1/communities/name-available?name=<n>`      |
| **Test Scenario**         | Pre-flight availability for a free name                |
| **Category**              | Happy Path                                             |
| **Priority**              | Low                                                    |
| **Preconditions**         | Authenticated                                          |
| **Request Payload**       | query `name=Rust Devs`                                 |
| **Expected Response**     | `200` `{ data: { name: "<normalized>", available: true | false } }` |
| **Expected DB Changes**   | None (cached)                                          |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | Cache-first via `communityCache`.                      |

### TC-COMM-016 — Handle availability check (helper endpoint)

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- | ---------- |
| **Feature/Module**        | Communities / Create helpers                             |
| **API/Event Name**        | `GET /api/v1/communities/handle-available?handle=<h>`    |
| **Test Scenario**         | Pre-flight availability for a handle                     |
| **Category**              | Happy Path                                               |
| **Priority**              | Low                                                      |
| **Preconditions**         | Authenticated                                            |
| **Request Payload**       | query `handle=rust_devs`                                 |
| **Expected Response**     | `200` `{ data: { handle: "<normalized>", available: true | false } }` |
| **Expected DB Changes**   | None                                                     |
| **Expected Socket/Event** | None                                                     |
| **Notes**                 | Invalid handle in query → `400`.                         |

### TC-COMM-017 — Concurrent create of same handle (race)

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Communities / Create                                         |
| **API/Event Name**        | `POST /api/v1/communities`                                   |
| **Test Scenario**         | Two requests create identical handle simultaneously          |
| **Category**              | Concurrency                                                  |
| **Priority**              | Medium                                                       |
| **Preconditions**         | Two authenticated users, same free handle                    |
| **Request Payload**       | identical handle                                             |
| **Expected Response**     | One `201`, the other `409` `COMMUNITY_HANDLE_TAKEN`          |
| **Expected DB Changes**   | Exactly one community                                        |
| **Expected Socket/Event** | RabbitMQ `community.created.for-chat` for winner only        |
| **Notes**                 | DB unique index is the source of truth (cache can be stale). |

### TC-COMM-018 — Get community by id (membership-aware)

| Field                     | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Read                                                                           |
| **API/Event Name**        | `GET /api/v1/communities/:id`                                                                |
| **Test Scenario**         | Fetch a community; myRole reflects ACTIVE membership                                         |
| **Category**              | Happy Path                                                                                   |
| **Priority**              | Medium                                                                                       |
| **Preconditions**         | Community exists                                                                             |
| **Request Payload**       | path id                                                                                      |
| **Expected Response**     | `200` DTO with `myRole` (ADMIN/MODERATOR/MEMBER or null), `myIsMuted`, `myMuteUntil`         |
| **Expected DB Changes**   | None                                                                                         |
| **Expected Socket/Event** | None                                                                                         |
| **Notes**                 | BANNED/LEFT members → `myRole: null`. Non-existent/soft-deleted → `404 COMMUNITY_NOT_FOUND`. |
