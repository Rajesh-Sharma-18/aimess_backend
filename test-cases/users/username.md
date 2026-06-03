# USERS — Username (generate / validate)

Source: `apps/user-service/src/api/routes/username.routes.ts`, `controllers/username.controller.ts`, `validators/username.validator.ts`, `services/username.service.ts`, `lib/username.util.ts`, `lib/user-cache.js`.

Endpoints:

- `POST /api/v1/users/usernames/generate` — generate an available username from an account string
- `POST /api/v1/users/usernames/validate` — check availability of a candidate username

---

### TC-USER-029 — Generate username from account (happy path)

| Field                     | Value                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Username                                                                                                                  |
| **API/Event Name**        | `POST /api/v1/users/usernames/generate`                                                                                           |
| **Test Scenario**         | Account string yields a free, valid username                                                                                      |
| **Category**              | Happy Path                                                                                                                        |
| **Priority**              | High                                                                                                                              |
| **Preconditions**         | Authenticated user                                                                                                                |
| **Request Payload**       | `{ "account": "Ada Lovelace" }`                                                                                                   |
| **Expected Response**     | `200` `{ data: { username: "ada_lovelace" } }`                                                                                    |
| **Expected DB Changes**   | None (read-only availability checks; may set cache `taken` flags)                                                                 |
| **Expected Socket/Event** | None                                                                                                                              |
| **Notes**                 | `usernameBaseFromAccount` lowercases, replaces non `[a-z0-9_]` with `_`, collapses repeats, trims edge underscores, slices to 32. |

### TC-USER-030 — Generate appends numeric suffix when base taken

| Field                     | Value                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Username                                                                                                            |
| **API/Event Name**        | `POST /api/v1/users/usernames/generate`                                                                                     |
| **Test Scenario**         | Base handle already taken; service finds `base_2`, `base_3`, ...                                                            |
| **Category**              | Business Rule                                                                                                               |
| **Priority**              | Medium                                                                                                                      |
| **Preconditions**         | `ada` taken; `ada_2` free                                                                                                   |
| **Request Payload**       | `{ "account": "ada" }`                                                                                                      |
| **Expected Response**     | `200` `{ username: "ada_2" }` (first free suffix)                                                                           |
| **Expected DB Changes**   | None                                                                                                                        |
| **Expected Socket/Event** | None                                                                                                                        |
| **Notes**                 | Loop `suffix` 2..9999; `usernameWithSuffix` trims base so total ≤ 32. Throws `USERNAME_GENERATION_FAILED` if all exhausted. |

### TC-USER-031 — Generate: short account padded to min length

| Field                     | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| **Feature/Module**        | Users / Username                                                        |
| **API/Event Name**        | `POST /api/v1/users/usernames/generate`                                 |
| **Test Scenario**         | Account normalizes to < 3 chars, padded with underscores                |
| **Category**              | Edge Case                                                               |
| **Priority**              | Low                                                                     |
| **Preconditions**         | Authenticated user                                                      |
| **Request Payload**       | `{ "account": "ab" }`                                                   |
| **Expected Response**     | `200` username like `ab_` (padEnd to 3)                                 |
| **Expected DB Changes**   | None                                                                    |
| **Expected Socket/Event** | None                                                                    |
| **Notes**                 | `usernameBaseFromAccount` pads with `_` to reach `USERNAME_MIN_LENGTH`. |

### TC-USER-032 — Generate: account produces empty/invalid base

| Field                     | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Username                                                                                              |
| **API/Event Name**        | `POST /api/v1/users/usernames/generate`                                                                       |
| **Test Scenario**         | Account is all symbols → base empty → padded `___` may still be format-valid                                  |
| **Category**              | Edge Case                                                                                                     |
| **Priority**              | Low                                                                                                           |
| **Preconditions**         | Authenticated user                                                                                            |
| **Request Payload**       | `{ "account": "@@@@" }`                                                                                       |
| **Expected Response**     | `200` (`___` is valid format) or `400 INVALID_USERNAME_FORMAT` if base fails format check                     |
| **Expected DB Changes**   | None                                                                                                          |
| **Expected Socket/Event** | None                                                                                                          |
| **Notes**                 | `@@@@` → replace → empty → padEnd → `___`; `___` matches `^[a-z0-9_]+$` so it passes. Document actual output. |

### TC-USER-033 — Generate: account required & length bounds

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Users / Username                                            |
| **API/Event Name**        | `POST /api/v1/users/usernames/generate`                     |
| **Test Scenario**         | Missing account, empty, or > 128 chars                      |
| **Category**              | Input Validation                                            |
| **Priority**              | Medium                                                      |
| **Preconditions**         | Authenticated user                                          |
| **Request Payload**       | `{}` / `{ "account": "" }` / `{ "account": "<129 chars>" }` |
| **Expected Response**     | `400` validation error                                      |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | Schema `min(1).max(128)`, trimmed.                          |

### TC-USER-034 — Generate requires auth

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Users / Username                               |
| **API/Event Name**        | `POST /api/v1/users/usernames/generate`        |
| **Test Scenario**         | No/invalid token                               |
| **Category**              | AuthN                                          |
| **Priority**              | High                                           |
| **Preconditions**         | None                                           |
| **Request Payload**       | `{ "account": "ada" }` without Bearer          |
| **Expected Response**     | `401`                                          |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | `authenticateAccessToken` precedes controller. |

