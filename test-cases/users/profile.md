# USERS — Profile

Source: `apps/user-service/src/api/routes/profile.routes.ts`, `controllers/profile.controller.ts`, `validators/profile.validator.ts`, `services/user-profile.service.ts`, `services/avatar.service.ts`, `lib/username.util.ts`, `lib/profile-fields.util.ts`. Routes mounted at `/api/v1/users/profiles` (gateway path may differ).

Endpoints:

- `GET /api/v1/users/profiles/me` — fetch own profile
- `PATCH /api/v1/users/profiles/me` — update own profile

---

### TC-USER-001 — Get my profile (happy path)

| Field                     | Value                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                                                                                                                         |
| **API/Event Name**        | `GET /api/v1/users/profiles/me`                                                                                                                                                                         |
| **Test Scenario**         | Authenticated user fetches own profile                                                                                                                                                                  |
| **Category**              | Happy Path                                                                                                                                                                                              |
| **Priority**              | High                                                                                                                                                                                                    |
| **Preconditions**         | Verified user with a `UserProfile` row (created via `user.created` event)                                                                                                                               |
| **Request Payload**       | None; header `Authorization: Bearer <accessToken>`                                                                                                                                                      |
| **Expected Response**     | `200` `{ data: { userId, username, firstName, lastName, bio, account, email, isGoogleLogin, isAppleLogin, dateOfBirth, gender, avatarUrl, avatarUrlExpiresIn, updatedAt } }`                            |
| **Expected DB Changes**   | None (read); may populate profile cache                                                                                                                                                                 |
| **Expected Socket/Event** | None                                                                                                                                                                                                    |
| **Notes**                 | `account`/`email`/`isGoogleLogin`/`isAppleLogin` resolved live from auth-service via bearer token; falls back to DB flags if auth-service down. `avatarUrl` is a presigned GET URL (null if no avatar). |

### TC-USER-002 — Get my profile, no auth token

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                      |
| **API/Event Name**        | `GET /api/v1/users/profiles/me`                      |
| **Test Scenario**         | Request without Authorization header                 |
| **Category**              | AuthN                                                |
| **Priority**              | High                                                 |
| **Preconditions**         | None                                                 |
| **Request Payload**       | None                                                 |
| **Expected Response**     | `401` Unauthorized                                   |
| **Expected DB Changes**   | None                                                 |
| **Expected Socket/Event** | None                                                 |
| **Notes**                 | `authenticateAccessToken` rejects before controller. |

### TC-USER-003 — Get my profile, invalid/expired/malformed token

| Field                     | Value                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                                      |
| **API/Event Name**        | `GET /api/v1/users/profiles/me`                                                                                      |
| **Test Scenario**         | Token tampered, expired, or wrong signing secret                                                                     |
| **Category**              | AuthN                                                                                                                |
| **Priority**              | High                                                                                                                 |
| **Preconditions**         | None                                                                                                                 |
| **Request Payload**       | `Authorization: Bearer eyJ...tampered`                                                                               |
| **Expected Response**     | `401` Unauthorized                                                                                                   |
| **Expected DB Changes**   | None                                                                                                                 |
| **Expected Socket/Event** | None                                                                                                                 |
| **Notes**                 | Also covers a valid JWT whose session was revoked — `assertSessionActive` (`isSessionActiveForRequest`) must reject. |

### TC-USER-004 — Get my profile after profile soft-deleted

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                             |
| **API/Event Name**        | `GET /api/v1/users/profiles/me`                                             |
| **Test Scenario**         | Profile exists but `deletedAt` is set (user.deleted processed)              |
| **Category**              | Error Handling                                                              |
| **Priority**              | Medium                                                                      |
| **Preconditions**         | `UserProfile.deletedAt != null` and cache invalidated                       |
| **Request Payload**       | None                                                                        |
| **Expected Response**     | `404` `USER_PROFILE_NOT_FOUND`                                              |
| **Expected DB Changes**   | None                                                                        |
| **Expected Socket/Event** | None                                                                        |
| **Notes**                 | `loadProfileRecord` throws `NotFoundError` when `profile.deletedAt` is set. |

### TC-USER-005 — Update single field (happy path: bio)

| Field                     | Value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                         |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                       |
| **Test Scenario**         | Update bio only                                                                         |
| **Category**              | Happy Path                                                                              |
| **Priority**              | High                                                                                    |
| **Preconditions**         | Authenticated user with existing profile                                                |
| **Request Payload**       | `{ "bio": "Hello world" }`                                                              |
| **Expected Response**     | `200` updated profile object                                                            |
| **Expected DB Changes**   | `UserProfile.bio` updated, `updatedAt` bumped; profile cache invalidated                |
| **Expected Socket/Event** | RabbitMQ `profile.updated` published (`publishProfileUpdatedSafe`) — not a socket event |
| **Notes**                 | Bio is trimmed, max 280 chars.                                                          |

