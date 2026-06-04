import { NotFoundError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { buildMeta } from "../../lib/response-meta.js";
import { communityService } from "../../services/index.js";
import type { ListCommunitiesQuery } from "../../types/community.types.js";
import type {
  BulkCloseInput,
  BulkReopenInput,
  CloseCommunityInput,
  ListCommunitiesQueryInput,
  ReopenCommunityInput,
} from "../validators/index.js";

/** GET /v1/communities — paginated, filtered list. */
export const listCommunities: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListCommunitiesQueryInput;
      const result = await communityService.listCommunities(
        query as ListCommunitiesQuery
      );
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
        meta: buildMeta(req),
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/communities/:communityId — full detail. */
export const getCommunityDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by communityIdParamSchema on the route.
      const communityId = req.params.communityId as string;
      const community = await communityService.getCommunity(communityId);
      if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");
      res.status(200).json({
        success: true,
        data: community,
        meta: buildMeta(req),
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
      res.status(200).json({
        success: true,
        data: result,
        meta: buildMeta(req),
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
      res.status(200).json({
        success: true,
        data: result,
        meta: buildMeta(req),
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
        meta: buildMeta(req),
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
        meta: buildMeta(req),
      });
    } catch (error) {
      next(error);
    }
  })();
};
