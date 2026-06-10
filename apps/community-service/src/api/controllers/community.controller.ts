import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import { communityService } from "../../services/community.service.js";
import type {
  AddMembersInput,
  AuditLogsQuery,
  BulkMarkReadInput,
  BulkMuteInput,
  BulkSendInviteLinkInput,
  CommunityIdParams,
  CommunityMemberParams,
  CreateCommunityInput,
  CreateInviteInput,
  CreateInviteLinkInput,
  CreateJoinRequestInput,
  CreateReportInput,
  DiscoverQuery,
  HandleAvailableQuery,
  InviteIdParams,
  InviteLinkCodeParams,
  InviteLinkIdParams,
  JoinRequestIdParams,
  LeaveReasonInput,
  ListInvitesQuery,
  ListInviteLinksQuery,
  ListJoinRequestsQuery,
  ListMembersQuery,
  ListReportsQuery,
  ModerationReasonInput,
  MutedMembersQuery,
  MyCommunitiesQuery,
  MyInvitesQuery,
  MyJoinRequestsQuery,
  MyReportsQuery,
  NameAvailableQuery,
  ReportIdParams,
  ReportResolutionInput,
  SetMemberMuteInput,
  SetMuteInput,
  AdminCategoriesQuery,
  CategoryIdParams,
  CreateCategoryInput,
  SetNotificationPrefsInput,
  TransferAdminInput,
  UpdateCategoryInput,
  UpdateCommunityInput,
  UpdateMemberRoleInput,
  WarningsQuery,
  WarnMemberInput,
} from "../validators/community.validator.js";

export const createCommunity = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as CreateCommunityInput;
    const community = await communityService.create(req.auth.userId, body);

    return res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(community, t("COMMUNITY_CREATED", req.locale)));
  }
);

export const updateCommunity = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const body = req.body as UpdateCommunityInput;

    const community = await communityService.update(id, req.auth.userId, body);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(community, t("COMMUNITY_UPDATED", req.locale)));
  }
);

export const getCommunity = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const community = await communityService.getById(id, req.auth.userId);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(community, t("COMMUNITY_FETCHED", req.locale)));
  }
);

export const checkNameAvailable = asyncHandler(
  async (req: Request, res: Response) => {
    const { name } = req.query as unknown as NameAvailableQuery;
    const result = await communityService.checkNameAvailability(name);

    const messageKey = result.available
      ? "COMMUNITY_NAME_AVAILABLE"
      : "COMMUNITY_NAME_TAKEN";

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t(messageKey, req.locale)));
  }
);

export const checkHandleAvailable = asyncHandler(
  async (req: Request, res: Response) => {
    const { handle } = req.query as unknown as HandleAvailableQuery;
    const result = await communityService.checkHandleAvailability(handle);

    const messageKey = result.available
      ? "COMMUNITY_HANDLE_AVAILABLE"
      : "COMMUNITY_HANDLE_TAKEN";

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t(messageKey, req.locale)));
  }
);

export const listCategories = asyncHandler(
  async (req: Request, res: Response) => {
    const categories = await communityService.listCategories();

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { categories },
          t("COMMUNITY_CATEGORIES_FETCHED", req.locale)
        )
      );
  }
);

export const listMyCommunities = asyncHandler(
  async (req: Request, res: Response) => {
    const { before_ts, after_ts, q, categoryId, filter, page, limit } =
      req.query as unknown as MyCommunitiesQuery;

    // Pagination present → joined mode (the caller's communities, cursor
    // pagination). Takes precedence over q/categoryId if both are sent.
    if (before_ts != null || after_ts != null) {
      const direction = after_ts != null ? "after" : "before";
      const tsMs = after_ts ?? before_ts ?? Date.now();

      const result = await communityService.listMine(req.auth.userId, {
        direction,
        ts: new Date(tsMs),
        limit,
      });

      return res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("COMMUNITY_LIST_FETCHED", req.locale)));
    }

    // Else → search mode: PUBLIC communities plus PRIVATE ones the caller is an
    // ACTIVE member of (offset pagination), filtered by q/categoryId.
    const result = await communityService.discover(req.auth.userId, {
      q,
      categoryId,
      filter,
      page,
      limit,
      includeJoined: true,
      includeChatActivity: true,
    });

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_DISCOVER_FETCHED", req.locale))
      );
  }
);

