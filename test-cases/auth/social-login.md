# Auth — Social Login (Google / Apple)

Source: `apps/auth-service/src/api/routes/auth.routes.ts` (`POST /api/auth/google`, `POST /api/auth/apple`)

`loginWithGoogle` / `loginWithApple` → `socialAuthService`. Verifies the provider ID token, then:
existing link → login; verified-email match → auto-link to existing user; otherwise create a new account with
a unique generated username. Apple email is only trusted as verified when present in the signed token; a
client-supplied email is never treated as verified (takeover protection). New users emit `user.created`.

---

### TC-AUTH-061 — Google login existing linked user

| Field                     | Value                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Login                                                                                                                                      |
| **API/Event Name**        | `POST /api/auth/google`                                                                                                                                  |
| **Test Scenario**         | Provider sub already linked → returns tokens                                                                                                             |
| **Category**              | Happy Path                                                                                                                                               |
| **Priority**              | High                                                                                                                                                     |
| **Preconditions**         | `LinkedAccount(GOOGLE, sub)` exists for an active user                                                                                                   |
| **Request Payload**       | `{ "idToken": "<valid google jwt>" }`                                                                                                                    |
| **Expected Response**     | `200` `{ data:{ isNewUser:false, user:{ userId, account, email, provider:"GOOGLE" }, isProfileCompleted, tokens }, message: AUTH_SOCIAL_LOGIN_SUCCESS }` |
| **Expected DB Changes**   | recordSuccessfulLogin; FCM merge; new `Session` + `RefreshToken`                                                                                         |
| **Expected Socket/Event** | None (existing user)                                                                                                                                     |
| **Notes**                 | `findByProvider` hit.                                                                                                                                    |

### TC-AUTH-062 — Google login creates new account

| Field                     | Value                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Login                                                                                                                                 |
| **API/Event Name**        | `POST /api/auth/google`                                                                                                                             |
| **Test Scenario**         | New provider sub, email not on any account                                                                                                          |
| **Category**              | Happy Path                                                                                                                                          |
| **Priority**              | High                                                                                                                                                |
| **Preconditions**         | No link and no user with the token's email                                                                                                          |
| **Request Payload**       | `{ "idToken": "<valid google jwt, new user>" }`                                                                                                     |
| **Expected Response**     | `200` `{ data:{ isNewUser:true, isProfileCompleted:false, user:{...,provider:"GOOGLE"}, tokens } }`                                                 |
| **Expected DB Changes**   | New `AuthUser` (unique generated account, email, emailVerified from token, passwordHash null) + `LinkedAccount(GOOGLE)`; `Session` + `RefreshToken` |
| **Expected Socket/Event** | RabbitMQ `user.created` (isGoogleLogin:true)                                                                                                        |
| **Notes**                 | `generateUniqueAccount(buildSocialAccountBase(...))`.                                                                                               |

### TC-AUTH-063 — Google login auto-links to existing account by verified email

| Field                     | Value                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Login                                                               |
| **API/Event Name**        | `POST /api/auth/google`                                                           |
| **Test Scenario**         | Token email is verified and matches an existing user                              |
| **Category**              | Business Rule                                                                     |
| **Priority**              | High                                                                              |
| **Preconditions**         | Existing user with that email; no prior Google link; token emailVerified=true     |
| **Request Payload**       | `{ "idToken": "<google jwt, verified email of existing user>" }`                  |
| **Expected Response**     | `200` `{ data:{ isNewUser:false, ... } }`                                         |
| **Expected DB Changes**   | New `LinkedAccount(GOOGLE)` attached to existing user; success login; new session |
| **Expected Socket/Event** | None                                                                              |
| **Notes**                 | Auto-link only when emailVerified. P2002 race tolerated (concurrent link).        |

### TC-AUTH-064 — Google login does NOT auto-link on unverified email

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Login                                               |
| **API/Event Name**        | `POST /api/auth/google`                                           |
| **Test Scenario**         | Token email matches a user but emailVerified=false                |
| **Category**              | Security                                                          |
| **Priority**              | High                                                              |
| **Preconditions**         | Existing user with that email; token emailVerified=false          |
| **Request Payload**       | `{ "idToken": "<google jwt, unverified email>" }`                 |
| **Expected Response**     | `200` — a NEW account is created instead of linking (no takeover) |
| **Expected DB Changes**   | New `AuthUser` + `LinkedAccount`; existing user untouched         |
| **Expected Socket/Event** | `user.created`                                                    |
| **Notes**                 | Account-takeover guard.                                           |

### TC-AUTH-065 — Google login invalid ID token → 401

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Auth / Social Login                                |
| **API/Event Name**        | `POST /api/auth/google`                            |
| **Test Scenario**         | Token fails Google verification                    |
| **Category**              | AuthN                                              |
| **Priority**              | High                                               |
| **Preconditions**         | None                                               |
| **Request Payload**       | `{ "idToken": "invalid.jwt.value" }`               |
| **Expected Response**     | `401`/error from `verifyGoogleIdToken`             |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | Verify error code surfaced by google-id-token lib. |

