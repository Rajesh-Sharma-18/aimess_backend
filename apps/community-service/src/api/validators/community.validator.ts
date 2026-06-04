import { z } from "zod";

import { normalizeHandle } from "../../lib/community-slug.util.js";

const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;

const nameSchema = z
  .string()
  .trim()
  .min(3, "Name must be at least 3 characters")
  .max(50, "Name must be at most 50 characters");

const handleSchema = z
  .string()
  .trim()
  .transform((s) => normalizeHandle(s))
  .pipe(
    z
      .string()
      .min(3, "Handle must be at least 3 characters")
      .max(32, "Handle must be at most 32 characters")
      .regex(
        /^[a-z0-9_]+$/,
        "Handle may only contain lowercase letters, numbers, and underscores"
      )
  );

const descriptionSchema = z
  .string()
  .trim()
  .max(500, "Description must be at most 500 characters");

const categoryIdSchema = z
  .string()
  .trim()
  .regex(OBJECT_ID_REGEX, "categoryId must be a 24-character hex ObjectId");

const objectKeySchema = z.string().trim().min(1).max(512);

const memberIdsSchema = z
  .array(z.string().uuid("memberIds must be UUIDs"))
  .max(500, "Too many members")
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
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.handle !== undefined ||
      body.type !== undefined ||
      body.categoryId !== undefined ||
      body.description !== undefined ||
      body.avatarObjectKey !== undefined,
    { message: "At least one field is required to update" }
  );

export type UpdateCommunityInput = z.infer<typeof updateCommunitySchema>;

export const communityIdParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "id must be a 24-character hex ObjectId"),
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

/** Reusable discovery search query field (`q`). */
const discoverSearchSchema = z
  .string()
  .trim()
  .min(1, "Search query must not be empty")
  .max(100, "Search query must be at most 100 characters");

/**
 * `GET /communities/mine` — a single endpoint that serves two scopes:
 *
 *   scope=joined (default) — the caller's own communities, ordered by
 *     `lastActivityAt`, using **cursor (timestamp) pagination**. Timestamps are
 *     epoch milliseconds and mutually exclusive:
 *       before_ts → lastActivityAt <= before_ts (newest-first)
 *       after_ts  → lastActivityAt >= after_ts  (oldest-first)
 *     Omit both for the newest page.
 *
 *   scope=discover — public communities the caller is not in, browse/search,
 *     using **offset (page) pagination** with `q` / `categoryId` / `filter`.
 *     `filter`: "all" browses every public community; "live"/"upcoming" are
 *     reserved for livestream filtering (no-op until stream-service exists).
 *
 * Both scopes share `limit`. Scope-irrelevant params are simply ignored, so a
 * client switching tabs can keep `limit` and drop the rest. The two pagination
 * styles never mix: `before_ts`/`after_ts` only apply to `joined`, and
 * `page`/`q`/`categoryId`/`filter` only apply to `discover`.
 */
export const myCommunitiesQuerySchema = z
  .object({
    scope: z.enum(["joined", "discover"]).default("joined"),
    // joined-scope cursor pagination
    before_ts: z.coerce.number().int().positive().optional(),
    after_ts: z.coerce.number().int().positive().optional(),
    // discover-scope filters + offset pagination
    q: discoverSearchSchema.optional(),
    categoryId: categoryIdSchema.optional(),
    filter: z.enum(["all", "live", "upcoming"]).default("all"),
    page: pageSchema,
    // shared
    limit: limitSchema,
  })
  .refine((q) => !(q.before_ts != null && q.after_ts != null), {
    message: "Provide either before_ts or after_ts, not both",
    path: ["before_ts"],
  });

export type MyCommunitiesQuery = z.infer<typeof myCommunitiesQuerySchema>;

/**
 * Public discovery / browse / search query — backs the deprecated
 * `GET /communities/discover` alias. New clients should call
 * `GET /communities/mine?scope=discover` instead.
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
  id: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "id must be a 24-character hex ObjectId"),
  userId: z.string().trim().uuid("userId must be a UUID"),
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
    .array(z.string().uuid("userIds must be UUIDs"))
    .min(1, "At least one userId is required")
    .max(100, "Too many members")
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
  userId: z.string().trim().uuid("userId must be a UUID"),
});

export type TransferAdminInput = z.infer<typeof transferAdminSchema>;

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
  id: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "id must be a 24-character hex ObjectId"),
  requestId: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "requestId must be a 24-character hex ObjectId"),
});
export type JoinRequestIdParams = z.infer<typeof joinRequestIdParamsSchema>;

// --- Invites --------------------------------------------------------------

export const createInviteSchema = z.object({
  inviteeId: z.string().trim().uuid("inviteeId must be a UUID"),
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
    .regex(OBJECT_ID_REGEX, "inviteId must be a 24-character hex ObjectId"),
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
  targetUserId: z
    .string()
    .trim()
    .uuid("targetUserId must be a UUID")
    .optional(),
  reason: z
    .string()
    .trim()
    .min(3, "Reason must be at least 3 characters")
    .max(1000, "Reason must be at most 1000 characters"),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

export const reportIdParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "id must be a 24-character hex ObjectId"),
  reportId: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "reportId must be a 24-character hex ObjectId"),
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

export const setMuteSchema = z.object({
  durationMinutes: z
    .number()
    .int()
    .min(1, "durationMinutes must be at least 1")
    .max(525_600, "durationMinutes must be at most 525600 (365 days)")
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
    .min(1, "durationMinutes must be at least 1")
    .max(525_600, "durationMinutes must be at most 525600 (365 days)")
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

export const leaveReasonSchema = z
  .object({
    reason: z
      .enum([
        "UNINTERESTED",
        "TOO_NOISY",
        "INAPPROPRIATE_CONTENT",
        "PRIVACY_CONCERN",
        "OTHER",
      ])
      .optional(),
    reasonText: z
      .string()
      .trim()
      .max(500, "reasonText must be at most 500 characters")
      .optional(),
  })
  .refine(
    (b) => b.reason !== "OTHER" || (!!b.reasonText && b.reasonText.length > 0),
    {
      message: "reasonText is required when reason is OTHER",
      path: ["reasonText"],
    }
  );
export type LeaveReasonInput = z.infer<typeof leaveReasonSchema>;

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
  id: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "id must be a 24-character hex ObjectId"),
  linkId: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "linkId must be a 24-character hex ObjectId"),
});
export type InviteLinkIdParams = z.infer<typeof inviteLinkIdParamsSchema>;

export const inviteLinkCodeParamsSchema = z.object({
  code: z
    .string()
    .trim()
    .min(4)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "invalid code"),
});
export type InviteLinkCodeParams = z.infer<typeof inviteLinkCodeParamsSchema>;