export const discoverCommunities = asyncHandler(
  async (req: Request, res: Response) => {
    const { q, categoryId, filter, page, limit } =
      req.query as unknown as DiscoverQuery;

    const result = await communityService.discover(req.auth.userId, {
      q,
      categoryId,
      filter,
      page,
      limit,
    });

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_DISCOVER_FETCHED", req.locale))
      );
  }
);

export const listCommunityMembers = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { page, limit, status } = req.query as unknown as ListMembersQuery;

    const result = await communityService.listMembers(id, req.auth.userId, {
      page,
      limit,
      status,
    });

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_MEMBERS_FETCHED", req.locale))
      );
  }
);

export const listCommunityAuditLogs = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { page, limit } = req.query as unknown as AuditLogsQuery;

    const result = await communityService.listAuditLogs(id, req.auth.userId, {
      page,
      limit,
    });

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_AUDIT_LOGS_FETCHED", req.locale))
      );
  }
);

export const updateCommunityMemberRole = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, userId } = req.params as CommunityMemberParams;
    const { role } = req.body as UpdateMemberRoleInput;

    const member = await communityService.updateMemberRole(
      id,
      req.auth.userId,
      userId,
      role
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(member, t("COMMUNITY_MEMBER_ROLE_UPDATED", req.locale))
      );
  }
);

export const kickCommunityMember = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, userId } = req.params as CommunityMemberParams;
    const { reason } = req.body as ModerationReasonInput;

    const member = await communityService.kickMember(
      id,
      req.auth.userId,
      userId,
      reason
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(member, t("COMMUNITY_MEMBER_KICKED", req.locale)));
  }
);

export const banCommunityMember = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, userId } = req.params as CommunityMemberParams;
    const { reason } = req.body as ModerationReasonInput;

    const member = await communityService.banMember(
      id,
      req.auth.userId,
      userId,
      reason
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(member, t("COMMUNITY_MEMBER_BANNED", req.locale)));
  }
);

export const addCommunityMembers = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { userIds } = req.body as AddMembersInput;

    const result = await communityService.addMembers(
      id,
      req.auth.userId,
      userIds
    );

    return res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("COMMUNITY_MEMBERS_ADDED", req.locale)));
  }
);

export const leaveCommunity = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    // Body is fully optional — body-parser produces `{}` for empty POSTs,
    // which the schema accepts. Forward whatever the user sent (or null).
    const body = req.body as LeaveReasonInput | undefined;

    const member = await communityService.leaveCommunity(id, req.auth.userId, {
      reason: body?.reason ?? null,
      reasonText: body?.reasonText ?? null,
    });

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(member, t("COMMUNITY_LEFT", req.locale)));
  }
);

export const unbanCommunityMember = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, userId } = req.params as CommunityMemberParams;

    const member = await communityService.unbanMember(
      id,
      req.auth.userId,
      userId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(member, t("COMMUNITY_MEMBER_UNBANNED", req.locale))
      );
  }
);

export const muteCommunityMember = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, userId } = req.params as CommunityMemberParams;
    const { durationMinutes, reason } = req.body as SetMemberMuteInput;

    const data = await communityService.muteMember(
      id,
      req.auth.userId,
      userId,
      durationMinutes ?? null,
      reason
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(data, t("COMMUNITY_MEMBER_MUTED", req.locale)));
  }
);

export const unmuteCommunityMember = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, userId } = req.params as CommunityMemberParams;

    await communityService.unmuteMember(id, req.auth.userId, userId);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("COMMUNITY_MEMBER_UNMUTED", req.locale)));
  }
);

export const listCommunityMutedMembers = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { page, limit } = req.query as unknown as MutedMembersQuery;

    const result = await communityService.listMutedMembers(
      id,
      req.auth.userId,
      { page, limit }
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("COMMUNITY_MUTED_MEMBERS_FETCHED", req.locale)
        )
      );
  }
);

