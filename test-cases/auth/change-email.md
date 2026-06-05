# Auth — Change Email

Source: `apps/auth-service/src/api/routes/change-email.routes.ts`
(`POST /api/auth/change-email/request`, `POST /api/auth/change-email/verify`)

`changeEmailService.requestOtp / verifyAndChange`. Both require auth. Request validates the user's current
email matches `oldEmail`, that `newEmail` differs and isn't taken, then sends an OTP (`EMAIL_CHANGE`) to the
new address. Verify re-checks the same guards, validates the OTP (must belong to this userId), and updates the
verified email.

---

### TC-AUTH-083 — Request change-email OTP (happy path)

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Change Email                                                |
| **API/Event Name**        | `POST /api/auth/change-email/request`                              |
| **Test Scenario**         | Valid oldEmail + new unused email                                  |
| **Category**              | Happy Path                                                         |
| **Priority**              | High                                                               |
| **Preconditions**         | Authed user with `email == oldEmail`; newEmail not taken           |
| **Request Payload**       | `{ "oldEmail": "old@example.com", "newEmail": "new@example.com" }` |
| **Expected Response**     | `200` `{ data:null, message: AUTH_CHANGE_EMAIL_OTP_SENT }`         |
| **Expected DB Changes**   | New `OtpCode(EMAIL_CHANGE)` for userId + identifier=newEmail       |
| **Expected Socket/Event** | RabbitMQ change-email OTP (`publishChangeEmailOtpSafe`)            |
| **Notes**                 | OTP issuance also rate-limited inside `sendEmailOtp`.              |

### TC-AUTH-084 — Request change-email without auth → 401

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Auth / Change Email                              |
| **API/Event Name**        | `POST /api/auth/change-email/request`            |
| **Test Scenario**         | No access token                                  |
| **Category**              | AuthN                                            |
| **Priority**              | High                                             |
| **Preconditions**         | None                                             |
| **Request Payload**       | `{ "oldEmail":"a@b.com", "newEmail":"c@d.com" }` |
| **Expected Response**     | `401`                                            |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | —                                                |

### TC-AUTH-085 — Request change-email with no email on account → 400

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Auth / Change Email                                              |
| **API/Event Name**        | `POST /api/auth/change-email/request`                            |
| **Test Scenario**         | User has no email set                                            |
| **Category**              | Business Rule                                                    |
| **Priority**              | Medium                                                           |
| **Preconditions**         | Authed user with `email == null`                                 |
| **Request Payload**       | `{ "oldEmail":"old@example.com", "newEmail":"new@example.com" }` |
| **Expected Response**     | `400` `AUTH_EMAIL_NOT_SET`                                       |
| **Expected DB Changes**   | None                                                             |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | Must link an email first.                                        |

### TC-AUTH-086 — Request change-email oldEmail mismatch → 400

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Change Email                                                |
| **API/Event Name**        | `POST /api/auth/change-email/request`                              |
| **Test Scenario**         | oldEmail != current account email                                  |
| **Category**              | AuthZ                                                              |
| **Priority**              | High                                                               |
| **Preconditions**         | Authed user; supplied oldEmail wrong                               |
| **Request Payload**       | `{ "oldEmail":"wrong@example.com", "newEmail":"new@example.com" }` |
| **Expected Response**     | `400` `AUTH_OLD_EMAIL_MISMATCH`                                    |
| **Expected DB Changes**   | None                                                               |
| **Expected Socket/Event** | None                                                               |
| **Notes**                 | Prevents blind email change without knowing current email.         |

### TC-AUTH-087 — Request change-email new same as old → 400

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Auth / Change Email                                          |
| **API/Event Name**        | `POST /api/auth/change-email/request`                        |
| **Test Scenario**         | newEmail equals oldEmail                                     |
| **Category**              | Business Rule                                                |
| **Priority**              | Medium                                                       |
| **Preconditions**         | Authed user                                                  |
| **Request Payload**       | `{ "oldEmail":"x@example.com", "newEmail":"x@example.com" }` |
| **Expected Response**     | `400` `AUTH_NEW_EMAIL_SAME_AS_OLD`                           |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | —                                                            |

### TC-AUTH-088 — Request change-email new email taken by another user → 409

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Change Email                                                 |
| **API/Event Name**        | `POST /api/auth/change-email/request`                               |
| **Test Scenario**         | newEmail belongs to a different user                                |
| **Category**              | Business Rule                                                       |
| **Priority**              | High                                                                |
| **Preconditions**         | Another user already owns newEmail                                  |
| **Request Payload**       | `{ "oldEmail":"mine@example.com", "newEmail":"taken@example.com" }` |
| **Expected Response**     | `409` `AUTH_EMAIL_EXISTS`                                           |
| **Expected DB Changes**   | None                                                                |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | `findEmailTakenByOtherUser`.                                        |

