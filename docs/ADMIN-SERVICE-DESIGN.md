# Admin Panel — Backend Architecture & API Design

> **Status:** Design proposal for review. Companion to [`BACKOFFICE-API-SPEC.md`](./BACKOFFICE-API-SPEC.md) (the route-by-route data-source map).
> **Scope:** Backend for the Admin Dashboard UI (every widget covered). Enterprise-scale social/chat platform (Discord/Slack/Telegram/Reddit class).
> **Service:** `backoffice-service` (a.k.a. Admin Service) · HTTP **3010** · gRPC **4010** · Postgres **`admin_db`** (Prisma 7).
>
> **Current constraints (per latest brief):**
>
> - **Total Livestreams** and **Reports** stat counters are **static placeholders for now** — the route/contract exists, the data source is stubbed (returns a constant / `0`), wired up later.
> - **5 roles:** Super Admin, Admin, Moderator, Support Agent, Analyst.
> - **"Groups" = chat-service group rooms** (`GroupRoom`/`GroupMember`/`GroupInviteLink`, MongoDB). There is **no** standalone Group Service — groups are owned by **chat-service**. Group admin data = chat-service gRPC + its group events.

---

## 0. Widget → data ownership map (so nothing is missed)

Every element on the dashboard screenshot, mapped to its source service. This drives the whole design.

| UI widget                                               | Source of truth                                      | Admin Service strategy                                              |
| ------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Total Users                                             | User Service                                         | read-model counter (event-fed)                                      |
| New Users Today                                         | User Service                                         | read-model counter (daily reset)                                    |
| Daily Active Users (DAU)                                | User Service                                         | read-model from daily snapshot job                                  |
| Monthly Active Users (MAU)                              | User Service                                         | read-model from rolling 30-day snapshot                             |
| Churned Users                                           | User Service                                         | read-model (derived: active last period, inactive this)             |
| Banned Users                                            | User Service (+ admin actions)                       | read-model counter                                                  |
| Total Communities                                       | Community Service                                    | read-model counter                                                  |
| Total Groups                                            | chat-service (GroupRoom)                             | read-model counter                                                  |
| **Total Livestreams**                                   | Livestream Service                                   | **STATIC stub now** → read-model later                              |
| **Open Reports**                                        | (future Moderation)                                  | **STATIC stub now** → admin_db queue later                          |
| Active vs Churned chart                                 | User Service                                         | time-series read-model (`DailyActiveSnapshot`)                      |
| Communities vs Groups donut                             | Community Service + chat-service                     | two read-model counters                                             |
| Service Status (API/Chat/Media/Livestream/Notification) | each service `/health` + gRPC health + breaker state | live probe (Redis-cached 5–10s)                                     |
| Quick Links (counts)                                    | derived from the above                               | reuse `/dashboard/stats`                                            |
| i18n EN / Tiếng Việt                                    | client-side + localizable content                    | stable error codes; translated content for announcements/categories |

---

## 1. Architecture recommendation

Three options, then the verdict.

### Option A — Admin endpoints inside each existing service

Each service exposes its own `/admin/*` routes; the frontend (or gateway) calls many services.

- ➕ No new service; each team owns its admin surface; always live/consistent.
- ➖ **Cross-cutting concerns scatter** — admin RBAC, audit logging, admin auth/2FA get re-implemented N times (or drift). Dashboard must fan out to 6+ services and stitch — slow, fragile, N failure points. No single place for the audit trail. Admin auth leaks into every service.
- **Verdict:** Rejected for enterprise scale. Admin concerns are a bounded context of their own.

### Option B — Dedicated Admin Service (microservice)

A standalone service owns admin identity, RBAC, audit logs, moderation queue, announcements, and read-models. It reads other domains **only** via gRPC (live) or events (read-models) — never their DBs.

- ➕ Single home for admin auth + TOTP + RBAC + audit. One DB for admin-owned data. Clean blast radius. Read-models make the dashboard a single fast query. Honors "one service, one DB."
- ➖ New service to run; eventual consistency on counters; needs read-only RPCs added to other services.
- **Verdict:** ✅ **This is the spine.**

### Option C — Admin BFF (Backend-for-Frontend)

A thin presentation/aggregation layer shaping responses exactly for the admin UI.

- ➕ Tailors payloads to the UI; absorbs UI churn without touching domain logic.
- ➖ A _pure_ BFF with no datastore can't own audit logs, RBAC, or read-models — it would just proxy. On its own it doesn't solve the hard problems.
- **Verdict:** ✅ Useful **as a role of the Admin Service**, not a separate tier. The Admin Service _is_ the BFF for the admin app (it shapes/aggregates) **and** owns admin state. The **api-gateway** stays the single public edge (CORS, IP whitelist, admin-JWT validation, rate limit) and proxies `/admin/*` → Admin Service.

