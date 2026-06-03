# Auth — Link Email

Source: `apps/auth-service/src/api/routes/email-link.routes.ts`
(`POST /api/auth/link-email/request`, `POST /api/auth/link-email/verify`)

`emailLinkService.requestOtp / verifyAndLink`. Auth required. Links/verifies a primary email to an account
(e.g. a social-only account adding an email). OTP purpose `EMAIL_VERIFY`. Special case: if the email is already
the account's unverified email, it re-sends an OTP with a different message key.

---

### TC-AUTH-103 — Request link-email OTP for new email (happy path)

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Link Email                                                                   |
| **API/Event Name**        | `POST /api/auth/link-email/request`                                                 |
| **Test Scenario**         | New email not on account                                                            |
| **Category**              | Happy Path                                                                          |
| **Priority**              | High                                                                                |
| **Preconditions**         | Authed user; email not theirs and not taken                                         |
| **Request Payload**       | `{ "email": "new@example.com" }`                                                    |
| **Expected Response**     | `200` message `AUTH_LINK_EMAIL_OTP_SENT`                                            |
| **Expected DB Changes**   | Prior active EMAIL_VERIFY OTPs for identifier consumed; new `OtpCode(EMAIL_VERIFY)` |
| **Expected Socket/Event** | RabbitMQ link-email OTP (`publishLinkEmailOtpSafe`)                                 |
| **Notes**                 | Rate-limited (`assertOtpRequestAllowed`).                                           |

### TC-AUTH-104 — Request link-email when email is already the account's unverified email

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Auth / Link Email                                              |
| **API/Event Name**        | `POST /api/auth/link-email/request`                            |
| **Test Scenario**         | email == user.email but emailVerified=false                    |
| **Category**              | Business Rule                                                  |
| **Priority**              | Medium                                                         |
| **Preconditions**         | User has unverified email == request email                     |
| **Request Payload**       | `{ "email": "mine@example.com" }`                              |
| **Expected Response**     | `200` message `AUTH_EMAIL_ALREADY_ON_ACCOUNT` (OTP still sent) |
| **Expected DB Changes**   | New EMAIL_VERIFY OTP created                                   |
| **Expected Socket/Event** | RabbitMQ link-email OTP                                        |
| **Notes**                 | Different message key, same send.                              |

### TC-AUTH-105 — Request link-email when email already verified on account → 400

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Auth / Link Email                        |
| **API/Event Name**        | `POST /api/auth/link-email/request`      |
| **Test Scenario**         | email == user.email and already verified |
| **Category**              | Business Rule                            |
| **Priority**              | Medium                                   |
| **Preconditions**         | User has verified email == request email |
| **Request Payload**       | `{ "email": "mine@example.com" }`        |
| **Expected Response**     | `400` `AUTH_EMAIL_ALREADY_LINKED`        |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | —                                        |

### TC-AUTH-106 — Request link-email taken by another user → 409

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Auth / Link Email                   |
| **API/Event Name**        | `POST /api/auth/link-email/request` |
| **Test Scenario**         | email owned by a different user     |
| **Category**              | Business Rule                       |
| **Priority**              | High                                |
| **Preconditions**         | Another user owns the email         |
| **Request Payload**       | `{ "email": "taken@example.com" }`  |
| **Expected Response**     | `409` `AUTH_EMAIL_EXISTS`           |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | `findEmailTakenByOtherUser`.        |

### TC-AUTH-107 — Request link-email without auth → 401

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Auth / Link Email                   |
| **API/Event Name**        | `POST /api/auth/link-email/request` |
| **Test Scenario**         | No access token                     |
| **Category**              | AuthN                               |
| **Priority**              | High                                |
| **Preconditions**         | None                                |
| **Request Payload**       | `{ "email":"x@y.com" }`             |
| **Expected Response**     | `401`                               |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | —                                   |

