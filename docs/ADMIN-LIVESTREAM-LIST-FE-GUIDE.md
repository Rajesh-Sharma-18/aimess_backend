# Admin Livestream List — Frontend Integration Guide

`GET /admin/v1/livestreams`

Enhanced list endpoint with **search, filters, sort, and pagination**. The response shape is unchanged from the previous version — only new query params were added, so existing pages keep working.

---

## 1. Endpoint

```
GET /admin/v1/livestreams
Authorization: Bearer <admin JWT>
Permission required: livestreams.read
```

---

## 2. Query Parameters (all optional)

| Param          | Type               | Example         | Notes                                                                                                                                 |
| -------------- | ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `page`         | integer ≥ 1        | `1`             | Default `1`.                                                                                                                          |
| `limit`        | integer 1–100      | `20`            | Default `20`.                                                                                                                         |
| `search`       | string             | `react`         | Case-insensitive. Matches title, community name, community handle, creator username, or creator full name.                            |
| `categoryId`   | string             | `cat_abc`       | Restrict to a single category (by id). Alias of `category` for id-only usage.                                                         |
| `status`       | enum               | `LIVE`          | `LIVE` \| `ENDED` \| `SCHEDULED` \| `CANCELLED`.                                                                                      |
| `reportStatus` | enum               | `REPORTED`      | `REPORTED` = reportCount > 0. `NOT_REPORTED` = reportCount == 0.                                                                      |
| `dateFrom`     | integer (epoch ms) | `1783600000000` | Inclusive lower bound on `createdAt`.                                                                                                 |
| `dateTo`       | integer (epoch ms) | `1784200000000` | Inclusive upper bound on `createdAt`.                                                                                                 |
| `sortBy`       | enum               | `viewerCount`   | `createdAt` \| `title` \| `viewerCount` \| `reportCount` \| `duration` \| `status` \| `category` \| `creatorName` \| `communityName`. |
| `sortOrder`    | enum               | `desc`          | `asc` \| `desc`. Default `desc`.                                                                                                      |

Legacy params still accepted (do NOT use in new code):

- `category` — accepts slug/id/name (use `categoryId` instead).
- `hasReports` (boolean) — use `reportStatus` instead.
- `minReports` (integer) — advanced tuning only.
- `sort=field:dir` — use `sortBy` + `sortOrder` instead.
- `order=asc|desc` — alias of `sortOrder`.

`reportStatus` wins over `hasReports` when both are sent. `categoryId` wins over `category` when both are sent.

---

## 3. Search Behavior

One `search` term matches any of:

| Field             | Source                                                      |
| ----------------- | ----------------------------------------------------------- |
| Livestream title  | stream-service (substring, case-insensitive)                |
| Community name    | resolved via community-service                              |
| Community handle  | resolved via community-service                              |
| Creator username  | resolved via user-service                                   |
| Creator full name | first name + last name (also matches "First Last" ordering) |

Examples:

```
?search=react           → all streams whose title/community/creator matches "react"
?search=john            → streams whose creator name/username contains "john"
?search=teach           → streams whose community handle or name contains "teach"
```

No need to hit multiple endpoints — one param covers all searchable fields.

---

## 4. Filters

### 4.1 Category

```
?categoryId=cat_gaming_01
```

Returns only livestreams whose community belongs to that category.

### 4.2 Status

```
?status=LIVE
?status=ENDED
?status=SCHEDULED   # maps to stream-service PENDING internally
?status=CANCELLED
```

### 4.3 Reports

```
?reportStatus=REPORTED       # reportCount > 0
?reportStatus=NOT_REPORTED   # reportCount == 0
```

### 4.4 Date Range (epoch milliseconds)

```
?dateFrom=1783600000000&dateTo=1784200000000
```

Filter on `createdAt`. Either bound is optional. Send `Date.now()`-style integers, not ISO strings.

```ts
const dateFrom = new Date("2026-07-01").getTime();
const dateTo = new Date("2026-07-31T23:59:59.999Z").getTime();
```

---

## 5. Sorting

```
?sortBy=viewerCount&sortOrder=desc
```

| sortBy          | Description                          |
| --------------- | ------------------------------------ |
| `createdAt`     | Default.                             |
| `title`         | Alphabetical.                        |
| `viewerCount`   | Total unique viewers.                |
| `reportCount`   | Number of comment reports.           |
| `duration`      | `durationSeconds`.                   |
| `status`        | Grouped by status.                   |
| `category`      | Category name (alphabetical).        |
| `creatorName`   | Creator display name (alphabetical). |
| `communityName` | Community name (alphabetical).       |

`sortOrder`: `asc` or `desc` (default `desc`).

---

## 6. Pagination

Offset pagination. Response includes:

```json
{
  "pagination": {
    "mode": "offset",
    "page": 1,
    "limit": 20,
    "total": 137,
    "totalPages": 7,
    "hasNext": true,
    "hasPrev": false,
    "nextCursor": null
  }
}
```

Drive your pager off `page`, `totalPages`, `hasNext`, `hasPrev`.

