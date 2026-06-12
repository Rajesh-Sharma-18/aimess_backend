import { Router, type IRouter } from "express";

import {
  acceptCommunityInvite,
  actionCommunityReport,
  addCommunityMembers,
  adminCreateCategory,
  adminDeleteCategory,
  adminListCategories,
  adminUpdateCategory,
  approveCommunityJoinRequest,
  banCommunityMember,
  bulkApproveCommunityJoinRequests,
  bulkLeaveCommunities,
  bulkMarkReadCommunities,
  bulkMuteCommunities,
  bulkRejectCommunityJoinRequests,
  bulkSendCommunityInviteLink,
  cancelCommunityJoinRequest,
  checkHandleAvailable,
  checkNameAvailable,
  clearMuteSetting,
  createCommunity,
  createCommunityInvite,
  createCommunityInviteLink,
  createCommunityJoinRequest,
  createCommunityReport,
  declineCommunityInvite,
  deleteCommunity,
  deleteCommunityReport,
  discoverCommunities,
  dismissCommunityReport,
  getCommunity,
  getMuteSetting,
  getNotificationPreferences,
  joinCommunity,
  kickCommunityMember,
  likeCommunity,
  listLikedCommunities,
  leaveCommunity,
  listCategories,
  listCommunityAuditLogs,
  listCommunityInvites,
  listCommunityInviteLinks,
  listCommunityJoinRequests,
  listCommunityMembers,
  listCommunityMemberWarnings,
  listCommunityMutedMembers,
  listCommunityReports,
  listMyCommunities,
  listMyInvites,
  listMyJoinRequests,
  listMyReports,
  muteCommunityMember,
  redeemCommunityInviteLink,
  rejectCommunityJoinRequest,
  reviewCommunityReport,
  revokeCommunityInviteLink,
  setMuteSetting,
  setNotificationPreferences,
  transferCommunityAdmin,
  unbanCommunityMember,
  unmuteCommunityMember,
  unlikeCommunity,
  updateCommunity,
  updateCommunityMemberRole,
  warnCommunityMember,
  withdrawCommunityReport,
} from "../controllers/community.controller.js";
import { createUploadUrl } from "../controllers/upload.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { requirePlatformAdmin } from "../../middleware/require-platform-admin.js";
import {
  addMembersSchema,
  adminCategoriesQuerySchema,
  bulkApproveJoinRequestsSchema,
  bulkLeaveSchema,
  bulkMarkReadSchema,
  bulkMuteSchema,
  bulkRejectJoinRequestsSchema,
  bulkSendInviteLinkSchema,
  auditLogsQuerySchema,
  categoryIdParamSchema,
  communityIdParamsSchema,
  communityMemberParamsSchema,
  createCategorySchema,
  createCommunitySchema,
  createInviteLinkSchema,
  createInviteSchema,
  createJoinRequestSchema,
  createReportSchema,
  discoverQuerySchema,
  handleAvailableQuerySchema,
  inviteIdParamsSchema,
  inviteLinkCodeParamsSchema,
  inviteLinkIdParamsSchema,
  joinRequestIdParamsSchema,
  leaveReasonSchema,
  listInviteLinksQuerySchema,
  listInvitesQuerySchema,
  listJoinRequestsQuerySchema,
  listMembersQuerySchema,
  listReportsQuerySchema,
  moderationReasonSchema,
  mutedMembersQuerySchema,
  myCommunitiesQuerySchema,
  myInvitesQuerySchema,
  myJoinRequestsQuerySchema,
  myReportsQuerySchema,
  nameAvailableQuerySchema,
  reportIdParamsSchema,
  reportResolutionSchema,
  setMemberMuteSchema,
  setMuteSchema,
  setNotificationPrefsSchema,
  transferAdminSchema,
  updateCategorySchema,
  updateCommunitySchema,
  updateMemberRoleSchema,
  warningsQuerySchema,
  warnMemberSchema,
} from "../validators/community.validator.js";
import { uploadUrlSchema } from "../validators/upload.validator.js";

export const communityRoutes: IRouter = Router();

