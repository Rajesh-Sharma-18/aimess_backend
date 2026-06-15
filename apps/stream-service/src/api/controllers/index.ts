import type { Request, Response } from "express";
import { asyncHandler, ApiResponse } from "@aimess/utils";
import { BadRequestError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";

import type { LivestreamService } from "../../services/livestream.service.js";
import type { LivestreamCommentService } from "../../services/livestream-comment.service.js";
import {
  createStreamSchema,
  listStreamsQuerySchema,
  commentsQuerySchema,
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

    const result = await this.livestreamService.getStream(id);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
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
}
