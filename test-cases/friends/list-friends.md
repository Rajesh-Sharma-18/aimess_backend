# FRIENDS — List Friends

**Source:**

- `apps/user-service/src/api/routes/friends.routes.ts` (`GET /`)
- `apps/user-service/src/api/controllers/friends.controller.ts` (`listFriends`)
- `apps/user-service/src/api/validators/friends.validator.ts` (`listFriendsQuerySchema`)
- `apps/user-service/src/services/friends.service.ts` (`listFriends`)
- `apps/user-service/src/repositories/friends.repository.ts` (`listAcceptedFriendIds`, `listFriendProfiles`)

**External path:** `GET /api/v1/users/friends`

**Query params:**

- `search` — optional, trimmed, 1–100 chars; matches firstName/lastName/username (case-insensitive `contains`)
- `cursor` — optional UUID (userId of last item on previous page)
- `limit` — optional int, 1–100, default 30

**Success response:** `200` `{ message: USER_FRIENDS_FETCHED, data: { friends: FriendListItem[], nextCursor: string|null } }`
where `FriendListItem = { userId, username, firstName, lastName, avatarUrl, section }` (`section` = uppercase first letter of firstName, else `#`).

> Only `ACCEPTED` friendships are listed. Ordering: `firstName ASC, lastName ASC, userId ASC`. Cursor paginates on `userId`. Soft-deleted profiles (`deletedAt != null`) are excluded.

---

### TC-FRND-070 — List friends (default page)

| Field                     | Value                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / List                                                                                       |
| **API/Event Name**        | `GET /api/v1/users/friends`                                                                          |
| **Test Scenario**         | User with several accepted friends fetches first page                                                |
| **Category**              | Happy Path                                                                                           |
| **Priority**              | High                                                                                                 |
| **Preconditions**         | Caller has ≥1 ACCEPTED friendship                                                                    |
| **Request Payload**       | No query params                                                                                      |
| **Expected Response**     | `200` `{ data: { friends: [...], nextCursor } }`, alphabetical by firstName; each item has `section` |
| **Expected DB Changes**   | None (read-only)                                                                                     |
| **Expected Socket/Event** | None                                                                                                 |

### TC-FRND-071 — Empty friends list

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Friends / List                                                     |
| **API/Event Name**        | `GET /api/v1/users/friends`                                        |
| **Test Scenario**         | User has no accepted friends                                       |
| **Category**              | Edge Case                                                          |
| **Priority**              | Medium                                                             |
| **Preconditions**         | No ACCEPTED friendships                                            |
| **Request Payload**       | none                                                               |
| **Expected Response**     | `200` `{ data: { friends: [], nextCursor: null } }` (not an error) |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |

### TC-FRND-072 — Pagination via cursor

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / List                                                                                                |
| **API/Event Name**        | `GET /api/v1/users/friends`                                                                                   |
| **Test Scenario**         | More than `limit` friends → follow `nextCursor` for page 2                                                    |
| **Category**              | Pagination/Filter/Sort                                                                                        |
| **Priority**              | High                                                                                                          |
| **Preconditions**         | Caller has > limit ACCEPTED friends                                                                           |
| **Request Payload**       | `?limit=2` then `?limit=2&cursor=<nextCursor>`                                                                |
| **Expected Response**     | Page 1 returns 2 items + non-null `nextCursor`; page 2 continues without overlap; last page `nextCursor=null` |
| **Expected DB Changes**   | None                                                                                                          |
| **Expected Socket/Event** | None                                                                                                          |
| **Notes**                 | Repo fetches `limit+1` to compute `hasMore`; `nextCursor` = last item's `userId`                              |

### TC-FRND-073 — Search filter by name/username

| Field                     | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| **Feature/Module**        | Friends / List                                                         |
| **API/Event Name**        | `GET /api/v1/users/friends`                                            |
| **Test Scenario**         | `search` term matches a subset of friends' firstName/lastName/username |
| **Category**              | Pagination/Filter/Sort                                                 |
| **Priority**              | Medium                                                                 |
| **Preconditions**         | Friends with varied names                                              |
| **Request Payload**       | `?search=ali`                                                          |
| **Expected Response**     | `200` only matching friends; case-insensitive substring match          |
| **Expected DB Changes**   | None                                                                   |
| **Expected Socket/Event** | None                                                                   |

### TC-FRND-074 — Search with no matches

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Friends / List                                |
| **API/Event Name**        | `GET /api/v1/users/friends`                   |
| **Test Scenario**         | `search` matches none of the caller's friends |
| **Category**              | Edge Case                                     |
| **Priority**              | Low                                           |
| **Preconditions**         | Has friends but none match                    |
| **Request Payload**       | `?search=zzzznomatch`                         |
| **Expected Response**     | `200` `{ friends: [], nextCursor: null }`     |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |

### TC-FRND-075 — `limit` out of range (>100)

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Friends / List                      |
| **API/Event Name**        | `GET /api/v1/users/friends`         |
| **Test Scenario**         | `limit=500` exceeds max             |
| **Category**              | Input Validation                    |
| **Priority**              | Medium                              |
| **Preconditions**         | Authenticated                       |
| **Request Payload**       | `?limit=500`                        |
| **Expected Response**     | `400` validation error (`max(100)`) |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |

### TC-FRND-076 — `limit` non-numeric / zero / negative

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Friends / List                          |
| **API/Event Name**        | `GET /api/v1/users/friends`             |
| **Test Scenario**         | `limit=abc`, `limit=0`, `limit=-1`      |
| **Category**              | Input Validation                        |
| **Priority**              | Medium                                  |
| **Preconditions**         | Authenticated                           |
| **Request Payload**       | `?limit=0` / `?limit=-1` / `?limit=abc` |
| **Expected Response**     | `400` (`positive` / int coercion fails) |
| **Expected DB Changes**   | None                                    |
| **Expected Socket/Event** | None                                    |

### TC-FRND-077 — `cursor` not a UUID

| Field                     | Value                       |
| ------------------------- | --------------------------- |
| **Feature/Module**        | Friends / List              |
| **API/Event Name**        | `GET /api/v1/users/friends` |
| **Test Scenario**         | Malformed cursor            |
| **Category**              | Input Validation            |
| **Priority**              | Low                         |
| **Preconditions**         | Authenticated               |
| **Request Payload**       | `?cursor=abc`               |
| **Expected Response**     | `400` validation error      |
| **Expected DB Changes**   | None                        |
| **Expected Socket/Event** | None                        |

### TC-FRND-078 — `search` over max length

| Field                     | Value                       |
| ------------------------- | --------------------------- |
| **Feature/Module**        | Friends / List              |
| **API/Event Name**        | `GET /api/v1/users/friends` |
| **Test Scenario**         | `search` > 100 chars        |
| **Category**              | Input Validation            |
| **Priority**              | Low                         |
| **Preconditions**         | Authenticated               |
| **Request Payload**       | `?search=<101 chars>`       |
| **Expected Response**     | `400` (`max(100)`)          |
| **Expected DB Changes**   | None                        |
| **Expected Socket/Event** | None                        |

### TC-FRND-079 — Soft-deleted friend excluded

| Field                     | Value                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / List                                                                                                                |
| **API/Event Name**        | `GET /api/v1/users/friends`                                                                                                   |
| **Test Scenario**         | A friend's profile was soft-deleted after the friendship was accepted                                                         |
| **Category**              | Business Rule / DB State                                                                                                      |
| **Priority**              | Medium                                                                                                                        |
| **Preconditions**         | Friend `UserProfile.deletedAt != null` while friendship still ACCEPTED                                                        |
| **Request Payload**       | none                                                                                                                          |
| **Expected Response**     | `200`; deleted friend NOT in `friends[]`                                                                                      |
| **Expected DB Changes**   | None                                                                                                                          |
| **Expected Socket/Event** | None                                                                                                                          |
| **Notes**                 | `friendsCount` may diverge from listed count since count isn't decremented on profile deletion — note potential inconsistency |

### TC-FRND-080 — Only ACCEPTED friendships appear

| Field                     | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / List                                                            |
| **API/Event Name**        | `GET /api/v1/users/friends`                                               |
| **Test Scenario**         | Caller has PENDING/REJECTED/CANCELLED/UNFRIENDED rows mixed with ACCEPTED |
| **Category**              | Business Rule                                                             |
| **Priority**              | High                                                                      |
| **Preconditions**         | Rows in various states                                                    |
| **Request Payload**       | none                                                                      |
| **Expected Response**     | `200`; only ACCEPTED peers listed                                         |
| **Expected DB Changes**   | None                                                                      |
| **Expected Socket/Event** | None                                                                      |

### TC-FRND-081 — List unauthenticated

| Field                     | Value                       |
| ------------------------- | --------------------------- |
| **Feature/Module**        | Friends / List              |
| **API/Event Name**        | `GET /api/v1/users/friends` |
| **Test Scenario**         | No token                    |
| **Category**              | AuthN                       |
| **Priority**              | High                        |
| **Preconditions**         | None                        |
| **Request Payload**       | none                        |
| **Expected Response**     | `401`                       |
| **Expected DB Changes**   | None                        |
| **Expected Socket/Event** | None                        |

### TC-FRND-082 — `section` grouping for non-alpha first name

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Friends / List                                      |
| **API/Event Name**        | `GET /api/v1/users/friends`                         |
| **Test Scenario**         | Friend's firstName starts with a digit/emoji/symbol |
| **Category**              | Edge Case                                           |
| **Priority**              | Low                                                 |
| **Preconditions**         | Friend with firstName like "1abc" or "\_x"          |
| **Request Payload**       | none                                                |
| **Expected Response**     | `200`; that friend's `section` = `#`                |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |

### TC-FRND-083 — Avatar URL resolution

| Field                     | Value                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / List                                                                                    |
| **API/Event Name**        | `GET /api/v1/users/friends`                                                                       |
| **Test Scenario**         | Friends with and without avatars                                                                  |
| **Category**              | Edge Case                                                                                         |
| **Priority**              | Low                                                                                               |
| **Preconditions**         | Mix of `avatarUrl` set/null                                                                       |
| **Request Payload**       | none                                                                                              |
| **Expected Response**     | `200`; `avatarUrl` is a resolved view URL or `null` (via `avatarService.resolveViewUrlForClient`) |
| **Expected DB Changes**   | None                                                                                              |
| **Expected Socket/Event** | None                                                                                              |