### TC-USER-006 — Update multiple fields at once

| Field                     | Value                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                   |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                 |
| **Test Scenario**         | firstName + lastName + dateOfBirth + gender together                                              |
| **Category**              | Happy Path                                                                                        |
| **Priority**              | Medium                                                                                            |
| **Preconditions**         | Authenticated user                                                                                |
| **Request Payload**       | `{ "firstName": "Ada", "lastName": "Lovelace", "dateOfBirth": "1990-12-10", "gender": "FEMALE" }` |
| **Expected Response**     | `200` updated profile                                                                             |
| **Expected DB Changes**   | All four columns updated; `displayName` rebuilt in published event                                |
| **Expected Socket/Event** | `profile.updated` (RabbitMQ)                                                                      |
| **Notes**                 | `dateOfBirth` converted to UTC midnight Date via `dateOfBirthToUtcDate`.                          |

### TC-USER-007 — Empty PATCH body rejected

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                               |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                             |
| **Test Scenario**         | No updatable field present                                                                                    |
| **Category**              | Input Validation                                                                                              |
| **Priority**              | Medium                                                                                                        |
| **Preconditions**         | Authenticated user                                                                                            |
| **Request Payload**       | `{}`                                                                                                          |
| **Expected Response**     | `400` "At least one field is required to update"                                                              |
| **Expected DB Changes**   | None                                                                                                          |
| **Expected Socket/Event** | None                                                                                                          |
| **Notes**                 | Schema `.refine` requires at least one of firstName/lastName/username/bio/dateOfBirth/gender/avatarObjectKey. |

### TC-USER-008 — firstName/lastName length & blank validation

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                            |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                          |
| **Test Scenario**         | firstName empty string, or > 50 chars                      |
| **Category**              | Input Validation                                           |
| **Priority**              | Medium                                                     |
| **Preconditions**         | Authenticated user                                         |
| **Request Payload**       | `{ "firstName": "" }` / `{ "firstName": "<51 chars>" }`    |
| **Expected Response**     | `400` ("First name is required" / "at most 50 characters") |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | Trimmed before length check; same rules apply to lastName. |

### TC-USER-009 — Bio over 280 chars rejected

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                             |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                           |
| **Test Scenario**         | Bio exceeds max length                                      |
| **Category**              | Input Validation                                            |
| **Priority**              | Low                                                         |
| **Preconditions**         | Authenticated user                                          |
| **Request Payload**       | `{ "bio": "<281 chars>" }`                                  |
| **Expected Response**     | `400` "Bio must be at most 280 characters"                  |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | Bio is nullable — `{ "bio": null }` is valid and clears it. |

### TC-USER-010 — Clear nullable fields (bio/gender/avatar to null)

| Field                     | Value                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                       |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                     |
| **Test Scenario**         | Set bio, gender, avatarObjectKey explicitly to null                                                   |
| **Category**              | Optional Params                                                                                       |
| **Priority**              | Medium                                                                                                |
| **Preconditions**         | Profile currently has these set                                                                       |
| **Request Payload**       | `{ "bio": null, "gender": null, "avatarObjectKey": null }`                                            |
| **Expected Response**     | `200` profile with those fields null                                                                  |
| **Expected DB Changes**   | `bio=null`, `gender=null`, `avatarUrl=null`                                                           |
| **Expected Socket/Event** | `profile.updated`                                                                                     |
| **Notes**                 | null is distinct from undefined (omitted). avatarObjectKey=null clears avatar without storage lookup. |

### TC-USER-011 — Date of birth format validation

| Field                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                       |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                     |
| **Test Scenario**         | Wrong format (not YYYY-MM-DD)                                         |
| **Category**              | Input Validation                                                      |
| **Priority**              | Medium                                                                |
| **Preconditions**         | Authenticated user                                                    |
| **Request Payload**       | `{ "dateOfBirth": "10/12/1990" }` / `{ "dateOfBirth": "1990-13-40" }` |
| **Expected Response**     | `400` "Date of birth must be YYYY-MM-DD" (or invalid-date refine)     |
| **Expected DB Changes**   | None                                                                  |
| **Expected Socket/Event** | None                                                                  |
| **Notes**                 | Regex `^\d{4}-\d{2}-\d{2}$` then `isValidProfileDateOfBirth` refine.  |

### TC-USER-012 — Business rule: minimum age 13