### TC-USER-035 — Validate username available (happy path)

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Users / Username                                             |
| **API/Event Name**        | `POST /api/v1/users/usernames/validate`                      |
| **Test Scenario**         | Candidate is free                                            |
| **Category**              | Happy Path                                                   |
| **Priority**              | High                                                         |
| **Preconditions**         | `free_name` unused                                           |
| **Request Payload**       | `{ "username": "free_name" }`                                |
| **Expected Response**     | `200` `{ data: { username: "free_name", available: true } }` |
| **Expected DB Changes**   | None; availability cached                                    |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | Result cached via `setUsernameAvailability`.                 |

### TC-USER-036 — Validate username taken by someone else

| Field                     | Value                                   |
| ------------------------- | --------------------------------------- |
| **Feature/Module**        | Users / Username                        |
| **API/Event Name**        | `POST /api/v1/users/usernames/validate` |
| **Test Scenario**         | Candidate owned by another user         |
| **Category**              | Business Rule                           |
| **Priority**              | High                                    |
| **Preconditions**         | `taken` owned by user B                 |
| **Request Payload**       | `{ "username": "taken" }` (caller is A) |
| **Expected Response**     | `200` `{ available: false }`            |
| **Expected DB Changes**   | None                                    |
| **Expected Socket/Event** | None                                    |
| **Notes**                 | 200 with available=false — not a 409.   |

### TC-USER-037 — Validate own current username returns available

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Users / Username                                                                     |
| **API/Event Name**        | `POST /api/v1/users/usernames/validate`                                              |
| **Test Scenario**         | Caller checks the handle they already own                                            |
| **Category**              | Business Rule                                                                        |
| **Priority**              | Medium                                                                               |
| **Preconditions**         | Caller A owns `my_name`                                                              |
| **Request Payload**       | `{ "username": "my_name" }`                                                          |
| **Expected Response**     | `200` `{ available: true }`                                                          |
| **Expected DB Changes**   | None                                                                                 |
| **Expected Socket/Event** | None                                                                                 |
| **Notes**                 | `excludeUserId = req.auth.userId`; if existing.userId === excludeUserId → available. |

### TC-USER-038 — Validate normalizes casing/whitespace

| Field                     | Value                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Username                                                                         |
| **API/Event Name**        | `POST /api/v1/users/usernames/validate`                                                  |
| **Test Scenario**         | Mixed case/leading spaces resolves to canonical                                          |
| **Category**              | Edge Case                                                                                |
| **Priority**              | Low                                                                                      |
| **Preconditions**         | `ada` taken                                                                              |
| **Request Payload**       | `{ "username": "  ADA " }`                                                               |
| **Expected Response**     | `200` `{ username: "ada", available: false }`                                            |
| **Expected DB Changes**   | None                                                                                     |
| **Expected Socket/Event** | None                                                                                     |
| **Notes**                 | Validator trims+lowercases via `normalizeUsername` transform; response echoes canonical. |

### TC-USER-039 — Validate format errors

| Field                     | Value                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Username                                                                                                                    |
| **API/Event Name**        | `POST /api/v1/users/usernames/validate`                                                                                             |
| **Test Scenario**         | Too short / too long / illegal chars                                                                                                |
| **Category**              | Input Validation                                                                                                                    |
| **Priority**              | Medium                                                                                                                              |
| **Preconditions**         | Authenticated user                                                                                                                  |
| **Request Payload**       | `{ "username": "ab" }` / `{ "username": "has space" }` / 33-char                                                                    |
| **Expected Response**     | `400` (min 3 / max 32 / regex)                                                                                                      |
| **Expected DB Changes**   | None                                                                                                                                |
| **Expected Socket/Event** | None                                                                                                                                |
| **Notes**                 | Validation occurs in Zod before service. Service also re-checks `isValidUsernameFormat` → `INVALID_USERNAME_FORMAT` for any bypass. |

### TC-USER-040 — Validate requires auth

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Username                                                            |
| **API/Event Name**        | `POST /api/v1/users/usernames/validate`                                     |
| **Test Scenario**         | No Bearer token                                                             |
| **Category**              | AuthN                                                                       |
| **Priority**              | High                                                                        |
| **Preconditions**         | None                                                                        |
| **Request Payload**       | `{ "username": "ada" }`                                                     |
| **Expected Response**     | `401`                                                                       |
| **Expected DB Changes**   | None                                                                        |
| **Expected Socket/Event** | None                                                                        |
| **Notes**                 | excludeUserId derived from auth; unauthenticated call cannot reach service. |

### TC-USER-041 — Cache consistency: validate true then username claimed

| Field                     | Value                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Users / Username                                                                                                         |
| **API/Event Name**        | `POST /api/v1/users/usernames/validate` then `PATCH profiles/me`                                                         |
| **Test Scenario**         | A validates "x" (true), B claims "x", A re-validates                                                                     |
| **Category**              | Concurrency                                                                                                              |
| **Priority**              | Low                                                                                                                      |
| **Preconditions**         | "x" free                                                                                                                 |
| **Request Payload**       | validate `{ "username": "x" }` (twice, around B's claim)                                                                 |
| **Expected Response**     | Second validate should return available=false after cache update on claim                                                |
| **Expected DB Changes**   | None                                                                                                                     |
| **Expected Socket/Event** | None                                                                                                                     |
| **Notes**                 | `onUsernameClaimed`/`onUsernameReleased` keep cache fresh; verify stale-cache window does not cause a false "available". |
