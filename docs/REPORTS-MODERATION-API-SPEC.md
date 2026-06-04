# Reports & Moderation — API & Schema Design

> Admin Panel → Reports & Moderation page. Owning service: **`backoffice-service`** (HTTP 3010 / gRPC 4010, `admin_db`).
> Status: **Phase 1 = static/mock data implementing the real contract.** Phase 2 = dynamic Postgres-backed implementation.
> Last updated: 2026-06-03.

## 0. Design principle: keep the _contract_ stable, swap the _source_

The most important decision for "mock now, dynamic later without major changes" is: **freeze the HTTP contract and the response envelope in Phase 1, and make Phase 1 a static implementation of that exact contract.** The frontend never knows whether bytes came from a JSON fixture or Postgres. Migration = replacing the service-layer data source, zero frontend changes.

Phase 1 and Phase 2 return **byte-identical response shapes**.

### Placement

Reports are _created_ inside `community-service` / `messaging-service` (where a user taps "Report"), but **moderation is a cross-cutting admin concern that belongs to `backoffice-service`** — which already has the auth/TOTP/RBAC/audit foundation. The admin API lives in `backoffice-service`, treating the report record as a _replicated/aggregated_ read model. See §7 for the sync path.

---

## 1. List Reports API

```
GET /api/v1/admin/moderation/reports
```

Served by `backoffice-service`. Requires a valid admin session + `moderation:reports:read` permission.

### Query parameters

| Param        | Type                          | Notes                                                                                 | Maps to UI         |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| `search`     | string                        | Matches `reportId` (exact/prefix), reported username/handle, reporter username/handle | Search box         |
| `reportType` | enum (repeatable)             | `?reportType=SPAM&reportType=HARASSMENT`                                              | Report Type filter |
| `status`     | enum (repeatable)             | e.g. `PENDING,UNDER_REVIEW`                                                           | Status filter      |
| `dateFrom`   | ISO 8601 date                 | inclusive, on `createdAt`                                                             | Date Range         |
| `dateTo`     | ISO 8601 date                 | inclusive                                                                             | Date Range         |
| `targetType` | enum                          | optional: `USER`/`MESSAGE`/`GROUP`/`POST`                                             | (future column)    |
| `assignedTo` | adminId / `me` / `unassigned` | optional moderator filter                                                             | (future)           |
| `sort`       | string                        | `createdAt:desc` (default), `status:asc`, `reportType:asc`                            | column sort        |
| `page`       | int ≥ 1                       | offset mode (default 1)                                                               | page jump          |
| `limit`      | int 1–100                     | default 20                                                                            | rows per page      |
| `cursor`     | opaque string                 | keyset mode (optional, takes precedence over `page`)                                  | infinite/next      |

### Pagination strategy — hybrid (recommended)

Admin tables need _page numbers + total count_ (UI shows "Page 3 of 240"). Pure keyset can't jump to page 3. But offset degrades at millions of rows (`OFFSET 100000` scans 100k rows).

- **Default mode = offset** (`page`/`limit`) for the UI — admins want page jumps and totals. Fine because moderation queues are filtered (status=PENDING) and rarely exceed a few thousand _open_ rows.
- **Keyset (`cursor`) opt-in** for deep/unbounded scans and exports — encodes `(createdAt, reportId)`.
- For totals at scale return **`totalApprox`** (from `pg_class.reltuples`/filtered estimate); only compute exact `total` when result set is small (< 10k). Envelope carries both.

### Sorting strategy

Whitelisted sort columns only: `createdAt`, `status`, `reportType`, `priority`, `updatedAt`. Format `field:dir`. Default `createdAt:desc`. **Always append `reportId` as a tiebreaker** so keyset pagination is stable. Reject non-whitelisted fields with `400`.

### Filtering strategy

- Multi-value enums (`status`, `reportType`) → `IN (...)`.
- `search` is the only fuzzy field; backed by trigram index (Postgres `pg_trgm`) on denormalized `reportedUsername`/`reporterUsername`, plus exact match on `reportId`. At true scale route `search` to Elasticsearch — same contract.
- All filters are **AND**-combined; `status`/`reportType` are **OR** within themselves.
- Validate all filters against enums (zod) before hitting the data layer.

### Response envelope (shared by all list endpoints)

