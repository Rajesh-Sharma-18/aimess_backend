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

/** Whitelisted sort fields + direction (always tiebroken on communityId in repo). */
const SORT_FIELDS = [
  "createdAt",
  "name",
  "memberCount",
  "livestreamCount",
] as const;
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")}):(asc|desc)$`);

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listCommunitiesQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  type: communityTypeEnum.optional(),
  // Accepts a category slug OR id (resolved in the repo).
  category: z.string().trim().min(1).optional(),
  status: communityStatusEnum.optional(),
  sort: z
    .string()
    .regex(SORT_PATTERN, "sort must be <field>:<asc|desc> from the whitelist")
    .default("createdAt:desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
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
