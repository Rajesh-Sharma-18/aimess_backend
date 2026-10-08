import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  PublicProfileQuery,
  SetCustomStatusInput,
  UpdateProfileInput,
} from "../validators/profile.validator.js";
import { customStatusService } from "../../services/custom-status.service.js";
import { userProfileService } from "../../services/user-profile.service.js";
import {
  credentialPlatformFor,
  listCustomCredentials,
} from "../../grpc/backoffice.client.js";

export const getMyProfile = asyncHandler(
  async (req: Request, res: Response) => {
    const [profile, credentials, customStatus] = await Promise.all([
      userProfileService.getMyProfile(req.auth.userId),
      listCustomCredentials(credentialPlatformFor(req.get("x-platform"))),
      customStatusService.getOwn(req.auth.userId),
    ]);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { ...profile, credentials, ...customStatus },
          t("USER_PROFILE_FETCHED", req.locale)
        )
      );
  }
);

export const updateProfile = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as UpdateProfileInput;

    const profile = await userProfileService.updateProfile(
      req.auth.userId,
      body,
      req.auth.sessionId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(profile, t("USER_PROFILE_UPDATED", req.locale)));
  }
);

/**
 * `GET /api/v1/users/:userId` — another user's profile, scoped to the viewer.
 *
 * `me` resolves to the caller. Clients were already sending it and, with no
 * param validation on this route, the literal string reached Prisma and blew up
 * with `invalid input syntax for type uuid: "me"` on every request. Anything
 * else that is not a UUID is rejected by `publicProfileParamsSchema` before it
 * gets here.
 */
export const getPublicProfile = asyncHandler(
  async (req: Request, res: Response) => {
    const requested = req.params.userId as string;
    const { groupId, communityId } = req.query as PublicProfileQuery;
    const profile = await userProfileService.getPublicProfile(
      req.auth.userId,
      requested === "me" ? req.auth.userId : requested,
      { groupId, communityId }
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(profile, t("USER_PROFILE_FETCHED", req.locale)));
  }
);

export const setCustomStatus = asyncHandler(async (req: Request, res: Response) => {
  const result = await customStatusService.set(
    req.auth.userId,
    req.body as SetCustomStatusInput
  );
  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(result, t("USER_CUSTOM_STATUS_UPDATED", req.locale)));
});

export const clearCustomStatus = asyncHandler(async (req: Request, res: Response) => {
  const result = await customStatusService.clear(req.auth.userId);
  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(result, t("USER_CUSTOM_STATUS_CLEARED", req.locale)));
});