```jsonc
{
  "data": [
    /* ReportListItem[] */
  ],
  "pagination": {
    "mode": "offset",
    "page": 1,
    "limit": 20,
    "total": 1284, // exact when cheap, else null
    "totalApprox": 1284, // always present
    "totalPages": 65,
    "hasNext": true,
    "hasPrev": false,
    "nextCursor": "eyJjcmVhdGVkQXQiOiIyMD...", // for opt-in keyset
  },
  "meta": {
    "requestId": "req_01HZX...",
    "generatedAt": "2026-06-03T10:00:00Z",
  },
}
```

### `ReportListItem` (exactly the table columns)

```jsonc
{
  "reportId": "RPT-2026-0001284",
  "reportedUser": {
    "id": "u_8f3",
    "username": "john_doe",
    "displayName": "John Doe",
    "avatarUrl": "https://cdn.aimess.app/...",
    "accountStatus": "ACTIVE",
  },
  "reporterUser": {
    "id": "u_2a1",
    "username": "jane_r",
    "displayName": "Jane R",
    "avatarUrl": null,
  },
  "reportType": "HARASSMENT",
  "targetType": "MESSAGE",
  "status": "PENDING",
  "priority": "HIGH",
  "createdAt": "2026-06-01T14:32:00Z",
  "resolvedAt": null,
  "moderator": null, // { id, name } once actioned
}
```

### Full example

**Request**

```
GET /api/v1/admin/moderation/reports?status=PENDING&status=UNDER_REVIEW&reportType=HARASSMENT&dateFrom=2026-05-01&dateTo=2026-06-03&search=john&sort=createdAt:desc&page=1&limit=20
Authorization: Bearer <admin_jwt>
```

**Response `200`**

```jsonc
{
  "data": [
    {
      "reportId": "RPT-2026-0001284",
      "reportedUser": {
        "id": "u_8f3",
        "username": "john_doe",
        "displayName": "John Doe",
        "avatarUrl": "https://cdn.aimess.app/av/8f3.jpg",
        "accountStatus": "ACTIVE",
      },
      "reporterUser": {
        "id": "u_2a1",
        "username": "jane_r",
        "displayName": "Jane R",
        "avatarUrl": null,
      },
      "reportType": "HARASSMENT",
      "targetType": "MESSAGE",
      "status": "PENDING",
      "priority": "HIGH",
      "createdAt": "2026-06-01T14:32:00Z",
      "resolvedAt": null,
      "moderator": null,
    },
    {
      "reportId": "RPT-2026-0001280",
      "reportedUser": {
        "id": "u_91a",
        "username": "spam_bot_7",
        "displayName": "Free Crypto",
        "avatarUrl": null,
        "accountStatus": "SUSPENDED",
      },
      "reporterUser": {
        "id": "u_55c",
        "username": "mike_t",
        "displayName": "Mike T",
        "avatarUrl": "https://cdn.aimess.app/av/55c.jpg",
      },
      "reportType": "SPAM",
      "targetType": "USER",
      "status": "UNDER_REVIEW",
      "priority": "MEDIUM",
      "createdAt": "2026-06-01T09:10:00Z",
      "resolvedAt": null,
      "moderator": { "id": "adm_3", "name": "Sara Admin" },
    },
  ],
  "pagination": {
    "mode": "offset",
    "page": 1,
    "limit": 20,
    "total": 2,
    "totalApprox": 2,
    "totalPages": 1,
    "hasNext": false,
    "hasPrev": false,
    "nextCursor": null,
  },
  "meta": {
    "requestId": "req_01HZXABC",
    "generatedAt": "2026-06-03T10:00:00Z",
  },
}
```

---

## 2. Report Details API

```
GET /api/v1/admin/moderation/reports/{reportId}
```

Permission: `moderation:reports:read`.

