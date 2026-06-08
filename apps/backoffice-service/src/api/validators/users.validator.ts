import { z } from "zod";

/**
 * Zod schemas + inferred types for the Admin User Management API.
 *
 * Repeatable query enums (`status`): Express 5 yields a single string when the
 * param appears once and a string[] when repeated. We accept both and normalize
 * to an array — same pattern as moderation.validator.ts.
 */

// ---------------------------------------------------------------------------
// Enums.
// ---------------------------------------------------------------------------
/**
 * Filterable user statuses surfaced by the admin panel's "Select Status"
 * dropdown. The platform's internal account model also has a SUSPENDED state
 * (produced by the ban-with-duration / suspend flows), but it is intentionally
 * NOT a list filter option — the panel exposes only these three.
 */
export const userStatusEnum = z.enum(["ACTIVE", "BANNED", "DELETED"]);

/**
 * Tolerant status filter. The admin panel's "Select Status" dropdown sends the
 * value with inconsistent casing (`active` vs `ACTIVE`) and uses
 * `pending_deletion` for the deleted bucket. Normalize case + that alias before
 * the enum check, and accept a single value or a repeated `?status=A&status=B`
 * list → always a string[]. Without this, a lowercase value 400s the whole
 * request and the list comes back empty, which reads as "the filter is broken".
 */
const STATUS_ALIASES: Record<string, z.infer<typeof userStatusEnum>> = {
  ACTIVE: "ACTIVE",
  BANNED: "BANNED",
  DELETED: "DELETED",
  PENDING_DELETION: "DELETED",
};

const userStatusFilter = z
  .preprocess((v) => {
    if (v == null) return undefined;
    const arr = Array.isArray(v) ? v : [v];
    return arr.map((s) => {
      if (typeof s !== "string") return s;
      const norm = s.trim().toUpperCase();
      return STATUS_ALIASES[norm] ?? norm;
    });
  }, z.array(userStatusEnum).optional())
  .optional();

/**
 * A calendar day accepted as `YYYY-MM-DD` OR a full ISO datetime (the date
 * picker may emit either), normalized to `YYYY-MM-DD` since the repository
 * builds the day-boundary range from it (`${date}T00:00:00.000Z`).
 */
const dateOnly = z
  .string()
  .trim()
  .transform((s, ctx) => {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
    const day = m?.[1];
    if (!day || Number.isNaN(new Date(`${day}T00:00:00.000Z`).getTime())) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid date (expected YYYY-MM-DD or an ISO datetime)",
      });
      return z.NEVER;
    }
    return day;
  })
  .optional();

/** Moderation reason vocabulary — subset of the report reportType values. */
export const moderationReasonEnum = z.enum([
  "SPAM",
  "HARASSMENT",
  "HATE_SPEECH",
  "NUDITY",
  "VIOLENCE",
  "IMPERSONATION",
  "MISINFORMATION",
  "ILLEGAL_CONTENT",
  "OTHER",
]);

export const reportsBucketEnum = z.enum(["none", "has", "gte_5", "gte_10"]);

/** Whitelisted sort fields + direction (always tiebroken on userId in repo). */
const SORT_FIELDS = [
  "joinedAt",
  "username",
  "email",
  "status",
  "reportCount",
] as const;
// The direction is OPTIONAL: accept a bare field (`username`) as well as the
// full token (`username:desc`). A bare field takes its direction from `order`
// (or defaults to desc), so `?sort=username&order=desc` — what the Swagger
// "Try it out" form emits — no longer 400s.
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")})(:(asc|desc))?$`);

// ---------------------------------------------------------------------------
// UI sort controls (sortBy / sortOrder).
// ---------------------------------------------------------------------------
/**
 * The admin panel's sortable column headers send `sortBy` + `sortOrder` (one
 * value each). We normalize that pair onto the canonical `<field>:<dir>` token
 * the repository already consumes, so nothing downstream changes.
 *
 *   sortBy=username   -> username
 *   sortBy=email      -> email
 *   sortBy=joinedDate -> joinedAt   (DB column on UserIndex)
 *   sortBy=reports    -> reportCount
 *
 * The legacy `sort` / `order` params still work and are used as a fallback when
 * `sortBy` is absent (older callers + saved links).
 */
// `satisfies` pins every mapped value to a member of the repository's sort
// whitelist (SORT_FIELDS). If the repo whitelist ever drops/renames a field,
// this fails to compile here instead of drifting silently at runtime.
const SORT_BY_TO_FIELD = {
  username: "username",
  email: "email",
  joinedDate: "joinedAt",
  reports: "reportCount",
} as const satisfies Record<string, (typeof SORT_FIELDS)[number]>;
type SortByKey = keyof typeof SORT_BY_TO_FIELD;

