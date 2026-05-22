import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import { communityService } from "../../services/community.service.js";
import type {
  AddMembersInput,
  AuditLogsQuery,
  CommunityIdParams,
  CommunityMemberParams,
  CreateCommunityInput,
  HandleAvailableQuery,
  ListMembersQuery,
  ModerationReasonInput,
  MyCommunitiesQuery,
  NameAvailableQuery,
  UpdateCommunityInput,
  UpdateMemberRoleInput,
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

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_NAME_AVAILABILITY", req.locale))
      );
  }
);

export const checkHandleAvailable = asyncHandler(
  async (req: Request, res: Response) => {
    const { handle } = req.query as unknown as HandleAvailableQuery;
    const result = await communityService.checkHandleAvailability(handle);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("COMMUNITY_HANDLE_AVAILABILITY", req.locale))
      );
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
    const { cursor, limit } = req.query as unknown as MyCommunitiesQuery;
    const result = await communityService.listMine(req.auth.userId, {
      cursor,
      limit,
    });

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("COMMUNITY_LIST_FETCHED", req.locale)));
  }
);

export const listCommunityMembers = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as CommunityIdParams;
    const { cursor, limit, status } = req.query as unknown as ListMembersQuery;

    const result = await communityService.listMembers(id, req.auth.userId, {
      cursor,
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
    const { cursor, limit } = req.query as unknown as AuditLogsQuery;

    const result = await communityService.listAuditLogs(id, req.auth.userId, {
      cursor,
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

    const member = await communityService.leaveCommunity(id, req.auth.userId);

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
