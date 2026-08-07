import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import type { ConversationBulkService } from "../../services/conversation-bulk.service.js";
import type {
  BulkLeaveConversationsInput,
  BulkMarkReadConversationsInput,
  BulkMuteConversationsInput,
} from "../validators/conversation-bulk.validator.js";

export class ConversationBulkController {
  constructor(private readonly service: ConversationBulkService) {}

  bulkLeave = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { roomIds, groupAction } = req.body as BulkLeaveConversationsInput;
    const result = await this.service.bulkLeave(userId, roomIds, groupAction);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("CHAT_CONVERSATIONS_BULK_LEFT", req.locale))
      );
  });

  bulkMute = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { action, roomIds, durationMinutes } =
      req.body as BulkMuteConversationsInput;

    if (action === "unmute") {
      const result = await this.service.bulkUnmute(userId, roomIds);
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("CHAT_ROOM_UNMUTED", req.locale)));
      return;
    }

    const result = await this.service.bulkMute(
      userId,
      roomIds,
      durationMinutes
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_ROOM_MUTED", req.locale)));
  });

  bulkMarkRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { roomIds } = req.body as BulkMarkReadConversationsInput;
    const result = await this.service.bulkMarkRead(userId, roomIds);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("CHAT_CONVERSATIONS_BULK_READ", req.locale))
      );
  });
}