### Final pick

**Dedicated Admin Service that also plays the BFF role, behind the existing API Gateway.** Hybrid data sourcing: **gRPC-live** for detail/list screens, **event-fed read-models** for dashboard counters/charts. This matches the repo's locked architecture (gateway-only edge, DB-per-service, gRPC + RabbitMQ).

```
Admin SPA ──► API Gateway (edge: IP allowlist, admin-JWT, rate limit)
                  └─► Admin Service ──┬─ admin_db (Prisma, OWN: admins, RBAC, audit, read-models)
                                      ├─ gRPC (read-only) ─► User / Community / Group / Livestream / …
                                      └─ RabbitMQ consumer ─► builds read-models from domain events
```

---

## 2. API design

Conventions: base path `/admin/v1` (gateway strips `/admin`, proxies to `:3010/v1`). Admin JWT (8h) + mandatory TOTP. List endpoints: `?page&limit(≤100)&sort&order&q`; responses `{ data, pagination:{ page, limit, total, totalPages } }`. Mutations are audited.

> The exhaustive route table (68 endpoints, with data-source tags 🟦OWN/🟩gRPC/🟨read-model/🟥event/🟪redis) lives in [`BACKOFFICE-API-SPEC.md`](./BACKOFFICE-API-SPEC.md). Representative examples per module below.

### 2.1 Dashboard

**`GET /dashboard/stats`** — every stat card in one call.

```jsonc
// 200
{
  "totalUsers": 5234,
  "newUsersToday": 23,
  "dailyActiveUsers": 3456,
  "monthlyActiveUsers": 4821,
  "totalCommunities": 248,
  "totalGroups": 1342,
  "totalLivestreams": 17, // STATIC stub for now
  "openReports": 8, // STATIC stub for now
  "bannedUsers": 34,
  "asOf": "2026-06-03T09:00:00Z",
  "stale": { "totalLivestreams": true, "openReports": true }, // flags stubbed fields
}
```

**`GET /dashboard/active-vs-churned?period=monthly|weekly|daily&from&to`** — chart series.

```jsonc
// 200
{
  "period": "monthly",
  "series": [
    {
      "bucket": "2026-01",
      "dailyActive": 550,
      "monthlyActive": 450,
      "churned": 250,
    },
    {
      "bucket": "2026-02",
      "dailyActive": 470,
      "monthlyActive": 460,
      "churned": 230,
    },
  ],
}
```

**`GET /dashboard/communities-groups`** — donut.

```jsonc
{ "communities": 248, "groups": 1342, "total": 1590 }
```

**`GET /dashboard/service-status`** — Service Status panel (live, Redis-cached).

```jsonc
{
  "services": [
    { "key": "api", "label": "API", "status": "operational", "latencyMs": 12 },
    {
      "key": "chat",
      "label": "Chat Service",
      "status": "operational",
      "latencyMs": 21,
    },
    {
      "key": "media",
      "label": "Media Service",
      "status": "operational",
      "latencyMs": 33,
    },
    {
      "key": "livestream",
      "label": "Livestream",
      "status": "degraded",
      "breaker": "half-open",
    },
    {
      "key": "notification",
      "label": "Notification",
      "status": "operational",
      "latencyMs": 9,
    },
  ],
  "checkedAt": "2026-06-03T09:00:05Z",
}
```

Status enum: `operational | degraded | down`. Derived from gRPC health + opossum breaker state, cached in Redis 5–10s so the panel never hammers downstreams.

### 2.2 User Management

**`GET /users?status=&banned=&q=&page=&limit=`**

```jsonc
{
  "data": [
    {
      "id": "u_8f...",
      "username": "brianna",
      "email": "b@x.com",
      "status": "active",
      "banned": false,
      "createdAt": "2026-01-10T...",
      "communities": 4,
      "lastActiveAt": "2026-06-02T...",
    },
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5234, "totalPages": 262 },
}
```

Aggregates `auth-service.AdminListUsers` (identity/status) + `user-service.AdminListProfiles` (profile/stats) via gRPC.

**`POST /users/:id/ban`** (perm `users.moderate`, 🔐 step-up TOTP)

```jsonc
// request
{ "reason": "Repeated harassment", "evidenceReportIds": ["r_12"], "notifyUser": true }
// 200
{ "id": "u_8f...", "status": "banned", "moderationActionId": "ma_77", "bannedAt": "2026-06-03T..." }
```