/** Reverse map (canonical field -> UI sortBy) for the audit log / echo. */
const FIELD_TO_SORT_BY: Record<string, string> = {
  username: "username",
  email: "email",
  joinedAt: "joinedDate",
  reportCount: "reports",
  status: "status",
};

/**
 * Case-insensitive `sortBy` aliases. The panel sends `joinedDate`/`reports`,
 * but we also tolerate the canonical column names + common casings so a stray
 * `joinedAt` / `reportCount` / uppercase value does not 400 the whole request
 * (same tolerance philosophy as the status filter above).
 */
const SORT_BY_ALIASES: Record<string, SortByKey> = {
  username: "username",
  email: "email",
  joineddate: "joinedDate",
  joinedat: "joinedDate",
  joined: "joinedDate",
  reports: "reports",
  reportcount: "reports",
};

const sortByKeyEnum = z.enum(["username", "email", "joinedDate", "reports"]);
const sortOrderEnum = z.enum(["asc", "desc"]);

const sortByFilter = z
  .preprocess((v) => {
    if (v == null) return undefined;
    if (typeof v !== "string") return v;
    const norm = v.trim().toLowerCase();
    return SORT_BY_ALIASES[norm] ?? norm;
  }, sortByKeyEnum.optional())
  .optional();

const sortOrderFilter = z
  .preprocess((v) => {
    if (v == null) return undefined;
    if (typeof v !== "string") return v;
    return v.trim().toLowerCase();
  }, sortOrderEnum.optional())
  .optional();

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listUsersQuerySchema = z
  .object({
    // `q` is the public search param (case-insensitive partial match over
    // username + email). `search` is kept as a backward-compatible alias.
    q: z.string().trim().min(1).optional(),
    search: z.string().trim().min(1).optional(),
    status: userStatusFilter,
    reports: reportsBucketEnum.optional(),
    dateFrom: dateOnly,
    dateTo: dateOnly,
    // `createdAfter` / `createdBefore` are accepted as aliases for the date
    // range (the OpenAPI contract + some panel builds use these names).
    createdAfter: dateOnly,
    createdBefore: dateOnly,
    // `sortBy` / `sortOrder` are the admin panel's column-sort controls and take
    // precedence over the legacy `sort` / `order` pair (kept for old callers).
    sortBy: sortByFilter,
    sortOrder: sortOrderFilter,
    sort: z
      .string()
      .regex(SORT_PATTERN, "sort must be <field>:<asc|desc> from the whitelist")
      .default("joinedAt:desc"),
    // `order` is a direction-only alias that overrides the sort direction
    // (e.g. `?sort=username:asc&order=desc` → username:desc).
    order: z.enum(["asc", "desc"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().trim().min(1).optional(),
  })
  // Normalize the public params onto the canonical fields the service/repository
  // consume (`search`, `sort`, `dateFrom`/`dateTo`) so downstream code is
  // unchanged. Sort precedence: the new `sortBy`/`sortOrder` UI pair wins; else
  // the legacy `sort`/`order`; else the default `joinedAt:desc`. We also echo
  // the resolved UI pair (`sortBy`/`sortOrder`) for the list-view audit log.
  .transform(
    ({ q, order, createdAfter, createdBefore, sortBy, sortOrder, ...rest }) => {
      let field: string;
      let dir: "asc" | "desc";

      if (sortBy) {
        field = SORT_BY_TO_FIELD[sortBy];
        // sortOrder wins, then legacy `order`, then the dir baked into `sort`,
        // then desc — so a bare `sort` (no `:dir`) never yields `field:undefined`.
        dir =
          sortOrder ??
          order ??
          (rest.sort.split(":")[1] as "asc" | "desc" | undefined) ??
          "desc";
      } else {
        // `sort` may be `<field>` or `<field>:<dir>`. For a bare field, take the
        // direction from `order`, else default desc.
        const [f, d] = rest.sort.split(":") as [
          string,
          "asc" | "desc" | undefined,
        ];
        field = f;
        dir = order ?? d ?? "desc";
      }

      return {
        ...rest,
        search: q ?? rest.search,
        dateFrom: rest.dateFrom ?? createdAfter,
        dateTo: rest.dateTo ?? createdBefore,
        sort: `${field}:${dir}`,
        // UI-facing pair, resolved — consumed only by the audit log (repos read `sort`).
        sortBy: FIELD_TO_SORT_BY[field] ?? field,
        sortOrder: dir,
      };
    }
  );
export type ListUsersQueryInput = z.infer<typeof listUsersQuerySchema>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const userIdParamSchema = z.object({
  userId: z.string().trim().min(1).max(64),
});
export type UserIdParam = z.infer<typeof userIdParamSchema>;

// ---------------------------------------------------------------------------
// Reported-details list query (GET /users/:userId/reports).
// ---------------------------------------------------------------------------
export const userReportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type UserReportsQueryInput = z.infer<typeof userReportsQuerySchema>;

// ---------------------------------------------------------------------------
// Ban.
// ---------------------------------------------------------------------------
export const banUserSchema = z.object({
  reason: moderationReasonEnum,
  note: z.string().max(2000).optional(),
  // durationDays>0 turns a "ban" into a time-boxed suspend (see service docs).
  durationDays: z.number().int().positive().nullable().default(null),
  reportId: z.string().uuid().optional(),
  notifyUser: z.boolean().default(false),
  forceLogout: z.boolean().default(true),
});
export type BanUserInput = z.infer<typeof banUserSchema>;

// ---------------------------------------------------------------------------
// Suspend.
// ---------------------------------------------------------------------------
export const suspendUserSchema = z.object({
  reason: moderationReasonEnum,
  durationDays: z.number().int().positive(),
  note: z.string().max(2000).optional(),
  notifyUser: z.boolean().default(false),
});
export type SuspendUserInput = z.infer<typeof suspendUserSchema>;

// ---------------------------------------------------------------------------
// Unban.
// ---------------------------------------------------------------------------
export const unbanUserSchema = z.object({
  note: z.string().max(2000).optional(),
});
export type UnbanUserInput = z.infer<typeof unbanUserSchema>;

// ---------------------------------------------------------------------------
// Bulk.
// ---------------------------------------------------------------------------
const userIdsField = z.array(z.string().trim().min(1).max(64)).min(1).max(100);

export const bulkBanSchema = banUserSchema.extend({
  userIds: userIdsField,
});
export type BulkBanInput = z.infer<typeof bulkBanSchema>;

export const bulkActivateSchema = z.object({
  userIds: userIdsField,
  note: z.string().max(2000).optional(),
});
export type BulkActivateInput = z.infer<typeof bulkActivateSchema>;

// ===========================================================================
// User → Communities grid (GET /users/:userId/communities).
// ===========================================================================
/**
 * Whitelisted canonical sort fields the community-service contract consumes for
 * the user's communities grid (the user→communities reverse lookup).
 */
type UserCommunitiesSortField = "name" | "memberCount" | "createdAt";

/**
 * UI `sortBy` → canonical community-service `sortField`. Mirrors the
 * communities-list validator. `satisfies` pins each mapped value to a member of
 * the contract whitelist so a drift fails to compile here.
 *
 *   sortBy=name        -> name
 *   sortBy=members     -> memberCount
 *   sortBy=createdDate -> createdAt   (default)
 */
const USER_COMMUNITIES_SORT_BY_TO_FIELD = {
  name: "name",
  members: "memberCount",
  createdDate: "createdAt",
} as const satisfies Record<string, UserCommunitiesSortField>;
type UserCommunitiesSortByKey = keyof typeof USER_COMMUNITIES_SORT_BY_TO_FIELD;

/** Case-insensitive `sortBy` aliases (tolerate canonical names + casings). */
const USER_COMMUNITIES_SORT_BY_ALIASES: Record<
  string,
  UserCommunitiesSortByKey
> = {
  name: "name",
  members: "members",
  membercount: "members",
  member: "members",
  createddate: "createdDate",
  createdat: "createdDate",
  created: "createdDate",
};

const userCommunitiesSortByEnum = z.enum(["name", "members", "createdDate"]);

const userCommunitiesSortByFilter = z
  .preprocess((v) => {
    if (v == null) return undefined;
    if (typeof v !== "string") return v;
    const norm = v.trim().toLowerCase();
    return USER_COMMUNITIES_SORT_BY_ALIASES[norm] ?? norm;
  }, userCommunitiesSortByEnum.optional())
  .optional();

const userCommunitiesSortOrderFilter = z
  .preprocess((v) => {
    if (v == null) return undefined;
    if (typeof v !== "string") return v;
    return v.trim().toLowerCase();
  }, sortOrderEnum.optional())
  .optional();

/**
 * `q`/`search` (community name OR exact communityId), page/limit, and the
 * UI sort pair (`sortBy`/`sortOrder`) normalized onto the canonical
 * `sortField`/`sortDir` the community-service contract consumes. Default
 * createdDate/desc — same style as the communities list. `q` wins over `search`.
 */
export const listUserCommunitiesQuerySchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    search: z.string().trim().min(1).optional(),
    sortBy: userCommunitiesSortByFilter,
    sortOrder: userCommunitiesSortOrderFilter,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform(({ q, sortBy, sortOrder, ...rest }) => {
    const sortField = sortBy
      ? USER_COMMUNITIES_SORT_BY_TO_FIELD[sortBy]
      : "createdAt";
    const sortDir = sortOrder ?? "desc";
    return {
      ...rest,
      search: q ?? rest.search,
      sortField,
      sortDir,
    };
  });
export type ListUserCommunitiesQueryInput = z.infer<
  typeof listUserCommunitiesQuerySchema
>;

// ===========================================================================
// Co-member grid (GET /users/:userId/communities/:communityId/members).
// ===========================================================================
/**
 * Combined path params for the co-member grid. Reuses the userId shape +
 * the communityId shape (mirrors communityIdParamSchema) so the route can
 * narrow both at once.
 */
export const userCommunityMembersParamSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  communityId: z.string().trim().min(1).max(64),
});
export type UserCommunityMembersParam = z.infer<
  typeof userCommunityMembersParamSchema
