# Communities — Update & Delete

**Source:** `apps/community-service/src/api/routes/community.routes.ts` (`PATCH /:id`, `DELETE /:id`), `controllers/community.controller.ts` (`updateCommunity`, `deleteCommunity`), `validators/community.validator.ts` (`updateCommunitySchema`), `services/community.service.ts` (`update`, `deleteCommunity`).

> **Service:** community-service. Update/Delete are **ADMIN-only**. Delete is a **soft delete** (`deletedAt`) that evicts all members and notifies chat-service.

---

### TC-COMM-019 — Update name only (ADMIN)

| Field                     | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Update                                                   |
| **API/Event Name**        | `PATCH /api/v1/communities/:id`                                        |
| **Test Scenario**         | Admin renames community                                                |
| **Category**              | Happy Path                                                             |
| **Priority**              | High                                                                   |
| **Preconditions**         | Caller is ACTIVE ADMIN; new name free                                  |
| **Request Payload**       | `{ "name": "Rustaceans" }`                                             |
| **Expected Response**     | `200` updated DTO with `myRole: "ADMIN"`                               |
| **Expected DB Changes**   | `Community.name` updated; old+new name availability caches invalidated |
| **Expected Socket/Event** | None                                                                   |
| **Notes**                 | At least one field required (refine).                                  |

### TC-COMM-020 — Update with empty body

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Communities / Update                               |
| **API/Event Name**        | `PATCH /api/v1/communities/:id`                    |
| **Test Scenario**         | No updatable field provided                        |
| **Category**              | Input Validation                                   |
| **Priority**              | Medium                                             |
| **Preconditions**         | ADMIN                                              |
| **Request Payload**       | `{}`                                               |
| **Expected Response**     | `400` ("At least one field is required to update") |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | Schema `.refine`.                                  |

### TC-COMM-021 — Update by MODERATOR forbidden

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Communities / Update                          |
| **API/Event Name**        | `PATCH /api/v1/communities/:id`               |
| **Test Scenario**         | Moderator attempts to edit community settings |
| **Category**              | RBAC                                          |
| **Priority**              | High                                          |
| **Preconditions**         | Caller is ACTIVE MODERATOR (not ADMIN)        |
| **Request Payload**       | `{ "description": "x" }`                      |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`                   |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | `assertCommunityRole(membership, ADMIN)`.     |

### TC-COMM-022 — Update by non-member / MEMBER forbidden

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Communities / Update                     |
| **API/Event Name**        | `PATCH /api/v1/communities/:id`          |
| **Test Scenario**         | Plain member or outsider attempts update |
| **Category**              | RBAC                                     |
| **Priority**              | High                                     |
| **Preconditions**         | Caller MEMBER or non-member              |
| **Request Payload**       | `{ "name": "x" }`                        |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`              |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |
| **Notes**                 | —                                        |

### TC-COMM-023 — Update name to a taken name

| Field                     | Value                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Update                                                              |
| **API/Event Name**        | `PATCH /api/v1/communities/:id`                                                   |
| **Test Scenario**         | New name belongs to a different community                                         |
| **Category**              | Business Rule                                                                     |
| **Priority**              | High                                                                              |
| **Preconditions**         | ADMIN; name used elsewhere                                                        |
| **Request Payload**       | `{ "name": "<existing other name>" }`                                             |
| **Expected Response**     | `409` `COMMUNITY_NAME_TAKEN`                                                      |
| **Expected DB Changes**   | None                                                                              |
| **Expected Socket/Event** | None                                                                              |
| **Notes**                 | `checkNameAvailability(name, excludeId)` allows same-community name (idempotent). |

### TC-COMM-024 — Update handle to taken handle

| Field                     | Value                           |
| ------------------------- | ------------------------------- |
| **Feature/Module**        | Communities / Update            |
| **API/Event Name**        | `PATCH /api/v1/communities/:id` |
| **Test Scenario**         | New handle in use               |
| **Category**              | Business Rule                   |
| **Priority**              | High                            |
| **Preconditions**         | ADMIN                           |
| **Request Payload**       | `{ "handle": "<taken>" }`       |
| **Expected Response**     | `409` `COMMUNITY_HANDLE_TAKEN`  |
| **Expected DB Changes**   | None                            |
| **Expected Socket/Event** | None                            |
| **Notes**                 | —                               |

### TC-COMM-025 — Update categoryId to invalid category

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| **Feature/Module**        | Communities / Update                           |
| **API/Event Name**        | `PATCH /api/v1/communities/:id`                |
| **Test Scenario**         | categoryId well-formed but not active          |
| **Category**              | Business Rule                                  |
| **Priority**              | Medium                                         |
| **Preconditions**         | ADMIN                                          |
| **Request Payload**       | `{ "categoryId": "ffffffffffffffffffffffff" }` |
| **Expected Response**     | `400` `COMMUNITY_CATEGORY_INVALID`             |
| **Expected DB Changes**   | None                                           |
| **Expected Socket/Event** | None                                           |
| **Notes**                 | —                                              |

