# Auth — Register & Validate Account

Source: `apps/auth-service/src/api/routes/auth.routes.ts` (`POST /api/auth/register`, `POST /api/auth/accounts/validate`)

Covers account-availability check (`validateAccount` → `accountAvailabilityService`) and account registration
(`register` → `authService.register`). Username-only signup; password hashed with bcrypt cost 12; a
`Session` + `RefreshToken` are issued and a `user.created` event published to user-service.

---

### TC-AUTH-001 — Validate available account name

| Field                     | Value                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Account Availability                                                                             |
| **API/Event Name**        | `POST /api/auth/accounts/validate`                                                                      |
| **Test Scenario**         | Account name not taken → available:true                                                                 |
| **Category**              | Happy Path                                                                                              |
| **Priority**              | Medium                                                                                                  |
| **Preconditions**         | No `AuthUser` with `account = "rajesh_18"`                                                              |
| **Request Payload**       | `{ "account": "rajesh_18" }`                                                                            |
| **Expected Response**     | `200` `{ success:true, data:{ account:"rajesh_18", available:true }, message: AUTH_ACCOUNT_AVAILABLE }` |
| **Expected DB Changes**   | None                                                                                                    |
| **Expected Socket/Event** | None                                                                                                    |
| **Notes**                 | `findByAccount` lookup only; account is trimmed, not lowercased.                                        |

### TC-AUTH-002 — Validate taken account name returns 409

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Auth / Account Availability                        |
| **API/Event Name**        | `POST /api/auth/accounts/validate`                 |
| **Test Scenario**         | Account already exists → ConflictError             |
| **Category**              | Business Rule                                      |
| **Priority**              | Medium                                             |
| **Preconditions**         | An `AuthUser` exists with `account = "taken_user"` |
| **Request Payload**       | `{ "account": "taken_user" }`                      |
| **Expected Response**     | `409` error code `AUTH_ACCOUNT_TAKEN`              |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | Controller throws on `!result.available`.          |

### TC-AUTH-003 — Validate rejects account shorter than 3 chars

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Account Availability                                         |
| **API/Event Name**        | `POST /api/auth/accounts/validate`                                  |
| **Test Scenario**         | account = "ab" fails min(3)                                         |
| **Category**              | Input Validation                                                    |
| **Priority**              | Medium                                                              |
| **Preconditions**         | None                                                                |
| **Request Payload**       | `{ "account": "ab" }`                                               |
| **Expected Response**     | `400` `{ success:false, message: VALIDATION_FAILED, errors:{...} }` |
| **Expected DB Changes**   | None                                                                |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | `accountSchema.min(3)`.                                             |

### TC-AUTH-004 — Validate rejects account with illegal characters

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Account Availability                                                      |
| **API/Event Name**        | `POST /api/auth/accounts/validate`                                               |
| **Test Scenario**         | account = "bad name!" fails regex                                                |
| **Category**              | Input Validation                                                                 |
| **Priority**              | Medium                                                                           |
| **Preconditions**         | None                                                                             |
| **Request Payload**       | `{ "account": "bad name!" }`                                                     |
| **Expected Response**     | `400` VALIDATION_FAILED                                                          |
| **Expected DB Changes**   | None                                                                             |
| **Expected Socket/Event** | None                                                                             |
| **Notes**                 | Regex `^[-a-zA-Z0-9_]+$`. Spaces, `!`, `@`, `.` rejected. Hyphen `-` IS allowed. |

### TC-AUTH-005 — Validate rejects account longer than 32 chars

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Auth / Account Availability        |
| **API/Event Name**        | `POST /api/auth/accounts/validate` |
| **Test Scenario**         | 33-char account fails max(32)      |
| **Category**              | Edge Case                          |
| **Priority**              | Low                                |
| **Preconditions**         | None                               |
| **Request Payload**       | `{ "account": "a...(33 chars)" }`  |
| **Expected Response**     | `400` VALIDATION_FAILED            |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | Boundary: 32 passes, 33 fails.     |

### TC-AUTH-006 — Validate missing account field

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Auth / Account Availability        |
| **API/Event Name**        | `POST /api/auth/accounts/validate` |
| **Test Scenario**         | Empty body                         |
| **Category**              | Required Params                    |
| **Priority**              | Medium                             |
| **Preconditions**         | None                               |
| **Request Payload**       | `{}`                               |
| **Expected Response**     | `400` VALIDATION_FAILED            |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | —                                  |

### TC-AUTH-007 — Register new account (happy path)

| Field                     | Value                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Register                                                                                                                                                                                           |
| **API/Event Name**        | `POST /api/auth/register`                                                                                                                                                                                 |
| **Test Scenario**         | New username + password creates account and returns tokens                                                                                                                                                |
| **Category**              | Happy Path                                                                                                                                                                                                |
| **Priority**              | High                                                                                                                                                                                                      |
| **Preconditions**         | No `AuthUser` with `account = "new_user1"`                                                                                                                                                                |
| **Request Payload**       | `{ "account": "new_user1", "password": "Str0ngPass!", "fcmTokens": [] }`                                                                                                                                  |
| **Expected Response**     | `201` `{ success:true, data:{ user:{ userId, account:"new_user1", createdAt }, tokens:{ accessToken, refreshToken, accessTokenExpiresIn, refreshTokenExpiresIn } }, message: AUTH_REGISTRATION_SUCCESS }` |
| **Expected DB Changes**   | New `AuthUser` (passwordHash bcrypt cost 12, `lastPasswordChangeAt` set, status ACTIVE); new `Session`; new `RefreshToken` (hashed)                                                                       |
| **Expected Socket/Event** | RabbitMQ `user.created` published (`publishUserCreatedSafe`, isGoogleLogin:false)                                                                                                                         |
| **Notes**                 | `fcmTokens` defaults to `[]` if omitted.                                                                                                                                                                  |

