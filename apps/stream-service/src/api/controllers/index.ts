import type { Request, Response } from "express";
import { asyncHandler, ApiResponse } from "@aimess/utils";
import { BadRequestError } from "@aimess/errors";
import { HTTP_STATUS, t } from "@aimess/constants";

import type { LivestreamService } from "../../services/livestream.service.js";
import type { LivestreamCommentService } from "../../services/livestream-comment.service.js";
import {
  createStreamSchema,
  listStreamsQuerySchema,
  updateStreamSchema,
  commentsQuerySchema,
  banUserSchema,
  setCommentStatusSchema,
  reportCommentSchema,
  reportsQuerySchema,
} from "../validators/index.js";

export class StreamController {
  constructor(
    private readonly livestreamService: LivestreamService,
    private readonly commentService: LivestreamCommentService
  ) {}

  createStream = asyncHandler(async (req: Request, res: Response) => {
    const parsed = createStreamSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.createStream({
      communityId: parsed.data.communityId,
      creatorId: req.auth.userId,
      title: parsed.data.title,
      description: parsed.data.description,
      thumbnail: parsed.data.thumbnail,
      sourceType: parsed.data.sourceType,
      sourceUrl: parsed.data.sourceUrl,
    });

    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("STREAM_CREATED", req.locale)));
  });

  listStreams = asyncHandler(async (req: Request, res: Response) => {
    const parsed = listStreamsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.listStreams(parsed.data);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("STREAM_LIST_FETCHED", req.locale)));
  });

  getStream = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.getStream(id, req.auth.userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("STREAM_FETCHED", req.locale)));
  });

  updateStream = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const parsed = updateStreamSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.updateStream(
      id,
      req.auth.userId,
      parsed.data
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("STREAM_UPDATED", req.locale)));
  });

  deleteStream = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    await this.livestreamService.deleteStream(id, req.auth.userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ deleted: id }, t("STREAM_DELETED", req.locale)));
  });

  stopStream = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.stopStream(id, req.auth.userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("STREAM_STOPPED", req.locale)));
  });

  goLive = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.markLive(id, req.auth.userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("STREAM_WENT_LIVE", req.locale)));
  });

  getComments = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const parsed = commentsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.commentService.getComments(id, parsed.data);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("STREAM_COMMENTS_FETCHED", req.locale)));
  });

  getViewers = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const items = await this.livestreamService.getViewers(id, req.auth.userId);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse({ items }, t("STREAM_VIEWERS_FETCHED", req.locale))
      );
  });

  // Owner enables/disables live chat for the stream.
  setCommentStatus = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const parsed = setCommentStatusSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.setCommentStatus(
      id,
      req.auth.userId,
      parsed.data.enabled
    );
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("STREAM_COMMENT_STATUS_UPDATED", req.locale))
      );
  });

  // Owner bans a user from the stream (kicks them live + blocks rejoin).
  banUser = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const parsed = banUserSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    await this.livestreamService.banUser(
      id,
      req.auth.userId,
      parsed.data.userId,
      parsed.data.reason
    );
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { banned: parsed.data.userId },
          t("STREAM_USER_BANNED", req.locale)
        )
      );
  });

  // Owner lifts a ban.
  unbanUser = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    const userId =
      typeof req.params.userId === "string" ? req.params.userId : "";
    if (!id || !userId) throw new BadRequestError("STREAM_REQUEST_INVALID");

    await this.livestreamService.unbanUser(id, req.auth.userId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { unbanned: userId },
          t("STREAM_USER_UNBANNED", req.locale)
        )
      );
  });

  // Owner lists banned users.
  listBans = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const items = await this.livestreamService.listBans(id, req.auth.userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ items }, t("STREAM_BANS_FETCHED", req.locale)));
  });

  // Any authenticated viewer reports a live chat comment.
  reportComment = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    const commentId =
      typeof req.params.commentId === "string" ? req.params.commentId : "";
    if (!id || !commentId) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const parsed = reportCommentSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.commentService.reportComment({
      commentId,
      livestreamId: id,
      reportedBy: req.auth.userId,
      reason: parsed.data.reason,
      details: parsed.data.details,
    });

    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("STREAM_COMMENT_REPORTED", req.locale)));
  });

  // Owner or community ADMIN/MODERATOR lists reported comments for a stream.
  listCommentReports = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const parsed = reportsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.commentService.listReports({
      livestreamId: id,
      requesterId: req.auth.userId,
      limit: parsed.data.limit,
      before: parsed.data.before,
    });

    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("STREAM_COMMENT_REPORTS_FETCHED", req.locale))
      );
  });
}
