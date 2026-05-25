import type { Namespace, Socket } from "socket.io";

import {
  GENERAL_EVENTS,
  GENERAL_PREFIX,
  GENERAL_HOME_LOBBY,
} from "../../types/socket-events.js";
import {
  validateSocketPayload,
  handleSocketAction,
  formatSocketResponse,
} from "../helpers/validate-socket.js";
import {
  sendCommunityMessageSchema,
  reactCommunityMessageSchema,
} from "../../api/validators/community.validator.js";
import { SocketGuard } from "../guards/socket-guard.js";
import type { CommunityMessageService } from "../../services/community-message.service.js";
import type { CommunityRoomService } from "../../services/community-room.service.js";
import type { CacheRepository } from "../../repositories/cache.repository.js";
import type { GeneralRoomRepository } from "../../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../../repositories/room-member.repository.js";

type SocketCallback = (response: Record<string, unknown>) => void;

export function registerCommunityMessageHandler(
  io: Namespace,
  socket: Socket,
  deps: {
    communityMessageService: CommunityMessageService;
    communityRoomService: CommunityRoomService;
    cacheRepo: CacheRepository;
    generalRoomRepo: GeneralRoomRepository;
    roomMemberRepo: RoomMemberRepository;
  }
): void {
  const {
    communityMessageService,
    communityRoomService,
    cacheRepo,
    generalRoomRepo,
  } = deps;

  const buildRoomChannel = (roomId: string) => `${GENERAL_PREFIX}:${roomId}`;

  const joinHome = async (
    _payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      socket.join(GENERAL_HOME_LOBBY);
      const userId = socket.user.userId;
      const rooms = await communityRoomService.getRooms(userId);
      formatSocketResponse(callback, { rooms });
    }, callback);
  };

  const leaveHome = async (
    _payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      socket.leave(GENERAL_HOME_LOBBY);
      formatSocketResponse(callback, { message: "Left home" });
    }, callback);
  };

  const joinRoom = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const roomId = payload.roomId as string;
      if (!roomId) return;

      const { userId } = socket.user;
      await communityRoomService.assertNotBanned(roomId, userId);

      const room = await generalRoomRepo.findRoomById(roomId);
      if (!room) {
        callback({ return_code: "ERROR", message: "Room not found" });
        return;
      }

      const roomName = buildRoomChannel(roomId);
      socket.join(roomName);

      // Mark as read
      const timestamp = room.lastMessageAt
        ? new Date(room.lastMessageAt).getTime()
        : Date.now();
      await cacheRepo.markGeneralRoomRead(userId, roomId, timestamp);

      const messages = await communityMessageService.getMessages({
        roomId,
        userId,
        limit: 20,
      });

      formatSocketResponse(callback, { messages });
      io.to(roomName).emit(`${GENERAL_PREFIX}:nofify:join`, {
        userId,
        username: socket.user.username,
        timestamp: new Date(),
      });
    }, callback);
  };

  const loadMoreMessages = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const roomId = payload.roomId as string;
      const lastMessageDate = payload.lastMessageDate as string;
      const messages = await communityMessageService.getMessages({
        roomId,
        userId: socket.user.userId,
        cursor: lastMessageDate,
        limit: 20,
      });
      formatSocketResponse(callback, { messages });
    }, callback);
  };

  const addNewMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        sendCommunityMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      SocketGuard.requireAuth(socket);

      const { userId } = socket.user;
      await communityRoomService.assertNotBanned(value.roomId, userId);

      // Location and contact attachments live as typed items alongside any
      // uploaded media files.
      const attachments: Array<Record<string, unknown>> = [
        ...(value.media?.files ?? []),
      ];
      if (value.location) {
        attachments.push({ type: "location", ...value.location });
      }
      if (value.contact) {
        attachments.push({ type: "contact", ...value.contact });
      }

      const message = await communityMessageService.sendMessage({
        roomId: value.roomId,
        sentBy: userId,
        senderName: value.displayname || value.username,
        senderAvatar: value.avatar || "",
        message: value.message || "",
        messageType: value.messageType,
        parentMessageId: value.parentMessageId,
        clientMessageId: value.clientMessageId,
        attachments: attachments.length ? attachments : undefined,
      });

      await cacheRepo.markGeneralRoomRead(
        userId,
        value.roomId,
        message.createdAt?.getTime() || Date.now()
      );

      const roomName = buildRoomChannel(value.roomId);
      io.to(roomName).emit(`${roomName}:message:add:new`, message);

      // Notify home lobby
      io.to(GENERAL_HOME_LOBBY).emit(GENERAL_HOME_LOBBY, {
        action: "last-message:update",
        roomId: value.roomId,
        lastMessageAt: message.createdAt || null,
        latestMessage: {
          senderId: message.sentBy,
          senderName: message.senderName,
          message: message.message,
          messageType: message.messageType,
          createdAt: message.createdAt,
        },
      });

      formatSocketResponse(callback, { message });
    }, callback);
  };

  const reactMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        reactCommunityMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const message = await communityMessageService.react(
        value.messageId,
        value.reactions
      );
      const roomName = `${GENERAL_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${GENERAL_PREFIX}:message:react:new`, message);
      formatSocketResponse(callback, { message });
    }, callback);
  };

  // Register events
  socket.on(GENERAL_EVENTS.HOME_JOIN, joinHome);
  socket.on(GENERAL_EVENTS.HOME_LEAVE, leaveHome);
  socket.on(GENERAL_EVENTS.USER_JOIN, joinRoom);
  socket.on(GENERAL_EVENTS.MESSAGES_LOAD_MORE, loadMoreMessages);
  socket.on(GENERAL_EVENTS.MESSAGE_ADD, addNewMessage);
  socket.on(GENERAL_EVENTS.MESSAGE_REACT, reactMessage);
}
