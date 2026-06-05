# Auth — Account Deletion

Source: `apps/auth-service/src/api/routes/account-deletion.routes.ts` (`DELETE /api/auth/account`)

`accountDeletionService.deleteAccount`. Auth required. Password confirmation is mandatory ONLY for accounts
that have a password (social-only accounts can skip it). Soft-delete: sets `deletedAt`, status
`PENDING_DELETION`, 30-day `scheduledDeletionAt`; revokes all sessions; emits `user.deleted`.

---

### TC-AUTH-135 — Delete account with password (happy path)

| Field                     | Value                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Account Deletion                                                                              |
| **API/Event Name**        | `DELETE /api/auth/account`                                                                           |
| **Test Scenario**         | Password user confirms with correct password                                                         |
| **Category**              | Happy Path                                                                                           |
| **Priority**              | High                                                                                                 |
| **Preconditions**         | Authed active user with a password                                                                   |
| **Request Payload**       | `{ "password": "Str0ngPass!" }`                                                                      |
| **Expected Response**     | `200` `{ data:{ deletedAt }, message: AUTH_ACCOUNT_DELETED }`                                        |
| **Expected DB Changes**   | `deletedAt` set, status `PENDING_DELETION`, `scheduledDeletionAt` ~30 days out; ALL sessions revoked |
| **Expected Socket/Event** | RabbitMQ `user.deleted` (`publishUserDeletedSafe`)                                                   |
| **Notes**                 | Irreversible from the user's side until grace-period purge.                                          |

### TC-AUTH-136 — Delete social-only account without password

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Auth / Account Deletion                                          |
| **API/Event Name**        | `DELETE /api/auth/account`                                       |
| **Test Scenario**         | No passwordHash → password not required                          |
| **Category**              | Business Rule                                                    |
| **Priority**              | High                                                             |
| **Preconditions**         | Authed social-only user (passwordHash null)                      |
| **Request Payload**       | `{}`                                                             |
| **Expected Response**     | `200` AUTH_ACCOUNT_DELETED                                       |
| **Expected DB Changes**   | Soft-delete as above; sessions revoked                           |
| **Expected Socket/Event** | `user.deleted`                                                   |
| **Notes**                 | `password` optional in schema; service skips check when no hash. |

### TC-AUTH-137 — Delete password account without supplying password → 400

| Field                     | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Account Deletion                                                |
| **API/Event Name**        | `DELETE /api/auth/account`                                             |
| **Test Scenario**         | Password user omits password                                           |
| **Category**              | Required Params                                                        |
| **Priority**              | High                                                                   |
| **Preconditions**         | Authed user with a password                                            |
| **Request Payload**       | `{}`                                                                   |
| **Expected Response**     | `400` `AUTH_PASSWORD_REQUIRED`                                         |
| **Expected DB Changes**   | None                                                                   |
| **Expected Socket/Event** | None                                                                   |
| **Notes**                 | Enforced in service (not schema), since social-only users may omit it. |

### TC-AUTH-138 — Delete with wrong password → 401

| Field                     | Value                           |
| ------------------------- | ------------------------------- |
| **Feature/Module**        | Auth / Account Deletion         |
| **API/Event Name**        | `DELETE /api/auth/account`      |
| **Test Scenario**         | Incorrect password              |
| **Category**              | AuthN                           |
| **Priority**              | High                            |
| **Preconditions**         | Authed user with a password     |
| **Request Payload**       | `{ "password": "WrongPass1" }`  |
| **Expected Response**     | `401` `AUTH_PASSWORD_INCORRECT` |
| **Expected DB Changes**   | None                            |
| **Expected Socket/Event** | None                            |
| **Notes**                 | bcrypt compare.                 |

### TC-AUTH-139 — Delete without auth → 401

| Field                     | Value                      |
| ------------------------- | -------------------------- |
| **Feature/Module**        | Auth / Account Deletion    |
| **API/Event Name**        | `DELETE /api/auth/account` |
| **Test Scenario**         | No access token            |
| **Category**              | AuthN                      |
| **Priority**              | High                       |
| **Preconditions**         | None                       |
| **Request Payload**       | `{ "password":"x" }`       |
| **Expected Response**     | `401`                      |
| **Expected DB Changes**   | None                       |
| **Expected Socket/Event** | None                       |
| **Notes**                 | —                          |

### TC-AUTH-140 — Delete already-deleted/inactive account → error

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Account Deletion                                              |
| **API/Event Name**        | `DELETE /api/auth/account`                                           |
| **Test Scenario**         | Account already deleted or not active                                |
| **Category**              | Business Rule                                                        |
| **Priority**              | Medium                                                               |
| **Preconditions**         | User deletedAt set or status != ACTIVE                               |
| **Request Payload**       | `{ "password": "Str0ngPass!" }`                                      |
| **Expected Response**     | `401`/`404` `AUTH_ACCOUNT_NOT_ACTIVE` (from `loadActiveAuthUser`)    |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | In practice middleware also blocks; double-delete is idempotent-ish. |

### TC-AUTH-141 — Deleted account cannot log back in (password path)

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Auth / Account Deletion                                |
| **API/Event Name**        | `DELETE /api/auth/account` then `POST /api/auth/login` |
| **Test Scenario**         | Login blocked after deletion                           |
| **Category**              | Security                                               |
| **Priority**              | High                                                   |
| **Preconditions**         | Account just soft-deleted                              |
| **Request Payload**       | login with the deleted user's correct creds            |
| **Expected Response**     | login `401 AUTH_INVALID_CREDENTIALS` (deletedAt guard) |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | Confirms deletedAt blocks re-entry.                    |

### TC-AUTH-142 — Deleted account cannot log back in (social path)

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Account Deletion                                            |
| **API/Event Name**        | `DELETE /api/auth/account` then `POST /api/auth/google`            |
| **Test Scenario**         | Social login blocked after deletion                                |
| **Category**              | Security                                                           |
| **Priority**              | High                                                               |
| **Preconditions**         | Social-linked account just soft-deleted                            |
| **Request Payload**       | Google login with the linked sub                                   |
| **Expected Response**     | `401 AUTH_ACCOUNT_NOT_ACTIVE` (assertUserCanLogin deletedAt guard) |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | Both login paths honor the soft-delete.                            |