```jsonc
{
  "data": {
    "reportId": "RPT-2026-0001284",
    "reportType": "HARASSMENT",
    "targetType": "MESSAGE",
    "status": "PENDING",
    "priority": "HIGH",
    "reason": "Sending threatening messages repeatedly",
    "reporterNote": "He keeps messaging me after I blocked him.",
    "sourceService": "messaging-service",
    "createdAt": "2026-06-01T14:32:00Z",
    "updatedAt": "2026-06-01T14:32:00Z",
    "resolvedAt": null,
    "slaDueAt": "2026-06-02T14:32:00Z",

    "reportedUser": {
      "id": "u_8f3",
      "username": "john_doe",
      "displayName": "John Doe",
      "avatarUrl": "https://cdn.aimess.app/av/8f3.jpg",
      "accountStatus": "ACTIVE",
      "joinedAt": "2025-02-11T00:00:00Z",
      "priorReportsCount": 4,
      "priorActionsCount": 1,
    },
    "reporterUser": {
      "id": "u_2a1",
      "username": "jane_r",
      "displayName": "Jane R",
      "avatarUrl": null,
      "accountStatus": "ACTIVE",
      "reportsFiledCount": 2,
      "falseReportRate": 0.0,
    },

    "target": {
      "type": "MESSAGE",
      "id": "msg_77c",
      "conversationId": "conv_12",
      "snapshot": {
        "text": "You better watch yourself.",
        "sentAt": "2026-06-01T14:30:00Z",
        "deleted": false,
      },
      "deepLink": "/admin/messaging/conversations/conv_12?focus=msg_77c",
    },

    "evidence": [
      {
        "id": "ev_1",
        "type": "MESSAGE_SNAPSHOT",
        "capturedAt": "2026-06-01T14:32:00Z",
        "content": {
          "text": "You better watch yourself.",
          "messageId": "msg_77c",
        },
      },
      {
        "id": "ev_2",
        "type": "ATTACHMENT",
        "mimeType": "image/jpeg",
        "url": "https://cdn.aimess.app/evidence/ev_2.jpg",
        "thumbnailUrl": "https://cdn.aimess.app/evidence/ev_2_thumb.jpg",
        "sizeBytes": 84213,
      },
    ],

    "history": [
      {
        "id": "h_1",
        "action": "CREATED",
        "actorType": "USER",
        "actorId": "u_2a1",
        "actorName": "Jane R",
        "at": "2026-06-01T14:32:00Z",
        "note": null,
      },
      {
        "id": "h_2",
        "action": "ASSIGNED",
        "actorType": "ADMIN",
        "actorId": "adm_3",
        "actorName": "Sara Admin",
        "at": "2026-06-01T15:00:00Z",
        "note": "Picked up from queue",
      },
    ],

    "relatedReports": [
      {
        "reportId": "RPT-2026-0001102",
        "reportType": "HARASSMENT",
        "status": "RESOLVED",
        "createdAt": "2026-05-20T00:00:00Z",
      },
    ],

    "availableActions": ["RESOLVE", "DISMISS", "ESCALATE", "ASSIGN"],
  },
  "meta": {
    "requestId": "req_01HZY...",
    "generatedAt": "2026-06-03T10:00:00Z",
  },
}
```

Key points the "View Report Details" needs:

- **Related users** — full reported + reporter profiles with moderation signals (`priorReportsCount`, `falseReportRate`).
- **Evidence/attachments** — typed array; media served via **signed short-TTL URLs**, never public CDN links. CSAM/illegal content gets `restricted: true` and is access-logged separately.
- **Report history** — full timeline (created → assigned → actioned), feeding the audit trail.
- **`availableActions`** — server tells the UI which buttons to enable based on status + RBAC. UI never hardcodes this.

---

## 3. Resolve Report API

```
POST /api/v1/admin/moderation/reports/{reportId}/resolve
```

Permission: `moderation:reports:resolve`. **Idempotent** via `Idempotency-Key` header.

**Request**

```jsonc
{
  "resolution": "ACTION_TAKEN", // ACTION_TAKEN | WARNING_ISSUED | CONTENT_REMOVED
  "actionOnReportedUser": "SUSPEND_7D", // NONE | WARN | CONTENT_REMOVE | MUTE | SUSPEND_7D | SUSPEND_30D | BAN
  "note": "Confirmed harassment across 3 messages. 7-day suspension.",
  "notifyReporter": true,
  "notifyReportedUser": true,
}
```

**Response `200`**

```jsonc
{
  "data": {
    "reportId": "RPT-2026-0001284",
    "status": "RESOLVED",
    "resolution": "ACTION_TAKEN",
    "resolvedAt": "2026-06-03T10:05:00Z",
    "moderator": { "id": "adm_3", "name": "Sara Admin" },
    "appliedActions": [
      {
        "type": "SUSPEND_7D",
        "targetUserId": "u_8f3",
        "effectiveUntil": "2026-06-10T10:05:00Z",
      },
    ],
  },
  "meta": {
    "requestId": "req_01HZZ...",
    "generatedAt": "2026-06-03T10:05:00Z",
  },
}
```

