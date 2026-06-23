import { z } from "zod";

import { normalizeHandle } from "../../lib/community-slug.util.js";

const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;

const nameSchema = z
  .string()
  .trim()
  .min(3, "Community name must be at least 3 characters")
  .max(50, "Community name must be at most 50 characters");

const handleSchema = z
  .string()
  .trim()
  .transform((s) => normalizeHandle(s))
  .pipe(
    z
      .string()
      .min(3, "Community handle must be at least 3 characters")
      .max(32, "Community handle must be at most 32 characters")
      .regex(
        /^[a-z0-9_]+$/,
        "Community handle may only contain lowercase letters, numbers, and underscores"
      )
  );

const descriptionSchema = z
  .string()
  .trim()
  .max(500, "Description must be at most 500 characters");

const categoryIdSchema = z
  .string()
  .trim()
  .regex(OBJECT_ID_REGEX, "Category is invalid");

const objectKeySchema = z.string().trim().min(1).max(512);

const memberIdsSchema = z
  .array(z.string().uuid("One or more member IDs are invalid"))
  .max(500, "You can select at most 500 members")
  .transform((ids) => [...new Set(ids)]);

/** Shared offset/page pagination query fields. */
const pageSchema = z.coerce.number().int().positive().default(1);
const limitSchema = z.coerce.number().int().positive().max(50).default(20);

export const createCommunitySchema = z.object({
  name: nameSchema,
  handle: handleSchema,
  type: z.enum(["PUBLIC", "PRIVATE"]),
  categoryId: categoryIdSchema,
  description: descriptionSchema.optional(),
  avatarObjectKey: objectKeySchema.optional(),
  memberIds: memberIdsSchema.default([]),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;

export const updateCommunitySchema = z
  .object({
    name: nameSchema.optional(),
    handle: handleSchema.optional(),
    type: z.enum(["PUBLIC", "PRIVATE"]).optional(),
    categoryId: categoryIdSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    avatarObjectKey: objectKeySchema.nullable().optional(),
    memberIds: memberIdsSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.handle !== undefined ||
      body.type !== undefined ||
      body.categoryId !== undefined ||
      body.description !== undefined ||
      body.avatarObjectKey !== undefined ||
      body.memberIds !== undefined,
    { message: "At least one field is required to update" }
  );

export type UpdateCommunityInput = z.infer<typeof updateCommunitySchema>;

export const communityIdParamsSchema = z.object({
  id: z.string().trim().regex(OBJECT_ID_REGEX, "Community ID is invalid"),
});

export type CommunityIdParams = z.infer<typeof communityIdParamsSchema>;

export const nameAvailableQuerySchema = z.object({
  name: nameSchema,
});

export type NameAvailableQuery = z.infer<typeof nameAvailableQuerySchema>;

export const handleAvailableQuerySchema = z.object({
  handle: handleSchema,
});

export type HandleAvailableQuery = z.infer<typeof handleAvailableQuerySchema>;

/**
 * `GET /communities/by-handle/:handle` path param. Reuses `handleSchema` so a
 * malformed handle is rejected (400 INVALID_HANDLE) before hitting the service.
 */
export const handleParamsSchema = z.object({
  handle: handleSchema,
});

export type HandleParams = z.infer<typeof handleParamsSchema>;

/** Reusable discovery search query field (`q`). */
const discoverSearchSchema = z
  .string()
  .trim()
  .min(1, "Search query is required")
  .max(100, "Search query must be at most 100 characters");

/**
 * `GET /communities/mine` — a single endpoint that serves two modes, inferred
 * from the params (no `scope` flag). At least one of `before_ts`, `after_ts`,
 * `q`, or `categoryId` must be present.
 *
 *   joined mode (before_ts OR after_ts present) — the caller's own communities,
 *     ordered by `lastActivityAt`, using **cursor (timestamp) pagination**.
 *     Timestamps are epoch milliseconds and mutually exclusive:
 *       before_ts → lastActivityAt <= before_ts (newest-first)
 *       after_ts  → lastActivityAt >= after_ts  (oldest-first)
 *     Pagination takes precedence over `q`/`categoryId` if both are sent.
 *
 *   search mode (q and/or categoryId, no pagination) — PUBLIC communities plus
 *     any PRIVATE community the caller is already an ACTIVE member of, filtered
 *     by `q` / `categoryId`, using **offset (page) pagination**.
 *     `filter`: "all" browses every public community; "live"/"upcoming" are
 *     reserved for livestream filtering (no-op until stream-service exists).
 *
 * Both modes share `limit`.
 */
export const myCommunitiesQuerySchema = z
  .object({
    // joined-mode cursor pagination
    before_ts: z.coerce.number().int().positive().optional(),
    after_ts: z.coerce.number().int().positive().optional(),
    // search-mode filters + offset pagination
    q: discoverSearchSchema.optional(),
    categoryId: categoryIdSchema.optional(),
    filter: z.enum(["all", "live", "upcoming"]).default("all"),
    page: pageSchema,
    // shared
    limit: limitSchema,
  })
  .refine((q) => !(q.before_ts != null && q.after_ts != null), {
    message: "Only one pagination parameter is allowed at a time",
    path: ["before_ts"],
  });

export type MyCommunitiesQuery = z.infer<typeof myCommunitiesQuerySchema>;

/**
 * Public discovery / browse / search query — backs the deprecated
 * `GET /communities/discover` alias. New clients should call
 * `GET /communities/mine` with `q`/`categoryId` instead.
 */
export const discoverQuerySchema = z.object({
  q: discoverSearchSchema.optional(),
  categoryId: categoryIdSchema.optional(),
  filter: z.enum(["all", "live", "upcoming"]).default("all"),
  page: pageSchema,
  limit: limitSchema,
});

export type DiscoverQuery = z.infer<typeof discoverQuerySchema>;

export const communityMemberParamsSchema = z.object({
  id: z.string().trim().regex(OBJECT_ID_REGEX, "Community ID is invalid"),
  userId: z.string().trim().uuid("User ID is invalid"),
});

export type CommunityMemberParams = z.infer<typeof communityMemberParamsSchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum(["MODERATOR", "MEMBER"]),
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

/** Optional reason for a moderation action (kick / ban). The body may be empty. */
export const moderationReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, "Reason must be at most 500 characters")
    .optional(),
});