Writes `ModerationAction` in `admin_db` (admin trail = source of truth) **and** emits `admin.user_banned`; auth-service consumes it and locks the account. Admin Service never writes auth's tables.

Also: `POST /users/:id/suspend`, `/unban`, `/force-logout`, `GET /users/:id`, `/users/:id/sessions`, `/users/:id/reports`, `DELETE /users/:id` (soft, event-driven).

### 2.3 Community Management

`GET /communities` (read-model + gRPC fallback), `GET /communities/:id`, `/:id/members`, `POST /:id/suspend` (🔐, emits `admin.community_suspended`), `/:id/unsuspend`, `DELETE /:id/content/:contentId` (emits `admin.content_deleted`).

**`POST /communities/:id/suspend`**

```jsonc
// request
{ "reason": "ToS violation", "durationDays": 7 }
// 200
{ "id": "c_55", "status": "suspended", "until": "2026-06-10T...", "moderationActionId": "ma_78" }
```

### 2.4 Group Management (groups = chat-service group rooms)

`GET /groups` (read-model `GroupIndex`), `GET /groups/:id`, `/:id/members`, `POST /:id/suspend` (🔐), `DELETE /:id` (disband). Backed by **chat-service** gRPC (`AdminListGroups`, `AdminGetGroup`, `AdminGetGroupMembers` — new read-only RPCs to add to chat-service). `GroupIndex` read-model is fed by chat-service group lifecycle events (group room created/disbanded/member-count changes). Group fields map to `GroupRoom` (`roomId`, `name`, `createdBy`, `status`, `memberCount`, `disbandedAt`).

### 2.5 Livestream Management (counter static now; management routes real later)

`GET /livestreams` (read-model `StreamIndex` — **stubbed empty for now**), `GET /livestreams/:id` (gRPC), `POST /livestreams/:id/force-end` (🔐, `admin.stream_force_ended`). The **counter** on the dashboard is static; the management routes are speced but can return `501 Not Implemented`/empty until the Livestream admin RPCs land.

### 2.6 Reports & Moderation (static counter now; queue later)

Speced for the future moderation queue: `GET /reports`, `GET /reports/:id`, `PATCH /:id/assign`, `PATCH /:id/status`, `POST /:id/notes`, `POST /:id/action` (🔐). For now the **Open Reports** counter is static and these routes can be feature-flagged off. Ingestion (when built): users emit `report.created` → Admin Service consumer writes `Report` to `admin_db`.

**`POST /reports/:id/action`** (future)

```jsonc
// request
{ "decision": "ban_user", "targetId": "u_8f", "reason": "Spam", "resolveReport": true }
// 200
{ "reportId": "r_12", "status": "resolved", "moderationActionId": "ma_79", "emittedEvent": "admin.user_banned" }
```

### 2.7 Service Monitoring

`GET /system/health` (per-service status + breaker state), `GET /system/queues` (RabbitMQ/Bull depths, DLQ counts), `GET /system/metrics` (snapshot).

### 2.8 Analytics

`GET /analytics/users?metric=dau|mau|churn|new&from&to&granularity=day|week|month` — backed by `DailyActiveSnapshot`. `GET /analytics/communities-growth`, `GET /analytics/engagement`. All read-model (no live fan-out — analytics must be cheap).

### 2.9 Audit Logs

`GET /audit-logs?actorId=&action=&targetType=&from=&to=` (append-only, no mutations), `GET /audit-logs/:id`, `GET /audit-logs/export` (CSV/JSON → presigned MinIO for large exports).

```jsonc
// GET /audit-logs item
{
  "id": "al_900",
  "actorId": "adm_1",
  "actorEmail": "ops@x.com",
  "action": "user.ban",
  "targetType": "user",
  "targetId": "u_8f",
  "before": { "status": "active" },
  "after": { "status": "banned" },
  "ip": "203.0.113.7",
  "userAgent": "...",
  "createdAt": "2026-06-03T...",
}
```

### 2.10 Admin Roles & Permissions

`GET /admins`, `GET /admins/:id`, `POST /admins` (🔐, invite + TOTP enrol), `PATCH /admins/:id/role` (🔐), `POST /admins/:id/disable`, `POST /admins/:id/reset-totp`, `GET /roles`, `GET /permissions`.

**`PATCH /admins/:id/role`** (SUPER_ADMIN only, 🔐)

```jsonc
// request
{ "role": "MODERATOR" }
// 200
{ "id": "adm_5", "role": "MODERATOR", "permissions": ["dashboard.read","users.read","users.moderate","reports.read","reports.action","communities.read","communities.moderate","livestreams.read","livestreams.moderate"] }
```

### 2.11 Admin Auth (2-step + TOTP)