>;

/**
 * Accepted member-role inputs INCLUDING OWNER. OWNER is mapped onto ADMIN in
 * the transform (community-service has no distinct OWNER role on this grid; the
 * community admin is the owner), so the panel's "Owner" filter still works.
 */
const otherMemberRoleEnum = z.enum(["ADMIN", "MODERATOR", "MEMBER", "OWNER"]);

const OTHER_MEMBERS_SORT_BY_TO_FIELD = {
  username: "username",
  joinedDate: "joinedAt",
} as const satisfies Record<string, "username" | "joinedAt">;
type OtherMembersSortByKey = keyof typeof OTHER_MEMBERS_SORT_BY_TO_FIELD;

const OTHER_MEMBERS_SORT_BY_ALIASES: Record<string, OtherMembersSortByKey> = {
  username: "username",
  joineddate: "joinedDate",
  joinedat: "joinedDate",
  joined: "joinedDate",
};

const otherMembersSortByEnum = z.enum(["username", "joinedDate"]);

const otherMembersSortByFilter = z
  .preprocess((v) => {
    if (v == null) return undefined;
    if (typeof v !== "string") return v;
    const norm = v.trim().toLowerCase();
    return OTHER_MEMBERS_SORT_BY_ALIASES[norm] ?? norm;
  }, otherMembersSortByEnum.optional())
  .optional();

