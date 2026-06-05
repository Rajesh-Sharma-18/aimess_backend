# Communities — Categories

**Source:** `apps/community-service/src/api/routes/community.routes.ts` (`GET /categories`), `controllers/community.controller.ts` (`listCategories`), `services/community.service.ts` (`listCategories` → `communityRepository.listActiveCategories`). Categories are **seeded**, not created via API (`pnpm db:setup:community` — Mongo db push + seed categories).

> **Service:** community-service (MongoDB). Categories are reference data. There is **no create/update/delete category endpoint** — categories are seeded and only listed. A category is referenced by `categoryId` (24-hex ObjectId) on create/update and validated against active categories.

---

### TC-COMM-099 — List active categories

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Categories                                            |
| **API/Event Name**        | `GET /api/v1/communities/categories`                                |
| **Test Scenario**         | Fetch seeded category list                                          |
| **Category**              | Happy Path                                                          |
| **Priority**              | Medium                                                              |
| **Preconditions**         | Authenticated; seed has run (`pnpm db:setup:community`)             |
| **Request Payload**       | —                                                                   |
| **Expected Response**     | `200` `{ data: { categories: [{ id, name, ... }] } }` (active only) |
| **Expected DB Changes**   | None                                                                |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | Only active categories returned (`listActiveCategories`).           |

### TC-COMM-100 — List categories unauthenticated

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Categories                                             |
| **API/Event Name**        | `GET /api/v1/communities/categories`                                 |
| **Test Scenario**         | No token                                                             |
| **Category**              | AuthN                                                                |
| **Priority**              | High                                                                 |
| **Preconditions**         | —                                                                    |
| **Request Payload**       | no Authorization                                                     |
| **Expected Response**     | `401`                                                                |
| **Expected DB Changes**   | None                                                                 |
| **Expected Socket/Event** | None                                                                 |
| **Notes**                 | `communityRoutes.use(authenticateAccessToken)` covers `/categories`. |

### TC-COMM-101 — Categories empty when seed not run

| Field                     | Value                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Categories                                                                                  |
| **API/Event Name**        | `GET /api/v1/communities/categories`                                                                      |
| **Test Scenario**         | Fresh DB without `db:setup:community`                                                                     |
| **Category**              | Edge Case                                                                                                 |
| **Priority**              | Low                                                                                                       |
| **Preconditions**         | No categories seeded                                                                                      |
| **Request Payload**       | —                                                                                                         |
| **Expected Response**     | `200` `{ categories: [] }`                                                                                |
| **Expected DB Changes**   | None                                                                                                      |
| **Expected Socket/Event** | None                                                                                                      |
| **Notes**                 | Without categories, community create is impossible (categoryId can't validate) — operational gap to flag. |

### TC-COMM-102 — Create community references a known active category (link)

| Field                     | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| **Feature/Module**        | Communities / Categories                                        |
| **API/Event Name**        | `POST /api/v1/communities`                                      |
| **Test Scenario**         | categoryId from `GET /categories` is accepted on create         |
| **Category**              | Business Rule                                                   |
| **Priority**              | Medium                                                          |
| **Preconditions**         | A category id obtained from list                                |
| **Request Payload**       | create body with that categoryId                                |
| **Expected Response**     | `201`                                                           |
| **Expected DB Changes**   | community.categoryId set                                        |
| **Expected Socket/Event** | RabbitMQ `community.created.for-chat`                           |
| **Notes**                 | Cross-ref TC-COMM-007 (invalid) / TC-COMM-025 (update invalid). |