`POST /auth/login` → `{ totpRequired, challengeToken }`; `POST /auth/login/totp` → admin JWT; `POST /auth/refresh`; `POST /auth/logout` (blacklist jti); `GET /me`; `POST /me/totp/setup` + `/verify`.

---

## 3. Dashboard aggregation strategy

**Problem:** the dashboard must not fan out to 6 services on every page load — that's slow and couples uptime to every downstream.

**Solution — pre-aggregated read-models, refreshed by events + a job:**

```
Domain events (RabbitMQ aimess.events)            Admin Service
  user.registered ─┐
  user.deleted ────┤   consumer (prefetch 10,     ┌─────────────────────────┐
  user.locked ─────┤   manual ACK, DLQ+retry) ──► │ PlatformStats (counters)│  ← GET /dashboard/stats (1 row read)
  community.created ┤                              │ DailyActiveSnapshot     │  ← active-vs-churned chart
  community.deleted ┤                              │ CommunityIndex          │  ← communities list/donut
  group.created ────┤                              │ GroupIndex              │  ← groups list/donut
  group.deleted ────┘                              │ StreamIndex (later)     │
                                                   └─────────────────────────┘
  Bull cron (daily 00:05) ── computes DAU/MAU/churn snapshot ──► DailyActiveSnapshot
  Live probes (gRPC health) ── Redis cache 5–10s ──────────────► /dashboard/service-status
```

- **Counters** (`PlatformStats`): incremented/decremented by event consumers. `GET /dashboard/stats` = **one indexed row read** (sub-millisecond). Cache in Redis 30–60s on top.
- **Static fields now:** `totalLivestreams` and `openReports` return constants (or `0`) with a `stale` flag, so the UI renders today and we swap the source in later with zero contract change.
- **Time series** (`DailyActiveSnapshot`): a **Bull daily job** computes DAU/MAU/churn from User Service (via gRPC `AdminGetUserStats` or an activity event stream) and writes one row/day. The chart reads a date range — cheap.
- **Service status:** live gRPC health probes, **Redis-cached 5–10s**. Never blocks; if a downstream is down its tile shows `down` rather than failing the whole dashboard.
- **Self-healing:** a nightly reconciliation job re-reads authoritative counts via gRPC and corrects any read-model drift (events can be lost; counters can skew).

**Caching tiers:**

1. Read-model row in `admin_db` (authoritative-for-dashboard).
2. Redis cache (30–60s for stats, 5–10s for health) — absorbs refresh spam.
3. HTTP `Cache-Control`/ETag on dashboard GETs.

---

## 4. Database design (`admin_db`, Postgres / Prisma 7)

Admin-owned data only. Everything else is referenced by **shared ID** (no cross-DB FK).

