import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import type { PrivateRoomService } from "../../services/private-room.service.js";

export class PrivateRoomController {
  constructor(private readonly service: PrivateRoomService) {}

  // Same id-shape disambiguation as getRoomDetails below: a caller that POSTs
  // the room's OWN id here (rather than a peer's userId) almost certainly
  // wants that room's details, not "create a room with peer <roomId>" (which
  // would 403 CHAT_FRIENDSHIP_REQUIRED — a bogus id is never a real friend).
  // Routes to the same read-only, friendship-independent lookup as the GET
  // handler so this endpoint can never misfire a friendship gate off a room id.
  getOrCreateRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const idOrPeerId = req.params.peerId as string;
    if (idOrPeerId.startsWith("prv_")) {
      const details = await this.service.getRoomDetailsById(userId, idOrPeerId);
      res.status(HTTP_STATUS.OK).json(new ApiResponse(details));
      return;
    }
    const room = await this.service.getOrCreateRoom(userId, idOrPeerId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(room));
  });

  // Accepts EITHER the room's own id (`prv_<id>` — see lib/room-id.ts, a pure
  // read, never creates, never friendship-gated) OR a peer's userId (get-or-
  // create + friendship-gated on first contact) — same URL shape, disambiguated
  // by the id's own format so existing peerId-based clients keep working
  // unchanged. See PrivateRoomService.getRoomDetailsById's doc for why a room
  // must be reachable by its own id independently of friendship state.
  getRoomDetails = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const idOrPeerId = req.params.peerId as string;
    const details = idOrPeerId.startsWith("prv_")
      ? await this.service.getRoomDetailsById(userId, idOrPeerId)
      : await this.service.getRoomDetails(userId, idOrPeerId);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(details, t("CHAT_ROOM_DETAILS_FETCHED", req.locale))
      );
  });

  // Cursor (before_ts/after_ts, epoch ms) pagination — same query-param
  // contract and exact-hasMore semantics as community's `GET /communities/mine`
  // (before_ts/after_ts/limit only; same limit bounds). Express 5's req.query
  // is read-only, so validateQuery only rejects malformed input — this still
  // parses the raw strings itself (same convention as every other controller
  // in this file).
  getConversationList = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const beforeTs = req.query.before_ts
      ? Number(req.query.before_ts)
      : undefined;
    const afterTs = req.query.after_ts ? Number(req.query.after_ts) : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    const direction = afterTs != null ? "after" : "before";
    const tsMs = afterTs ?? beforeTs ?? Date.now();

    const paginated = await this.service.listMine(userId, {
      direction,
      ts: new Date(tsMs),
      limit,
    });
    const msg = paginated.data.length
      ? t("CHAT_CONVERSATIONS_FETCHED", req.locale)
      : t("CHAT_NO_CONVERSATIONS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  deleteForMe = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    await this.service.deleteForMe(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("CHAT_CONVERSATION_DELETED", req.locale)));
  });

  muteRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { muteUntil } = req.body as { muteUntil?: string | null };
    const result = await this.service.muteRoom(
      roomId,
      userId,
      muteUntil ? new Date(muteUntil) : null
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_ROOM_MUTED", req.locale)));
  });

  unmuteRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const result = await this.service.unmuteRoom(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_ROOM_UNMUTED", req.locale)));
  });

  archiveRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const result = await this.service.archiveRoom(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_ROOM_ARCHIVED", req.locale)));
  });

  unarchiveRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const result = await this.service.unarchiveRoom(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_ROOM_UNARCHIVED", req.locale)));
  });
}
