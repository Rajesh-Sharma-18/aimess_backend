import { NotFoundError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { communityService } from "../../services/index.js";
import type {
  CommunityDetail,
  CommunityDetailResponse,
  ListCommunitiesQuery,
  ListCommunityMembersQuery,
  ListMutedMembersQuery,
} from "../../types/community.types.js";
import type {
  BulkCloseInput,
  BulkReopenInput,
  CloseCommunityInput,
  ListCommunitiesQueryInput,
  ListCommunityMembersQueryInput,
  ListMutedMembersQueryInput,
  ReopenCommunityInput,
} from "../validators/index.js";
import { HTTP_STATUS } from "@aimess/constants";

/** GET /v1/communities — paginated, filtered list. */
export const listCommunities: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListCommunitiesQueryInput;
      const result = await communityService.listCommunities(
        query as ListCommunitiesQuery,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * Reshape the repository's internal {@link CommunityDetail} into the
 * GET /communities/{communityId} wire response: `community`/`owner`
 * sub-objects are inlined onto the root (no nested wrappers), `memberStats`/
 * `livestreamStats` collapse from an object to a single number, and
 * `moderationHistory`/`settingsSummary`/`partial` are dropped. No new
 * queries — pure projection of data the repository already fetched.
 */
function toCommunityDetailResponse(
  community: CommunityDetail
): CommunityDetailResponse {
  const { community: core, owner } = community;
  return {
    communityId: core.communityId,
    communityName: core.name,
    communityHandle: core.handle,
    communityAvatar: core.avatar,
    communityType: core.type,
    category: core.category,
    status: core.status,
    createdAt: core.createdAt,
    description: core.description,
    coverUrl: core.coverUrl,
    lastActivityAt: core.lastActivityAt,
    ownerId: owner.userId,
    ownerName: owner.displayName,
    ownerUsername: owner.username,
    ownerAvatar: owner.avatar,
    ownerEmail: owner.email,
    ownerAccountStatus: owner.accountStatus,
    membersCount: community.memberStats.total,
    liveStreamsCount: community.livestreamStats?.total ?? 0,
  };
}

/** GET /v1/communities/:communityId — full detail. */
export const getCommunityDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by communityIdParamSchema on the route.
      const communityId = req.params.communityId as string;
      const community = await communityService.getCommunity(communityId);
      if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: toCommunityDetailResponse(community),
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/communities/:communityId/members — paginated member grid. */
export const listCommunityMembers: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by communityIdParamSchema on the route.
      const communityId = req.params.communityId as string;
      const query = req.query as unknown as ListCommunityMembersQueryInput;
      const result = await communityService.listCommunityMembers(
        communityId,
        query as ListCommunityMembersQuery
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/communities/:communityId/muted-members — currently-muted members. */
export const listCommunityMutedMembers: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by communityIdParamSchema on the route.
      const communityId = req.params.communityId as string;
      const query = req.query as unknown as ListMutedMembersQueryInput;
      const result = await communityService.listMutedMembers(
        communityId,
        query as ListMutedMembersQuery
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/communities/:communityId/close. */
export const closeCommunity: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by communityIdParamSchema on the route.
      const communityId = req.params.communityId as string;
      const body = req.body as CloseCommunityInput;
      const result = await communityService.closeCommunity(
        communityId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/communities/:communityId/reopen. */
export const reopenCommunity: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by communityIdParamSchema on the route.
      const communityId = req.params.communityId as string;
      const body = req.body as ReopenCommunityInput;
      const result = await communityService.reopenCommunity(
        communityId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/communities/bulk/close — 207 Multi-Status. */
export const bulkCloseCommunities: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { communityIds, ...input } = req.body as BulkCloseInput;
      const result = await communityService.bulkClose(
        communityIds,
        input,
        req.admin!,
        getRequestContext(req)
      );
      res.status(207).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/communities/bulk/reopen — 207 Multi-Status. */
export const bulkReopenCommunities: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { communityIds, ...input } = req.body as BulkReopenInput;
      const result = await communityService.bulkReopen(
        communityIds,
        input,
        req.admin!,
        getRequestContext(req)
      );
      res.status(207).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};
