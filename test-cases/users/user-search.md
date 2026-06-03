# USERS — User Search / Discovery

Source: `apps/user-service/src/api/routes/users.routes.ts`, `controllers/user-discovery.controller.ts`, `validators/user-discovery.validator.ts`, `services/user-discovery.service.ts`, `repositories/user-profile.repository.ts`. Route mounted at `/api/v1/users/` (GET `/`).

Endpoint:

- `GET /api/v1/users/?section=&q=&page=&limit=` — paginated user search with relationship annotations

---

### TC-USER-078 — Search others (default section, happy path)

| Field                     | Value                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                                                                                                                               |
| **API/Event Name**        | `GET /api/v1/users/`                                                                                                                                            |
| **Test Scenario**         | Default section returns non-friends, excluding self/friends/blocked                                                                                             |
| **Category**              | Happy Path                                                                                                                                                      |
| **Priority**              | High                                                                                                                                                            |
| **Preconditions**         | Authenticated viewer; other active profiles exist                                                                                                               |
| **Request Payload**       | (no query) → defaults `section=others, page=1, limit=20`                                                                                                        |
| **Expected Response**     | `200` `{ data: { users: [{ userId, username, firstName, lastName, bio, avatarUrl, avatarUrlExpiresIn, isOnline, relationshipStatus, friendshipId }], total } }` |
| **Expected DB Changes**   | None                                                                                                                                                            |
| **Expected Socket/Event** | None                                                                                                                                                            |
| **Notes**                 | `others` excludes viewer, accepted friends, and blocked users. relationshipStatus ∈ NONE/PENDING_IN/PENDING_OUT.                                                |

### TC-USER-079 — Search friends section

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Users / Discovery                                                  |
| **API/Event Name**        | `GET /api/v1/users/?section=friends`                               |
| **Test Scenario**         | Returns only accepted friends                                      |
| **Category**              | Happy Path                                                         |
| **Priority**              | High                                                               |
| **Preconditions**         | Viewer has accepted friends                                        |
| **Request Payload**       | `?section=friends`                                                 |
| **Expected Response**     | `200`; each user `relationshipStatus="FRIEND"`, `friendshipId` set |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | Empty `{ users: [], total: 0 }` when viewer has no friends.        |

### TC-USER-080 — Search all section

| Field                     | Value                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                                                                                                                                                                                                      |
| **API/Event Name**        | `GET /api/v1/users/?section=all`                                                                                                                                                                                                       |
| **Test Scenario**         | Returns everyone except self and blocked, no relationship annotation                                                                                                                                                                   |
| **Category**              | Happy Path                                                                                                                                                                                                                             |
| **Priority**              | Medium                                                                                                                                                                                                                                 |
| **Preconditions**         | Authenticated viewer                                                                                                                                                                                                                   |
| **Request Payload**       | `?section=all`                                                                                                                                                                                                                         |
| **Expected Response**     | `200`; users without relationshipStatus/friendshipId fields                                                                                                                                                                            |
| **Expected DB Changes**   | None                                                                                                                                                                                                                                   |
| **Expected Socket/Event** | None                                                                                                                                                                                                                                   |
| **Notes**                 | `_queryAll` excludes only viewer + blockerIds. NOTE: it only collects `b.blockerId` from blocks, so users the viewer blocked (where viewer is blocker) may still appear — verify intended exclusion of both directions. Potential GAP. |

### TC-USER-081 — Search with query string filter

| Field                     | Value                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                                                                    |
| **API/Event Name**        | `GET /api/v1/users/?q=`                                                                              |
| **Test Scenario**         | Filter by username/name substring                                                                    |
| **Category**              | Pagination/Filter/Sort                                                                               |
| **Priority**              | High                                                                                                 |
| **Preconditions**         | Profiles matching/not matching `q`                                                                   |
| **Request Payload**       | `?q=ada`                                                                                             |
| **Expected Response**     | `200` only matching users; `total` reflects filtered count                                           |
| **Expected DB Changes**   | None                                                                                                 |
| **Expected Socket/Event** | None                                                                                                 |
| **Notes**                 | Verify which columns `q` matches (username/firstName/lastName) and case-insensitivity in repository. |

