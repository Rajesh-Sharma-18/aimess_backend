import { z } from "zod";

/**
 * Zod schemas + inferred types for the Community Management admin API.
 * Contract: docs/COMMUNITY-MANAGEMENT-API-SPEC.md.
 */

// ---------------------------------------------------------------------------
// Enums (reused across schemas).
// ---------------------------------------------------------------------------
export const communityTypeEnum = z.enum(["PUBLIC", "PRIVATE"]);

export const communityStatusEnum = z.enum(["ACTIVE", "CLOSED"]);

export const closeReasonEnum = z.enum([
  "GUIDELINES_VIOLATION",
  "SPAM",
  "ILLEGAL_CONTENT",
  "INACTIVE",
  "ADMIN_ACTION",
]);

/**
 * Whitelisted canonical sort fields + direction (always tiebroken on
 * communityId in the community-service repo). `categoryName` is the denormalized,
 * indexed Community column the repo orders on for category sorting (Prisma's
 * MongoDB connector can't `orderBy` the related category collection). `name` and
 * `livestreamCount` remain accepted for backward compatibility with old callers.
 */
const SORT_FIELDS = [
  "createdAt",
  "name",
  "memberCount",
  "categoryName",
  "livestreamCount",
] as const;
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")}):(asc|desc)$`);

// ---------------------------------------------------------------------------
// UI sort controls (sortBy / sortOrder).
// ---------------------------------------------------------------------------
/**
 * The admin panel's sortable column headers send `sortBy` + `sortOrder` (one
 * value each). We normalize that pair onto the canonical `<field>:<dir>` token
 * the repository already consumes, so nothing downstream changes.
 *
 *   sortBy=category    -> categoryName  (denormalized, indexed Community column)
 *   sortBy=members     -> memberCount   (denormalized counter on Community)
 *   sortBy=createdDate -> createdAt
 *
 * The legacy `sort` param still works and is used as a fallback when `sortBy` is
 * absent (older callers + saved links). Default: createdDate / desc.
 */
// `satisfies` pins every mapped value to a member of the repository's sort
// whitelist (SORT_FIELDS). If the repo whitelist ever drops/renames a field,
// this fails to compile here instead of drifting silently at runtime.
const SORT_BY_TO_FIELD = {
  category: "categoryName",
  members: "memberCount",
  createdDate: "createdAt",
} as const satisfies Record<string, (typeof SORT_FIELDS)[number]>;
type SortByKey = keyof typeof SORT_BY_TO_FIELD;

/** Reverse map (canonical field -> UI sortBy) for the audit log / echo. */
const FIELD_TO_SORT_BY: Record<string, string> = {
  categoryName: "category",
  memberCount: "members",
  createdAt: "createdDate",
  name: "name",
  livestreamCount: "livestreamCount",
};

/**
 * Case-insensitive `sortBy` aliases. The panel sends `category`/`members`/
 * `createdDate`, but we also tolerate the canonical column names + common
 * casings so a stray `categoryName` / `memberCount` / `createdAt` value does not
 * 400 the whole request (same tolerance philosophy as the users list).
 */
const SORT_BY_ALIASES: Record<string, SortByKey> = {
  category: "category",
  categoryname: "category",
  members: "members",
  membercount: "members",
  member: "members",
  createddate: "createdDate",
  createdat: "createdDate",
  created: "createdDate",
};

const sortByKeyEnum = z.enum(["category", "members", "createdDate"]);
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
export const listCommunitiesQuerySchema = z
  .object({
    search: z.string().trim().min(1).optional(),
    type: communityTypeEnum.optional(),
    // Accepts a category slug OR id (resolved in the repo).
    category: z.string().trim().min(1).optional(),
    status: communityStatusEnum.optional(),
    // `sortBy` / `sortOrder` are the admin panel's column-sort controls and take
    // precedence over the legacy `sort` token (kept for old callers).
    sortBy: sortByFilter,
    sortOrder: sortOrderFilter,
    sort: z
      .string()
      .regex(SORT_PATTERN, "sort must be <field>:<asc|desc> from the whitelist")
      .default("createdAt:desc"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    createdFrom: z.iso.date().optional(),
    createdTo: z.iso.date().optional(),
  })
  // Normalize the UI pair onto the canonical `sort` token the service/repository
  // consume, so downstream code is unchanged. Sort precedence: the new
  // `sortBy`/`sortOrder` UI pair wins; else the legacy `sort`; else the default
  // `createdAt:desc` (== createdDate / desc). We also echo the resolved UI pair
  // (`sortBy`/`sortOrder`) for the list-view audit log.
  .transform(({ sortBy, sortOrder, ...rest }) => {
    let field: string;
    let dir: "asc" | "desc";

    if (sortBy) {
      field = SORT_BY_TO_FIELD[sortBy];
      // sortOrder wins, then the dir baked into the legacy `sort` token.
      dir = sortOrder ?? (rest.sort.split(":")[1] as "asc" | "desc");
    } else {
      const [f, d] = rest.sort.split(":") as [string, "asc" | "desc"];
      field = f;
      dir = sortOrder ?? d;
    }

    return {
      ...rest,
      sort: `${field}:${dir}`,
      // UI-facing pair, resolved — consumed only by the audit log (repos read `sort`).
      sortBy: FIELD_TO_SORT_BY[field] ?? field,
      sortOrder: dir,
    };
  });
export type ListCommunitiesQueryInput = z.infer<
  typeof listCommunitiesQuerySchema
>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const communityIdParamSchema = z.object({
  // Lenient: real ids look like comm_001 but we don't hard-fail on shape.
  communityId: z.string().trim().min(1).max(64),
});
export type CommunityIdParam = z.infer<typeof communityIdParamSchema>;

// ---------------------------------------------------------------------------
// Community Member List query (the "Community User List" grid).
// ---------------------------------------------------------------------------
export const communityMemberRoleEnum = z.enum(["ADMIN", "MODERATOR", "MEMBER"]);

/**
 * `q` is the UI search box alias (mirrors the users list); it maps to `search`.
 * Pass either `q` or `search` — `q` wins when both are present.
 */
export const listCommunityMembersQuerySchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    search: z.string().trim().min(1).optional(),
    role: communityMemberRoleEnum.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform(({ q, ...rest }) => ({ ...rest, search: q ?? rest.search }));
export type ListCommunityMembersQueryInput = z.infer<
  typeof listCommunityMembersQuerySchema
>;

// ---------------------------------------------------------------------------
// Close.
// ---------------------------------------------------------------------------
export const closeCommunitySchema = z.object({
  reasonCode: closeReasonEnum,
  reasonNote: z.string().max(2000).optional(),
  notifyOwner: z.boolean().default(true),
});
export type CloseCommunityInput = z.infer<typeof closeCommunitySchema>;

// ---------------------------------------------------------------------------
// Reopen.
// ---------------------------------------------------------------------------
export const reopenCommunitySchema = z.object({
  reasonNote: z.string().max(2000).optional(),
  notifyOwner: z.boolean().default(true),
});
export type ReopenCommunityInput = z.infer<typeof reopenCommunitySchema>;

// ---------------------------------------------------------------------------
// Bulk.
// ---------------------------------------------------------------------------
const communityIdsField = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(100);

export const bulkCloseSchema = closeCommunitySchema.extend({
  communityIds: communityIdsField,
});
export type BulkCloseInput = z.infer<typeof bulkCloseSchema>;

export const bulkReopenSchema = reopenCommunitySchema.extend({
  communityIds: communityIdsField,
});
export type BulkReopenInput = z.infer<typeof bulkReopenSchema>;
