import type { Namespace, Socket } from "socket.io";

import {
  LIVESTREAM_EVENTS,
  LIVESTREAM_PREFIX,
} from "../../types/socket-events.js";
import {
  handleSocketAction,
  formatSocketResponse,
} from "../helpers/validate-socket.js";
import { SocketGuard } from "../guards/socket-guard.js";
import type { LivestreamCommentService } from "../../services/livestream-comment.service.js";

type SocketCallback = (response: Record<string, unknown>) => void;

export function registerLivestreamHandler(
  io: Namespace,
  socket: Socket,
  deps: { livestreamCommentService: LivestreamCommentService }
): void {
  const { livestreamCommentService } = deps;

  const joinLivestream = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const livestreamId = payload.livestreamId as string;
      if (!livestreamId) return;
      const roomName = `${LIVESTREAM_PREFIX}:${livestreamId}`;
      socket.join(roomName);
      formatSocketResponse(callback, { status: "ok" });
    }, callback);
  };

  const leaveLivestream = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const livestreamId = payload.livestreamId as string;
      if (!livestreamId) return;
      const roomName = `${LIVESTREAM_PREFIX}:${livestreamId}`;
      socket.leave(roomName);
      formatSocketResponse(callback, { status: "ok" });
    }, callback);
  };

  const addComment = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const livestreamId = payload.livestreamId as string;
      const roomId = payload.roomId as string;
      const message = payload.message as string;
      const clientCommentId = payload.clientCommentId as string | undefined;

      if (!livestreamId || !message) return;

      const { userId } = socket.user;

      const comment = await livestreamCommentService.addComment({
        livestreamId,
        roomId: roomId || "",
        userId,
        userName: socket.user.displayname || "",
        userAvatar: "",
        message,
        clientCommentId,
      });

      const roomName = `${LIVESTREAM_PREFIX}:${livestreamId}`;
      io.to(roomName).emit(`${roomName}:comment:new`, comment);

      formatSocketResponse(
        callback,
        comment as unknown as Record<string, unknown>
      );
    }, callback);
  };

  const loadMoreComments = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const livestreamId = payload.livestreamId as string;
      const cursor = payload.cursor as string | undefined;
      if (!livestreamId) return;

      const comments = await livestreamCommentService.getComments(
        livestreamId,
        {
          limit: 30,
          before: cursor,
        }
      );

      formatSocketResponse(
        callback,
        comments as unknown as Record<string, unknown>
      );
    }, callback);
  };

  socket.on(LIVESTREAM_EVENTS.JOIN, joinLivestream);
  socket.on(LIVESTREAM_EVENTS.LEAVE, leaveLivestream);
  socket.on(LIVESTREAM_EVENTS.COMMENT_ADD, addComment);
  socket.on(LIVESTREAM_EVENTS.COMMENTS_LOAD_MORE, loadMoreComments);
}