| Field                     | Value                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                                   |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                                 |
| **Test Scenario**         | DOB makes user younger than 13                                                                                    |
| **Category**              | Business Rule                                                                                                     |
| **Priority**              | High                                                                                                              |
| **Preconditions**         | Authenticated user; current date 2026-06-03                                                                       |
| **Request Payload**       | `{ "dateOfBirth": "2020-01-01" }`                                                                                 |
| **Expected Response**     | `400` "...you must be at least 13"                                                                                |
| **Expected DB Changes**   | None                                                                                                              |
| **Expected Socket/Event** | None                                                                                                              |
| **Notes**                 | Boundary: exactly 13 today should pass; 13 minus 1 day should fail (verify `isValidProfileDateOfBirth` boundary). |

### TC-USER-013 — Gender enum validation

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                         |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                       |
| **Test Scenario**         | gender not in allowed set                               |
| **Category**              | Input Validation                                        |
| **Priority**              | Low                                                     |
| **Preconditions**         | Authenticated user                                      |
| **Request Payload**       | `{ "gender": "ROBOT" }`                                 |
| **Expected Response**     | `400` invalid enum                                      |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | Allowed values = `PROFILE_GENDER_VALUES`; null allowed. |

### TC-USER-014 — Username change via PATCH (happy path)

| Field                     | Value                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                                        |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                                      |
| **Test Scenario**         | Change username to a free, valid handle                                                                                |
| **Category**              | Business Rule                                                                                                          |
| **Priority**              | High                                                                                                                   |
| **Preconditions**         | Profile with `lastUsernameChangeAt` null or > 30 days ago                                                              |
| **Request Payload**       | `{ "username": "ada_new" }`                                                                                            |
| **Expected Response**     | `200` profile with new username                                                                                        |
| **Expected DB Changes**   | `username` updated, `lastUsernameChangeAt = now`; cache: old username released, new claimed; profile cache invalidated |
| **Expected Socket/Event** | `profile.updated` (RabbitMQ)                                                                                           |
| **Notes**                 | Username normalized to lowercase before checks.                                                                        |

### TC-USER-015 — Username cooldown (30 days) enforced

| Field                     | Value                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                                                     |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                                                   |
| **Test Scenario**         | Change username within 30 days of last change                                                                                       |
| **Category**              | Business Rule                                                                                                                       |
| **Priority**              | High                                                                                                                                |
| **Preconditions**         | `lastUsernameChangeAt` set < 30 days ago                                                                                            |
| **Request Payload**       | `{ "username": "another_one" }`                                                                                                     |
| **Expected Response**     | `400` `USER_USERNAME_CHANGE_TOO_SOON`                                                                                               |
| **Expected DB Changes**   | None                                                                                                                                |
| **Expected Socket/Event** | None                                                                                                                                |
| **Notes**                 | `USERNAME_CHANGE_COOLDOWN_MS = 30*24*60*60*1000`. Cooldown only applies when the new handle differs from current normalized handle. |

### TC-USER-016 — Username casing-only change bypasses cooldown

| Field                     | Value                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                                                                                   |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                                                                                 |
| **Test Scenario**         | Same handle, different casing (e.g. "Ada" when stored "ada")                                                                                                      |
| **Category**              | Edge Case                                                                                                                                                         |
| **Priority**              | Low                                                                                                                                                               |
| **Preconditions**         | Stored username `ada`, recently changed                                                                                                                           |
| **Request Payload**       | `{ "username": "Ada" }`                                                                                                                                           |
| **Expected Response**     | `200`; stored canonical lowercase, no cooldown/claim                                                                                                              |
| **Expected DB Changes**   | `username` rewritten to lowercase; `lastUsernameChangeAt` NOT updated                                                                                             |
| **Expected Socket/Event** | `profile.updated`                                                                                                                                                 |
| **Notes**                 | Normalized equals current → no cooldown branch; the `else if` only triggers if stored differs from normalized. If already lowercase and identical, it is a no-op. |

### TC-USER-017 — Username taken by another user

| Field                     | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| **Feature/Module**        | Users / Profile                                                          |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                        |
| **Test Scenario**         | Requested username belongs to a different user                           |
| **Category**              | Business Rule                                                            |
| **Priority**              | High                                                                     |
| **Preconditions**         | Another active profile owns `taken_name`; cooldown not active            |
| **Request Payload**       | `{ "username": "taken_name" }`                                           |
| **Expected Response**     | `409` `USER_USERNAME_TAKEN`                                              |
| **Expected DB Changes**   | None                                                                     |
| **Expected Socket/Event** | None                                                                     |
| **Notes**                 | `validateAvailability(name, ownStorage userId)` returns available=false. |

