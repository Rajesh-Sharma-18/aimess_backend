# Communities — Discovery & Listing (pagination / filter / sort)

**Source:** `apps/community-service/src/api/routes/community.routes.ts` (`GET /discover`, `GET /mine`), `controllers/community.controller.ts` (`discoverCommunities`, `listMyCommunities`), `validators/community.validator.ts` (`discoverQuerySchema`, `myCommunitiesQuerySchema`), `services/community.service.ts` (`discover`, `listMine`). Also chat-service room listing (see community-chat.md).

> **Service:** community-service. `discover` (deprecated alias) = offset/page pagination over PUBLIC communities the caller is NOT already in. `mine` infers the mode from params (no `scope`): **at least one of `before_ts`/`after_ts`/`q`/`categoryId` is required**. Pagination present → cursor pagination ordered by `lastActivityAt` over my ACTIVE-member communities. Else → search across PUBLIC communities PLUS PRIVATE ones the caller is an ACTIVE member of (joined NOT excluded), filtered by `q`/`categoryId`. All datetime response fields are epoch milliseconds (number).
>
> **Merged endpoint (current):** `GET /communities/mine` now serves both datasets via a `scope` param — `scope=joined` (default) = my communities (cursor pagination, `before_ts`/`after_ts`); `scope=discover` = public browse/search (offset pagination, `q`/`categoryId`/`filter`/`page`). `scope` defaults to `joined`, so all existing `/mine` calls are unchanged. Every `GET /communities/discover?...` case below is equivalent to `GET /communities/mine?scope=discover&...` and returns the identical `CommunityDiscoverResponseData`. The legacy `GET /communities/discover` route is kept as a **deprecated alias**. Params irrelevant to the active scope are ignored.

---

### TC-COMM-103 — Discover all PUBLIC communities (page 1)

| Field                     | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Discovery                                                                                  |
| **API/Event Name**        | `GET /api/v1/communities/discover?filter=all&page=1&limit=20`                                            |
| **Test Scenario**         | Browse public communities                                                                                |
| **Category**              | Pagination/Filter/Sort                                                                                   |
| **Priority**              | High                                                                                                     |
| **Preconditions**         | Authenticated; PUBLIC communities exist                                                                  |
| **Request Payload**       | query                                                                                                    |
| **Expected Response**     | `200` paginated discover items (id, name, handle, type, category, memberCount, avatarUrl) + `pagination` |
| **Expected DB Changes**   | None                                                                                                     |
| **Expected Socket/Event** | None                                                                                                     |
| **Notes**                 | Excludes communities caller is active/pending/banned in (`listExcludedCommunityIds`).                    |

### TC-COMM-104 — Discover with text search `q`

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Communities / Discovery                   |
| **API/Event Name**        | `GET /api/v1/communities/discover?q=rust` |
| **Test Scenario**         | Search by name/handle                     |
| **Category**              | Pagination/Filter/Sort                    |
| **Priority**              | Medium                                    |
| **Preconditions**         | Matching communities exist                |
| **Request Payload**       | `q=rust` (1–100 chars)                    |
| **Expected Response**     | `200` matching subset                     |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | Empty `q` → `400`; >100 chars → `400`.    |

### TC-COMM-105 — Discover filtered by categoryId

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Communities / Discovery                               |
| **API/Event Name**        | `GET /api/v1/communities/discover?categoryId=<24hex>` |
| **Test Scenario**         | Filter by category                                    |
| **Category**              | Pagination/Filter/Sort                                |
| **Priority**              | Medium                                                |
| **Preconditions**         | Communities in that category                          |
| **Request Payload**       | `categoryId=<24hex>`                                  |
| **Expected Response**     | `200` filtered list                                   |
| **Expected DB Changes**   | None                                                  |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | Malformed categoryId → `400`.                         |

### TC-COMM-106 — Discover filter=live / upcoming returns empty (gap)

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Discovery                                                             |
| **API/Event Name**        | `GET /api/v1/communities/discover?filter=live`                                      |
| **Test Scenario**         | Livestream-based filter                                                             |
| **Category**              | Edge Case / Gap                                                                     |
| **Priority**              | Low                                                                                 |
| **Preconditions**         | —                                                                                   |
| **Request Payload**       | `filter=live` or `filter=upcoming`                                                  |
| **Expected Response**     | `200` empty page (no error)                                                         |
| **Expected DB Changes**   | None                                                                                |
| **Expected Socket/Event** | None                                                                                |
| **Notes**                 | Reserved until stream-service ships — returns `buildPaginatedResponse([], 0, ...)`. |

