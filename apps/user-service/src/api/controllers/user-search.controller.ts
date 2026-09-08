import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { NotFoundError } from "@aimess/errors";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  GroupSearchQuery,
  RecordRecentUserSearchBody,
  RemoveRecentUserSearchParams,
  RemoveRecentUserSearchQuery,
  UnifiedSearchQuery,
} from "../validators/user-search.validator.js";
import { userSearchService } from "../../services/user-search.service.js";

export const recordRecentUserSearch = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as RecordRecentUserSearchBody;
    await userSearchService.recordRecent({
      userId: req.auth.userId,
      targetType: body.targetType,
      targetId: body.targetId,
    });
    return res
      .status(HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(null, t("USER_RECENT_SEARCH_RECORDED", req.locale))
      );
  }
);

export const removeRecentUserSearch = asyncHandler(
  async (req: Request, res: Response) => {
    const { targetId } = req.params as unknown as RemoveRecentUserSearchParams;
    const { targetType } = req.query as unknown as RemoveRecentUserSearchQuery;
    const deleted = await userSearchService.removeRecent({
      userId: req.auth.userId,
      targetType,
      targetId,
    });
    if (!deleted) {
      // Thrown, not written: `asyncHandler` forwards it to the shared error
      // handler, which is the only place the error envelope is built.
      throw new NotFoundError("RECENT_SEARCH_NOT_FOUND");
    }
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("RECENT_SEARCH_DELETED", req.locale)));
  }
);

export const clearRecentUserSearches = asyncHandler(
  async (req: Request, res: Response) => {
    await userSearchService.clearRecent(req.auth.userId);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("RECENT_SEARCH_CLEARED", req.locale)));
  }
);

export const searchUsersUnified = asyncHandler(
  async (req: Request, res: Response) => {
    const query = req.query as unknown as UnifiedSearchQuery;
    const result = query.q?.trim()
      ? await userSearchService.searchByQuery(req.auth.userId, query)
      : await userSearchService.searchRecent(req.auth.userId);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("USERS_FETCHED", req.locale)));
  }
);

/**
 * GET /api/v1/users/search/groups?q=&limit=&cursor=
 *
 * Groups the caller ACTIVELY belongs to. A separate endpoint rather than a flag
 * on the unified search because the two page differently: people walk a keyset,
 * groups walk an offset over the caller's own membership rows.
 */
export const searchGroups = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as GroupSearchQuery;
  const result = await userSearchService.searchGroups(req.auth.userId, query);
  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(result, t("USERS_FETCHED", req.locale)));
});