export type ModerationReasonInput = z.infer<typeof moderationReasonSchema>;

export const addMembersSchema = z.object({
  userIds: z
    .array(z.string().uuid("One or more user IDs are invalid"))
    .min(1, "Select at least one user")
    .max(100, "You can select at most 100 members")
    .transform((ids) => [...new Set(ids)]),
});

export type AddMembersInput = z.infer<typeof addMembersSchema>;

export const listMembersQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  status: z.enum(["ACTIVE", "PENDING", "BANNED", "LEFT"]).optional(),
});

export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;

export const auditLogsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
});

export type AuditLogsQuery = z.infer<typeof auditLogsQuerySchema>;

export const transferAdminSchema = z.object({
  userId: z.string().trim().uuid("User ID is invalid"),
});

export type TransferAdminInput = z.infer<typeof transferAdminSchema>;

/**
 * Body for POST /communities/:id/close. `reason` is an optional free-text note
 * surfaced to evicted members. Empty/omitted body is accepted.
 */
export const closeCommunitySchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .default({});

export type CloseCommunityInput = z.infer<typeof closeCommunitySchema>;

const joinRequestStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);

const inviteStatusEnum = z.enum(["PENDING", "ACCEPTED", "DECLINED", "EXPIRED"]);

const messageSchema = z
  .string()
  .trim()
  .max(500, "Message must be at most 500 characters");

// --- Join requests --------------------------------------------------------

export const createJoinRequestSchema = z.object({
  message: messageSchema.optional(),
});
export type CreateJoinRequestInput = z.infer<typeof createJoinRequestSchema>;

export const listJoinRequestsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  status: joinRequestStatusEnum.optional(),
});
export type ListJoinRequestsQuery = z.infer<typeof listJoinRequestsQuerySchema>;

export const myJoinRequestsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  status: joinRequestStatusEnum.optional(),
});
export type MyJoinRequestsQuery = z.infer<typeof myJoinRequestsQuerySchema>;

export const joinRequestIdParamsSchema = z.object({
  id: z.string().trim().regex(OBJECT_ID_REGEX, "Community ID is invalid"),
  requestId: z.string().trim().regex(OBJECT_ID_REGEX, "Request ID is invalid"),
});
export type JoinRequestIdParams = z.infer<typeof joinRequestIdParamsSchema>;

const joinRequestIdsSchema = z
  .array(
    z
      .string()
      .trim()
      .regex(OBJECT_ID_REGEX, "One or more request IDs are invalid")
  )
  .min(1, "Select at least one request")
  .max(50, "You can select at most 50 requests")
  .transform((ids) => [...new Set(ids)]);

export const bulkApproveJoinRequestsSchema = z.object({
  requestIds: joinRequestIdsSchema,
});
export type BulkApproveJoinRequestsInput = z.infer<
  typeof bulkApproveJoinRequestsSchema
>;

export const bulkRejectJoinRequestsSchema = z.object({
  requestIds: joinRequestIdsSchema,
});
export type BulkRejectJoinRequestsInput = z.infer<
  typeof bulkRejectJoinRequestsSchema
>;

// --- Invites --------------------------------------------------------------