export const warnCommunityMember = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, userId } = req.params as CommunityMemberParams;
    const { note } = req.body as WarnMemberInput;

    const data = await communityService.warnMember(
      id,
      req.auth.userId,
      userId,
      note
    );

    return res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(data, t("COMMUNITY_MEMBER_WARNED", req.locale)));
  }
);

export const listCommunityMemberWarnings = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, userId } = req.params as CommunityMemberParams;
    const { page, limit } = req.query as unknown as WarningsQuery;

    const result = await communityService.listMemberWarnings(
      id,
      req.auth.userId,
      userId,
      { page, limit }
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("COMMUNITY_MEMBER_WARNINGS_FETCHED", req.locale)
        )
      );
  }
);

export const joinCommunity = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;

    const result = await communityService.joinCommunity(id, req.auth.userId);

    // `joinCommunity` now creates a join request for PUBLIC communities and
    // returns the join-request DTO. Respond with CREATED.
    return res
      .status(HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(result, t("COMMUNITY_JOIN_REQUEST_CREATED", req.locale))
      );
  }
);

export const transferCommunityAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { userId } = req.body as TransferAdminInput;

    const community = await communityService.transferAdmin(
      id,
      req.auth.userId,
      userId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(community, t("COMMUNITY_ADMIN_TRANSFERRED", req.locale))
      );
  }
);

export const deleteCommunity = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;

    await communityService.deleteCommunity(id, req.auth.userId);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("COMMUNITY_DELETED", req.locale)));
  }
);

// --- Join requests ---

export const createCommunityJoinRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { message } = req.body as CreateJoinRequestInput;
    const result = await communityService.createJoinRequest(
      id,
      req.auth.userId,
      message ?? null
    );
    return res
      .status(HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(result, t("COMMUNITY_JOIN_REQUEST_CREATED", req.locale))
      );
  }
);

export const listCommunityJoinRequests = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { page, limit, status } =
      req.query as unknown as ListJoinRequestsQuery;
    const result = await communityService.listCommunityJoinRequests(
      id,
      req.auth.userId,
      { page, limit, status }
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("COMMUNITY_JOIN_REQUESTS_FETCHED", req.locale)
        )
      );
  }
);

export const listMyJoinRequests = asyncHandler(
  async (req: Request, res: Response) => {
    const { page, limit, status } = req.query as unknown as MyJoinRequestsQuery;
    const result = await communityService.listMyJoinRequests(req.auth.userId, {
      page,
      limit,
      status,
    });
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("COMMUNITY_MY_JOIN_REQUESTS_FETCHED", req.locale)
        )
      );
  }
);

export const approveCommunityJoinRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, requestId } = req.params as JoinRequestIdParams;
    const result = await communityService.approveJoinRequest(
      id,
      req.auth.userId,
      requestId
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("COMMUNITY_JOIN_REQUEST_APPROVED", req.locale)
        )
      );
  }
);

export const rejectCommunityJoinRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, requestId } = req.params as JoinRequestIdParams;
    const result = await communityService.rejectJoinRequest(
      id,
      req.auth.userId,
      requestId
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("COMMUNITY_JOIN_REQUEST_REJECTED", req.locale)
        )
      );
  }
);

export const cancelCommunityJoinRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, requestId } = req.params as JoinRequestIdParams;
    const result = await communityService.cancelJoinRequest(
      id,
      req.auth.userId,
      requestId
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("COMMUNITY_JOIN_REQUEST_CANCELLED", req.locale)
        )
      );
  }
);

// --- Invites ---

export const createCommunityInvite = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { inviteeId } = req.body as CreateInviteInput;
    const result = await communityService.createInvite(
      id,
      req.auth.userId,
      inviteeId
    );

    return res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("COMMUNITY_INVITE_CREATED", req.locale)));
  }
);

export const listCommunityInvites = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { page, limit, status } = req.query as unknown as ListInvitesQuery;
    const result = await communityService.listCommunityInvites(
      id,
      req.auth.userId,
      { page, limit, status }
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_INVITES_FETCHED", req.locale))
      );
  }
);

