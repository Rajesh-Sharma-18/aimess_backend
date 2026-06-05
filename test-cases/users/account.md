# USERS — Account (connected accounts)

Source: `apps/user-service/src/api/routes/account.routes.ts`, `controllers/account.controller.ts`, `services/connected-accounts.service.ts`, `lib/resolve-auth-account.ts`.

Endpoints:

- `GET /api/v1/users/accounts/me` — fetch connected sign-in providers + account status (proxied from auth-service)

---

### TC-USER-062 — Get connected accounts (happy path)

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Account                                                                             |
| **API/Event Name**        | `GET /api/v1/users/accounts/me`                                                             |
| **Test Scenario**         | Authenticated user fetches linked providers                                                 |
| **Category**              | Happy Path                                                                                  |
| **Priority**              | High                                                                                        |
| **Preconditions**         | Auth-service reachable; user has providers (e.g. PASSWORD, GOOGLE)                          |
| **Request Payload**       | None; Bearer token                                                                          |
| **Expected Response**     | `200` `{ data: { providers: [{ provider, connected, ... }], accountStatus } }`              |
| **Expected DB Changes**   | None (data comes from auth-service via `resolveAuthAccountSummary`)                         |
| **Expected Socket/Event** | None                                                                                        |
| **Notes**                 | user-service holds no provider data; it forwards the caller's bearer token to auth-service. |

### TC-USER-063 — Get connected accounts requires auth

| Field                     | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Account                                                                     |
| **API/Event Name**        | `GET /api/v1/users/accounts/me`                                                     |
| **Test Scenario**         | No/invalid Bearer token                                                             |
| **Category**              | AuthN                                                                               |
| **Priority**              | High                                                                                |
| **Preconditions**         | None                                                                                |
| **Request Payload**       | None                                                                                |
| **Expected Response**     | `401`                                                                               |
| **Expected DB Changes**   | None                                                                                |
| **Expected Socket/Event** | None                                                                                |
| **Notes**                 | Token also forwarded downstream; revoked session rejected by `assertSessionActive`. |

### TC-USER-064 — Auth-service unavailable (downstream failure)

| Field                     | Value                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Account                                                                                                                                                                                       |
| **API/Event Name**        | `GET /api/v1/users/accounts/me`                                                                                                                                                                       |
| **Test Scenario**         | auth-service down / circuit open when resolving account summary                                                                                                                                       |
| **Category**              | Error Handling                                                                                                                                                                                        |
| **Priority**              | Medium                                                                                                                                                                                                |
| **Preconditions**         | auth-service unreachable                                                                                                                                                                              |
| **Request Payload**       | None                                                                                                                                                                                                  |
| **Expected Response**     | `200` with `providers: null` (fallback) OR upstream error surfaced — verify behavior                                                                                                                  |
| **Expected DB Changes**   | None                                                                                                                                                                                                  |
| **Expected Socket/Event** | None                                                                                                                                                                                                  |
| **Notes**                 | `getConnectedAccounts` returns `providers: account?.providers ?? null`. Confirm whether `resolveAuthAccountSummary` swallows failures (returns null account) or throws; document the actual contract. |

### TC-USER-065 — Account status reflects suspended/deleted auth user

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Users / Account                                        |
| **API/Event Name**        | `GET /api/v1/users/accounts/me`                        |
| **Test Scenario**         | accountStatus passthrough for non-active auth account  |
| **Category**              | Business Rule                                          |
| **Priority**              | Low                                                    |
| **Preconditions**         | Auth account in a non-active status                    |
| **Request Payload**       | None                                                   |
| **Expected Response**     | `200` with `accountStatus` reflecting upstream value   |
| **Expected DB Changes**   | None                                                   |
| **Expected Socket/Event** | None                                                   |
| **Notes**                 | accountStatus is forwarded verbatim from auth-service. |

### TC-USER-066 — Security: cannot read another user's accounts

| Field                     | Value                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Users / Account                                                                                                |
| **API/Event Name**        | `GET /api/v1/users/accounts/me`                                                                                |
| **Test Scenario**         | Caller identity strictly from token                                                                            |
| **Category**              | Security                                                                                                       |
| **Priority**              | High                                                                                                           |
| **Preconditions**         | Authenticated as A                                                                                             |
| **Request Payload**       | Any query/body attempting to specify another userId                                                            |
| **Expected Response**     | `200` returns only A's data (params ignored)                                                                   |
| **Expected DB Changes**   | None                                                                                                           |
| **Expected Socket/Event** | None                                                                                                           |
| **Notes**                 | `userId = req.auth.userId`; no input controls identity. Email/providers are PII — ensure only owner sees them. |