```prisma
// ---------- Identity & RBAC ----------
model AdminUser {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  name         String
  roleId       String
  role         AdminRole @relation(fields: [roleId], references: [id])
  totpSecret   String?            // encrypted at rest
  totpEnabled  Boolean  @default(false)
  status       AdminStatus @default(ACTIVE)   // ACTIVE | DISABLED | INVITED
  lastLoginAt  DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  sessions     AdminSession[]
  auditLogs    AuditLog[]
  @@index([roleId])
}

model AdminRole {
  id          String   @id @default(uuid())
  key         RoleKey  @unique            // SUPER_ADMIN | ADMIN | MODERATOR | SUPPORT_AGENT | ANALYST
  name        String
  description String?
  permissions RolePermission[]
  admins      AdminUser[]
}

model Permission {
  id    String @id @default(uuid())
  key   String @unique                    // e.g. "users.moderate"
  group String                            // "users" | "reports" | ...
  roles RolePermission[]
}

model RolePermission {                     // explicit many-to-many (resource-level extensible)
  roleId       String
  permissionId String
  role         AdminRole  @relation(fields: [roleId], references: [id])
  permission   Permission @relation(fields: [permissionId], references: [id])
  scope        Json?                       // optional resource scope (e.g. { communityIds: [...] })
  @@id([roleId, permissionId])
}

model AdminSession {
  id           String   @id @default(uuid())
  adminId      String
  admin        AdminUser @relation(fields: [adminId], references: [id])
  jti          String   @unique            // matches JWT id; revoke via Redis blacklist
  ip           String
  userAgent    String?
  expiresAt    DateTime
  revokedAt    DateTime?
  createdAt    DateTime @default(now())
  @@index([adminId])
}

// ---------- Audit ----------
model AuditLog {
  id         String   @id @default(uuid())
  actorId    String
  actor      AdminUser @relation(fields: [actorId], references: [id])
  action     String                        // "user.ban", "role.change", ...
  targetType String                        // "user" | "community" | "group" | "stream" | "settings" | "admin"
  targetId   String?
  before     Json?
  after      Json?
  ip         String?
  userAgent  String?
  createdAt  DateTime @default(now())
  @@index([actorId, createdAt])
  @@index([targetType, targetId])
  @@index([action, createdAt])
}

// ---------- Moderation trail (admin side of truth) ----------
model ModerationAction {
  id         String   @id @default(uuid())
  actorId    String
  type       String                        // ban_user | suspend_user | suspend_community | delete_content | force_end_stream
  targetType String
  targetId   String
  reason     String
  metadata   Json?
  reportId   String?                       // links to Report when action came from queue (future)
  createdAt  DateTime @default(now())
  @@index([targetType, targetId])
}

// ---------- System settings ----------
model SystemSetting {
  key         String   @id                 // "feature.reports.enabled", "maintenance.banner"
  value       Json
  updatedById String?
  updatedAt   DateTime @updatedAt
}

// ---------- Announcements (i18n) ----------
model Announcement {
  id           String   @id @default(uuid())
  status       String   @default("draft")  // draft | scheduled | published
  audience     String   @default("all")
  publishAt    DateTime?
  createdById  String
  createdAt    DateTime @default(now())
  translations AnnouncementTranslation[]
}
model AnnouncementTranslation {
  id             String @id @default(uuid())
  announcementId String
  announcement   Announcement @relation(fields: [announcementId], references: [id])
  locale         String       // "en" | "vi"
  title          String
  body           String
  @@unique([announcementId, locale])
}

// ---------- Read-models (event-fed; eventually consistent) ----------
model PlatformStats {                       // single-row (or keyed) live counters
  id               String @id @default("singleton")
  totalUsers       Int    @default(0)
  newUsersToday    Int    @default(0)
  bannedUsers      Int    @default(0)
  totalCommunities Int    @default(0)
  totalGroups      Int    @default(0)
  totalLivestreams Int    @default(0)       // STATIC for now
  openReports      Int    @default(0)       // STATIC for now
  updatedAt        DateTime @updatedAt
}
model DailyActiveSnapshot {
  date         DateTime @id @db.Date
  dailyActive  Int
  monthlyActive Int
  churned      Int
  newUsers     Int
  createdAt    DateTime @default(now())
}
model CommunityIndex {                       // denormalized list source
  id          String @id                    // community id (shared)
  name        String
  ownerId     String
  memberCount Int    @default(0)
  status      String @default("active")
  createdAt   DateTime
  updatedAt   DateTime @updatedAt
  @@index([status])
}
model GroupIndex {
  id          String @id
  name        String
  ownerId     String
  memberCount Int    @default(0)
  status      String @default("active")
  updatedAt   DateTime @updatedAt
  @@index([status])
}

// ---------- Future: report queue (counter static until built) ----------
model Report {
  id          String @id @default(uuid())
  type        String                         // user | community | message | stream
  targetId    String
  reporterId  String
  reason      String
  status      String @default("open")        // open | reviewing | resolved | dismissed
  priority    String @default("normal")
  assignedTo  String?
  createdAt   DateTime @default(now())
  notes       ReportNote[]
  @@index([status, type])
}
model ReportNote {
  id        String @id @default(uuid())
  reportId  String
  report    Report @relation(fields: [reportId], references: [id])
  authorId  String
  body      String
  createdAt DateTime @default(now())
}
```

**Relationships:** `AdminUser → AdminRole` (N:1); `AdminRole ↔ Permission` (M:N via `RolePermission`); `AdminUser → AdminSession`/`AuditLog` (1:N); `Announcement → AnnouncementTranslation` (1:N); read-models are standalone (keyed by shared domain IDs, no FK to other DBs).

---

## 5. RBAC design (production-grade, 5 roles)

**Model:** Role → Permissions, permission key = `resource.action`. Stored in DB (not hardcoded) so roles are editable without redeploy. JWT carries `role` + resolved `permissions[]`; middleware checks `requirePermission('users.moderate')` per route. Optional **resource scope** (`RolePermission.scope` JSON) enables row-level limits (e.g. a Moderator scoped to specific communities) — extensible without schema change.

**Permission catalogue (resource.action):**
`dashboard.read` · `users.read|moderate|delete` · `reports.read|action` · `communities.read|moderate` · `groups.read|moderate` · `livestreams.read|moderate` · `categories.manage` · `announcements.manage` · `auditlogs.read` · `systemhealth.read` · `admins.manage` · `settings.manage`

**Role → permission matrix:**

