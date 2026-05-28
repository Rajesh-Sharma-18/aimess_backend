import { Router, type IRouter } from "express";
import { asyncHandler } from "@aimess/utils";
import { HTTP_STATUS } from "@aimess/constants";
import { ApiResponse } from "@aimess/utils";
import type { Request, Response } from "express";
import type { MessagingClient } from "../../grpc/clients/messaging.client.js";

export function createWebRtcRouter(messagingClient: MessagingClient): IRouter {
  const router = Router();

  router.get(
    "/rtc-config",
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await messagingClient.getRtcConfig();
        return res
          .status(HTTP_STATUS.OK)
          .json(
            new ApiResponse(result.rtcConfig, "RTC configuration retrieved")
          );
      } catch {
        return res
          .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
          .json(new ApiResponse(null, "RTC service temporarily unavailable"));
      }
    })
  );

  return router;
}