const otherMembersSortOrderFilter = z
  .preprocess((v) => {
    if (v == null) return undefined;
    if (typeof v !== "string") return v;
    return v.trim().toLowerCase();
  }, sortOrderEnum.optional())
  .optional();

/**
 * `q`/`search` (username, userId, OR email — an `@` in the value flags an email
 * to be resolved to a userId upstream; surfaced as `searchIsEmail`), `role`
 * (incl OWNER→ADMIN), UI sort pair → canonical `sortField`/`sortDir`,
 * page/limit. No default sort field ("" lets community-service apply its
 * default order); `sortDir` defaults asc only when a `sortField` is chosen.
 */
export const listOtherMembersQuerySchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    search: z.string().trim().min(1).optional(),
    role: otherMemberRoleEnum.optional(),
    sortBy: otherMembersSortByFilter,
    sortOrder: otherMembersSortOrderFilter,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform(({ q, role, sortBy, sortOrder, ...rest }) => {
    const search = q ?? rest.search;
    // OWNER folds onto ADMIN (community-service treats the admin as the owner).
    const normalizedRole = role === "OWNER" ? "ADMIN" : role;
    const sortField = sortBy ? OTHER_MEMBERS_SORT_BY_TO_FIELD[sortBy] : "";
    // Direction only applies when an explicit field is chosen; "" otherwise so
    // community-service uses its default order.
    const sortDir = sortField ? (sortOrder ?? "asc") : "";
    return {
      ...rest,
      search,
      // Email detection: an `@` routes the search to email→userId resolution
      // upstream rather than a username/userId match.
      searchIsEmail: search != null && search.includes("@"),
      role: normalizedRole,
      sortField,
      sortDir,
    };
  });
export type ListOtherMembersQueryInput = z.infer<
  typeof listOtherMembersQuerySchema
>;