### TC-COMM-107 — Discover limit boundary

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Communities / Discovery                        |
| **API/Event Name**        | `GET /api/v1/communities/discover?limit=51`    |
| **Test Scenario**         | limit exceeds cap                              |
| **Category**              | Input Validation                               |
| **Priority**              | Low                                            |
| **Preconditions**         | —                                              |
| **Request Payload**       | `limit=51` / `limit=0` / `page=0`              |
| **Expected Response**     | `400` (limit max 50; page/limit positive ints) |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | defaults page=1, limit=20.                     |

### TC-COMM-108 — Discover excludes communities caller already in

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Communities / Discovery                                    |
| **API/Event Name**        | `GET /api/v1/communities/discover`                         |
| **Test Scenario**         | Member/pending/banned communities not shown                |
| **Category**              | Business Rule                                              |
| **Priority**              | High                                                       |
| **Preconditions**         | Caller is active in community A, pending in B, banned in C |
| **Request Payload**       | query                                                      |
| **Expected Response**     | `200`; A, B, C absent from results                         |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | PRIVATE communities never appear in discover.              |

### TC-COMM-109 — List my communities (cursor, newest first)

| Field                     | Value                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Listing                                                                                                                                                |
| **API/Event Name**        | `GET /api/v1/communities/mine?before_ts=<ms>&limit=20`                                                                                                               |
| **Test Scenario**         | First page of caller's communities by lastActivityAt (newest)                                                                                                        |
| **Category**              | Pagination/Filter/Sort                                                                                                                                               |
| **Priority**              | High                                                                                                                                                                 |
| **Preconditions**         | Caller is a member of ≥1 community                                                                                                                                   |
| **Request Payload**       | `before_ts` = now (or any ts ≥ newest)                                                                                                                               |
| **Expected Response**     | `200` items (id, name, handle, type, memberCount, avatarUrl, myRole, lastActivityAt) + `pagination.nextCursor` (epoch-ms) + `hasMore`                                |
| **Expected DB Changes**   | None                                                                                                                                                                 |
| **Expected Socket/Event** | None                                                                                                                                                                 |
| **Notes**                 | `lastActivityAt` is **epoch ms (number)**. Ordered by lastActivityAt (latest message else createdAt). Joined mode requires `before_ts`/`after_ts` (no bare `/mine`). |

### TC-COMM-110 — List my communities — before_ts pagination

| Field                     | Value                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Listing                                                                    |
| **API/Event Name**        | `GET /api/v1/communities/mine?before_ts=<ms>&limit=20`                                   |
| **Test Scenario**         | Older page (newest-first)                                                                |
| **Category**              | Pagination/Filter/Sort                                                                   |
| **Priority**              | Medium                                                                                   |
| **Preconditions**         | More than one page                                                                       |
| **Request Payload**       | `before_ts` = previous nextCursor                                                        |
| **Expected Response**     | `200` next older page; boundary community may repeat (inclusive) — client de-dupes by id |
| **Expected DB Changes**   | None                                                                                     |
| **Expected Socket/Event** | None                                                                                     |
| **Notes**                 | `lastActivityAt <= before_ts`.                                                           |

### TC-COMM-111 — List my communities — after_ts pagination

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Communities / Listing                        |
| **API/Event Name**        | `GET /api/v1/communities/mine?after_ts=<ms>` |
| **Test Scenario**         | Fetch newer (oldest-first) page              |
| **Category**              | Pagination/Filter/Sort                       |
| **Priority**              | Low                                          |
| **Preconditions**         | —                                            |
| **Request Payload**       | `after_ts`                                   |
| **Expected Response**     | `200`; `lastActivityAt >= after_ts`          |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | —                                            |

### TC-COMM-112 — before_ts and after_ts both provided

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Communities / Listing                                    |
| **API/Event Name**        | `GET /api/v1/communities/mine?before_ts=1&after_ts=2`    |
| **Test Scenario**         | Mutually exclusive cursors                               |
| **Category**              | Input Validation                                         |
| **Priority**              | Medium                                                   |
| **Preconditions**         | —                                                        |
| **Request Payload**       | both params                                              |
| **Expected Response**     | `400` ("Provide either before_ts or after_ts, not both") |
| **Expected DB Changes**   | None                                                     |
| **Expected Socket/Event** | None                                                     |
| **Notes**                 | `myCommunitiesQuerySchema.refine`.                       |