| Permission           | SUPER_ADMIN | ADMIN | MODERATOR | SUPPORT_AGENT | ANALYST |
| -------------------- | :---------: | :---: | :-------: | :-----------: | :-----: |
| dashboard.read       |     ✅      |  ✅   |    ✅     |      ✅       |   ✅    |
| users.read           |     ✅      |  ✅   |    ✅     |      ✅       |   ✅    |
| users.moderate       |     ✅      |  ✅   |    ✅     |       —       |    —    |
| users.delete         |     ✅      |  ✅   |     —     |       —       |    —    |
| reports.read         |     ✅      |  ✅   |    ✅     |      ✅       |   ✅    |
| reports.action       |     ✅      |  ✅   |    ✅     |       —       |    —    |
| communities.read     |     ✅      |  ✅   |    ✅     |      ✅       |   ✅    |
| communities.moderate |     ✅      |  ✅   |    ✅     |       —       |    —    |
| groups.read          |     ✅      |  ✅   |    ✅     |      ✅       |   ✅    |
| groups.moderate      |     ✅      |  ✅   |    ✅     |       —       |    —    |
| livestreams.read     |     ✅      |  ✅   |    ✅     |      ✅       |   ✅    |
| livestreams.moderate |     ✅      |  ✅   |    ✅     |       —       |    —    |
| categories.manage    |     ✅      |  ✅   |     —     |       —       |    —    |
| announcements.manage |     ✅      |  ✅   |     —     |       —       |    —    |
| auditlogs.read       |     ✅      |  ✅   |     —     |       —       |   ✅    |
| systemhealth.read    |     ✅      |  ✅   |     —     |      ✅       |   ✅    |
| settings.manage      |     ✅      |   —   |     —     |       —       |    —    |
| admins.manage        |     ✅      |   —   |     —     |       —       |    —    |

**Role intent:**

- **Super Admin** — everything incl. managing admins, settings, role changes. Smallest possible set of people.
- **Admin** — full operations except managing other admins/global settings.
- **Moderator** — acts on users/communities/groups/livestreams + works the report queue. No deletes, no config.
- **Support Agent** — read-heavy: can _view_ users/communities/groups and _triage/read_ reports (answer tickets) but **cannot moderate** (no ban/suspend). Bridges users and moderators.
- **Analyst** — pure read/analytics: dashboard, lists, audit logs, system health. No mutations at all.

**Example check:**

```ts
router.post(
  "/users/:id/ban",
  requirePermission("users.moderate"),
  requireStepUpTotp(), // 🔐 fresh TOTP for destructive ops
  banUserController
);
```

---

## 6. Audit logging

**Principle:** every state-changing admin action is recorded _append-only_ with before/after, actor, target, IP — non-repudiable.

**Tracked:** user bans/suspends, community suspensions, group suspensions, report actions, livestream terminations, settings changes, role changes, admin create/disable, TOTP resets, logins.

**Schema:** `AuditLog` (see §4) — indexed by `(actorId, createdAt)`, `(targetType, targetId)`, `(action, createdAt)`. Append-only: no UPDATE/DELETE routes; revocation handled by never mutating.

**Event flow:**

```
Controller (mutation) ──► service does the work ──► writes AuditLog row (same DB txn where possible)
        │                                                   │
        │                                                   └─► (optional) emit audit.* to RabbitMQ
        └─► emits domain admin.* event (e.g. admin.user_banned)        │
                                                                        ▼
                                          Audit pipeline consumer ──► long-term sink
                                          (cold storage / SIEM / data lake via MinIO/S3)
```

- **Hot path:** synchronous row write in `admin_db` (always, even if the broker is down) — the audit log must never be lost. Wrap with the domain mutation in one Prisma transaction when they share the DB.
- **Cold path (optional):** also publish `audit.recorded` so a pipeline can ship to immutable storage / SIEM for compliance and 7-year retention without bloating Postgres. Partition/archive old `AuditLog` rows monthly.
- **Tamper-evidence (optional hardening):** hash-chain each row (`prevHash` + `hash(payload)`) so deletion/edits are detectable.

**Implementation:** an `auditLog()` middleware/decorator captures `{ actor, action, targetType, targetId, before, after, ip, ua }`. Controllers pass `before`/`after`; for ban-type actions the snapshot is the moderation decision.

---

## 7. Scalability (10M+ users, 1M+ communities, 100M+ messages, thousands of live streams)

