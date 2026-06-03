# Backoffice (Admin Panel) API — Module → Endpoint → Data-Source Spec

> **Status:** DRAFT for review. No code yet. Review every route here before implementation begins.
> **Service:** `backoffice-service` · HTTP **3010** · gRPC **4010** · Postgres **`admin_db`** (Prisma 7) + read-only Mongo views via gRPC.
> **Public entry:** all routes exposed only through `api-gateway` at `/admin/*` (admin-JWT validation + IP whitelist at the edge).
> Maps the admin dashboard design (Dashboard, User Mgmt, Communities, Groups, Reports, Livestreams, Announcements, Categories, Audit Logs, System Health, Admin Accounts, i18n EN/VI).

---

## 1. Conventions

### 1.1 Base path & versioning

- All paths below are **relative to** `/admin/v1` (gateway strips `/admin`, proxies to backoffice `:3010/v1`).
- Example: spec `GET /users` → client calls `GET https://api/admin/v1/users`.

### 1.2 Auth & RBAC (applies to every route unless marked **public**)

- **Admin JWT** — 8h, secret `JWT_ADMIN_SECRET`, sent as `Authorization: Bearer <token>`.
- **TOTP 2FA** — mandatory; login is a 2-step flow (password → TOTP). Sensitive mutations may re-require a fresh TOTP (`X-Totp-Code` header) — flagged per route as **🔐 step-up**.
- **IP whitelist** — enforced at the gateway for the entire `/admin/*` surface.
- **RBAC** — every protected route declares a required permission. Roles map to permission sets (see §3).

### 1.3 Data-source legend

Each endpoint is tagged with where its data comes from — this is the core of the hybrid model:

| Tag                  | Meaning                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟦 **OWN**           | Read/write `admin_db` (Prisma) — data this service owns (admins, roles, audit logs, reports, announcements, moderation actions, read-model counters). |
| 🟩 **gRPC-live**     | Read-only gRPC call to the owning service at request time (fresh detail/list data). Wrapped in **opossum** (timeout 2000ms, fallback).                |
| 🟨 **read-model**    | Served from `admin_db` tables maintained by RabbitMQ **consumers** (fast dashboard counters / indexes; eventually consistent).                        |
| 🟥 **event-publish** | Mutation emits an event on `aimess.events` (e.g. `admin.user_suspended`).                                                                             |
| 🟪 **redis**         | Live infra/health probe (Redis, queue depth, circuit-breaker state).                                                                                  |

> **Hard rule:** backoffice **never** queries another service's DB directly. Cross-service data = gRPC-live or read-model only.

### 1.4 Audit logging

Every **mutating** route (POST/PATCH/PUT/DELETE) writes an `AuditLog` row (`admin_db`) via the `audit-log` middleware: actor admin id, action, target type+id, before/after diff, IP, timestamp. Marked **📝 audited** below (default for all mutations).

### 1.5 Standard list/query params

`GET` list endpoints accept: `?page` `?limit` (max 100) `?sort` `?order=asc|desc` `?q` (search) plus per-module filters. Responses: `{ data: [...], pagination: { page, limit, total, totalPages } }`.

---

## 2. Downstream dependencies this spec requires

### 2.1 New read-only gRPC RPCs to add (in `packages/grpc-contracts/proto`)

