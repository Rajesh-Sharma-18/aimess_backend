# FRIENDS — Block / Unblock — GAP (read-only today)

**Source:**

- `apps/user-service/prisma/schema.prisma` (`Block` model, `@@unique([blockerId, blockedId])`)
- `apps/user-service/src/repositories/friendship.repository.ts` (`findAllBlocks`)
- `apps/user-service/src/services/friendship.service.ts` (`sendRequest` — block enforcement)

## Status: NO block/unblock REST endpoints in the FRIENDS module

The `Block` model exists and is **read** during `sendRequest` to reject friend requests between
blocked pairs (either direction → `400 FRIEND_BLOCKED`, see `send-request.md` TC-FRND-007/008).
However there is **no route/controller in the friends or friendship router** to _create_ or
_remove_ a block. `findAllBlocks` is the only `Block` access in this module, and it's read-only.

> If block/unblock is exposed elsewhere (e.g. a privacy/settings or moderation router, or
> community-service), it is **out of scope for the user-service FRIENDS module** and should be
> tested under that module. Within FRIENDS, only block _enforcement on send_ is observable.

The cases below capture (a) the observable enforcement behavior that IS implemented, and
(b) BLOCKED placeholders for the missing block/unblock write endpoints.

---

### TC-FRND-120 — Block enforcement on send (implemented)

| Field                     | Value                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Block enforcement                                                                               |
| **API/Event Name**        | `POST /api/v1/users/friends/requests`                                                                     |
| **Test Scenario**         | A `Block` row exists for the pair (either direction); send request is rejected                            |
| **Category**              | Business Rule                                                                                             |
| **Priority**              | High                                                                                                      |
| **Preconditions**         | `blocks` row `(me→other)` or `(other→me)`                                                                 |
| **Request Payload**       | `{ "addresseeId": "<blocked-uuid>" }`                                                                     |
| **Expected Response**     | `400` `FRIEND_BLOCKED`                                                                                    |
| **Expected DB Changes**   | None                                                                                                      |
| **Expected Socket/Event** | None                                                                                                      |
| **Notes**                 | Cross-ref `send-request.md` TC-FRND-007/008. This is the only block behavior reachable via FRIENDS routes |

### TC-FRND-121 — Existing friendship + later block (state interaction)

| Field                     | Value                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Block interaction                                                                                                                                |
| **API/Event Name**        | n/a (data setup)                                                                                                                                           |
| **Test Scenario**         | A & B are ACCEPTED friends, then a Block row is inserted; verify list-friends & check behavior                                                             |
| **Category**              | Business Rule / DB State                                                                                                                                   |
| **Priority**              | Medium                                                                                                                                                     |
| **Preconditions**         | ACCEPTED friendship + `blocks` row for the pair                                                                                                            |
| **Request Payload**       | `GET /friends`, `GET /internal/friendship-check`                                                                                                           |
| **Expected Response**     | **Verify:** list-friends and friendship-check do NOT filter on blocks — a blocked-but-still-ACCEPTED pair would still appear as friends. Document this gap |
| **Expected DB Changes**   | None                                                                                                                                                       |
| **Expected Socket/Event** | None                                                                                                                                                       |
| **Notes**                 | Blocking does not auto-unfriend, and friend reads ignore blocks → potential business-rule gap                                                              |

### TC-FRND-122 — [BLOCKED] Block a user

| Field                     | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Block                                                           |
| **API/Event Name**        | `POST /api/v1/users/friends/:userId/block` _(proposed — not implemented)_ |
| **Test Scenario**         | Create a `Block` row                                                      |
| **Category**              | Happy Path                                                                |
| **Priority**              | High                                                                      |
| **Preconditions**         | None                                                                      |
| **Request Payload**       | n/a                                                                       |
| **Expected Response**     | `404`/route-not-found today                                               |
| **Expected DB Changes**   | None today                                                                |
| **Expected Socket/Event** | None                                                                      |
| **Notes**                 | GAP — no write endpoint in FRIENDS module                                 |

### TC-FRND-123 — [BLOCKED] Unblock a user

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Unblock                                                           |
| **API/Event Name**        | `DELETE /api/v1/users/friends/:userId/block` _(proposed — not implemented)_ |
| **Test Scenario**         | Remove a `Block` row                                                        |
| **Category**              | Happy Path                                                                  |
| **Priority**              | High                                                                        |
| **Preconditions**         | Existing block                                                              |
| **Request Payload**       | n/a                                                                         |
| **Expected Response**     | `404`/route-not-found today                                                 |
| **Expected DB Changes**   | None today                                                                  |
| **Expected Socket/Event** | None                                                                        |
| **Notes**                 | GAP — no write endpoint in FRIENDS module                                   |

### TC-FRND-124 — [BLOCKED] List blocked users

| Field                     | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| **Feature/Module**        | Friends / Block list                                              |
| **API/Event Name**        | `GET /api/v1/users/friends/blocks` _(proposed — not implemented)_ |
| **Test Scenario**         | List users the caller has blocked                                 |
| **Category**              | Happy Path                                                        |
| **Priority**              | Medium                                                            |
| **Preconditions**         | Existing blocks                                                   |
| **Request Payload**       | n/a                                                               |
| **Expected Response**     | `404`/route-not-found today                                       |
| **Expected DB Changes**   | None today                                                        |
| **Expected Socket/Event** | None                                                              |
| **Notes**                 | GAP — `findAllBlocks` exists in repo but no read route            |