### TC-COMM-026 — Clear avatar / description (nullable)

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Communities / Update                                |
| **API/Event Name**        | `PATCH /api/v1/communities/:id`                     |
| **Test Scenario**         | Set `avatarObjectKey: null` and `description: null` |
| **Category**              | Optional Params                                     |
| **Priority**              | Low                                                 |
| **Preconditions**         | ADMIN                                               |
| **Request Payload**       | `{ "avatarObjectKey": null, "description": null }`  |
| **Expected Response**     | `200`; `avatarUrl: null`, `description: null`       |
| **Expected DB Changes**   | `avatarUrl`/`description` set null                  |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | Both fields are `.nullable().optional()`.           |

### TC-COMM-027 — Update on soft-deleted / missing community

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Communities / Update                      |
| **API/Event Name**        | `PATCH /api/v1/communities/:id`           |
| **Test Scenario**         | id valid hex but community deleted/absent |
| **Category**              | Error Handling                            |
| **Priority**              | Medium                                    |
| **Preconditions**         | Community deletedAt set                   |
| **Request Payload**       | `{ "name": "x" }`                         |
| **Expected Response**     | `404` `COMMUNITY_NOT_FOUND`               |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | `findById` excludes soft-deleted.         |

### TC-COMM-028 — Delete community (ADMIN, with members)

| Field                     | Value                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Delete                                                                                                                                                  |
| **API/Event Name**        | `DELETE /api/v1/communities/:id`                                                                                                                                      |
| **Test Scenario**         | Admin deletes even when other ACTIVE members present                                                                                                                  |
| **Category**              | Happy Path                                                                                                                                                            |
| **Priority**              | High                                                                                                                                                                  |
| **Preconditions**         | Caller ACTIVE ADMIN; multiple members                                                                                                                                 |
| **Request Payload**       | —                                                                                                                                                                     |
| **Expected Response**     | `200` `COMMUNITY_DELETED`                                                                                                                                             |
| **Expected DB Changes**   | `deletedAt` set (soft delete) FIRST; all ACTIVE members → LEFT; `memberCount=0`; audit `COMMUNITY_DELETED` (reason `explicit_delete`); name/handle caches invalidated |
| **Expected Socket/Event** | RabbitMQ `community.deleted` (memberIds captured pre-eviction) + `community.deleted.for-chat` (tears down chat room)                                                  |
| **Notes**                 | Order matters: soft-delete before eviction so concurrent readers get 404.                                                                                             |

### TC-COMM-029 — Delete by MODERATOR forbidden

| Field                     | Value                            |
| ------------------------- | -------------------------------- |
| **Feature/Module**        | Communities / Delete             |
| **API/Event Name**        | `DELETE /api/v1/communities/:id` |
| **Test Scenario**         | Moderator attempts delete        |
| **Category**              | RBAC                             |
| **Priority**              | High                             |
| **Preconditions**         | Caller MODERATOR                 |
| **Request Payload**       | —                                |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`      |
| **Expected DB Changes**   | None                             |
| **Expected Socket/Event** | None                             |
| **Notes**                 | ADMIN-only.                      |

### TC-COMM-030 — Delete already-deleted community

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| **Feature/Module**        | Communities / Delete               |
| **API/Event Name**        | `DELETE /api/v1/communities/:id`   |
| **Test Scenario**         | Re-delete a soft-deleted community |
| **Category**              | Idempotency / Error Handling       |
| **Priority**              | Low                                |
| **Preconditions**         | Community already deletedAt set    |
| **Request Payload**       | —                                  |
| **Expected Response**     | `404` `COMMUNITY_NOT_FOUND`        |
| **Expected DB Changes**   | None                               |
| **Expected Socket/Event** | None                               |
| **Notes**                 | `findById` returns null.           |

### TC-COMM-031 — Concurrent update + delete

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Communities / Update+Delete                            |
| **API/Event Name**        | `PATCH` + `DELETE /api/v1/communities/:id`             |
| **Test Scenario**         | Admin patches while a delete is in flight              |
| **Category**              | Concurrency                                            |
| **Priority**              | Low                                                    |
| **Preconditions**         | ADMIN                                                  |
| **Request Payload**       | concurrent                                             |
| **Expected Response**     | One succeeds; the other may `404` once `deletedAt` set |
| **Expected DB Changes**   | Community ends soft-deleted                            |
| **Expected Socket/Event** | delete events                                          |
| **Notes**                 | No `$transaction`; eventual consistency.               |