// All community endpoints require a valid access token.
communityRoutes.use(authenticateAccessToken);

// Static / specific routes MUST be registered before the `/:id` param route.

// GET /categories — public (active only, no query params) stays backward-compatible.
// Admin CRUD on /categories uses the admin sub-handlers below.
communityRoutes.get("/categories", listCategories);

// Admin category CRUD — these MUST be before the `/:id` param route, and are
// gated by a platform-admin role check (fail-fast, before the validators).
communityRoutes.get(
  "/categories/admin",
  requirePlatformAdmin,
  validateQuery(adminCategoriesQuerySchema),
  adminListCategories
);

communityRoutes.post(
  "/categories",
  requirePlatformAdmin,
  validateBody(createCategorySchema),
  adminCreateCategory
);

communityRoutes.patch(
  "/categories/:categoryId",
  requirePlatformAdmin,
  validateParams(categoryIdParamSchema),
  validateBody(updateCategorySchema),
  adminUpdateCategory
);

communityRoutes.delete(
  "/categories/:categoryId",
  requirePlatformAdmin,
  validateParams(categoryIdParamSchema),
  adminDeleteCategory
);

communityRoutes.get(
  "/name-available",
  validateQuery(nameAvailableQuerySchema),
  checkNameAvailable
);

communityRoutes.get(
  "/handle-available",
  validateQuery(handleAvailableQuerySchema),
  checkHandleAvailable
);

// Unified list: mode inferred from params. Pagination (before_ts/after_ts) →
// my joined communities (cursor pagination); else q/categoryId → search across
// public + my private communities (offset pagination). At least one required.
communityRoutes.get(
  "/mine",
  validateQuery(myCommunitiesQuerySchema),
  listMyCommunities
);

// Deprecated alias — public browse/search excluding joined communities. Kept for
// backward compatibility; prefer `GET /mine` with `q`/`categoryId`.
communityRoutes.get(
  "/discover",
  validateQuery(discoverQuerySchema),
  discoverCommunities
);

communityRoutes.post(
  "/uploads/url",
  validateBody(uploadUrlSchema),
  createUploadUrl
);

// Static "/mine" + "/invites/:inviteId/..." routes must be registered before
// any `/:id/...` route so the param route doesn't capture them.
communityRoutes.get(
  "/join-requests/mine",
  validateQuery(myJoinRequestsQuerySchema),
  listMyJoinRequests
);

communityRoutes.get(
  "/invites/mine",
  validateQuery(myInvitesQuerySchema),
  listMyInvites
);

communityRoutes.get(
  "/reports/mine",
  validateQuery(myReportsQuerySchema),
  listMyReports
);

// Static "/liked" listing MUST be before the `/:id` param route, otherwise
// "liked" is captured as a community id and rejected by communityIdParamsSchema.
communityRoutes.get("/liked", listLikedCommunities);

communityRoutes.post(
  "/invites/:inviteId/accept",
  validateParams(inviteIdParamsSchema),
  acceptCommunityInvite
);

communityRoutes.post(
  "/invites/:inviteId/decline",
  validateParams(inviteIdParamsSchema),
  declineCommunityInvite
);

// Static `/invite-links/:code/redeem` MUST come BEFORE the `/:id` capture so
// the param route doesn't swallow `invite-links` as a community id.
communityRoutes.post(
  "/invite-links/:code/redeem",
  validateParams(inviteLinkCodeParamsSchema),
  redeemCommunityInviteLink
);

// --- Bulk mute / unmute / mark-as-read (static, must be before /:id) ---

communityRoutes.post(
  "/mute/bulk",
  validateBody(bulkMuteSchema),
  bulkMuteCommunities
);

communityRoutes.post(
  "/read/bulk",
  validateBody(bulkMarkReadSchema),
  bulkMarkReadCommunities
);

communityRoutes.post("/", validateBody(createCommunitySchema), createCommunity);

communityRoutes.get(
  "/:id",
  validateParams(communityIdParamsSchema),
  getCommunity
);

