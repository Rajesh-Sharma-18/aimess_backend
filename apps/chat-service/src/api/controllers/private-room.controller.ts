import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import type { PrivateRoomService } from "../../services/private-room.service.js";
import type { AutoDeleteService } from "../../services/auto-delete.service.js";

export class PrivateRoomController {
  constructor(
    private readonly service: PrivateRoomService,
    private readonly autoDeleteService: AutoDeleteService
  ) {}

  // Same id-shape disambiguation as getRoomDetails below: a caller that POSTs
  // the room's OWN id here (rather than a peer's userId) almost certainly
  // wants that room's details, not "create a room with peer <roomId>".
  // Routes to the same read-only, friendship-independent lookup as the GET
  // handler so this endpoint can never misfire a friendship gate off a room id.
  getOrCreateRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const idOrPeerId = req.params.peerId as string;
    // Both branches return the enriched `PrivateRoomDetailsData` shape (peer
    // snapshot, avatar, presence, unread, mute, friendship + user-search-shaped
    // relationship metadata) so GET and POST on the same URL are consistent.
    const details = idOrPeerId.startsWith("prv_")
      ? await this.service.getRoomDetailsById(userId, idOrPeerId)
      : await this.service.getRoomDetails(userId, idOrPeerId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(details));
  });

  // THE pair-state resolver — every entry point that can open a DM (chat list,
  // search, recent searches, contact list, profile, group-member profile,
  // notification tap, deep link, forward target) is meant to render from this
  // one response, so the same pair cannot resolve to two different screens.
  //
  // Accepts EITHER the room's own id (`prv_<id>` — see lib/room-id.ts, a pure
  // read, never creates, never friendship-gated) OR a peer's userId (get-or-
  // create for friends; a `pairState` verdict for everyone else, where this
  // used to 403) — same URL shape, disambiguated by the id's own format so
  // existing peerId-based clients keep working unchanged. Both branches carry
  // `pairState`; read that before `friendship`/`relationship`, which each
  // describe one axis and cannot decide a screen on their own.
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

  clearChat = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    await this.service.clearChat(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("CHAT_CLEARED", req.locale)));
  });

  // Report the peer of this conversation. Body carries the target explicitly so
  // the service can bind it to the room's participants rather than inferring it.
  reportUser = asyncHandler(async (req: Request, res: Response) => {
    const { userId: reporterId } = req.auth;
    const roomId = req.params.roomId as string;
    const { userId, reason, description } = req.body as {
      userId: string;
      reason: string;
      description?: string;
    };
    const result = await this.service.reportUser({
      roomId,
      reporterId,
      targetUserId: userId,
      reason,
      description,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
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

  // Automatically Delete Messages (disappearing messages). One-sided by design:
  // the caller sets only their OWN timer; the peer is informed, never asked.
  getAutoDelete = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const result = await this.autoDeleteService.getSettings(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_AUTO_DELETE_FETCHED", req.locale)));
  });

  setAutoDelete = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { mode, ttlSeconds } = req.body as {
      mode: string;
      ttlSeconds?: number | null;
    };
    const result = await this.autoDeleteService.updateSetting(roomId, userId, {
      mode,
      ttlSeconds: ttlSeconds ?? null,
    });
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_AUTO_DELETE_UPDATED", req.locale)));
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