---

## 7. Response Shape (unchanged)

```json
{
  "success": true,
  "data": [
    {
      "livestreamId": "LS-2026-00042",
      "title": "Weekly React Deep Dive",
      "community": {
        "id": "C-101",
        "name": "Indie Devs",
        "slug": "indie_devs",
        "avatar": { "url": "https://...", "contentType": "IMAGE" }
      },
      "creator": {
        "id": "U-777",
        "username": "jdoe",
        "displayName": "Jane Doe",
        "avatar": { "url": "https://...", "contentType": "IMAGE" }
      },
      "category": { "id": "cat_tech", "name": "Tech", "slug": "tech" },
      "createdAt": 1783612345678,
      "startedAt": 1783612500000,
      "endedAt": null,
      "durationSeconds": 3245,
      "status": "LIVE",
      "viewerCount": 128,
      "reportCount": 2,
      "reportSeverity": "LOW",
      "thumbnailUrl": "https://..."
    }
  ],
  "pagination": { "...": "..." }
}
```

All media fields are pre-resolved presigned URLs — do NOT re-resolve.

---

## 8. Full Example — Combined Query

```
GET /admin/v1/livestreams
  ?page=1
  &limit=20
  &search=react
  &status=LIVE
  &categoryId=cat_tech
  &reportStatus=REPORTED
  &dateFrom=1783600000000
  &dateTo=1784200000000
  &sortBy=viewerCount
  &sortOrder=desc
```

---

## 9. TypeScript Client

```ts
export type LivestreamStatus = "LIVE" | "ENDED" | "SCHEDULED" | "CANCELLED";
export type ReportStatus = "REPORTED" | "NOT_REPORTED";
export type SortBy =
  | "createdAt"
  | "title"
  | "viewerCount"
  | "reportCount"
  | "duration"
  | "status"
  | "category"
  | "creatorName"
  | "communityName";

export interface ListLivestreamsQuery {
  page?: number;
  limit?: number;
  search?: string;
  categoryId?: string;
  status?: LivestreamStatus;
  reportStatus?: ReportStatus;
  dateFrom?: number; // epoch ms
  dateTo?: number; // epoch ms
  sortBy?: SortBy;
  sortOrder?: "asc" | "desc";
}

export async function listLivestreams(q: ListLivestreamsQuery, token: string) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const res = await fetch(`/admin/v1/livestreams?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
```

---

## 10. React Hook Example

```ts
function useLivestreams(query: ListLivestreamsQuery) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const debounced = useDebounce(query, 300); // debounce user input

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listLivestreams(debounced, getToken())
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [JSON.stringify(debounced)]);

  return { data, loading };
}
```

**Tip:** debounce `search` (~300ms). Reset `page` to `1` when any filter/search/sort changes.

---

## 11. URL / State Sync

Mirror the query object into the URL so filters survive refresh and share:

```ts
const [params, setParams] = useSearchParams();

const query: ListLivestreamsQuery = {
  page: Number(params.get("page") ?? 1),
  limit: Number(params.get("limit") ?? 20),
  search: params.get("search") ?? undefined,
  status: (params.get("status") as LivestreamStatus) ?? undefined,
  categoryId: params.get("categoryId") ?? undefined,
  reportStatus: (params.get("reportStatus") as ReportStatus) ?? undefined,
  dateFrom: params.get("dateFrom") ? Number(params.get("dateFrom")) : undefined,
  dateTo: params.get("dateTo") ? Number(params.get("dateTo")) : undefined,
  sortBy: (params.get("sortBy") as SortBy) ?? undefined,
  sortOrder: (params.get("sortOrder") as "asc" | "desc") ?? undefined,
};
```

---

## 12. Errors

| Status | When                                                          | Action                           |
| ------ | ------------------------------------------------------------- | -------------------------------- |
| `400`  | Malformed value (bad enum, negative page, sort pattern wrong) | Show inline validation error.    |
| `401`  | Missing/expired admin token                                   | Redirect to admin login.         |
| `403`  | Admin lacks `livestreams.read`                                | Show "Insufficient permissions". |
| `500`  | Backend/gRPC failure                                          | Show retry banner.               |

---

## 13. Migration Notes (from the previous version)

| Old                         | New                                 | Action                                       |
| --------------------------- | ----------------------------------- | -------------------------------------------- |
| `dateFrom=2026-07-01` (ISO) | `dateFrom=1783600000000` (epoch ms) | **Breaking.** Update callers.                |
| `hasReports=true`           | `reportStatus=REPORTED`             | Alias, `hasReports` still works.             |
| `hasReports=false`          | `reportStatus=NOT_REPORTED`         | Alias, `hasReports` still works.             |
| `category=<slug/id/name>`   | `categoryId=<id>`                   | Alias, `category` still works for slug/name. |
| `sort=viewerCount:desc`     | `sortBy=viewerCount&sortOrder=desc` | Alias, `sort` still works.                   |

Response shape is **unchanged** — no rendering code needs to change.