| Concern                    | Strategy                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Caching**                | 3 tiers: read-model row → Redis (stats 30–60s, health 5–10s) → HTTP ETag. Admin traffic is low-volume but expensive-per-query, so cache the _aggregations_, not raw rows.                                                   |
| **Aggregation**            | Never fan out to N services on dashboard load. Counters are event-incremented; time-series is a daily Bull snapshot. `GET /dashboard/stats` = one row.                                                                      |
| **Event-driven**           | RabbitMQ topic `aimess.events`, durable, `persistent:true`, consumer `prefetch(10)`, manual ACK, 3 retries via `aimess.retry` (1s→2s→4s) → `aimess.dlq` (Grafana alert). Read-models built off this.                        |
| **Background jobs (Bull)** | Daily DAU/MAU/churn snapshot; `newUsersToday` reset at midnight; nightly read-model reconciliation vs gRPC truth; audit-log archival; large CSV exports (→ presigned MinIO).                                                |
| **Read models**            | CQRS: write-side stays in domain services; Admin Service maintains denormalized read-side (`CommunityIndex`, `GroupIndex`, `DailyActiveSnapshot`, `PlatformStats`) optimized for admin queries.                             |
| **gRPC discipline**        | Every outbound call wrapped in **opossum** (timeout 2000, errorThreshold 50%, resetTimeout 10000, volumeThreshold 5) with graceful fallback to read-model/cached value. One slow downstream never takes the dashboard down. |
| **DB performance**         | Index all list filters (`status`, `createdAt`, `targetType+targetId`). Cursor pagination for huge tables (audit logs). Partition `AuditLog` by month. Cap `limit` at 100.                                                   |
| **Search at scale**        | For 10M users / 1M communities, free-text `q` should hit a search index (OpenSearch/Elastic fed by events), not `ILIKE` on Postgres — Admin Service queries the index, not the domain DB.                                   |
| **Isolation**              | Admin Service is low-QPS but high-privilege: separate rate limits, IP allowlist, separate JWT secret, separate deployment so admin load/incidents never touch the user-facing path.                                         |
| **Consistency**            | Read-models are eventually consistent — acceptable for dashboards. Detail screens that need exactness use gRPC-live. Reconciliation job corrects drift.                                                                     |

---

## 8. Folder structure (`apps/backoffice-service`)

Matches the repo's `controllers → services → repositories` layering, ESM `.js` imports, `@aimess/*` shared packages.

```
apps/backoffice-service/
├── prisma/
│   ├── schema.prisma              # admin_db models (§4)
│   └── migrations/
├── src/
│   ├── server.ts                  # bootstrap HTTP(3010)+gRPC(4010), graceful shutdown
│   ├── app.ts                     # express app, helmet, cors, requestId, error handler
│   ├── config/
│   │   ├── env.ts                 # Zod-validated env (ports, JWT_ADMIN_SECRET, gRPC URLs, REDIS, RMQ)
│   │   ├── prisma.ts              # PrismaClient (admin_db)
│   │   └── redis.ts
│   ├── api/
│   │   ├── routes/                # dashboard, users, communities, groups, livestreams,
│   │   │                          #   reports, analytics, audit-logs, system, admins, auth, announcements, categories
│   │   ├── controllers/          # thin: parse → call service → shape response
│   │   ├── validators/           # Zod request schemas
│   │   └── middleware/
│   │       ├── admin-auth.ts      # verify admin JWT + jti blacklist
│   │       ├── require-permission.ts  # RBAC
│   │       ├── require-totp.ts    # 🔐 step-up
│   │       ├── audit-log.ts       # writes AuditLog on mutations
│   │       └── validate.ts        # body/params/query
│   ├── services/                  # business logic per module
│   │   ├── dashboard.service.ts
│   │   ├── user-admin.service.ts
│   │   ├── moderation.service.ts
│   │   ├── analytics.service.ts
│   │   ├── audit.service.ts
│   │   ├── rbac.service.ts
│   │   └── health.service.ts
│   ├── repositories/              # admin_db data access (Prisma)
│   ├── grpc/
│   │   ├── server.ts              # backoffice gRPC server (if exposing any)
│   │   └── clients/               # read-only clients to user/community/group/livestream/auth
│   │       ├── user.client.ts     #   each wrapped in opossum
│   │       ├── community.client.ts
│   │       ├── chat.client.ts        #   groups live in chat-service
│   │       └── livestream.client.ts
│   ├── messaging/
│   │   ├── consumers/             # event → read-model updaters
│   │   │   ├── user-events.consumer.ts
│   │   │   ├── community-events.consumer.ts
│   │   │   └── group-events.consumer.ts
│   │   ├── publishers/            # admin.* events
│   │   └── topology.ts            # exchange/queue/DLQ setup
│   ├── jobs/                      # Bull
│   │   ├── daily-snapshot.job.ts
│   │   ├── reconcile-readmodels.job.ts
│   │   └── audit-archive.job.ts
│   ├── lib/                       # totp, jwt-admin, csv-export, cache helpers
│   ├── constants/                 # permission keys, role keys, event names
│   └── types/
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 9. System diagram (text)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Admin Frontend (SPA, EN/VI)                          │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                     │ HTTPS  /admin/v1/*   (Bearer admin-JWT)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  API Gateway (8000) — IP allowlist · admin-JWT validate · CORS · rate limit   │
│                       · request-id · proxy /admin/* → backoffice               │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                     │  /v1/*
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Admin (Backoffice) Service  3010 / gRPC 4010            │
│  Controllers → Services → Repositories                                         │
│  ┌─ Auth(2FA/TOTP) ─ RBAC ─ Audit middleware ─ Moderation ─ Dashboard ─ Jobs ┐ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
└───┬───────────────┬───────────────────────────┬──────────────────┬────────────┘
    │ Prisma        │ gRPC (read-only,           │ RabbitMQ          │ Redis
    ▼               │  opossum-wrapped)          │ (aimess.events)   ▼
┌────────────┐      │                            │            ┌──────────────┐
│  admin_db  │      │                            │            │   Redis      │
│ (Postgres) │      ▼                            │            │ cache · jti  │
│ admins/RBAC│  ┌──────────────────────────┐     │            │ blacklist ·  │
│ audit logs │  │  Existing Microservices   │     │            │ Bull broker  │
│ read-models│  │  User · Community · Auth  │◄────┘ publish    └──────────────┘
│ announce.  │  │  Chat · Media · Livestream│  admin.user_banned, admin.content_deleted …
└────────────┘  │  Notification            │
                │  (each owns its own DB)   │
                └─────────────┬─────────────┘
                              │ emit domain events (user.*, community.*, group.*, …)
                              ▼
                  ┌──────────────────────────┐        ┌───────────────────────────┐
                  │  RabbitMQ  aimess.events  │───────►│ Admin event consumers      │
                  │  topic · DLQ · retry      │        │ → update read-models       │
                  └──────────────────────────┘        └───────────────────────────┘
                              │ (admin.announcement_published)
                              ▼
                     Notification Service ── fan-out push/in-app

  Audit Log Pipeline:  AuditLog row (sync, admin_db)  ──►  audit.recorded (RMQ, optional)
                                                          ──►  cold storage / SIEM (MinIO/S3)
```