### TC-USER-018 — Username format validation in PATCH

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                             |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                           |
| **Test Scenario**         | Too short / too long / illegal chars                                        |
| **Category**              | Input Validation                                                            |
| **Priority**              | Medium                                                                      |
| **Preconditions**         | Authenticated user                                                          |
| **Request Payload**       | `{ "username": "ab" }` / `{ "username": "Bad Name!" }` / 33 chars           |
| **Expected Response**     | `400` min 3 / max 32 / regex `^[a-z0-9_]+$`                                 |
| **Expected DB Changes**   | None                                                                        |
| **Expected Socket/Event** | None                                                                        |
| **Notes**                 | Input is trimmed + lowercased before regex; "Bad Name!" fails on space/`!`. |

### TC-USER-019 — Set avatar via avatarObjectKey (happy path)

| Field                     | Value                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                   |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                 |
| **Test Scenario**         | Attach an already-uploaded avatar object key                                      |
| **Category**              | Happy Path                                                                        |
| **Priority**              | High                                                                              |
| **Preconditions**         | Object exists in MinIO under `avatars/<ownStorage userId>/...`, size within limit |
| **Request Payload**       | `{ "avatarObjectKey": "avatars/<userId>/<uuid>.jpg" }`                            |
| **Expected Response**     | `200`; profile `avatarUrl` is a presigned GET URL                                 |
| **Expected DB Changes**   | `avatarUrl` stores object key (not public URL)                                    |
| **Expected Socket/Event** | `profile.updated` carrying `avatarObjectKey`                                      |
| **Notes**                 | `resolveAvatarObjectKeyForProfile` validates ownership + HEAD + size.             |

### TC-USER-020 — Security/IDOR: avatar object key owned by another user

| Field                     | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                        |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                      |
| **Test Scenario**         | avatarObjectKey points to another user's prefix or uses path traversal                 |
| **Category**              | Security                                                                               |
| **Priority**              | High                                                                                   |
| **Preconditions**         | Authenticated as user A                                                                |
| **Request Payload**       | `{ "avatarObjectKey": "avatars/<otherUserId>/x.jpg" }` or `"avatars/<A>/../<B>/x.jpg"` |
| **Expected Response**     | `400` `INVALID_AVATAR_OBJECT_KEY`                                                      |
| **Expected DB Changes**   | None                                                                                   |
| **Expected Socket/Event** | None                                                                                   |
| **Notes**                 | `assertObjectKeyOwnedBy` requires prefix `avatars/<ownerId>/` and rejects `..`.        |

### TC-USER-021 — Avatar object not yet uploaded

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                         |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                       |
| **Test Scenario**         | Key well-formed and owned, but object missing in MinIO  |
| **Category**              | Error Handling                                          |
| **Priority**              | Medium                                                  |
| **Preconditions**         | No object at the given key                              |
| **Request Payload**       | `{ "avatarObjectKey": "avatars/<userId>/missing.jpg" }` |
| **Expected Response**     | `400` `AVATAR_NOT_UPLOADED`                             |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | `headObject` reports not exists / no contentLength.     |

### TC-USER-022 — Avatar exceeds max size (deferred-size enforcement)

| Field                     | Value                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                           |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                         |
| **Test Scenario**         | Uploaded object larger than `AVATAR_MAX_UPLOAD_BYTES`                                                     |
| **Category**              | File Upload                                                                                               |
| **Priority**              | High                                                                                                      |
| **Preconditions**         | Object present but oversize (client bypassed presign content-length)                                      |
| **Request Payload**       | `{ "avatarObjectKey": "avatars/<userId>/big.png" }`                                                       |
| **Expected Response**     | `400` `AVATAR_FILE_TOO_LARGE`                                                                             |
| **Expected DB Changes**   | None; the oversize object is DELETED from MinIO                                                           |
| **Expected Socket/Event** | None                                                                                                      |
| **Notes**                 | Server re-checks `head.contentLength` and deletes on violation — defense against tampered direct uploads. |

### TC-USER-023 — avatarObjectKey length bounds

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                     |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                   |
| **Test Scenario**         | Empty string or > 512 chars                         |
| **Category**              | Input Validation                                    |
| **Priority**              | Low                                                 |
| **Preconditions**         | Authenticated user                                  |
| **Request Payload**       | `{ "avatarObjectKey": "" }` / 513-char string       |
| **Expected Response**     | `400` (min 1 / max 512)                             |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | Schema `min(1).max(512)`; null is the way to clear. |