Errors: `409 REPORT_ALREADY_RESOLVED`, `403 INSUFFICIENT_PERMISSION`, `422 INVALID_ACTION_FOR_TARGET`.

> The enforcement action (`SUSPEND_7D`, etc.) is **not** executed inside backoffice-service. backoffice emits a `moderation.action.requested` event (RabbitMQ) consumed by auth-service/user-service which owns account state. backoffice only records the _decision_. Keeps the bounded-context rule intact.

---

## 4. Dismiss Report API

```
POST /api/v1/admin/moderation/reports/{reportId}/dismiss
```

Permission: `moderation:reports:dismiss`. Idempotent.

**Request**

```jsonc
{
  "reason": "NO_VIOLATION", // NO_VIOLATION | INSUFFICIENT_EVIDENCE | DUPLICATE | FALSE_REPORT
  "note": "Messages are within community guidelines.",
  "notifyReporter": false,
  "flagFalseReport": false, // if true, increments reporter.falseReportRate signal
}
```

**Response `200`**

```jsonc
{
  "data": {
    "reportId": "RPT-2026-0001284",
    "status": "DISMISSED",
    "dismissReason": "NO_VIOLATION",
    "resolvedAt": "2026-06-03T10:06:00Z",
    "moderator": { "id": "adm_3", "name": "Sara Admin" },
  },
  "meta": {
    "requestId": "req_01I00...",
    "generatedAt": "2026-06-03T10:06:00Z",
  },
}
```

---

## 5. Bulk Actions APIs

```
POST /api/v1/admin/moderation/reports/bulk/resolve
POST /api/v1/admin/moderation/reports/bulk/dismiss
```

Permission: `moderation:reports:resolve` / `:dismiss`. Cap at **100 IDs** per call. Idempotent.

**Request (bulk resolve)**

```jsonc
{
  "reportIds": ["RPT-2026-0001284", "RPT-2026-0001280", "RPT-2026-0001277"],
  "resolution": "CONTENT_REMOVED",
  "actionOnReportedUser": "WARN",
  "note": "Batch spam cleanup",
  "notifyReporter": false,
}
```

**Response `207 Multi-Status`** (partial success is the norm in bulk ops):

```jsonc
{
  "data": {
    "requested": 3,
    "succeeded": 2,
    "failed": 1,
    "results": [
      { "reportId": "RPT-2026-0001284", "status": "RESOLVED", "ok": true },
      { "reportId": "RPT-2026-0001280", "status": "RESOLVED", "ok": true },
      {
        "reportId": "RPT-2026-0001277",
        "ok": false,
        "error": {
          "code": "REPORT_ALREADY_RESOLVED",
          "message": "Already resolved by another moderator",
        },
      },
    ],
  },
  "meta": {
    "requestId": "req_01I01...",
    "generatedAt": "2026-06-03T10:07:00Z",
  },
}
```

For very large batches at scale, switch bulk to **async**: return `202 { jobId }`, process via Bull queue, expose `GET /bulk/jobs/{jobId}`. Same envelope, add the job indirection — design the UI to handle both from day one (if response has `jobId`, poll).

---

## 6. Database Schema (`admin_db`, PostgreSQL / Prisma)

backoffice-service owns a **moderation read+decision model**. Source content stays in community/messaging Mongo; here we store denormalized snapshots + the moderation lifecycle.