export const createInviteSchema = z.object({
  inviteeId: z.string().trim().uuid("Invitee ID is invalid"),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const listInvitesQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  status: inviteStatusEnum.optional(),
});
export type ListInvitesQuery = z.infer<typeof listInvitesQuerySchema>;

export const myInvitesQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  status: inviteStatusEnum.optional(),
});
export type MyInvitesQuery = z.infer<typeof myInvitesQuerySchema>;

export const inviteIdParamsSchema = z.object({
  inviteId: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "Invitation ID is invalid"),
});
export type InviteIdParams = z.infer<typeof inviteIdParamsSchema>;

// --- Reports --------------------------------------------------------------

const reportStatusEnum = z.enum([
  "OPEN",
  "REVIEWED",
  "ACTIONED",
  "DISMISSED",
  "WITHDRAWN",
]);

export const createReportSchema = z.object({
  targetUserId: z.string().trim().uuid("User ID is invalid").optional(),
  reason: z
    .string()
    .trim()
    .min(3, "Reason must be at least 3 characters")
    .max(1000, "Reason must be at most 1000 characters"),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

export const reportIdParamsSchema = z.object({
  id: z.string().trim().regex(OBJECT_ID_REGEX, "Community ID is invalid"),
  reportId: z.string().trim().regex(OBJECT_ID_REGEX, "Report ID is invalid"),
});
export type ReportIdParams = z.infer<typeof reportIdParamsSchema>;

export const listReportsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  status: reportStatusEnum.optional(),
});
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;

export const myReportsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  status: reportStatusEnum.optional(),
});
export type MyReportsQuery = z.infer<typeof myReportsQuerySchema>;

/** Optional moderator-supplied resolution text on review/action/dismiss. */
export const reportResolutionSchema = z.object({
  resolution: z
    .string()
    .trim()
    .max(1000, "Resolution must be at most 1000 characters")
    .optional(),
});
export type ReportResolutionInput = z.infer<typeof reportResolutionSchema>;

// --- Mute -----------------------------------------------------------------

const communityIdsSchema = z
  .array(
    z
      .string()
      .trim()
      .regex(OBJECT_ID_REGEX, "One or more community IDs are invalid")
  )
  .min(1, "Select at least one community")
  .max(50, "You can select at most 50 communities")
  .transform((ids) => [...new Set(ids)]);

export const bulkMarkReadSchema = z.object({
  communityIds: communityIdsSchema,
});
export type BulkMarkReadInput = z.infer<typeof bulkMarkReadSchema>;

export const bulkMuteSchema = z.object({
  action: z.enum(["mute", "unmute"]),
  communityIds: communityIdsSchema,
  durationMinutes: z
    .number()
    .int()
    .min(1, "Mute duration must be at least 1 minute")
    .max(525_600, "Mute duration must be at most 365 days")
    .nullable()
    .optional(),
});
export type BulkMuteInput = z.infer<typeof bulkMuteSchema>;

export const setMuteSchema = z.object({
  durationMinutes: z
    .number()
    .int()
    .min(1, "Mute duration must be at least 1 minute")
    .max(525_600, "Mute duration must be at most 365 days")
    .nullable()
    .optional(),
});
export type SetMuteInput = z.infer<typeof setMuteSchema>;

// --- Member moderation mute / warn ----------------------------------------

/** Mute a member: optional duration (null/omitted = indefinite) + optional reason. */
export const setMemberMuteSchema = z.object({
  durationMinutes: z
    .number()
    .int()
    .min(1, "Mute duration must be at least 1 minute")
    .max(525_600, "Mute duration must be at most 365 days")
    .nullable()
    .optional(),
  reason: z
    .string()
    .trim()
    .max(500, "Reason must be at most 500 characters")
    .optional(),
});
export type SetMemberMuteInput = z.infer<typeof setMemberMuteSchema>;

export const mutedMembersQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
});
export type MutedMembersQuery = z.infer<typeof mutedMembersQuerySchema>;

/**
 * Banned-members list query: page/limit pagination, optional free-text search
 * (matched against displayName / username / userId), and sort controls.
 * `sortBy=bannedAt` + `sortOrder=desc` = "Newest first" (the default);
 * `sortOrder=asc` = "Oldest first". displayName/username sort the roster
 * alphabetically.
 */
export const bannedMembersQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  search: z
    .string()
    .trim()
    .min(1)
    .max(100, "Search must be at most 100 characters")
    .optional(),
  sortBy: z.enum(["bannedAt", "displayName", "username"]).default("bannedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});
export type BannedMembersQuery = z.infer<typeof bannedMembersQuerySchema>;

/** Warn a member: a required note. */
export const warnMemberSchema = z.object({
  note: z
    .string()
    .trim()
    .min(1, "Note is required")
    .max(1000, "Note must be at most 1000 characters"),
});
export type WarnMemberInput = z.infer<typeof warnMemberSchema>;

export const warningsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
});
export type WarningsQuery = z.infer<typeof warningsQuerySchema>;

