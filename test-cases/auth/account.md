# Auth — Account Summary & Internal Accounts

Source: `apps/auth-service/src/api/routes/account.routes.ts` (`GET /api/auth/internal/account`)
and `apps/auth-service/src/api/routes/internal.routes.ts` (`GET /api/internal/accounts`)

`getMyAccount` → `accountService.getAccountSummary` (authed; returns connected providers + flags).
`getAccountsByUserIds` → bulk `{ userId, account }` lookup for service-to-service use (NO auth on the route).

---

### TC-AUTH-126 — Get my account summary (happy path)

| Field                     | Value                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Account                                                                                                                                                                       |
| **API/Event Name**        | `GET /api/auth/internal/account`                                                                                                                                                     |
| **Test Scenario**         | Authed user fetches their account summary                                                                                                                                            |
| **Category**              | Happy Path                                                                                                                                                                           |
| **Priority**              | High                                                                                                                                                                                 |
| **Preconditions**         | Active authed user                                                                                                                                                                   |
| **Request Payload**       | none (Bearer token)                                                                                                                                                                  |
| **Expected Response**     | `200` `{ data:{ userId, account, email, emailVerified, hasPassword, providers:[{ provider, connected, providerUserId, providerEmail, linkedAt }] }, message: AUTH_ACCOUNT_FETCHED }` |
| **Expected DB Changes**   | None                                                                                                                                                                                 |
| **Expected Socket/Event** | None                                                                                                                                                                                 |
| **Notes**                 | providers always lists EMAIL, GOOGLE, APPLE with connected flags. `hasPassword` from passwordHash presence.                                                                          |

### TC-AUTH-127 — Account summary EMAIL provider connected only when verified

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| **Feature/Module**        | Auth / Account                                              |
| **API/Event Name**        | `GET /api/auth/internal/account`                            |
| **Test Scenario**         | User has email but emailVerified=false                      |
| **Category**              | Business Rule                                               |
| **Priority**              | Medium                                                      |
| **Preconditions**         | Authed user with unverified email                           |
| **Request Payload**       | none                                                        |
| **Expected Response**     | `200`; EMAIL provider `connected:false`, providerEmail null |
| **Expected DB Changes**   | None                                                        |
| **Expected Socket/Event** | None                                                        |
| **Notes**                 | `emailConnected = email && emailVerified`.                  |

### TC-AUTH-128 — Account summary without auth → 401

| Field                     | Value                            |
| ------------------------- | -------------------------------- |
| **Feature/Module**        | Auth / Account                   |
| **API/Event Name**        | `GET /api/auth/internal/account` |
| **Test Scenario**         | No token                         |
| **Category**              | AuthN                            |
| **Priority**              | High                             |
| **Preconditions**         | None                             |
| **Request Payload**       | none                             |
| **Expected Response**     | `401`                            |
| **Expected DB Changes**   | None                             |
| **Expected Socket/Event** | None                             |
| **Notes**                 | —                                |

### TC-AUTH-129 — Account summary for deleted/inactive user → error

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Auth / Account                                                       |
| **API/Event Name**        | `GET /api/auth/internal/account`                                     |
| **Test Scenario**         | Token valid but user deleted/suspended                               |
| **Category**              | Business Rule                                                        |
| **Priority**              | Medium                                                               |
| **Preconditions**         | User deletedAt or status != ACTIVE                                   |
| **Request Payload**       | none                                                                 |
| **Expected Response**     | `401`/`404` `AUTH_ACCOUNT_NOT_ACTIVE` (from `loadActiveAuthUser`)    |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | In practice the session-active middleware also blocks deleted users. |

### TC-AUTH-130 — Internal accounts bulk lookup (happy path)

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Auth / Internal                                                   |
| **API/Event Name**        | `GET /api/internal/accounts?userIds=...`                          |
| **Test Scenario**         | Resolve account names by userIds                                  |
| **Category**              | Happy Path                                                        |
| **Priority**              | Medium                                                            |
| **Preconditions**         | Two existing users                                                |
| **Request Payload**       | query `userIds=<uuid1>,<uuid2>`                                   |
| **Expected Response**     | `200` `{ data:{ accounts:[{ userId, account }] }, message:"ok" }` |
| **Expected DB Changes**   | None                                                              |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | Used by chat-service to resolve senderName.                       |

### TC-AUTH-131 — Internal accounts empty/missing param returns empty list

| Field                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| **Feature/Module**        | Auth / Internal                                 |
| **API/Event Name**        | `GET /api/internal/accounts`                    |
| **Test Scenario**         | No userIds query param                          |
| **Category**              | Edge Case                                       |
| **Priority**              | Low                                             |
| **Preconditions**         | None                                            |
| **Request Payload**       | (no query)                                      |
| **Expected Response**     | `200` `{ data:{ accounts:[] }, message:"ok" }`  |
| **Expected DB Changes**   | None                                            |
| **Expected Socket/Event** | None                                            |
| **Notes**                 | Empty/blank string → empty array (no DB query). |

### TC-AUTH-132 — Internal accounts caps at 500 ids

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Auth / Internal                                       |
| **API/Event Name**        | `GET /api/internal/accounts`                          |
| **Test Scenario**         | More than 500 userIds supplied                        |
| **Category**              | Edge Case                                             |
| **Priority**              | Low                                                   |
| **Preconditions**         | None                                                  |
| **Request Payload**       | query `userIds=<600 comma-separated ids>`             |
| **Expected Response**     | `200`; only first 500 processed                       |
| **Expected DB Changes**   | None                                                  |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | `.slice(0, 500)` guards against oversized IN queries. |

### TC-AUTH-133 — Internal accounts unknown ids omitted

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Auth / Internal                               |
| **API/Event Name**        | `GET /api/internal/accounts`                  |
| **Test Scenario**         | Mix of valid and unknown userIds              |
| **Category**              | Error Handling                                |
| **Priority**              | Low                                           |
| **Preconditions**         | One valid, one nonexistent id                 |
| **Request Payload**       | query `userIds=<valid>,<missing>`             |
| **Expected Response**     | `200`; only the existing user returned        |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | `findMany where id in` silently drops misses. |

### TC-AUTH-134 — Internal accounts has no auth guard (security note)

| Field                     | Value                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Auth / Internal                                                                                                                            |
| **API/Event Name**        | `GET /api/internal/accounts`                                                                                                               |
| **Test Scenario**         | Endpoint reachable without any token                                                                                                       |
| **Category**              | Security                                                                                                                                   |
| **Priority**              | Medium                                                                                                                                     |
| **Preconditions**         | None                                                                                                                                       |
| **Request Payload**       | query `userIds=<uuid>` (no Authorization header)                                                                                           |
| **Expected Response**     | `200` data returned                                                                                                                        |
| **Expected DB Changes**   | None                                                                                                                                       |
| **Expected Socket/Event** | None                                                                                                                                       |
| **Notes**                 | GAP: route relies on network isolation (`/api/internal` not exposed via gateway). No service-token/mTLS check in code — flag for COVERAGE. |