### TC-USER-082 — Pagination page/limit

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                   |
| **API/Event Name**        | `GET /api/v1/users/?page=&limit=`                   |
| **Test Scenario**         | Second page with custom limit                       |
| **Category**              | Pagination/Filter/Sort                              |
| **Priority**              | High                                                |
| **Preconditions**         | > limit users available                             |
| **Request Payload**       | `?page=2&limit=5`                                   |
| **Expected Response**     | `200`; users skipping first 5; total = full count   |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | `skip = (page-1)*limit`. total independent of page. |

### TC-USER-083 — Pagination limit bounds

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Users / Discovery                       |
| **API/Event Name**        | `GET /api/v1/users/?limit=`             |
| **Test Scenario**         | limit below 1 or above 50               |
| **Category**              | Input Validation                        |
| **Priority**              | Medium                                  |
| **Preconditions**         | Authenticated viewer                    |
| **Request Payload**       | `?limit=0` / `?limit=51` / `?limit=-3`  |
| **Expected Response**     | `400` (min 1, max 50)                   |
| **Expected DB Changes**   | None                                    |
| **Expected Socket/Event** | None                                    |
| **Notes**                 | `coerce.number().int().min(1).max(50)`. |

### TC-USER-084 — Page must be positive int

| Field                     | Value                                |
| ------------------------- | ------------------------------------ |
| **Feature/Module**        | Users / Discovery                    |
| **API/Event Name**        | `GET /api/v1/users/?page=`           |
| **Test Scenario**         | page 0, negative, or non-numeric     |
| **Category**              | Input Validation                     |
| **Priority**              | Medium                               |
| **Preconditions**         | Authenticated viewer                 |
| **Request Payload**       | `?page=0` / `?page=-1` / `?page=abc` |
| **Expected Response**     | `400`                                |
| **Expected DB Changes**   | None                                 |
| **Expected Socket/Event** | None                                 |
| **Notes**                 | `coerce.number().int().positive()`.  |

### TC-USER-085 — Invalid section enum

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Users / Discovery                     |
| **API/Event Name**        | `GET /api/v1/users/?section=`         |
| **Test Scenario**         | section not in {friends, others, all} |
| **Category**              | Input Validation                      |
| **Priority**              | Low                                   |
| **Preconditions**         | Authenticated viewer                  |
| **Request Payload**       | `?section=enemies`                    |
| **Expected Response**     | `400` invalid enum                    |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |
| **Notes**                 | —                                     |

### TC-USER-086 — q length cap

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                    |
| **API/Event Name**        | `GET /api/v1/users/?q=`                              |
| **Test Scenario**         | q over 100 chars                                     |
| **Category**              | Input Validation                                     |
| **Priority**              | Low                                                  |
| **Preconditions**         | Authenticated viewer                                 |
| **Request Payload**       | `?q=<101 chars>`                                     |
| **Expected Response**     | `400` (max 100)                                      |
| **Expected DB Changes**   | None                                                 |
| **Expected Socket/Event** | None                                                 |
| **Notes**                 | q trimmed; empty q treated as undefined (no filter). |

### TC-USER-087 — Empty result set

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                          |
| **API/Event Name**        | `GET /api/v1/users/`                                       |
| **Test Scenario**         | No users match / page beyond range                         |
| **Category**              | Edge Case                                                  |
| **Priority**              | Low                                                        |
| **Preconditions**         | Authenticated viewer                                       |
| **Request Payload**       | `?q=zzz_no_match` / `?page=9999`                           |
| **Expected Response**     | `200` `{ users: [], total: <0 or matching count> }`        |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | Out-of-range page returns empty users with non-zero total. |

### TC-USER-088 — Search requires auth

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                          |
| **API/Event Name**        | `GET /api/v1/users/`                                       |
| **Test Scenario**         | No Bearer token                                            |
| **Category**              | AuthN                                                      |
| **Priority**              | High                                                       |
| **Preconditions**         | None                                                       |
| **Request Payload**       | (none)                                                     |
| **Expected Response**     | `401`                                                      |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | viewerId from token drives exclusion + relationship logic. |

### TC-USER-089 — AuthZ: blocked users excluded both ways (others)