// --- Notification preferences ---------------------------------------------

export const setNotificationPrefsSchema = z
  .object({
    streamEnabled: z.boolean().optional(),
    chatEnabled: z.boolean().optional(),
    announcementEnabled: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.streamEnabled !== undefined ||
      b.chatEnabled !== undefined ||
      b.announcementEnabled !== undefined,
    { message: "At least one preference field is required" }
  );
export type SetNotificationPrefsInput = z.infer<
  typeof setNotificationPrefsSchema
>;

// --- Leave reason ---------------------------------------------------------

const leaveReasonEnum = [
  "TOO_MANY_NOTIFICATIONS",
  "NOT_RELEVANT",
  "COMMUNITY_INACTIVE",
  "TOO_MANY_MESSAGES",
  "PRIVACY_CONCERN",
  "JOINED_BY_MISTAKE",
  "TAKING_A_BREAK",
  "OTHER",
] as const;

const leaveReasonFields = {
  reason: z.enum(leaveReasonEnum).optional(),
  reasonText: z
    .string()
    .trim()
    .max(500, "Reason must be at most 500 characters")
    .optional(),
};

const requireReasonText = (b: { reason?: string; reasonText?: string }) =>
  b.reason !== "OTHER" || (!!b.reasonText && b.reasonText.length > 0);

const reasonTextRequired = {
  message: "Reason is required when selecting 'Other'",
  path: ["reasonText"] as string[],
};

export const leaveReasonSchema = z
  .object(leaveReasonFields)
  .refine(requireReasonText, reasonTextRequired);
export type LeaveReasonInput = z.infer<typeof leaveReasonSchema>;

// --- Bulk leave -----------------------------------------------------------

export const bulkLeaveSchema = z.object({
  communityIds: communityIdsSchema,
});
export type BulkLeaveInput = z.infer<typeof bulkLeaveSchema>;

// --- Invite links ---------------------------------------------------------

export const createInviteLinkSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresInMinutes: z.number().int().min(1).max(525_600).optional(),
  autoApprove: z.boolean().optional(),
});
export type CreateInviteLinkInput = z.infer<typeof createInviteLinkSchema>;

const inviteLinkStatusEnum = z.enum(["active", "expired", "revoked"]);

export const listInviteLinksQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  status: inviteLinkStatusEnum.optional(),
});
export type ListInviteLinksQuery = z.infer<typeof listInviteLinksQuerySchema>;

export const inviteLinkIdParamsSchema = z.object({
  id: z.string().trim().regex(OBJECT_ID_REGEX, "Community ID is invalid"),
  linkId: z.string().trim().regex(OBJECT_ID_REGEX, "Invite link ID is invalid"),
});
export type InviteLinkIdParams = z.infer<typeof inviteLinkIdParamsSchema>;

export const inviteLinkCodeParamsSchema = z.object({
  code: z
    .string()
    .trim()
    .min(4)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "Invite code is invalid"),
});
export type InviteLinkCodeParams = z.infer<typeof inviteLinkCodeParamsSchema>;

export const bulkSendInviteLinkSchema = z.object({
  /**
   * IDs of users who should receive the invite-link DM.
   * Min 1, max 50 per request to keep fan-out bounded.
   */
  userIds: z
    .array(
      z
        .string()
        .trim()
        .regex(OBJECT_ID_REGEX, "One or more user IDs are invalid")
    )
    .min(1, "Select at least one user")
    .max(50, "You can select at most 50 users"),
  /**
   * Optional: reuse a specific invite link. When omitted the service fetches the
   * first active link or creates one on the fly.
   */
  linkId: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "Invite link ID is invalid")
    .optional(),
});
export type BulkSendInviteLinkInput = z.infer<typeof bulkSendInviteLinkSchema>;

// ---------------------------------------------------------------------------
// Admin category CRUD
// ---------------------------------------------------------------------------

const categoryNameSchema = z
  .string()
  .trim()
  .min(2, "Category name must be at least 2 characters")
  .max(80, "Category name must be at most 80 characters");

export const adminCategoriesQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  status: z.enum(["visible", "hidden", "all"]).optional().default("all"),
  page: pageSchema,
  limit: limitSchema,
});

export type AdminCategoriesQuery = z.infer<typeof adminCategoriesQuerySchema>;

export const createCategorySchema = z.object({
  name: categoryNameSchema,
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: categoryNameSchema.optional(),
    visible: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.visible !== undefined, {
    message: "At least one of name or visible must be provided",
  });

export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const categoryIdParamSchema = z.object({
  categoryId: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "Category ID is invalid"),
});

export type CategoryIdParams = z.infer<typeof categoryIdParamSchema>;