export const listMyInvites = asyncHandler(
  async (req: Request, res: Response) => {
    const { page, limit, status } = req.query as unknown as MyInvitesQuery;
    const result = await communityService.listMyInvites(req.auth.userId, {
      page,
      limit,
      status,
    });
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_MY_INVITES_FETCHED", req.locale))
      );
  }
);

export const acceptCommunityInvite = asyncHandler(
  async (req: Request, res: Response) => {
    const { inviteId } = req.params as InviteIdParams;
    const result = await communityService.acceptInvite(
      req.auth.userId,
      inviteId
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_INVITE_ACCEPTED", req.locale))
      );
  }
);

export const declineCommunityInvite = asyncHandler(
  async (req: Request, res: Response) => {
    const { inviteId } = req.params as InviteIdParams;
    const result = await communityService.declineInvite(
      req.auth.userId,
      inviteId
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_INVITE_DECLINED", req.locale))
      );
  }
);

// --- Reports ---

export const createCommunityReport = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { targetUserId, reason } = req.body as CreateReportInput;
    const result = await communityService.createReport(id, req.auth.userId, {
      targetUserId,
      reason,
    });
    return res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("COMMUNITY_REPORT_CREATED", req.locale)));
  }
);

export const listCommunityReports = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { page, limit, status } = req.query as unknown as ListReportsQuery;
    const result = await communityService.listCommunityReports(
      id,
      req.auth.userId,
      { page, limit, status }
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_REPORTS_FETCHED", req.locale))
      );
  }
);

export const listMyReports = asyncHandler(
  async (req: Request, res: Response) => {
    const { page, limit, status } = req.query as unknown as MyReportsQuery;
    const result = await communityService.listMyReports(req.auth.userId, {
      page,
      limit,
      status,
    });
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_MY_REPORTS_FETCHED", req.locale))
      );
  }
);

export const reviewCommunityReport = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, reportId } = req.params as ReportIdParams;
    const { resolution } = req.body as ReportResolutionInput;
    const result = await communityService.reviewReport(
      id,
      req.auth.userId,
      reportId,
      resolution ?? null
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_REPORT_REVIEWED", req.locale))
      );
  }
);

export const actionCommunityReport = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, reportId } = req.params as ReportIdParams;
    const { resolution } = req.body as ReportResolutionInput;
    const result = await communityService.actionReport(
      id,
      req.auth.userId,
      reportId,
      resolution ?? null
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_REPORT_ACTIONED", req.locale))
      );
  }
);

export const dismissCommunityReport = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, reportId } = req.params as ReportIdParams;
    const { resolution } = req.body as ReportResolutionInput;
    const result = await communityService.dismissReport(
      id,
      req.auth.userId,
      reportId,
      resolution ?? null
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_REPORT_DISMISSED", req.locale))
      );
  }
);

export const withdrawCommunityReport = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, reportId } = req.params as ReportIdParams;
    const result = await communityService.withdrawReport(
      id,
      req.auth.userId,
      reportId
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_REPORT_WITHDRAWN", req.locale))
      );
  }
);

export const deleteCommunityReport = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, reportId } = req.params as ReportIdParams;
    await communityService.deleteReport(id, req.auth.userId, reportId);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("COMMUNITY_REPORT_DELETED", req.locale)));
  }
);

// --- Mute settings ---------------------------------------------------------

export const getMuteSetting = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const data = await communityService.getMute(id, req.auth.userId);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(data, t("COMMUNITY_MUTE_FETCHED", req.locale)));
  }
);

export const setMuteSetting = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { durationMinutes } = req.body as SetMuteInput;
    const data = await communityService.setMute(
      id,
      req.auth.userId,
      durationMinutes ?? null
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(data, t("COMMUNITY_MUTE_UPDATED", req.locale)));
  }
);

export const clearMuteSetting = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    await communityService.clearMute(id, req.auth.userId);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("COMMUNITY_MUTE_CLEARED", req.locale)));
  }
);