### TC-AUTH-008 — Register with duplicate account → 409

| Field                     | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Register                                                                        |
| **API/Event Name**        | `POST /api/auth/register`                                                              |
| **Test Scenario**         | account already exists                                                                 |
| **Category**              | Business Rule                                                                          |
| **Priority**              | High                                                                                   |
| **Preconditions**         | `AuthUser` with `account = "new_user1"` exists                                         |
| **Request Payload**       | `{ "account": "new_user1", "password": "Str0ngPass!" }`                                |
| **Expected Response**     | `409` `AUTH_ACCOUNT_TAKEN`                                                             |
| **Expected DB Changes**   | None                                                                                   |
| **Expected Socket/Event** | None                                                                                   |
| **Notes**                 | `findByAccount` precheck; unique constraint on `auth_users.account` is final backstop. |

### TC-AUTH-009 — Register rejects password shorter than 8 chars

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Auth / Register                                   |
| **API/Event Name**        | `POST /api/auth/register`                         |
| **Test Scenario**         | password = "short" fails min(8)                   |
| **Category**              | Input Validation                                  |
| **Priority**              | High                                              |
| **Preconditions**         | None                                              |
| **Request Payload**       | `{ "account": "new_user2", "password": "short" }` |
| **Expected Response**     | `400` VALIDATION_FAILED                           |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | `passwordSchema.min(8).max(128)`.                 |

### TC-AUTH-010 — Register rejects password longer than 128 chars

| Field                     | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| **Feature/Module**        | Auth / Register                                         |
| **API/Event Name**        | `POST /api/auth/register`                               |
| **Test Scenario**         | 129-char password fails max(128)                        |
| **Category**              | Security                                                |
| **Priority**              | Medium                                                  |
| **Preconditions**         | None                                                    |
| **Request Payload**       | `{ "account": "new_user3", "password": "<129 chars>" }` |
| **Expected Response**     | `400` VALIDATION_FAILED                                 |
| **Expected DB Changes**   | None                                                    |
| **Expected Socket/Event** | None                                                    |
| **Notes**                 | Upper bound prevents bcrypt DoS via huge inputs.        |

### TC-AUTH-011 — Register rejects invalid fcmTokens (empty string entry)

| Field                     | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Register                                                            |
| **API/Event Name**        | `POST /api/auth/register`                                                  |
| **Test Scenario**         | fcmTokens contains an empty string                                         |
| **Category**              | Input Validation                                                           |
| **Priority**              | Low                                                                        |
| **Preconditions**         | None                                                                       |
| **Request Payload**       | `{ "account": "new_user4", "password": "Str0ngPass!", "fcmTokens": [""] }` |
| **Expected Response**     | `400` VALIDATION_FAILED                                                    |
| **Expected DB Changes**   | None                                                                       |
| **Expected Socket/Event** | None                                                                       |
| **Notes**                 | Each token must be non-empty after trim.                                   |

### TC-AUTH-012 — Register password is never stored in plaintext

| Field                     | Value                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Register                                                                               |
| **API/Event Name**        | `POST /api/auth/register`                                                                     |
| **Test Scenario**         | Stored passwordHash is bcrypt, not the raw password                                           |
| **Category**              | Security                                                                                      |
| **Priority**              | High                                                                                          |
| **Preconditions**         | None                                                                                          |
| **Request Payload**       | `{ "account": "sec_user", "password": "Str0ngPass!" }`                                        |
| **Expected Response**     | `201`                                                                                         |
| **Expected DB Changes**   | `auth_users.passwordHash` matches `^\$2[aby]\$12\$` bcrypt format; never equals the plaintext |
| **Expected Socket/Event** | `user.created`                                                                                |
| **Notes**                 | Verify cost factor 12.                                                                        |

### TC-AUTH-013 — Concurrent register of same account (race)

| Field                     | Value                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Register                                                                                                                                   |
| **API/Event Name**        | `POST /api/auth/register`                                                                                                                         |
| **Test Scenario**         | Two parallel requests for the same new account                                                                                                    |
| **Category**              | Concurrency                                                                                                                                       |
| **Priority**              | High                                                                                                                                              |
| **Preconditions**         | account not yet present                                                                                                                           |
| **Request Payload**       | 2× `{ "account": "race_user", "password": "Str0ngPass!" }`                                                                                        |
| **Expected Response**     | One `201`; the other `409` or `500` (Prisma P2002 unique violation on `account`)                                                                  |
| **Expected DB Changes**   | Exactly one `AuthUser` row created                                                                                                                |
| **Expected Socket/Event** | One `user.created`                                                                                                                                |
| **Notes**                 | Precheck `findByAccount` is racy; DB unique constraint is the real guarantee. P2002 is not explicitly mapped in register — confirm error surface. |