### TC-AUTH-089 — Request change-email OTP throttled

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Auth / Change Email                   |
| **API/Event Name**        | `POST /api/auth/change-email/request` |
| **Test Scenario**         | Too many OTP requests                 |
| **Category**              | Rate Limit                            |
| **Priority**              | Medium                                |
| **Preconditions**         | Exceed OTP_REQUEST_MAX in window      |
| **Request Payload**       | repeated valid request                |
| **Expected Response**     | `429` `AUTH_OTP_REQUEST_THROTTLED`    |
| **Expected DB Changes**   | None for throttled                    |
| **Expected Socket/Event** | None                                  |
| **Notes**                 | Throttle inside `sendEmailOtp`.       |

### TC-AUTH-090 — Verify change-email (happy path)

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Change Email                                                                 |
| **API/Event Name**        | `POST /api/auth/change-email/verify`                                                |
| **Test Scenario**         | Correct OTP updates email                                                           |
| **Category**              | Happy Path                                                                          |
| **Priority**              | High                                                                                |
| **Preconditions**         | Active EMAIL_CHANGE OTP for this userId + newEmail                                  |
| **Request Payload**       | `{ "oldEmail":"old@example.com", "newEmail":"new@example.com", "code":"123456" }`   |
| **Expected Response**     | `200` `{ data:{ userId, emailVerified:true }, message: AUTH_CHANGE_EMAIL_SUCCESS }` |
| **Expected DB Changes**   | OTP consumed; `auth_users.email = newEmail`, `emailVerified=true`                   |
| **Expected Socket/Event** | None                                                                                |
| **Notes**                 | —                                                                                   |

### TC-AUTH-091 — Verify change-email wrong code increments attempts → 400

| Field                     | Value                                |
| ------------------------- | ------------------------------------ |
| **Feature/Module**        | Auth / Change Email                  |
| **API/Event Name**        | `POST /api/auth/change-email/verify` |
| **Test Scenario**         | Incorrect OTP                        |
| **Category**              | AuthN                                |
| **Priority**              | High                                 |
| **Preconditions**         | Active OTP exists                    |
| **Request Payload**       | `{ ..., "code":"000000" }`           |
| **Expected Response**     | `400` `AUTH_OTP_INVALID`             |
| **Expected DB Changes**   | OTP `attempts` += 1                  |
| **Expected Socket/Event** | None                                 |
| **Notes**                 | —                                    |

### TC-AUTH-092 — Verify change-email OTP belongs to another user → 400

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Auth / Change Email                            |
| **API/Event Name**        | `POST /api/auth/change-email/verify`           |
| **Test Scenario**         | Latest OTP for newEmail has a different userId |
| **Category**              | Security                                       |
| **Priority**              | High                                           |
| **Preconditions**         | OTP for newEmail issued to a different user    |
| **Request Payload**       | `{ ..., "code":"123456" }`                     |
| **Expected Response**     | `400` `AUTH_OTP_INVALID`                       |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | `otp.userId !== userId` guard.                 |

### TC-AUTH-093 — Verify change-email max attempts → 400

| Field                     | Value                                |
| ------------------------- | ------------------------------------ |
| **Feature/Module**        | Auth / Change Email                  |
| **API/Event Name**        | `POST /api/auth/change-email/verify` |
| **Test Scenario**         | attempts >= maxAttempts              |
| **Category**              | Rate Limit                           |
| **Priority**              | Medium                               |
| **Preconditions**         | OTP capped                           |
| **Request Payload**       | `{ ..., "code":"123456" }`           |
| **Expected Response**     | `400` `AUTH_OTP_MAX_ATTEMPTS`        |
| **Expected DB Changes**   | None                                 |
| **Expected Socket/Event** | None                                 |
| **Notes**                 | —                                    |

### TC-AUTH-094 — Verify change-email invalid code format → 400

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Auth / Change Email                                           |
| **API/Event Name**        | `POST /api/auth/change-email/verify`                          |
| **Test Scenario**         | code not 6 digits                                             |
| **Category**              | Input Validation                                              |
| **Priority**              | Medium                                                        |
| **Preconditions**         | None                                                          |
| **Request Payload**       | `{ "oldEmail":"a@b.com", "newEmail":"c@d.com", "code":"12" }` |
| **Expected Response**     | `400` VALIDATION_FAILED                                       |
| **Expected DB Changes**   | None                                                          |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | Regex `^\d{6}$`.                                              |

### TC-AUTH-095 — Verify change-email new email taken between request and verify → 409

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Auth / Change Email                             |
| **API/Event Name**        | `POST /api/auth/change-email/verify`            |
| **Test Scenario**         | newEmail claimed by another user after OTP sent |
| **Category**              | Concurrency                                     |
| **Priority**              | Medium                                          |
| **Preconditions**         | Another user took newEmail after request        |
| **Request Payload**       | `{ ..., "code":"123456" }`                      |
| **Expected Response**     | `409` `AUTH_EMAIL_EXISTS`                       |
| **Expected DB Changes**   | None                                            |
| **Expected Socket/Event** | None                                            |
| **Notes**                 | Re-checked at verify time.                      |
