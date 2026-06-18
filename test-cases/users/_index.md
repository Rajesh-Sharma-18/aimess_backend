# USERS module — test-case index

Scope: `user-service` REST API, excluding friends/friendship (owned by another agent). ID prefix `TC-USER-NNN`, range **TC-USER-001 … TC-USER-103**.

Source of truth: `apps/user-service/src/api/{routes,controllers,validators}`, `apps/user-service/src/services/*`, `apps/user-service/src/repositories/*`, `apps/user-service/src/config/uploads.ts`, `packages/storage/src/*`.

| File               | Endpoint(s)                                                                        | Cases | ID range          |
| ------------------ | ---------------------------------------------------------------------------------- | ----- | ----------------- |
| `profile.md`       | `GET /api/v1/users/profiles/me`, `PATCH /api/v1/users/profiles/me`                 | 28    | TC-USER-001 … 028 |
| `username.md`      | `POST /api/v1/users/usernames/generate`, `POST /api/v1/users/usernames/validate`   | 13    | TC-USER-029 … 041 |
| `settings.md`      | `GET /api/v1/users/settings/me`, `PATCH /api/v1/users/settings/me`                 | 20    | TC-USER-042 … 061 |
| `account.md`       | `GET /api/v1/users/accounts/me`                                                    | 5     | TC-USER-062 … 066 |
| `avatar-upload.md` | `POST /api/v1/users/uploads/url` (gateway alias → `POST /api/v1/media/upload-url`) | 11    | TC-USER-067 … 077 |
| `user-search.md`   | `GET /api/v1/users/` (search/discovery)                                            | 16    | TC-USER-078 … 093 |
| `internal.md`      | `GET /api/internal/bulk-snapshot`, `GET /api/internal/friendship-check`            | 10    | TC-USER-094 … 103 |

**Total endpoints covered:** 11 (across 7 endpoint families).
**Total test cases:** 103.

## Category coverage

Happy Path · Input Validation · Required/Optional Params · AuthN · AuthZ · Business Rule (username 30-day cooldown, min-age 13, reserved/suffix generation, call-allow-list self-exclusion) · DB State · Error Handling · Edge Case · File Upload (MIME/size/empty/spoof) · Pagination/Filter/Sort · Concurrency (username race, settings race) · Security (IDOR, PII exposure, injection, content sniffing).

## Gaps / ambiguities found

1. **Internal endpoints are unauthenticated (HIGH).** `internal.routes.ts` mounts `/api/internal/{bulk-snapshot,friendship-check}` with NO auth middleware and trusts a query-supplied `callerId`. Anyone with network reach can enumerate any user's friends and snapshot any profiles. Needs service-token/mTLS or strict network isolation. (TC-USER-101, 102)
2. **Username change is not atomic with availability check (MEDIUM).** The PATCH path checks `validateAvailability` then writes — no retry loop like the registration path. Two users racing for the same free handle rely on the DB unique constraint to produce a `409`; verify the P2002 is mapped (not a 500). Also the cooldown read-then-write is non-transactional for the same user. (TC-USER-025, 026)
3. **`section=all` block filtering is one-directional (MEDIUM).** `_queryAll` only collects `b.blockerId` from blocks, so users the viewer has blocked (viewer = blocker) may still appear in `all`. `_queryOthers` filters both directions. Confirm whether `all` should also hide users the viewer blocked. (TC-USER-080)
4. **No server-side content sniffing on avatar upload (MEDIUM).** Only the MIME _string_ and byte size are validated; there is no magic-byte or image-dimension check. The object key extension is derived from the claimed MIME. Bucket is private (presigned GET only), which mitigates execution risk, but a disguised payload can be stored. (TC-USER-074)
5. **Avatar dimension limits not enforced.** Task mentioned dimension validation; the code enforces MIME + max bytes only — no width/height checks anywhere. Documented as a gap, not testable today.
6. **No rate limiting at the service layer.** No rate-limit middleware was found in `user-service` routes/app (rate limiting, if any, lives at the gateway). Rate-limit category not separately covered per endpoint — verify gateway throttling for username generate/validate and search.
7. **Downstream (auth-service) failure contract for `accounts/me` is ambiguous.** Unclear whether `resolveAuthAccountSummary` swallows failures (returns null → `providers: null`) or propagates an error. Behavior should be pinned. (TC-USER-064)
8. **`bulk-snapshot` returns raw `avatarObjectKey`, not a presigned URL** (intentional for internal callers) — callers must presign themselves; documented for contract clarity. Blank/empty id segments are passed to the repo unfiltered. (TC-USER-103)