export const bulkMuteCommunities = asyncHandler(
  async (req: Request, res: Response) => {
    const { action, communityIds, durationMinutes } = req.body as BulkMuteInput;

    if (action === "unmute") {
      const result = await communityService.bulkUnmute(
        req.auth.userId,
        communityIds
      );
      return res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("COMMUNITY_MUTE_CLEARED", req.locale)));
    }

    const result = await communityService.bulkMute(
      req.auth.userId,
      communityIds,
      durationMinutes
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("COMMUNITY_MUTE_UPDATED", req.locale)));
  }
);

export const bulkMarkReadCommunities = asyncHandler(
  async (req: Request, res: Response) => {
    const { communityIds } = req.body as BulkMarkReadInput;
    const result = await communityService.bulkMarkRead(
      req.auth.userId,
      communityIds
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_MARK_READ_UPDATED", req.locale))
      );
  }
);

// --- Notification preferences ----------------------------------------------

export const getNotificationPreferences = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const data = await communityService.getNotificationPreferences(
      id,
      req.auth.userId
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          data,
          t("COMMUNITY_NOTIFICATION_PREFERENCES_FETCHED", req.locale)
        )
      );
  }
);

export const setNotificationPreferences = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const body = req.body as SetNotificationPrefsInput;
    const data = await communityService.setNotificationPreferences(
      id,
      req.auth.userId,
      body
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          data,
          t("COMMUNITY_NOTIFICATION_PREFERENCES_UPDATED", req.locale)
        )
      );
  }
);

// --- Invite links ----------------------------------------------------------

export const createCommunityInviteLink = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const body = req.body as CreateInviteLinkInput;
    const link = await communityService.createInviteLink(
      id,
      req.auth.userId,
      body
    );
    return res
      .status(HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(link, t("COMMUNITY_INVITE_LINK_CREATED", req.locale))
      );
  }
);

export const listCommunityInviteLinks = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const q = req.query as unknown as ListInviteLinksQuery;
    const result = await communityService.listInviteLinks(
      id,
      req.auth.userId,
      q
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_INVITE_LINKS_FETCHED", req.locale))
      );
  }
);

export const revokeCommunityInviteLink = asyncHandler(
  async (req: Request, res: Response) => {
    const { id, linkId } = req.params as InviteLinkIdParams;
    const link = await communityService.revokeInviteLink(
      id,
      req.auth.userId,
      linkId
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(link, t("COMMUNITY_INVITE_LINK_REVOKED", req.locale))
      );
  }
);

export const redeemCommunityInviteLink = asyncHandler(
  async (req: Request, res: Response) => {
    const { code } = req.params as InviteLinkCodeParams;
    const result = await communityService.redeemInviteLink(
      code,
      req.auth.userId
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_INVITE_LINK_REDEEMED", req.locale))
      );
  }
);

export const bulkSendCommunityInviteLink = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const body = req.body as BulkSendInviteLinkInput;
    const result = await communityService.bulkSendInviteLink(
      id,
      req.auth.userId,
      body
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("COMMUNITY_INVITE_LINK_BULK_SENT", req.locale)
        )
      );
  }
);

// ---------------------------------------------------------------------------
// Admin category CRUD
// ---------------------------------------------------------------------------

export const adminListCategories = asyncHandler(
  async (req: Request, res: Response) => {
    const query = req.query as unknown as AdminCategoriesQuery;
    const result = await communityService.listCategoriesAdmin({
      search: query.search,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });
    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_CATEGORIES_FETCHED", req.locale))
      );
  }
);

export const adminCreateCategory = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as CreateCategoryInput;
    const category = await communityService.createCategory(body);
    return res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(category, "Category created"));
  }
);

export const adminUpdateCategory = asyncHandler(
  async (req: Request, res: Response) => {
    const { categoryId } = req.params as CategoryIdParams;
    const body = req.body as UpdateCategoryInput;
    const category = await communityService.updateCategory(categoryId, body);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(category, "Category updated"));
  }
);

export const adminDeleteCategory = asyncHandler(
  async (req: Request, res: Response) => {
    const { categoryId } = req.params as CategoryIdParams;
    await communityService.deleteCategory(categoryId);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, "Category deleted"));
  }
);