| Field                     | Value                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                                                                                                                         |
| **API/Event Name**        | `GET /api/v1/users/?section=others`                                                                                                                       |
| **Test Scenario**         | Viewer blocked B and C blocked viewer — both excluded                                                                                                     |
| **Category**              | AuthZ                                                                                                                                                     |
| **Priority**              | High                                                                                                                                                      |
| **Preconditions**         | Block rows where viewer is blocker and where viewer is blocked                                                                                            |
| **Request Payload**       | `?section=others`                                                                                                                                         |
| **Expected Response**     | `200`; neither B nor C present                                                                                                                            |
| **Expected DB Changes**   | None                                                                                                                                                      |
| **Expected Socket/Event** | None                                                                                                                                                      |
| **Notes**                 | `_queryOthers` adds `b.blockerId===viewer ? b.blockedId : b.blockerId` → both directions. Contrast with `all` (TC-USER-080) which only filters blockerId. |

### TC-USER-090 — Relationship annotation: PENDING_IN vs PENDING_OUT

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Users / Discovery                                                                    |
| **API/Event Name**        | `GET /api/v1/users/?section=others`                                                  |
| **Test Scenario**         | Pending request directions correctly labeled                                         |
| **Category**              | Business Rule                                                                        |
| **Priority**              | Medium                                                                               |
| **Preconditions**         | Viewer sent a request to X; Y sent a request to viewer                               |
| **Request Payload**       | `?section=others`                                                                    |
| **Expected Response**     | `200`; X → PENDING_OUT, Y → PENDING_IN, with friendshipId                            |
| **Expected DB Changes**   | None                                                                                 |
| **Expected Socket/Event** | None                                                                                 |
| **Notes**                 | `isRequester = f.requesterId===viewer`. Accepted friends are excluded from `others`. |

### TC-USER-091 — Security: q injection / wildcard handling

| Field                     | Value                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                                                                                                                                         |
| **API/Event Name**        | `GET /api/v1/users/?q=`                                                                                                                                                   |
| **Test Scenario**         | q contains SQL/regex/`%`/`_` LIKE wildcards                                                                                                                               |
| **Category**              | Security                                                                                                                                                                  |
| **Priority**              | Medium                                                                                                                                                                    |
| **Preconditions**         | Authenticated viewer                                                                                                                                                      |
| **Request Payload**       | `?q=%` / `?q=' OR 1=1--` / `?q=a_b`                                                                                                                                       |
| **Expected Response**     | `200` treated as literal search; no injection, no full-table dump                                                                                                         |
| **Expected DB Changes**   | None                                                                                                                                                                      |
| **Expected Socket/Event** | None                                                                                                                                                                      |
| **Notes**                 | Verify Prisma `contains` parameterizes and that `%`/`_` are not interpreted as wildcards by the client (Prisma `contains` is literal). Confirm no unintended broad match. |

### TC-USER-092 — Security: PII exposure in results

| Field                     | Value                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                                                                     |
| **API/Event Name**        | `GET /api/v1/users/`                                                                                  |
| **Test Scenario**         | Result payload must not leak email/account/DOB/gender                                                 |
| **Category**              | Security                                                                                              |
| **Priority**              | High                                                                                                  |
| **Preconditions**         | Authenticated viewer                                                                                  |
| **Request Payload**       | `?section=all`                                                                                        |
| **Expected Response**     | `200`; only userId, username, name, bio, avatar, isOnline, relationship fields — NO email/DOB/account |
| **Expected DB Changes**   | None                                                                                                  |
| **Expected Socket/Event** | None                                                                                                  |
| **Notes**                 | `UserDiscoveryResult` shape excludes PII by design — assert no overexposure.                          |

### TC-USER-093 — Soft-deleted profiles excluded from search

| Field                     | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Discovery                                                                            |
| **API/Event Name**        | `GET /api/v1/users/`                                                                         |
| **Test Scenario**         | Deleted/inactive profiles never returned                                                     |
| **Category**              | DB State                                                                                     |
| **Priority**              | Medium                                                                                       |
| **Preconditions**         | A profile with `deletedAt`/status DELETED exists                                             |
| **Request Payload**       | `?section=all&q=<deleted username>`                                                          |
| **Expected Response**     | `200`; deleted user absent                                                                   |
| **Expected DB Changes**   | None                                                                                         |
| **Expected Socket/Event** | None                                                                                         |
| **Notes**                 | Verify repository `findUsersNotInList`/`findUsersInList` filter out deleted/non-active rows. |
