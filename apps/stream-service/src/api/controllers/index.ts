import type { Request, Response } from "express";
import { asyncHandler, ApiResponse } from "@aimess/utils";
import { BadRequestError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";

import type { LivestreamService } from "../../services/livestream.service.js";
import type { LivestreamCommentService } from "../../services/livestream-comment.service.js";
import {
  createStreamSchema,
  listStreamsQuerySchema,
  updateStreamSchema,
  commentsQuerySchema,
  banUserSchema,
  setCommentStatusSchema,
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

    res.status(HTTP_STATUS.CREATED).json(new ApiResponse(result));
  });

  listStreams = asyncHandler(async (req: Request, res: Response) => {
    const parsed = listStreamsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.listStreams(parsed.data);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  getStream = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.getStream(id, req.auth.userId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
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
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  deleteStream = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    await this.livestreamService.deleteStream(id, req.auth.userId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ deleted: id }));
  });

  stopStream = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.livestreamService.stopStream(id, req.auth.userId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  getComments = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const parsed = commentsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const result = await this.commentService.getComments(id, parsed.data);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  getViewers = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const items = await this.livestreamService.getViewers(id, req.auth.userId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ items }));
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
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
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
      .json(new ApiResponse({ banned: parsed.data.userId }));
  });

  // Owner lifts a ban.
  unbanUser = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    const userId =
      typeof req.params.userId === "string" ? req.params.userId : "";
    if (!id || !userId) throw new BadRequestError("STREAM_REQUEST_INVALID");

    await this.livestreamService.unbanUser(id, req.auth.userId, userId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ unbanned: userId }));
  });

  // Owner lists banned users.
  listBans = asyncHandler(async (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) throw new BadRequestError("STREAM_REQUEST_INVALID");

    const items = await this.livestreamService.listBans(id, req.auth.userId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ items }));
  });
}
