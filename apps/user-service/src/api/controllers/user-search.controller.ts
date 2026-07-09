import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  RecordRecentUserSearchBody,
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

export const searchUsersUnified = asyncHandler(
  async (req: Request, res: Response) => {
    const query = req.query as unknown as UnifiedSearchQuery;
    const result = await userSearchService.search(req.auth.userId, query);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("USERS_FETCHED", req.locale)));
  }
);