communityRoutes.patch(
  "/:id",
  validateParams(communityIdParamsSchema),
  validateBody(updateCommunitySchema),
  updateCommunity
);

communityRoutes.delete(
  "/:id",
  validateParams(communityIdParamsSchema),
  deleteCommunity
);

communityRoutes.get(
  "/:id/members",
  validateParams(communityIdParamsSchema),
  validateQuery(listMembersQuerySchema),
  listCommunityMembers
);

communityRoutes.get(
  "/:id/audit-logs",
  validateParams(communityIdParamsSchema),
  validateQuery(auditLogsQuerySchema),
  listCommunityAuditLogs
);

communityRoutes.post(
  "/:id/members",
  validateParams(communityIdParamsSchema),
  validateBody(addMembersSchema),
  addCommunityMembers
);

// Static route must be registered before /:id to prevent "leave" being
// captured as a communityId param.
communityRoutes.post(
  "/leave/bulk",
  validateBody(bulkLeaveSchema),
  bulkLeaveCommunities
);

communityRoutes.post(
  "/:id/leave",
  validateParams(communityIdParamsSchema),
  validateBody(leaveReasonSchema),
  leaveCommunity
);

communityRoutes.post(
  "/:id/like",
  validateParams(communityIdParamsSchema),
  likeCommunity
);

communityRoutes.delete(
  "/:id/like",
  validateParams(communityIdParamsSchema),
  unlikeCommunity
);

communityRoutes.post(
  "/:id/join",
  validateParams(communityIdParamsSchema),
  joinCommunity
);

communityRoutes.post(
  "/:id/transfer-admin",
  validateParams(communityIdParamsSchema),
  validateBody(transferAdminSchema),
  transferCommunityAdmin
);

communityRoutes.put(
  "/:id/members/:userId/role",
  validateParams(communityMemberParamsSchema),
  validateBody(updateMemberRoleSchema),
  updateCommunityMemberRole
);

communityRoutes.delete(
  "/:id/members/:userId",
  validateParams(communityMemberParamsSchema),
  validateBody(moderationReasonSchema),
  kickCommunityMember
);

communityRoutes.post(
  "/:id/members/:userId/ban",
  validateParams(communityMemberParamsSchema),
  validateBody(moderationReasonSchema),
  banCommunityMember
);

communityRoutes.delete(
  "/:id/members/:userId/ban",
  validateParams(communityMemberParamsSchema),
  unbanCommunityMember
);

// --- Member moderation mute / warn (MODERATOR+) ---

communityRoutes.get(
  "/:id/muted-members",
  validateParams(communityIdParamsSchema),
  validateQuery(mutedMembersQuerySchema),
  listCommunityMutedMembers
);

communityRoutes.post(
  "/:id/members/:userId/mute",
  validateParams(communityMemberParamsSchema),
  validateBody(setMemberMuteSchema),
  muteCommunityMember
);

communityRoutes.delete(
  "/:id/members/:userId/mute",
  validateParams(communityMemberParamsSchema),
  unmuteCommunityMember
);

communityRoutes.post(
  "/:id/members/:userId/warn",
  validateParams(communityMemberParamsSchema),
  validateBody(warnMemberSchema),
  warnCommunityMember
);

communityRoutes.get(
  "/:id/members/:userId/warnings",
  validateParams(communityMemberParamsSchema),
  validateQuery(warningsQuerySchema),
  listCommunityMemberWarnings
);

// --- Join requests under a community ---

communityRoutes.post(
  "/:id/join-requests",
  validateParams(communityIdParamsSchema),
  validateBody(createJoinRequestSchema),
  createCommunityJoinRequest
);

communityRoutes.get(
  "/:id/join-requests",
  validateParams(communityIdParamsSchema),
  validateQuery(listJoinRequestsQuerySchema),
  listCommunityJoinRequests
);

communityRoutes.post(
  "/:id/join-requests/:requestId/approve",
  validateParams(joinRequestIdParamsSchema),
  approveCommunityJoinRequest
);

communityRoutes.post(
  "/:id/join-requests/:requestId/reject",
  validateParams(joinRequestIdParamsSchema),
  rejectCommunityJoinRequest
);