### TC-AUTH-108 — Request link-email on deleted/inactive user → 401

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Auth / Link Email                      |
| **API/Event Name**        | `POST /api/auth/link-email/request`    |
| **Test Scenario**         | Token valid but user deleted/suspended |
| **Category**              | Business Rule                          |
| **Priority**              | Medium                                 |
| **Preconditions**         | User deletedAt or status != ACTIVE     |
| **Request Payload**       | `{ "email":"x@y.com" }`                |
| **Expected Response**     | `401` `AUTH_ACCOUNT_NOT_ACTIVE`        |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | `loadActiveUser`.                      |

### TC-AUTH-109 — Request link-email OTP throttled

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Auth / Link Email                   |
| **API/Event Name**        | `POST /api/auth/link-email/request` |
| **Test Scenario**         | Exceed OTP request limit            |
| **Category**              | Rate Limit                          |
| **Priority**              | Medium                              |
| **Preconditions**         | Exceed OTP_REQUEST_MAX              |
| **Request Payload**       | repeated valid request              |
| **Expected Response**     | `429` `AUTH_OTP_REQUEST_THROTTLED`  |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | —                                   |

### TC-AUTH-110 — Verify link-email (happy path)

| Field                     | Value                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Link Email                                                                 |
| **API/Event Name**        | `POST /api/auth/link-email/verify`                                                |
| **Test Scenario**         | Correct OTP links + verifies email                                                |
| **Category**              | Happy Path                                                                        |
| **Priority**              | High                                                                              |
| **Preconditions**         | Active EMAIL_VERIFY OTP for userId + email                                        |
| **Request Payload**       | `{ "email":"new@example.com", "code":"123456" }`                                  |
| **Expected Response**     | `200` `{ data:{ userId, emailVerified:true }, message: AUTH_LINK_EMAIL_SUCCESS }` |
| **Expected DB Changes**   | OTP consumed; `auth_users.email = email`, `emailVerified=true`                    |
| **Expected Socket/Event** | None                                                                              |
| **Notes**                 | `verifyAndConsumeOtp` enforces userId match + attempts.                           |

### TC-AUTH-111 — Verify link-email taken by another user (race) → 409

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Auth / Link Email                                      |
| **API/Event Name**        | `POST /api/auth/link-email/verify`                     |
| **Test Scenario**         | email taken by another user between request and verify |
| **Category**              | Concurrency                                            |
| **Priority**              | Medium                                                 |
| **Preconditions**         | Another user claimed email                             |
| **Request Payload**       | `{ "email":"new@example.com", "code":"123456" }`       |
| **Expected Response**     | `409` `AUTH_EMAIL_EXISTS`                              |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | Re-checked before linking.                             |

### TC-AUTH-112 — Verify link-email wrong/invalid OTP → 400

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Auth / Link Email                                |
| **API/Event Name**        | `POST /api/auth/link-email/verify`               |
| **Test Scenario**         | Incorrect or missing OTP                         |
| **Category**              | AuthN                                            |
| **Priority**              | High                                             |
| **Preconditions**         | OTP wrong/expired                                |
| **Request Payload**       | `{ "email":"new@example.com", "code":"000000" }` |
| **Expected Response**     | `400` `AUTH_OTP_INVALID` (or MAX_ATTEMPTS)       |
| **Expected DB Changes**   | OTP attempts incremented on wrong code           |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | Behavior from `verifyAndConsumeOtp`.             |

### TC-AUTH-113 — Verify link-email invalid code format → 400

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Auth / Link Email                             |
| **API/Event Name**        | `POST /api/auth/link-email/verify`            |
| **Test Scenario**         | code not 6 digits                             |
| **Category**              | Input Validation                              |
| **Priority**              | Low                                           |
| **Preconditions**         | None                                          |
| **Request Payload**       | `{ "email":"new@example.com", "code":"abc" }` |
| **Expected Response**     | `400` VALIDATION_FAILED                       |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | —                                             |