```prisma
enum ReportType { SPAM HARASSMENT HATE_SPEECH NUDITY VIOLENCE SELF_HARM
                  IMPERSONATION MISINFORMATION ILLEGAL_CONTENT CSAM TERRORISM OTHER }
enum TargetType { USER MESSAGE GROUP COMMUNITY POST COMMENT MEDIA }
enum ReportStatus { PENDING UNDER_REVIEW RESOLVED DISMISSED ESCALATED }
enum ReportPriority { LOW MEDIUM HIGH CRITICAL }
enum EvidenceType { MESSAGE_SNAPSHOT ATTACHMENT SCREENSHOT PROFILE_SNAPSHOT LINK SYSTEM_LOG }

model Report {
  id                 String        @id @default(cuid())
  publicId           String        @unique            // "RPT-2026-0001284"
  reportType         ReportType
  targetType         TargetType
  status             ReportStatus  @default(PENDING)
  priority           ReportPriority @default(MEDIUM)

  // denormalized for fast table render + search (synced from source services)
  reportedUserId     String
  reportedUsername   String
  reporterUserId     String
  reporterUsername   String

  targetEntityId     String?       // msg/post/group id in source service
  sourceService      String        // "messaging-service" | "community-service"
  reason             String
  reporterNote       String?

  assignedToAdminId  String?
  resolution         String?       // ACTION_TAKEN | WARNING_ISSUED | CONTENT_REMOVED
  dismissReason      String?
  decisionNote       String?
  moderatorAdminId   String?
  moderatorName      String?

  slaDueAt           DateTime?
  createdAt          DateTime      @default(now())     // = original user report time
  updatedAt          DateTime      @updatedAt
  resolvedAt         DateTime?

  evidence           ReportEvidence[]
  actions            ReportAction[]

  @@index([status, createdAt(sort: Desc)])              // queue view
  @@index([reportType, status])
  @@index([reportedUserId])
  @@index([assignedToAdminId, status])
  @@index([reportedUsername])                           // + pg_trgm GIN in migration
  @@index([reporterUsername])
  @@map("reports")
}

model ReportEvidence {
  id          String       @id @default(cuid())
  reportId    String
  report      Report       @relation(fields: [reportId], references: [id], onDelete: Cascade)
  type        EvidenceType
  mimeType    String?
  storageKey  String?      // MinIO object key (sign on read; never store public URL)
  contentJson Json?        // text snapshots, profile snapshots
  restricted  Boolean      @default(false)   // CSAM/illegal — extra access control
  capturedAt  DateTime     @default(now())
  @@index([reportId])
  @@map("report_evidence")
}

// Immutable audit log — every state change + who/what/when
model ReportAction {
  id          String   @id @default(cuid())
  reportId    String
  report      Report   @relation(fields: [reportId], references: [id], onDelete: Cascade)
  action      String   // CREATED ASSIGNED STATUS_CHANGED RESOLVED DISMISSED ESCALATED NOTE_ADDED EVIDENCE_VIEWED
  actorType   String   // USER | ADMIN | SYSTEM
  actorId     String?
  actorName   String?
  fromStatus  ReportStatus?
  toStatus    ReportStatus?
  metadata    Json?    // resolution, action applied, idempotencyKey, requestId, ip
  createdAt   DateTime @default(now())
  @@index([reportId, createdAt])
  @@index([actorId, createdAt])
  @@map("report_actions")
}
```

Notes:

- `ReportAction` is **append-only** — it _is_ the audit trail. Serves both UI history and compliance.
- Denormalized usernames make the table render and `search` index-only — no cross-service join per row. A `user.renamed` event keeps them fresh (eventual consistency is fine for moderation).
- Evidence media never stored as URLs — store the MinIO `storageKey`, sign on read with short TTL, log `EVIDENCE_VIEWED` for restricted items.

---

## 7. RBAC, Audit & Scale

**RBAC** — granular permissions checked in middleware:

- `moderation:reports:read`, `:resolve`, `:dismiss`, `:assign`, `:escalate`, `:bulk`, `:evidence:restricted:view`.
- Roles (`MODERATOR`, `SENIOR_MODERATOR`, `ADMIN`) are bundles of these. CSAM/illegal evidence gated behind `:evidence:restricted:view` regardless of role.
- Reuse the existing backoffice TOTP + session + RBAC foundation; sensitive actions (BAN, restricted evidence) can require **step-up re-auth**.

**Audit logging** — every read of restricted evidence and every write goes to `ReportAction` + the global admin audit log, capturing `adminId`, `requestId`, `ip`, `userAgent`, before/after status. Idempotency keys recorded to dedupe retries.

**Scalability**

- Indexes above cover the queue (`status, createdAt`) and filter combos; partition `reports` by `createdAt` (monthly) once volume warrants.
- Route `search` to **Elasticsearch** at scale (same contract).
- Bulk + enforcement go async via **Bull**; enforcement decoupled via **RabbitMQ** to user/auth services.
- `totalApprox` avoids `COUNT(*)` on every page load.
- Ingestion: source services publish `report.created` / `report.evidence.added` to RabbitMQ → backoffice consumer upserts the read model. Reports never written synchronously cross-service.