communityRoutes.post(
  "/:id/join-requests/bulk-approve",
  validateParams(communityIdParamsSchema),
  validateBody(bulkApproveJoinRequestsSchema),
  bulkApproveCommunityJoinRequests
);

communityRoutes.post(
  "/:id/join-requests/bulk-reject",
  validateParams(communityIdParamsSchema),
  validateBody(bulkRejectJoinRequestsSchema),
  bulkRejectCommunityJoinRequests
);

communityRoutes.delete(
  "/:id/join-requests/:requestId",
  validateParams(joinRequestIdParamsSchema),
  cancelCommunityJoinRequest
);

// --- Invites under a community (mod-facing create & list) ---

communityRoutes.post(
  "/:id/invites",
  validateParams(communityIdParamsSchema),
  validateBody(createInviteSchema),
  createCommunityInvite
);

communityRoutes.get(
  "/:id/invites",
  validateParams(communityIdParamsSchema),
  validateQuery(listInvitesQuerySchema),
  listCommunityInvites
);

// --- Reports under a community ---

communityRoutes.post(
  "/:id/reports",
  validateParams(communityIdParamsSchema),
  validateBody(createReportSchema),
  createCommunityReport
);

communityRoutes.get(
  "/:id/reports",
  validateParams(communityIdParamsSchema),
  validateQuery(listReportsQuerySchema),
  listCommunityReports
);

communityRoutes.post(
  "/:id/reports/:reportId/review",
  validateParams(reportIdParamsSchema),
  validateBody(reportResolutionSchema),
  reviewCommunityReport
);

communityRoutes.post(
  "/:id/reports/:reportId/action",
  validateParams(reportIdParamsSchema),
  validateBody(reportResolutionSchema),
  actionCommunityReport
);

communityRoutes.post(
  "/:id/reports/:reportId/dismiss",
  validateParams(reportIdParamsSchema),
  validateBody(reportResolutionSchema),
  dismissCommunityReport
);

// Reporter self-withdraw (owner-only, OPEN-only).
communityRoutes.post(
  "/:id/reports/:reportId/withdraw",
  validateParams(reportIdParamsSchema),
  withdrawCommunityReport
);

// Moderator hard-delete of a report (MODERATOR+).
communityRoutes.delete(
  "/:id/reports/:reportId",
  validateParams(reportIdParamsSchema),
  deleteCommunityReport
);

// --- Mute settings ---

communityRoutes.get(
  "/:id/mute",
  validateParams(communityIdParamsSchema),
  getMuteSetting
);

communityRoutes.put(
  "/:id/mute",
  validateParams(communityIdParamsSchema),
  validateBody(setMuteSchema),
  setMuteSetting
);

communityRoutes.delete(
  "/:id/mute",
  validateParams(communityIdParamsSchema),
  clearMuteSetting
);

// --- Notification preferences (MEMBER+ self-service) ---

communityRoutes.get(
  "/:id/notification-preferences",
  validateParams(communityIdParamsSchema),
  getNotificationPreferences
);

communityRoutes.put(
  "/:id/notification-preferences",
  validateParams(communityIdParamsSchema),
  validateBody(setNotificationPrefsSchema),
  setNotificationPreferences
);

// --- Invite links (per-community) ---

communityRoutes.post(
  "/:id/invite-links",
  validateParams(communityIdParamsSchema),
  validateBody(createInviteLinkSchema),
  createCommunityInviteLink
);

communityRoutes.get(
  "/:id/invite-links",
  validateParams(communityIdParamsSchema),
  validateQuery(listInviteLinksQuerySchema),
  listCommunityInviteLinks
);

communityRoutes.delete(
  "/:id/invite-links/:linkId",
  validateParams(inviteLinkIdParamsSchema),
  revokeCommunityInviteLink
);

communityRoutes.post(
  "/:id/invite-links/bulk-send",
  validateParams(communityIdParamsSchema),
  validateBody(bulkSendInviteLinkSchema),
  bulkSendCommunityInviteLink
);
