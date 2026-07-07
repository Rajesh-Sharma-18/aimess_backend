import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { RecordRecentSearchBody } from "../validators/recent-search.validator.js";
import { recentSearchService } from "../../services/recent-search.service.js";

export const listRecentSearches = asyncHandler(
  async (req: Request, res: Response) => {
    const searches = await recentSearchService.list(req.auth.userId);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ searches }, t("SUCCESS", req.locale)));
  }
);

export const recordRecentSearch = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as RecordRecentSearchBody;
    await recentSearchService.record({
      userId: req.auth.userId,
      searchedUserId: body.searchedUserId,
      query: body.query,
    });
    return res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(null, t("SUCCESS", req.locale)));
  }
);

export const deleteRecentSearch = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const deleted = await recentSearchService.deleteOne(id, req.auth.userId);
    if (!deleted) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        message: t("NOT_FOUND", req.locale),
      });
    }
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("SUCCESS", req.locale)));
  }
);

export const clearRecentSearches = asyncHandler(
  async (req: Request, res: Response) => {
    await recentSearchService.clearAll(req.auth.userId);
    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("SUCCESS", req.locale)));
  }
);
