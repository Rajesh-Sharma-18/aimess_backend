# Auth — Change Password

Source: `apps/auth-service/src/api/routes/change-password.routes.ts` (`POST /api/auth/change-password`)

`changePasswordService.change`. Requires auth. Verifies the current password, rejects reuse of the same
password, hashes (bcrypt 12) and updates, then **revokes all sessions** of the user.

---

### TC-AUTH-096 — Change password (happy path) revokes all sessions

| Field                     | Value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Change Password                                                          |
| **API/Event Name**        | `POST /api/auth/change-password`                                                |
| **Test Scenario**         | Correct current password + new password                                         |
| **Category**              | Happy Path                                                                      |
| **Priority**              | High                                                                            |
| **Preconditions**         | Authed user with a password                                                     |
| **Request Payload**       | `{ "currentPassword":"Str0ngPass!", "newPassword":"N3wStr0ng!" }`               |
| **Expected Response**     | `200` `{ data:null, message: AUTH_CHANGE_PASSWORD_SUCCESS }`                    |
| **Expected DB Changes**   | `passwordHash` updated (bcrypt 12); ALL sessions revoked + active cache cleared |
| **Expected Socket/Event** | None                                                                            |
| **Notes**                 | Caller's own current session is also revoked → must re-login.                   |

### TC-AUTH-097 — Change password without auth → 401

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Auth / Change Password                         |
| **API/Event Name**        | `POST /api/auth/change-password`               |
| **Test Scenario**         | No access token                                |
| **Category**              | AuthN                                          |
| **Priority**              | High                                           |
| **Preconditions**         | None                                           |
| **Request Payload**       | `{ "currentPassword":"x", "newPassword":"y" }` |
| **Expected Response**     | `401`                                          |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | —                                              |

### TC-AUTH-098 — Change password with wrong current password → 401

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Auth / Change Password                                           |
| **API/Event Name**        | `POST /api/auth/change-password`                                 |
| **Test Scenario**         | currentPassword incorrect                                        |
| **Category**              | AuthN                                                            |
| **Priority**              | High                                                             |
| **Preconditions**         | Authed user with a password                                      |
| **Request Payload**       | `{ "currentPassword":"WrongPass1", "newPassword":"N3wStr0ng!" }` |
| **Expected Response**     | `401` `AUTH_CURRENT_PASSWORD_INVALID`                            |
| **Expected DB Changes**   | None                                                             |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | —                                                                |

### TC-AUTH-099 — Change password on social-only account (no password set) → 400

| Field                     | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| **Feature/Module**        | Auth / Change Password                                          |
| **API/Event Name**        | `POST /api/auth/change-password`                                |
| **Test Scenario**         | User has no passwordHash                                        |
| **Category**              | Business Rule                                                   |
| **Priority**              | Medium                                                          |
| **Preconditions**         | Authed social-only user                                         |
| **Request Payload**       | `{ "currentPassword":"whatever1", "newPassword":"N3wStr0ng!" }` |
| **Expected Response**     | `400` `AUTH_PASSWORD_NOT_SET`                                   |
| **Expected DB Changes**   | None                                                            |
| **Expected Socket/Event** | None                                                            |
| **Notes**                 | Cannot "change" a password that doesn't exist.                  |

### TC-AUTH-100 — Change password new same as current → 400

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Change Password                                             |
| **API/Event Name**        | `POST /api/auth/change-password`                                   |
| **Test Scenario**         | newPassword equals current                                         |
| **Category**              | Business Rule                                                      |
| **Priority**              | Medium                                                             |
| **Preconditions**         | Authed user with a password                                        |
| **Request Payload**       | `{ "currentPassword":"Str0ngPass!", "newPassword":"Str0ngPass!" }` |
| **Expected Response**     | `400` `AUTH_PASSWORD_SAME_AS_CURRENT`                              |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | bcrypt compare against existing hash.                              |

### TC-AUTH-101 — Change password new password too short → 400

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Auth / Change Password                                       |
| **API/Event Name**        | `POST /api/auth/change-password`                             |
| **Test Scenario**         | newPassword < 8 chars                                        |
| **Category**              | Input Validation                                             |
| **Priority**              | Medium                                                       |
| **Preconditions**         | None                                                         |
| **Request Payload**       | `{ "currentPassword":"Str0ngPass!", "newPassword":"short" }` |
| **Expected Response**     | `400` VALIDATION_FAILED                                      |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | Both fields use `passwordSchema` (8–128).                    |

### TC-AUTH-102 — Change password missing fields → 400

| Field                     | Value                            |
| ------------------------- | -------------------------------- |
| **Feature/Module**        | Auth / Change Password           |
| **API/Event Name**        | `POST /api/auth/change-password` |
| **Test Scenario**         | Empty body                       |
| **Category**              | Required Params                  |
| **Priority**              | Medium                           |
| **Preconditions**         | None                             |
| **Request Payload**       | `{}`                             |
| **Expected Response**     | `400` VALIDATION_FAILED          |
| **Expected DB Changes**   | None                             |
| **Expected Socket/Event** | None                             |
| **Notes**                 | —                                |
