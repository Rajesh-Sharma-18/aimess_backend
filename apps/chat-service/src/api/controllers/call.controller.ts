import type { Request, Response } from "express";
import { ApiResponse, asyncHandler } from "@aimess/utils";
import { NotFoundError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";
import type { CallService } from "../../services/call.service.js";

export class CallController {
  constructor(private readonly callService: CallService) {}

  getCallHistory = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const result = await this.callService.getCallHistory({
      userId,
      cursor: cursor ?? null,
      limit,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  getActiveIncoming = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const calls = await this.callService.getActiveIncoming(userId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(calls));
  });

  getCallById = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const callId = req.params.callId as string;
    const call = await this.callService.getCallByCallId(callId, userId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    res.status(HTTP_STATUS.OK).json(new ApiResponse(call));
  });

  /**
   * REST twins of the `call:answer` / `call:decline` / `call:end` socket events.
   *
   * The socket is still the primary transport — it carries the ack and keeps the
   * client in `call:<id>` — but it is not always AVAILABLE. iOS tears the socket
   * down whenever the app leaves the foreground, and a device woken by a VoIP
   * push (or launched by a notification action) has no UI scene and therefore no
   * socket at all. A decline taken from the lock screen was simply lost in that
   * state, leaving the caller ringing until the 60s missed sweep.
   *
   * These hit the SAME CallService methods, so every gate, state transition,
   * Redis fan-out, push and timeline card is identical — there is no second
   * call-state path to keep in sync, only a second way in.
   */
  answerCall = asyncHandler(async (req: Request, res: Response) => {
    // `sessionId` is the acting device, forwarded so the "handled elsewhere" /
    // "ring dismissed" backstop push skips it. This is the entry point that
    // needs it most: a lock-screen action taken with no socket at all.
    const { userId, sessionId } = req.auth;
    const callId = req.params.callId as string;
    const { legId } = req.body as { legId?: string };
    const call = await this.callService.answerCall({
      callId,
      calleeId: userId,
      legId,
      sessionId,
    });
    // Same shape the `call:answer` ack returns, so the client parses one thing.
    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        callId: call.callId,
        status: call.status,
        livekitUrl: call.livekit.url,
        token: call.livekit.token,
        // In-call timer origin, epoch ms. Carried here as well as on the socket
        // ack — this is the lock-screen path, which has no socket at all, so it
        // is exactly where the client would otherwise fall back to its own clock.
        answeredAt: call.answeredAt?.getTime() ?? 0,
      })
    );
  });

  declineCall = asyncHandler(async (req: Request, res: Response) => {
    const { userId, sessionId } = req.auth;
    const callId = req.params.callId as string;
    const call = await this.callService.declineCall({
      callId,
      calleeId: userId,
      sessionId,
    });
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ callId: call.callId, status: call.status }));
  });

  endCall = asyncHandler(async (req: Request, res: Response) => {
    const { userId, sessionId } = req.auth;
    const callId = req.params.callId as string;
    const { legId } = req.body as { legId?: string };
    const call = await this.callService.endCall({
      callId,
      userId,
      legId,
      sessionId,
    });
    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        callId: call.callId,
        status: call.status,
        durationSec: call.durationSec,
      })
    );
  });
}