| Service           | RPC                                                                                                                                           | Used by                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| auth-service      | `AdminGetUser`, `AdminListUsers`, `AdminGetUserSessions`                                                                                      | User Mgmt                         |
| user-service      | `AdminGetProfile`, `AdminListProfiles`, `AdminGetUserStats`                                                                                   | User Mgmt                         |
| community-service | `AdminListCommunities`, `AdminGetCommunity`, `AdminListGroups`, `AdminGetGroup`, `AdminListCategories` (or categories owned by community-svc) | Communities / Groups / Categories |
| stream-service    | `AdminListStreams`, `AdminGetStream`, `AdminForceEndStream`                                                                                   | Livestreams                       |
| messaging-service | `AdminGetMessageContext` (for a report's reported message)                                                                                    | Reports                           |

### 2.2 RabbitMQ events consumed (build read-models)

`user.registered`, `user.locked`, `user.deleted`, `user.profile_updated`, `friend.*`, `community.created|deleted|member_joined|member_left`, `group.created|deleted`, `stream.started|ended`, `message.sent` (count only), `call.*` (optional metrics).
→ maintain: `PlatformStats`, `DailyActiveSnapshot`, `CommunityIndex`, `GroupIndex`, `StreamIndex`.

### 2.3 RabbitMQ events published (admin actions)

`admin.user_suspended`, `admin.user_banned`, `admin.user_unbanned`, `admin.content_deleted`, `admin.community_suspended`, `admin.stream_force_ended`, `admin.announcement_published`.

### 2.4 `admin_db` Prisma models (owned)

`AdminUser`, `AdminRole`, `AdminPermission` (or role→permission JSON), `AuditLog`, `Report`, `ReportNote`, `ModerationAction`, `Announcement`, `AnnouncementTranslation`, `Category` _(if categories are admin-owned — see §4.8 open question)_, `PlatformStats`, `DailyActiveSnapshot`, `CommunityIndex`, `GroupIndex`, `StreamIndex`, `ServiceHealthSnapshot` _(optional cache of probes)_.

---

## 3. RBAC permission matrix (draft)

| Permission                         | SUPER_ADMIN | ADMIN | MODERATOR | ANALYST (read-only) |
| ---------------------------------- | :---------: | :---: | :-------: | :-----------------: |
| `dashboard.read`                   |     ✅      |  ✅   |    ✅     |         ✅          |
| `users.read`                       |     ✅      |  ✅   |    ✅     |         ✅          |
| `users.moderate` (ban/suspend)     |     ✅      |  ✅   |    ✅     |          —          |
| `users.delete`                     |     ✅      |  ✅   |     —     |          —          |
| `reports.read`                     |     ✅      |  ✅   |    ✅     |         ✅          |
| `reports.action`                   |     ✅      |  ✅   |    ✅     |          —          |
| `communities.read`                 |     ✅      |  ✅   |    ✅     |         ✅          |
| `communities.moderate`             |     ✅      |  ✅   |    ✅     |          —          |
| `livestreams.read`                 |     ✅      |  ✅   |    ✅     |         ✅          |
| `livestreams.moderate` (force-end) |     ✅      |  ✅   |    ✅     |          —          |
| `categories.manage`                |     ✅      |  ✅   |     —     |          —          |
| `announcements.manage`             |     ✅      |  ✅   |     —     |          —          |
| `auditlogs.read`                   |     ✅      |  ✅   |     —     |         ✅          |
| `systemhealth.read`                |     ✅      |  ✅   |     —     |         ✅          |
| `admins.manage`                    |     ✅      |   —   |     —     |          —          |

---

## 4. Modules → Endpoints → Data sources

### 4.0 Auth & session (public + self)

| Method | Path               | Auth/Perm                   | Request                        | Data source | Notes                                                     |
| ------ | ------------------ | --------------------------- | ------------------------------ | ----------- | --------------------------------------------------------- |
| POST   | `/auth/login`      | **public**                  | `{ email, password }`          | 🟦 OWN      | Step 1. Returns `{ totpRequired: true, challengeToken }`. |
| POST   | `/auth/login/totp` | **public** (challengeToken) | `{ challengeToken, totpCode }` | 🟦 OWN      | Step 2. Returns admin JWT (8h). 📝 audited (login).       |
| POST   | `/auth/refresh`    | **public** (refresh cookie) | —                              | 🟦 OWN      | Rotate admin JWT.                                         |
| POST   | `/auth/logout`     | self                        | —                              | 🟦 OWN      | Blacklist `jti` in Redis. 📝 audited.                     |
| GET    | `/me`              | self                        | —                              | 🟦 OWN      | Current admin profile + permissions.                      |
| POST   | `/me/totp/setup`   | self                        | —                              | 🟦 OWN      | Returns provisioning URI/QR secret.                       |
| POST   | `/me/totp/verify`  | self                        | `{ totpCode }`                 | 🟦 OWN      | Activates 2FA. 📝 audited.                                |
| PATCH  | `/me/password`     | self 🔐 step-up             | `{ current, next }`            | 🟦 OWN      | 📝 audited.                                               |

### 4.1 Dashboard (`dashboard.read`)

| Method | Path                                                         | Request | Data source             | Notes                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------ | ------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/dashboard/stats`                                           | —       | 🟨 read-model           | The stat cards: totalUsers, newUsersToday, dailyActive, monthlyActive, totalCommunities, totalGroups, totalLivestreams, openReports, bannedUsers. Single fast read from `PlatformStats`. |
| GET    | `/dashboard/active-vs-churned?period=monthly\|weekly\|daily` | query   | 🟨 read-model           | Time series for the chart (Daily Active / Monthly Active / Churned) from `DailyActiveSnapshot`.                                                                                          |
| GET    | `/dashboard/communities-groups`                              | —       | 🟨 read-model           | Donut data: communities vs groups totals.                                                                                                                                                |
| GET    | `/dashboard/service-status`                                  | —       | 🟪 redis + 🟩 gRPC-live | Chat / Media / Livestream / Notification operational status (health probes). Mirrors §4.10.                                                                                              |
| GET    | `/dashboard/quick-links`                                     | —       | static/🟨               | Counts for the Quick Links panel (open reports, live livestreams). Optional — can be derived from `/dashboard/stats`.                                                                    |

### 4.2 User Management (`users.read` / `users.moderate` / `users.delete`)

| Method | Path                      | Perm        | Data source               | Notes                                                                                                                                 |
| ------ | ------------------------- | ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/users`                  | read        | 🟩 gRPC-live (auth+user)  | List/search users. Filters: `status`, `banned`, `createdAfter`, `q`. Aggregates `AdminListUsers` (auth) + `AdminListProfiles` (user). |
| GET    | `/users/:id`              | read        | 🟩 gRPC-live              | Full profile: identity (auth) + profile/stats (user) + moderation history (🟦 OWN `ModerationAction`).                                |
| GET    | `/users/:id/sessions`     | read        | 🟩 gRPC-live              | Active device sessions (`AdminGetUserSessions`).                                                                                      |
| GET    | `/users/:id/reports`      | read        | 🟦 OWN                    | Reports filed against this user.                                                                                                      |
| POST   | `/users/:id/suspend`      | moderate 🔐 | 🟦 OWN + 🟥 publish       | Temp suspend (with `reason`, `until`). Emits `admin.user_suspended`. 📝 audited.                                                      |
| POST   | `/users/:id/ban`          | moderate 🔐 | 🟦 OWN + 🟥 publish       | Emits `admin.user_banned`. 📝 audited.                                                                                                |
| POST   | `/users/:id/unban`        | moderate    | 🟦 OWN + 🟥 publish       | Emits `admin.user_unbanned`. 📝 audited.                                                                                              |
| POST   | `/users/:id/force-logout` | moderate    | 🟥 publish (auth revokes) | Revoke all sessions. 📝 audited.                                                                                                      |
| DELETE | `/users/:id`              | delete 🔐   | 🟥 publish                | Soft-delete request → auth/user services own actual deletion. 📝 audited.                                                             |

> Suspend/ban writes the `ModerationAction` row in `admin_db` (source of truth for the admin trail); the _effect_ (locking the account) happens in auth-service via the published event. Backoffice does not write auth's tables.

### 4.3 Communities (`communities.read` / `communities.moderate`)

| Method | Path                                  | Perm        | Data source                      | Notes                                                                  |
| ------ | ------------------------------------- | ----------- | -------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/communities`                        | read        | 🟨 read-model (`CommunityIndex`) | Fast list for the table; falls back to 🟩 gRPC `AdminListCommunities`. |
| GET    | `/communities/:id`                    | read        | 🟩 gRPC-live                     | Full detail incl. member count, owner, settings.                       |
| GET    | `/communities/:id/members`            | read        | 🟩 gRPC-live                     | Paginated members + roles.                                             |
| GET    | `/communities/:id/reports`            | read        | 🟦 OWN                           | Reports against this community/its content.                            |
| POST   | `/communities/:id/suspend`            | moderate 🔐 | 🟦 OWN + 🟥 publish              | `admin.community_suspended`. 📝 audited.                               |
| POST   | `/communities/:id/unsuspend`          | moderate    | 🟥 publish                       | 📝 audited.                                                            |
| DELETE | `/communities/:id/content/:contentId` | moderate 🔐 | 🟥 publish                       | `admin.content_deleted`. 📝 audited.                                   |

### 4.4 Groups (`communities.read` / `communities.moderate`)

> Groups are a sub-entity (see open question §6.3 — group = chat group vs community sub-group). Endpoints mirror communities.

| Method | Path                  | Perm        | Data source                                     |
| ------ | --------------------- | ----------- | ----------------------------------------------- |
| GET    | `/groups`             | read        | 🟨 read-model (`GroupIndex`) → fallback 🟩 gRPC |
| GET    | `/groups/:id`         | read        | 🟩 gRPC-live                                    |
| GET    | `/groups/:id/members` | read        | 🟩 gRPC-live                                    |
| POST   | `/groups/:id/suspend` | moderate 🔐 | 🟦 OWN + 🟥 publish                             |
| DELETE | `/groups/:id`         | moderate 🔐 | 🟥 publish                                      |

### 4.5 Reports / Moderation queue (`reports.read` / `reports.action`)

| Method | Path                  | Perm      | Data source           | Notes                                                                                                                                                         |
| ------ | --------------------- | --------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/reports`            | read      | 🟦 OWN                | Queue. Filters: `status=open\|reviewing\|resolved\|dismissed`, `type=user\|community\|message\|stream`, `priority`.                                           |
| GET    | `/reports/:id`        | read      | 🟦 OWN + 🟩 gRPC-live | Report record + live context of reported entity (e.g. `AdminGetMessageContext`).                                                                              |
| PATCH  | `/reports/:id/assign` | action    | 🟦 OWN                | Assign to an admin. 📝 audited.                                                                                                                               |
| PATCH  | `/reports/:id/status` | action    | 🟦 OWN                | open→reviewing→resolved/dismissed. 📝 audited.                                                                                                                |
| POST   | `/reports/:id/notes`  | action    | 🟦 OWN                | Internal note (`ReportNote`).                                                                                                                                 |
| POST   | `/reports/:id/action` | action 🔐 | 🟦 OWN + 🟥 publish   | Take action (ban user / delete content / suspend community) — creates `ModerationAction` + emits the matching `admin.*` event in one transaction. 📝 audited. |

> **Report ingestion:** reports originate from end-user clients. Decide ingestion path (open question §6.1): users emit `report.created` → backoffice consumer writes `Report`, **or** a gateway-proxied `POST /reports` lands directly in backoffice. Spec assumes **event-ingested** by default.

### 4.6 Livestreams (`livestreams.read` / `livestreams.moderate`)

| Method | Path                         | Perm        | Data source                                | Notes                                        |
| ------ | ---------------------------- | ----------- | ------------------------------------------ | -------------------------------------------- |
| GET    | `/livestreams`               | read        | 🟨 read-model (`StreamIndex`)              | Filter `status=live\|ended\|scheduled`.      |
| GET    | `/livestreams/:id`           | read        | 🟩 gRPC-live                               | Live detail: viewers, community, RTMP state. |
| POST   | `/livestreams/:id/force-end` | moderate 🔐 | 🟩 gRPC `AdminForceEndStream` + 🟥 publish | `admin.stream_force_ended`. 📝 audited.      |

### 4.7 Announcements (`announcements.manage`)

> Platform-wide announcements, **i18n** (EN/VI) — each has translations.

| Method | Path                         | Perm   | Data source         | Notes                                                                        |
| ------ | ---------------------------- | ------ | ------------------- | ---------------------------------------------------------------------------- |
| GET    | `/announcements`             | read   | 🟦 OWN              | List with status (draft/scheduled/published).                                |
| GET    | `/announcements/:id`         | read   | 🟦 OWN              | Includes all translations.                                                   |
| POST   | `/announcements`             | manage | 🟦 OWN              | Body has `translations: { en, vi }`, `audience`, `publishAt`. 📝 audited.    |
| PATCH  | `/announcements/:id`         | manage | 🟦 OWN              | 📝 audited.                                                                  |
| POST   | `/announcements/:id/publish` | manage | 🟦 OWN + 🟥 publish | `admin.announcement_published` → notifications-service fans out. 📝 audited. |
| DELETE | `/announcements/:id`         | manage | 🟦 OWN              | 📝 audited.                                                                  |

### 4.8 Categories (`categories.manage`)

> Community categories (the seeded categories in community-service). **Ownership open question §6.2.**

| Method | Path              | Perm      | Data source                                | Notes                                       |
| ------ | ----------------- | --------- | ------------------------------------------ | ------------------------------------------- |
| GET    | `/categories`     | read      | 🟩 gRPC-live (community-svc) **or** 🟦 OWN | Depends on §6.2.                            |
| POST   | `/categories`     | manage    | 🟩 gRPC write **or** 🟦 OWN + 🟥 publish   | i18n name (en/vi), icon, order. 📝 audited. |
| PATCH  | `/categories/:id` | manage    | as above                                   | 📝 audited.                                 |
| DELETE | `/categories/:id` | manage 🔐 | as above                                   | Guard: block if in use. 📝 audited.         |

### 4.9 Audit Logs (`auditlogs.read`)

| Method | Path                 | Perm | Data source | Notes                                                                                                         |
| ------ | -------------------- | ---- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/audit-logs`        | read | 🟦 OWN      | Filters: `actorId`, `action`, `targetType`, `from`, `to`. Read-only — no mutation routes (append-only table). |
| GET    | `/audit-logs/:id`    | read | 🟦 OWN      | Full diff detail.                                                                                             |
| GET    | `/audit-logs/export` | read | 🟦 OWN      | CSV/JSON export (presigned MinIO for large exports — private bucket).                                         |

### 4.10 System Health (`systemhealth.read`)

| Method | Path              | Perm | Data source             | Notes                                                                                                                      |
| ------ | ----------------- | ---- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/system/health`  | read | 🟪 redis + 🟩 gRPC-live | Per-service status (Chat/Media/Livestream/Notification + auth/user/community). Probes gRPC health + circuit-breaker state. |
| GET    | `/system/queues`  | read | 🟪 redis                | RabbitMQ/Bull queue depths, DLQ counts.                                                                                    |
| GET    | `/system/metrics` | read | 🟨 read-model + 🟪      | Aggregate platform metrics snapshot.                                                                                       |

### 4.11 Admin Accounts (`admins.manage` — SUPER_ADMIN only)

| Method | Path                     | Perm      | Data source | Notes                                                       |
| ------ | ------------------------ | --------- | ----------- | ----------------------------------------------------------- |
| GET    | `/admins`                | manage    | 🟦 OWN      | List admin accounts + roles.                                |
| GET    | `/admins/:id`            | manage    | 🟦 OWN      |                                                             |
| POST   | `/admins`                | manage 🔐 | 🟦 OWN      | Create admin (invite + initial TOTP enrolment). 📝 audited. |
| PATCH  | `/admins/:id/role`       | manage 🔐 | 🟦 OWN      | Change role/permissions. 📝 audited.                        |
| POST   | `/admins/:id/disable`    | manage 🔐 | 🟦 OWN      | Deactivate. 📝 audited.                                     |
| POST   | `/admins/:id/reset-totp` | manage 🔐 | 🟦 OWN      | Force 2FA re-enrolment. 📝 audited.                         |
| GET    | `/roles`                 | manage    | 🟦 OWN      | List roles + permission sets.                               |

### 4.12 Health (infra — public to gateway/k8s)

| Method | Path            | Auth   | Notes                                   |
| ------ | --------------- | ------ | --------------------------------------- |
| GET    | `/health`       | public | Liveness (no auth — gateway/k8s probe). |
| GET    | `/health/ready` | public | Readiness (DB/Redis/RMQ reachable).     |

---

## 5. i18n handling

- Admin UI offers **English / Tiếng Việt**. Server-side i18n applies only to **persisted localizable content**: Announcements (`AnnouncementTranslation`) and Categories (name per locale).
- API/validation/error messages: returned as **stable codes** (`@aimess/errors`); the frontend localizes. Optionally honor `Accept-Language` for human-readable `message` fields.

---

## 6. Open questions to resolve before coding

1. **Report ingestion path** — event-driven (`report.created` consumed) vs synchronous gateway POST into backoffice? _(Spec assumes event-driven.)_
2. **Categories ownership** — does community-service own categories (backoffice manages via gRPC) or does backoffice own them (community-service reads via gRPC/event)? Affects §4.8.
3. **"Groups" definition** — chat/messaging groups vs community sub-groups? Determines which service backs §4.4.
4. **DAU/MAU & churn computation** — derive in backoffice from events, or have a metrics job (Bull) compute daily snapshots? _(Spec assumes Bull job writing `DailyActiveSnapshot`.)_
5. **Banned-users counter source** — read-model maintained from `user.locked`/`admin.user_banned`, confirm single source of truth.
6. **Announcement delivery** — confirm notifications-service consumes `admin.announcement_published` and owns fan-out (push/in-app).

---

## 7. Endpoint count summary

| Module          | Endpoints |
| --------------- | --------- |
| Auth & session  | 8         |
| Dashboard       | 5         |
| User Management | 9         |
| Communities     | 7         |
| Groups          | 5         |
| Reports         | 6         |
| Livestreams     | 3         |
| Announcements   | 6         |
| Categories      | 4         |
| Audit Logs      | 3         |
| System Health   | 3         |
| Admin Accounts  | 7         |
| Health          | 2         |
| **Total**       | **68**    |