---

## 8. Phase 1 (static/mock) — implement so Phase 2 is a drop-in

1. **Build the real routes/controllers/validators now** with the exact contract above. zod-validate every query param and body.
2. Back them with a **`MockReportRepository`** that reads a `reports.fixture.json` (50–100 varied rows covering every status/type/priority) and does filtering/sorting/pagination **in memory** — implementing the _same repository interface_ the Prisma repo will implement:
   ```ts
   interface ReportRepository {
     list(query: ListReportsQuery): Promise<Paginated<ReportListItem>>;
     getById(id: string): Promise<ReportDetail | null>;
     resolve(id: string, input, actor): Promise<ReportResult>;
     dismiss(id: string, input, actor): Promise<ReportResult>;
     bulkResolve(...) / bulkDismiss(...): Promise<BulkResult>;
   }
   ```
3. Resolve/dismiss/bulk **mutate the in-memory array** (or a JSON file) so the UI sees state changes during dev.
4. Wire the same RBAC middleware + envelope/error format as Phase 2 — only the data source is fake.

**Migration = swap `MockReportRepository` → `PrismaReportRepository` in the DI container.** Controllers, routes, validators, response shapes, and the entire frontend stay untouched.

---

## 9. UI label mapping (Phase 1)

The API returns **enum values**; the frontend maps them to the friendly labels shown in the Reports & Moderation table (decision: keep the richer enums in the contract, map in the UI — no contract churn when dynamic data lands). This table is the canonical source for both repos.

**Report Type → label**

| API enum          | UI label              |
| ----------------- | --------------------- |
| `SPAM`            | Spam Messages         |
| `HARASSMENT`      | Harassment            |
| `HATE_SPEECH`     | Offensive Language    |
| `NUDITY`          | Nudity                |
| `VIOLENCE`        | Violence              |
| `SELF_HARM`       | Self-Harm             |
| `IMPERSONATION`   | Impersonation         |
| `MISINFORMATION`  | Misinformation        |
| `ILLEGAL_CONTENT` | Inappropriate Content |
| `CSAM`            | Child Safety          |
| `TERRORISM`       | Terrorism             |
| `OTHER`           | Other                 |

**Status → label / badge**

| API enum       | UI label     | Badge       |
| -------------- | ------------ | ----------- |
| `PENDING`      | Open         | green check |
| `UNDER_REVIEW` | Under Review | amber       |
| `RESOLVED`     | Resolved     | red check   |
| `DISMISSED`    | Dismissed    | grey ✕      |
| `ESCALATED`    | Escalated    | red ▲       |

**Table rendering notes**

- The **"No."** column is a 1-based row serial the UI derives from `(page-1)*limit + index`; the stable key remains `reportId` (not shown as a column, used for actions/detail links).
- **Actions** are driven by `availableActions[]` on each row: render **View** always, **Dismiss**/**Resolve** only when present (open/actionable rows). Resolved/Dismissed rows carry `["VIEW"]` only.
- The mockup uses **page size 10**, so the frontend requests `?limit=10` (API default is 20). With the 20-row Phase-1 fixture this yields the "Showing 1-10 of 20 results" pager.
- **Created Date** displays as e.g. "2 Feb, 2026"; the API field `createdAt` is ISO-8601 UTC — format client-side.

## Final recommendation

- **Adopt the shared envelope (`data` / `pagination` / `meta`) and the `ReportRepository` interface now.** Implement Phase 1 as a real, validated API backed by a JSON fixture — not mock data baked into the controller.
- **Pagination: offset-by-default with `totalApprox`, keyset opt-in via `cursor`.** Offset gives admins page jumps and counts; keyset is there for deep scans/exports without a contract change.
- **Keep moderation in `backoffice-service` as a read+decision model**, fed by events from community/messaging, with enforcement delegated back to auth/user services. Respects one-bounded-context-per-service.
- **Trade-offs:** denormalizing usernames costs eventual-consistency (stale name until event lands) but buys index-only table rendering and search. Async bulk/enforcement adds a polling path; design the client to handle both `200` and `202 {jobId}` from day one.