---

## 10. Final recommendation

**Build a dedicated Admin (Backoffice) Service that also serves as the BFF for the admin app, behind the existing API Gateway, using hybrid data sourcing (gRPC-live for detail screens + event-fed read-models for dashboards).**

Why this over the alternatives:

1. **Admin is its own bounded context.** Auth, RBAC, TOTP, audit, and moderation are cross-cutting and high-privilege. Scattering them into every service (Option A) guarantees drift and N audit trails. One service = one source of admin truth.
2. **Dashboards must be O(1), not O(services).** Fanning out live to 6 services per page load couples admin uptime to every downstream and is slow. Event-fed read-models make the dashboard a single indexed read; live gRPC is reserved for detail screens where freshness matters. Circuit breakers keep one slow downstream from sinking the page.
3. **It honors the locked architecture** — gateway-only public edge, DB-per-service (Admin never reads another service's DB), gRPC + RabbitMQ, opossum, Bull, Prisma 7. No new patterns to maintain.
4. **Security posture is centralized** — separate JWT secret, mandatory TOTP, step-up on destructive actions, IP allowlist, append-only (optionally hash-chained) audit, isolated deployment/rate limits.

**Opinionated cautions / common mistakes to avoid:**

- ❌ Don't let the Admin Service read other services' databases for "convenience." It's the fastest way to break the platform later. gRPC or events only.
- ❌ Don't compute DAU/MAU live per request — snapshot it. Don't `ILIKE` over 10M users — use a search index fed by events.
- ❌ Don't make read-models the _only_ source — add a nightly reconciliation job; events get lost.
- ❌ Don't skip the synchronous audit write "because we publish an event" — the broker can be down; the audit row cannot be optional.
- ✅ Do ship the **static stubs** for Total Livestreams / Open Reports behind the _real_ contract + a `stale` flag, so swapping in the live source later is a no-op for the frontend.
- ✅ Do feature-flag the Reports/Moderation queue and Livestream-admin routes (`SystemSetting`) so they can light up without redeploy.

**Suggested build order:** scaffold + env/Prisma → admin auth (2-step + TOTP) + RBAC + audit middleware → gateway `/admin` proxy + IP allowlist → User Management + Dashboard (with static stubs) → Communities/Groups → Analytics/Audit/System Health → Announcements/Categories → (later) Reports queue + Livestream admin.