### TC-USER-024 — No-op PATCH (only no-change fields) returns current profile

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                               |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                             |
| **Test Scenario**         | Username equals current normalized value, no other field                                                      |
| **Category**              | Edge Case                                                                                                     |
| **Priority**              | Low                                                                                                           |
| **Preconditions**         | Stored username `ada`, lowercase                                                                              |
| **Request Payload**       | `{ "username": "ada" }`                                                                                       |
| **Expected Response**     | `200` current profile, unchanged                                                                              |
| **Expected DB Changes**   | None (updateData empty → no DB write, no event)                                                               |
| **Expected Socket/Event** | None                                                                                                          |
| **Notes**                 | When updateData is empty, service returns profile without writing or publishing; auth summary still resolved. |

### TC-USER-025 — Concurrency: simultaneous username change requests

| Field                     | Value                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                                                                                                    |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                                                                                                  |
| **Test Scenario**         | Two requests change own username to two different free names at once                                                                                                               |
| **Category**              | Concurrency                                                                                                                                                                        |
| **Priority**              | Medium                                                                                                                                                                             |
| **Preconditions**         | Cooldown not active                                                                                                                                                                |
| **Request Payload**       | Req1 `{ "username": "name_a" }`, Req2 `{ "username": "name_b" }`                                                                                                                   |
| **Expected Response**     | One `200`; the other should hit cooldown or land last-write-wins                                                                                                                   |
| **Expected DB Changes**   | Exactly one final username; `lastUsernameChangeAt` set                                                                                                                             |
| **Expected Socket/Event** | `profile.updated` (one or both)                                                                                                                                                    |
| **Notes**                 | GAP: cooldown read-then-write is not transactional; back-to-back requests may both pass the cooldown check before either writes. Verify second is rejected or behavior documented. |

### TC-USER-026 — Concurrency: two users race for the same free username

| Field                     | Value                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                                                                                                                                               |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                                                                                                                                                             |
| **Test Scenario**         | Users A and B both PATCH username to "popular" simultaneously                                                                                                                                                                 |
| **Category**              | Concurrency                                                                                                                                                                                                                   |
| **Priority**              | Medium                                                                                                                                                                                                                        |
| **Preconditions**         | "popular" free; neither in cooldown                                                                                                                                                                                           |
| **Request Payload**       | Both `{ "username": "popular" }`                                                                                                                                                                                              |
| **Expected Response**     | One `200`; the other should get `409`                                                                                                                                                                                         |
| **Expected DB Changes**   | Only one profile owns "popular"                                                                                                                                                                                               |
| **Expected Socket/Event** | `profile.updated` for winner                                                                                                                                                                                                  |
| **Notes**                 | Availability check is not atomic with the write — verify the DB unique constraint on username surfaces a P2002 → `409` for the loser (the update path does NOT have the retry loop the registration path has). Potential GAP. |

### TC-USER-027 — Security: PII / cross-user access (own profile only)

| Field                     | Value                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                                                       |
| **API/Event Name**        | `GET/PATCH /api/v1/users/profiles/me`                                                                                 |
| **Test Scenario**         | Confirm userId is always taken from `req.auth.userId`, never from body/query                                          |
| **Category**              | Security                                                                                                              |
| **Priority**              | High                                                                                                                  |
| **Preconditions**         | Authenticated as user A                                                                                               |
| **Request Payload**       | Attempt body `{ "userId": "<B>", "bio": "x" }`                                                                        |
| **Expected Response**     | `200` updates A's profile only; extra `userId` ignored (schema does not allow it / stripped)                          |
| **Expected DB Changes**   | Only A's row changes                                                                                                  |
| **Expected Socket/Event** | `profile.updated` for A                                                                                               |
| **Notes**                 | profile schema is not `.strict()`; unknown keys are ignored by Zod object parse. Confirms no IDOR via body injection. |

### TC-USER-028 — Injection attempt in text fields stored literally

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Profile                                                                             |
| **API/Event Name**        | `PATCH /api/v1/users/profiles/me`                                                           |
| **Test Scenario**         | bio / firstName with script/SQL-like content                                                |
| **Category**              | Security                                                                                    |
| **Priority**              | Medium                                                                                      |
| **Preconditions**         | Authenticated user                                                                          |
| **Request Payload**       | `{ "bio": "<script>alert(1)</script>", "firstName": "Robert'); DROP TABLE--" }`             |
| **Expected Response**     | `200` stored verbatim (Prisma parameterizes; no execution)                                  |
| **Expected DB Changes**   | Literal string persisted                                                                    |
| **Expected Socket/Event** | `profile.updated`                                                                           |
| **Notes**                 | Output-encoding is a client concern; verify no SQL injection and length limits still apply. |
