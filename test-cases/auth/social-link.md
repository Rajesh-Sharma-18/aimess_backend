# Auth — Social Link / Unlink

Source: `apps/auth-service/src/api/routes/social-link.routes.ts`
(`POST /api/auth/social/google/link`, `POST /api/auth/social/apple/link`, `POST /api/auth/social/unlink`)

`socialLinkService.linkGoogle / linkApple / unlink`. Auth required. Verifies provider token, then links the
provider to the current user (one provider per user; a provider sub already linked elsewhere → conflict).
Unlink refuses to remove the **last** sign-in method.

---

### TC-AUTH-114 — Link Google to current account (happy path)

| Field                     | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Link                                                        |
| **API/Event Name**        | `POST /api/auth/social/google/link`                                       |
| **Test Scenario**         | Verified Google token, not linked anywhere                                |
| **Category**              | Happy Path                                                                |
| **Priority**              | High                                                                      |
| **Preconditions**         | Authed user with no Google link; sub unused                               |
| **Request Payload**       | `{ "idToken": "<valid google jwt>" }`                                     |
| **Expected Response**     | `200` `{ data:{ provider:"GOOGLE" }, message: AUTH_SOCIAL_LINK_SUCCESS }` |
| **Expected DB Changes**   | New `LinkedAccount(GOOGLE)` for userId                                    |
| **Expected Socket/Event** | None                                                                      |
| **Notes**                 | —                                                                         |

### TC-AUTH-115 — Link Apple to current account (happy path)

| Field                     | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Social Link                                                       |
| **API/Event Name**        | `POST /api/auth/social/apple/link`                                       |
| **Test Scenario**         | Verified Apple token, not linked anywhere                                |
| **Category**              | Happy Path                                                               |
| **Priority**              | High                                                                     |
| **Preconditions**         | Authed user with no Apple link; sub unused                               |
| **Request Payload**       | `{ "identityToken": "<valid apple jwt>", "fullName":"Raj S" }`           |
| **Expected Response**     | `200` `{ data:{ provider:"APPLE" }, message: AUTH_SOCIAL_LINK_SUCCESS }` |
| **Expected DB Changes**   | New `LinkedAccount(APPLE)` for userId                                    |
| **Expected Socket/Event** | None                                                                     |
| **Notes**                 | —                                                                        |

### TC-AUTH-116 — Link provider already linked to same user → 400

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Auth / Social Link                                 |
| **API/Event Name**        | `POST /api/auth/social/google/link`                |
| **Test Scenario**         | The exact provider sub already linked to this user |
| **Category**              | Business Rule                                      |
| **Priority**              | Medium                                             |
| **Preconditions**         | `LinkedAccount(GOOGLE, sub)` exists for this user  |
| **Request Payload**       | `{ "idToken": "<same google jwt>" }`               |
| **Expected Response**     | `400` `AUTH_SOCIAL_ALREADY_LINKED`                 |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | —                                                  |

### TC-AUTH-117 — Link provider sub already linked to another user → 409

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Auth / Social Link                                     |
| **API/Event Name**        | `POST /api/auth/social/google/link`                    |
| **Test Scenario**         | provider sub belongs to a different user               |
| **Category**              | Security                                               |
| **Priority**              | High                                                   |
| **Preconditions**         | `LinkedAccount(GOOGLE, sub)` belongs to another userId |
| **Request Payload**       | `{ "idToken": "<google jwt of that sub>" }`            |
| **Expected Response**     | `409` `AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE`           |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | Prevents stealing another user's social identity.      |

### TC-AUTH-118 — Link a second account of same provider → 400

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Auth / Social Link                                           |
| **API/Event Name**        | `POST /api/auth/social/google/link`                          |
| **Test Scenario**         | User already has a (different) Google link                   |
| **Category**              | Business Rule                                                |
| **Priority**              | Medium                                                       |
| **Preconditions**         | User already has one GOOGLE link; new sub                    |
| **Request Payload**       | `{ "idToken": "<different google jwt>" }`                    |
| **Expected Response**     | `400` `AUTH_PROVIDER_ALREADY_LINKED`                         |
| **Expected DB Changes**   | None                                                         |
| **Expected Socket/Event** | None                                                         |
| **Notes**                 | `@@unique([userId, provider])` — one provider link per user. |

### TC-AUTH-119 — Link concurrent race resolves via unique constraint

