# AUTH module — test case index

Module prefix: `TC-AUTH-NNN` (001–159). Base path `/api/auth` (internal bulk lookup at `/api/internal`).
Source of truth: `apps/auth-service/src`.

| File                  | Endpoints covered                                                                                      | # cases | ID range |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ------- | -------- |
| `register.md`         | `POST /api/auth/accounts/validate`, `POST /api/auth/register`                                          | 13      | 001–013  |
| `login.md`            | `POST /api/auth/login`                                                                                 | 13      | 014–026  |
| `refresh-token.md`    | `POST /api/auth/refresh`, `POST /api/auth/token`                                                       | 12      | 027–038  |
| `logout.md`           | `POST /api/auth/logout`                                                                                | 5       | 039–043  |
| `password-reset.md`   | `POST /api/auth/forgot-password/request`, `.../verify`, `.../reset`                                    | 17      | 044–060  |
| `social-login.md`     | `POST /api/auth/google`, `POST /api/auth/apple`                                                        | 12      | 061–072  |
| `sessions.md`         | `GET /api/auth/sessions`, `POST /api/auth/sessions/revoke-all`, `DELETE /api/auth/sessions/:sessionId` | 10      | 073–082  |
| `change-email.md`     | `POST /api/auth/change-email/request`, `.../verify`                                                    | 13      | 083–095  |
| `change-password.md`  | `POST /api/auth/change-password`                                                                       | 7       | 096–102  |
| `email-link.md`       | `POST /api/auth/link-email/request`, `.../verify`                                                      | 11      | 103–113  |
| `social-link.md`      | `POST /api/auth/social/google/link`, `.../apple/link`, `.../unlink`                                    | 12      | 114–125  |
| `account.md`          | `GET /api/auth/internal/account`, `GET /api/internal/accounts`                                         | 9       | 126–134  |
| `account-deletion.md` | `DELETE /api/auth/account`                                                                             | 8       | 135–142  |
| `device-link.md`      | `POST /api/auth/devices/link/initiate`, `GET .../status`, `POST .../approve`                           | 13      | 143–155  |
| `test-push.md`        | `POST /api/auth/test/push` (dev only)                                                                  | 4       | 156–159  |

**Totals:** 15 files · 24 endpoints (across 14 endpoint families) · **159 test cases**.

## Endpoint inventory (every route in auth-service)

1. `POST /api/auth/accounts/validate` — validate account availability
2. `POST /api/auth/register`
3. `POST /api/auth/login` (no Zod validator wired)
4. `POST /api/auth/refresh` (rotating)
5. `POST /api/auth/token` (access-only, no rotation)
6. `POST /api/auth/logout`
7. `POST /api/auth/google`
8. `POST /api/auth/apple`
9. `POST /api/auth/forgot-password/request`
10. `POST /api/auth/forgot-password/verify`
11. `POST /api/auth/forgot-password/reset`
12. `GET /api/auth/internal/account` (account summary, authed)
13. `POST /api/auth/link-email/request`
14. `POST /api/auth/link-email/verify`
15. `POST /api/auth/change-email/request`
16. `POST /api/auth/change-email/verify`
17. `POST /api/auth/change-password`
18. `GET /api/auth/sessions`
19. `POST /api/auth/sessions/revoke-all`
20. `DELETE /api/auth/sessions/:sessionId`
21. `POST /api/auth/social/google/link`
22. `POST /api/auth/social/apple/link`
23. `POST /api/auth/social/unlink`
24. `POST /api/auth/devices/link/initiate`
25. `GET /api/auth/devices/link/status`
26. `POST /api/auth/devices/link/approve`
27. `DELETE /api/auth/account`
28. `GET /api/internal/accounts` (service-to-service, no auth)
29. `POST /api/auth/test/push` (dev only)

## Gaps / ambiguities flagged for COVERAGE.md

- **Login has no Zod guard** — `loginSchema` exists but `validateBody` is commented out in `auth.routes.ts`.
  Malformed bodies reach the service unvalidated (TC-AUTH-025). Recommend wiring the validator.
- **Login case-handling ambiguity** — `login-identifier.ts` comment claims it lowercases identifiers, but
  `normalizeLoginIdentifier` only `.trim()`s. Username case-sensitivity depends on DB collation (TC-AUTH-026).
- **Account enumeration on forgot-password** — `/forgot-password/request` returns a distinct `404` for unknown
  emails (TC-AUTH-045), enabling enumeration. Other login flows correctly use a generic error.
- **Login timing side-channel** — missing-account path skips bcrypt compare, so response timing differs from
  the wrong-password path (TC-AUTH-019).
- **`GET /api/internal/accounts` has no auth/service-token** — relies solely on network isolation
  (TC-AUTH-134). No mTLS or shared-secret check in code.
- **Device-link approve may orphan a Session** — `approve` issues tokens (creating a `Session` + `RefreshToken`)
  BEFORE `approveLinkSessionAtomic`; a NOT_FOUND/ALREADY result there leaves the just-created session row
  un-cleaned (TC-AUTH-151, TC-AUTH-152). Verify and consider rollback.
- **Register debug logging** — `auth.controller.ts` / `auth.service.ts` contain `console.log` of registration
  bodies and the found user (incl. account). Not a test case, but a security/log-hygiene finding.
- **`LoginAttempt` model unused by current code** — schema defines `login_attempts` for audit, but
  `recordFailedLogin`/`recordSuccessfulLogin` operate on `auth_users` counters; no LoginAttempt rows are
  written in the read paths reviewed. Worth confirming whether audit logging is implemented elsewhere.
- **Provider-token verification internals** (`verifyGoogleIdToken`/`verifyAppleIdToken`) are treated as black
  boxes here; their own error codes/edge cases (expired token, wrong audience) are not separately enumerated.
- **`POST /api/auth/token` vs `/refresh` rotation semantics** — `/token` does NOT rotate the refresh token;
  ensure clients use the right one. Documented but easy to misuse.