### TC-AUTH-066 — Google login missing idToken → 400

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Auth / Social Login                 |
| **API/Event Name**        | `POST /api/auth/google`             |
| **Test Scenario**         | Empty body                          |
| **Category**              | Required Params                     |
| **Priority**              | Medium                              |
| **Preconditions**         | None                                |
| **Request Payload**       | `{}`                                |
| **Expected Response**     | `400` VALIDATION_FAILED             |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | `googleLoginSchema.idToken.min(1)`. |

### TC-AUTH-067 — Social login on locked/deleted/inactive account → blocked

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Login                                                         |
| **API/Event Name**        | `POST /api/auth/google`                                                     |
| **Test Scenario**         | Linked user is deleted/locked/suspended                                     |
| **Category**              | Business Rule                                                               |
| **Priority**              | High                                                                        |
| **Preconditions**         | Linked user with deletedAt OR lockedUntil future OR status != ACTIVE        |
| **Request Payload**       | `{ "idToken": "<google jwt of that user>" }`                                |
| **Expected Response**     | `401` `AUTH_ACCOUNT_NOT_ACTIVE` (deleted/inactive) or `AUTH_ACCOUNT_LOCKED` |
| **Expected DB Changes**   | None                                                                        |
| **Expected Socket/Event** | None                                                                        |
| **Notes**                 | `assertUserCanLogin`.                                                       |

### TC-AUTH-068 — Apple login new user (happy path)

| Field                     | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Social Login                                                      |
| **API/Event Name**        | `POST /api/auth/apple`                                                   |
| **Test Scenario**         | Valid identityToken with email → new account                             |
| **Category**              | Happy Path                                                               |
| **Priority**              | High                                                                     |
| **Preconditions**         | No prior Apple link; email present in token                              |
| **Request Payload**       | `{ "identityToken": "<valid apple jwt>", "fullName": "Raj S" }`          |
| **Expected Response**     | `200` `{ data:{ isNewUser:true, user:{...,provider:"APPLE"}, tokens } }` |
| **Expected DB Changes**   | New `AuthUser` + `LinkedAccount(APPLE)`; session                         |
| **Expected Socket/Event** | `user.created` (isGoogleLogin:false)                                     |
| **Notes**                 | displayName from token or input.fullName.                                |

### TC-AUTH-069 — Apple login no email anywhere → conflict

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Login                                           |
| **API/Event Name**        | `POST /api/auth/apple`                                        |
| **Test Scenario**         | Token has no email and client sent none; not an existing link |
| **Category**              | Business Rule                                                 |
| **Priority**              | High                                                          |
| **Preconditions**         | New Apple sub, no email                                       |
| **Request Payload**       | `{ "identityToken": "<apple jwt, no email>" }`                |
| **Expected Response**     | `409` `AUTH_SOCIAL_EMAIL_REQUIRED`                            |
| **Expected DB Changes**   | None                                                          |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | Apple only sends email on first auth.                         |

### TC-AUTH-070 — Apple client-supplied email never treated as verified

| Field                     | Value                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Login                                                                      |
| **API/Event Name**        | `POST /api/auth/apple`                                                                   |
| **Test Scenario**         | Token has no email, client passes someone else's email                                   |
| **Category**              | Security                                                                                 |
| **Priority**              | High                                                                                     |
| **Preconditions**         | Existing user owns the client-supplied email                                             |
| **Request Payload**       | `{ "identityToken": "<apple jwt, no email>", "email": "victim@example.com" }`            |
| **Expected Response**     | `200` — creates a NEW account; does NOT auto-link to victim (emailVerified forced false) |
| **Expected DB Changes**   | New `AuthUser`+`LinkedAccount`; victim untouched                                         |
| **Expected Socket/Event** | `user.created`                                                                           |
| **Notes**                 | `emailVerified = tokenProfile.email ? ... : false`. Core takeover protection.            |

### TC-AUTH-071 — Apple login invalid identityToken → 401

| Field                     | Value                                 |
| ------------------------- | ------------------------------------- |
| **Feature/Module**        | Auth / Social Login                   |
| **API/Event Name**        | `POST /api/auth/apple`                |
| **Test Scenario**         | Token fails Apple verification        |
| **Category**              | AuthN                                 |
| **Priority**              | High                                  |
| **Preconditions**         | None                                  |
| **Request Payload**       | `{ "identityToken": "bad.token" }`    |
| **Expected Response**     | `401`/error from `verifyAppleIdToken` |
| **Expected DB Changes**   | None                                  |
| **Expected Socket/Event** | None                                  |
| **Notes**                 | —                                     |

### TC-AUTH-072 — Apple login invalid optional email format → 400

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Auth / Social Login                                    |
| **API/Event Name**        | `POST /api/auth/apple`                                 |
| **Test Scenario**         | email present but malformed                            |
| **Category**              | Input Validation                                       |
| **Priority**              | Low                                                    |
| **Preconditions**         | None                                                   |
| **Request Payload**       | `{ "identityToken": "<valid>", "email": "bad-email" }` |
| **Expected Response**     | `400` VALIDATION_FAILED                                |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | `appleLoginSchema.email.optional().email()`.           |