| Field                     | Value                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Link                                                                                                         |
| **API/Event Name**        | `POST /api/auth/social/google/link`                                                                                        |
| **Test Scenario**         | Two concurrent link requests for same sub                                                                                  |
| **Category**              | Concurrency                                                                                                                |
| **Priority**              | Medium                                                                                                                     |
| **Preconditions**         | Unused sub; two parallel requests                                                                                          |
| **Request Payload**       | 2× `{ "idToken": "<same google jwt>" }`                                                                                    |
| **Expected Response**     | One `200`; other `409 AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE` or `400 AUTH_PROVIDER_ALREADY_LINKED` (P2002 mapped by target) |
| **Expected DB Changes**   | Exactly one LinkedAccount row                                                                                              |
| **Expected Socket/Event** | None                                                                                                                       |
| **Notes**                 | `isProviderAccountConflict` distinguishes which unique index fired.                                                        |

### TC-AUTH-120 — Link without auth → 401

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Auth / Social Link                  |
| **API/Event Name**        | `POST /api/auth/social/google/link` |
| **Test Scenario**         | No token                            |
| **Category**              | AuthN                               |
| **Priority**              | High                                |
| **Preconditions**         | None                                |
| **Request Payload**       | `{ "idToken":"x" }`                 |
| **Expected Response**     | `401`                               |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | —                                   |

### TC-AUTH-121 — Link missing idToken/identityToken → 400

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Auth / Social Link                 |
| **API/Event Name**        | `POST /api/auth/social/apple/link` |
| **Test Scenario**         | Empty body                         |
| **Category**              | Required Params                    |
| **Priority**              | Medium                             |
| **Preconditions**         | None                               |
| **Request Payload**       | `{}`                               |
| **Expected Response**     | `400` VALIDATION_FAILED            |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | —                                  |

### TC-AUTH-122 — Unlink a provider (happy path)

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Link                                                          |
| **API/Event Name**        | `POST /api/auth/social/unlink`                                              |
| **Test Scenario**         | Remove a provider when other sign-in methods remain                         |
| **Category**              | Happy Path                                                                  |
| **Priority**              | High                                                                        |
| **Preconditions**         | User has GOOGLE link + another method (password or email or APPLE)          |
| **Request Payload**       | `{ "provider": "GOOGLE" }`                                                  |
| **Expected Response**     | `200` `{ data:{ provider:"GOOGLE" }, message: AUTH_SOCIAL_UNLINK_SUCCESS }` |
| **Expected DB Changes**   | `LinkedAccount(GOOGLE)` deleted                                             |
| **Expected Socket/Event** | None                                                                        |
| **Notes**                 | —                                                                           |

### TC-AUTH-123 — Unlink a provider not linked → 400

| Field                     | Value                          |
| ------------------------- | ------------------------------ |
| **Feature/Module**        | Auth / Social Link             |
| **API/Event Name**        | `POST /api/auth/social/unlink` |
| **Test Scenario**         | provider not linked to user    |
| **Category**              | Error Handling                 |
| **Priority**              | Medium                         |
| **Preconditions**         | User has no APPLE link         |
| **Request Payload**       | `{ "provider": "APPLE" }`      |
| **Expected Response**     | `400` `AUTH_SOCIAL_NOT_LINKED` |
| **Expected DB Changes**   | None                           |
| **Expected Socket/Event** | None                           |
| **Notes**                 | —                              |

### TC-AUTH-124 — Unlink the last sign-in method → 400

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Social Link                                                               |
| **API/Event Name**        | `POST /api/auth/social/unlink`                                                   |
| **Test Scenario**         | Removing the provider would leave 0 sign-in methods                              |
| **Category**              | Business Rule                                                                    |
| **Priority**              | High                                                                             |
| **Preconditions**         | Social-only user with exactly one linked provider and no password/verified email |
| **Request Payload**       | `{ "provider": "GOOGLE" }`                                                       |
| **Expected Response**     | `400` `AUTH_LAST_SIGN_IN_METHOD`                                                 |
| **Expected DB Changes**   | None — link kept                                                                 |
| **Expected Socket/Event** | None                                                                             |
| **Notes**                 | `countSignInMethods <= 1` guard prevents account lockout (SOW: keep ≥1 method).  |

### TC-AUTH-125 — Unlink invalid provider value → 400

| Field                     | Value                          |
| ------------------------- | ------------------------------ |
| **Feature/Module**        | Auth / Social Link             |
| **API/Event Name**        | `POST /api/auth/social/unlink` |
| **Test Scenario**         | provider not in enum           |
| **Category**              | Input Validation               |
| **Priority**              | Low                            |
| **Preconditions**         | None                           |
| **Request Payload**       | `{ "provider": "FACEBOOK" }`   |
| **Expected Response**     | `400` VALIDATION_FAILED        |
| **Expected DB Changes**   | None                           |
| **Expected Socket/Event** | None                           |
| **Notes**                 | `z.enum(["GOOGLE","APPLE"])`.  |