### TC-COMM-113 — List my communities when none

| Field                     | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Listing                                                     |
| **API/Event Name**        | `GET /api/v1/communities/mine?before_ts=<ms>`                             |
| **Test Scenario**         | Caller has no communities (joined mode, empty page)                       |
| **Category**              | Edge Case                                                                 |
| **Priority**              | Low                                                                       |
| **Preconditions**         | New user                                                                  |
| **Request Payload**       | `before_ts` = now                                                         |
| **Expected Response**     | `200` `{ data: [], pagination: { hasMore:false, nextCursor:null, ... } }` |
| **Expected DB Changes**   | None                                                                      |
| **Expected Socket/Event** | None                                                                      |
| **Notes**                 | totalPage floors to 1. Bare `/mine` (no param) → `400` (see TC-COMM-116). |

---

### TC-COMM-114 — `/mine` search mode (q/categoryId, no pagination)

| Field                     | Value                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Listing                                                                                                                                                                                                     |
| **API/Event Name**        | `GET /api/v1/communities/mine?q=rust&categoryId=<24hex>&filter=all&page=1&limit=20`                                                                                                                                       |
| **Test Scenario**         | Search mode: `q`/`categoryId` (no `before_ts`/`after_ts`) → PUBLIC communities PLUS PRIVATE ones the caller is an ACTIVE member of, filtered                                                                              |
| **Category**              | Functional                                                                                                                                                                                                                |
| **Priority**              | High                                                                                                                                                                                                                      |
| **Preconditions**         | A matching PUBLIC community, and a matching PRIVATE community the caller is an ACTIVE member of                                                                                                                           |
| **Request Payload**       | —                                                                                                                                                                                                                         |
| **Expected Response**     | `200` `CommunityDiscoverResponseData` (offset/page `pagination` + discover items); includes the matching PRIVATE community the caller is in; joined PUBLIC communities are NOT excluded; `createdAt` is epoch ms (number) |
| **Expected DB Changes**   | None                                                                                                                                                                                                                      |
| **Expected Socket/Event** | None                                                                                                                                                                                                                      |
| **Notes**                 | Differs from the deprecated `/discover` alias, which excludes ALL joined communities and is PUBLIC-only.                                                                                                                  |

---

### TC-COMM-115 — `/mine` joined mode takes precedence over q/categoryId

| Field                     | Value                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Listing                                                                                                                             |
| **API/Event Name**        | `GET /api/v1/communities/mine?before_ts=<ms>&q=rust&limit=20`                                                                                     |
| **Test Scenario**         | When `before_ts`/`after_ts` is present, joined mode runs even if `q`/`categoryId` is also sent                                                    |
| **Category**              | Functional                                                                                                                                        |
| **Priority**              | High                                                                                                                                              |
| **Preconditions**         | Caller is an ACTIVE member of ≥1 community                                                                                                        |
| **Request Payload**       | —                                                                                                                                                 |
| **Expected Response**     | `200` `MyCommunitiesResponseData` (cursor pagination over my communities); `q`/`categoryId`/`page` ignored; `lastActivityAt` is epoch ms (number) |
| **Expected DB Changes**   | None                                                                                                                                              |
| **Expected Socket/Event** | None                                                                                                                                              |
| **Notes**                 | Pagination present → joined mode wins. The two pagination styles never combine.                                                                   |

---

### TC-COMM-116 — `/mine` with no filter or pagination param → 400

| Field                     | Value                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Listing                                                                                      |
| **API/Event Name**        | `GET /api/v1/communities/mine` (or only `?limit=20`)                                                       |
| **Test Scenario**         | At least one of `before_ts`/`after_ts`/`q`/`categoryId` is required                                        |
| **Category**              | Input Validation                                                                                           |
| **Priority**              | High                                                                                                       |
| **Preconditions**         | —                                                                                                          |
| **Request Payload**       | none of the four required params                                                                           |
| **Expected Response**     | `400` ("At least one filter or pagination parameter is required (before_ts, after_ts, q, or categoryId).") |
| **Expected DB Changes**   | None                                                                                                       |
| **Expected Socket/Event** | None                                                                                                       |
| **Notes**                 | `myCommunitiesQuerySchema.refine` (path `before_ts`).                                                      |
