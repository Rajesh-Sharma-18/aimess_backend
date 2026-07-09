import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS } from "@aimess/constants";
import { BadRequestError } from "@aimess/errors";

import {
  buildAvailableContext,
  buildUnavailableContext,
  isMessageContentError,
  type MessageConversationType,
} from "../../lib/message-context.js";
import type { PrivateMessageService } from "../../services/private-message.service.js";
import type { GroupMessageService } from "../../services/group-message.service.js";
import type { CommunityMessageService } from "../../services/community-message.service.js";

const CONVERSATION_TYPES: readonly MessageConversationType[] = [
  "PRIVATE",
  "GROUP",
  "COMMUNITY",
];

/**
 * Single cross-conversation-type "message navigation context" API.
 *
 * `GET /chat/messages/:messageId/context?conversationType=PRIVATE|GROUP|COMMUNITY&roomId=<roomId>`
 *
 * One entry point for every "locate + scroll to a message I don't currently
 * have loaded" use case: reply-tap, pinned-message-tap, search-result-tap,
 * a shared/forwarded message deep link, or a push-notification deep link.
 * The caller only needs the (conversationType, roomId, messageId) triple —
 * the same triple already carried by a reply's `quoteData`, a pin record, a
 * search hit, or a notification's `navigation` payload.
 *
 * Delegates to each conversation type's EXISTING, already-access-guarded
 * service method (`PrivateMessageService`/`GroupMessageService.getMessageContext`,
 * `CommunityMessageService.assertMember` + `findMessageById`) — no duplicated
 * access-control or lookup logic. Response shaping (anchor/cursor, the
 * available/unavailable envelope) is centralized in `lib/message-context.ts`
 * and shared with the legacy per-type `.../messages/:messageId/context`
 * endpoints so both surfaces stay byte-for-byte consistent.
 *
 * Always HTTP 200 for a content-level result (`isAvailable` discriminates
 * found vs. deleted/missing). Access failures (not a participant/member, room
 * doesn't exist) propagate as normal 403/404 — never masked as "unavailable".
 */
export class MessageContextController {
  constructor(
    private readonly privateService: PrivateMessageService,
    private readonly groupService: GroupMessageService,
    private readonly communityService: CommunityMessageService
  ) {}

  getContext = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const roomId = req.query.roomId as string;
    const conversationType = (
      req.query.conversationType as string
    ).toUpperCase() as MessageConversationType;

    if (!CONVERSATION_TYPES.includes(conversationType)) {
      throw new BadRequestError("CHAT_INVALID_CONVERSATION_TYPE");
    }

    let sequenceNumber: number | null = null;
    let createdAt: Date | number;

    try {
      if (conversationType === "PRIVATE") {
        const message = await this.privateService.getMessageContext(
          roomId,
          messageId,
          userId
        );
        sequenceNumber = message.sequenceNumber;
        createdAt = message.createdAt;
      } else if (conversationType === "GROUP") {
        const message = await this.groupService.getMessageContext(
          roomId,
          messageId,
          userId
        );
        sequenceNumber = message.sequenceNumber;
        createdAt = message.createdAt;
      } else {
        // COMMUNITY: assertMember throws (403/404) on an access failure;
        // a null/foreign-room/deleted message is a content-level result.
        await this.communityService.assertMember(roomId, userId);
        const message = await this.communityService.findMessageById(
          messageId,
          roomId
        );
        if (
          !message ||
          (message as { deletedForAll?: boolean }).deletedForAll
        ) {
          res
            .status(HTTP_STATUS.OK)
            .json(
              new ApiResponse(
                buildUnavailableContext({ messageId, roomId, conversationType })
              )
            );
          return;
        }
        createdAt = message.createdAt;
      }
    } catch (err) {
      if (!isMessageContentError(err)) throw err;
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            buildUnavailableContext({ messageId, roomId, conversationType })
          )
        );
      return;
    }

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        buildAvailableContext({
          messageId,
          roomId,
          conversationType,
          sequenceNumber,
          createdAt,
        })
      )
    );
  });
}
