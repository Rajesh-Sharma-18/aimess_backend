import type { Namespace, Socket } from "socket.io";

import {
  PRIVATE_EVENTS,
  PRIVATE_PREFIX,
  PRIVATE_HOME_LOBBY,
} from "../../types/socket-events.js";
import {
  validateSocketPayload,
  handleSocketAction,
  formatSocketResponse,
} from "../helpers/validate-socket.js";
import {
  sendPrivateMessageSchema,
  markReadSchema,
  reactMessageSchema,
  pinMessageSchema,
  unpinMessageSchema,
} from "../../api/validators/private-message.validator.js";
import { SocketGuard } from "../guards/socket-guard.js";
import type { PrivateRoomService } from "../../services/private-room.service.js";
import type { PrivateMessageService } from "../../services/private-message.service.js";
import type { PrivatePinService } from "../../services/private-pin.service.js";
import type { PresenceService } from "../../services/presence.service.js";
import type { CacheRepository } from "../../repositories/cache.repository.js";
import type { UserSnapshotService } from "../../services/user-snapshot.service.js";

type SocketCallback = (response: Record<string, unknown>) => void;

export function registerPrivateMessageHandler(
  io: Namespace,
  socket: Socket,
  deps: {
    privateRoomService: PrivateRoomService;
    privateMessageService: PrivateMessageService;
    privatePinService: PrivatePinService;
    presenceService: PresenceService;
    cacheRepo: CacheRepository;
    userSnapshotService: UserSnapshotService;
  }
): void {
  const {
    privateRoomService,
    privateMessageService,
    privatePinService,
    presenceService,
    cacheRepo,
  } = deps;

  const joinPrivateHome = async (
    _payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const { userId } = socket.user;
      const privateRoomName = `${PRIVATE_HOME_LOBBY}:${userId}`;
      socket.join(privateRoomName);

      const rooms = await privateRoomService.getConversationList({
        userId,
        limit: 20,
      });

      formatSocketResponse(callback, rooms);
    }, callback);
  };

  const leavePrivateHome = async (
    _payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const { userId } = socket.user;
      const privateRoomName = `${PRIVATE_HOME_LOBBY}:${userId}`;
      socket.leave(privateRoomName);
      formatSocketResponse(callback, { message: "Left private home" });
    }, callback);
  };

  const loadMoreConversations = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const { userId } = socket.user;
      const lastMessageAt = payload.lastMessageAt as string;
      const rooms = await privateRoomService.getConversationList({
        userId,
        limit: 20,
        cursor: lastMessageAt,
      });
      formatSocketResponse(callback, rooms);
    }, callback);
  };

  const joinPrivateRoom = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const roomId = payload.roomId as string;
      if (!roomId) return;
      const roomName = `${PRIVATE_PREFIX}:${roomId}`;
      socket.join(roomName);

      const messages = await privateMessageService.getMessages({
        roomId,
        userId: socket.user.userId,
        limit: 30,
      });
      const enriched = await privateMessageService.enrichMessages(messages);
      formatSocketResponse(callback, enriched);
    }, callback);
  };

  const loadMoreMessages = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const roomId = payload.roomId as string;
      const lastMessageDate = payload.lastMessageDate as string;
      const messages = await privateMessageService.getMessages({
        roomId,
        userId: socket.user.userId,
        cursor: lastMessageDate,
        limit: 30,
      });
      const enriched = await privateMessageService.enrichMessages(messages);
      formatSocketResponse(callback, enriched);
    }, callback);
  };

  const addPrivateMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        sendPrivateMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const { userId } = socket.user;
      const message = await privateMessageService.sendMessage({
        roomId: value.roomId,
        senderId: userId,
        receiverId: value.receiverId,
        content: value.content,
        messageType: value.messageType,
        parentMessageId: value.parentMessageId,
      });

      const [enrichedMessage] = await privateMessageService.enrichMessages([
        message,
      ]);

      const roomName = `${PRIVATE_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${roomName}:message:add:new`, enrichedMessage);

      // Notify home lobbies
      const senderLobby = `${PRIVATE_HOME_LOBBY}:${userId}`;
      const receiverLobby = `${PRIVATE_HOME_LOBBY}:${value.receiverId}`;
      io.to(senderLobby).emit(senderLobby, enrichedMessage);
      io.to(receiverLobby).emit(receiverLobby, enrichedMessage);

      formatSocketResponse(callback, enrichedMessage);
    }, callback);
  };

  const reactMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        reactMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const message = await privateMessageService.react(
        value.messageId,
        value.reactions
      );
      const roomName = `${PRIVATE_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${PRIVATE_PREFIX}:message:react:new`, message);
      formatSocketResponse(callback, message);
    }, callback);
  };

  const pinMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(pinMessageSchema, payload, callback);
      if (!value) return;

      const { userId } = socket.user;
      const result = await privatePinService.pin({
        roomId: value.roomId,
        messageId: value.messageId,
        userId,
      });

      const roomName = `${PRIVATE_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${roomName}:message:pin:new`, {
        pin: result.pin,
        pinned_count: result.pinnedCount,
      });
      formatSocketResponse(callback, result);
    }, callback);
  };

  const unPinMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        unpinMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const { userId } = socket.user;
      const result = await privatePinService.unpin({
        roomId: value.roomId,
        messageId: value.messageId,
        userId,
      });

      const roomName = `${PRIVATE_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${roomName}:message:pin:new`, {
        pinId: value.pinId,
        roomId: value.roomId,
        messageId: value.messageId,
        unpinnedBy: userId,
        pinnedCount: result.pinnedCount,
      });
      formatSocketResponse(callback, result);
    }, callback);
  };

  const markReadUpTo = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(markReadSchema, payload, callback);
      if (!value) return;

      const { userId } = socket.user;
      const room = await privateMessageService.markRead({
        roomId: value.roomId,
        userId,
        lastMessageId: value.lastMessageId,
      });

      // Notify receiver lobby
      const receiverLobby = `${PRIVATE_HOME_LOBBY}:${value.receiverId}`;
      io.to(receiverLobby).emit(
        `${PRIVATE_HOME_LOBBY}:conversation:read:updated`,
        room
      );

      // Notify room about read receipt
      const roomName = `${PRIVATE_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${roomName}:message:read`, {
        roomId: value.roomId,
        read: true,
        senderId: userId,
      });

      formatSocketResponse(callback, room);
    }, callback);
  };

  const heartbeat = async (
    _payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const { userId, deviceId } = socket.user;
      await cacheRepo.heartbeat({ userId, deviceId, now: Date.now() });
      formatSocketResponse(callback, { status: "ok" });
    }, callback);
  };

  const updateState = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const state = payload.state as string;
      if (!state) return;
      const { userId, deviceId } = socket.user;
      await cacheRepo.setAppState(userId, deviceId, state, Date.now());
      await presenceService.recompute(userId);
      formatSocketResponse(callback, { status: "ok" });
    }, callback);
  };

  const subscribePeers = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const peerIds =
        (payload.peerIds as string[]) ||
        (payload.peerId ? [payload.peerId as string] : []);
      for (const pid of peerIds) socket.join(`watch:${pid}`);
      formatSocketResponse(callback, { status: "ok" });
    }, callback);
  };

  const unsubscribePeers = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const peerIds =
        (payload.peerIds as string[]) ||
        (payload.peerId ? [payload.peerId as string] : []);
      for (const pid of peerIds) socket.leave(`watch:${pid}`);
      formatSocketResponse(callback, { status: "ok" });
    }, callback);
  };

  const joinInitiation = async (
    _payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const { userId } = socket.user;
      const initRoomName = `${PRIVATE_PREFIX}:${userId}`;
      socket.join(initRoomName);
      formatSocketResponse(callback, { status: "ok" });
    }, callback);
  };

  // Register events
  socket.on(PRIVATE_EVENTS.HOME_JOIN, joinPrivateHome);
  socket.on(PRIVATE_EVENTS.HOME_LEAVE, leavePrivateHome);
  socket.on(PRIVATE_EVENTS.HOME_CONVERSATIONS_LOAD_MORE, loadMoreConversations);
  socket.on(PRIVATE_EVENTS.INITIATION_JOIN, joinInitiation);
  socket.on(PRIVATE_EVENTS.USER_JOIN, joinPrivateRoom);
  socket.on(PRIVATE_EVENTS.MESSAGES_LOAD_MORE, loadMoreMessages);
  socket.on(PRIVATE_EVENTS.MESSAGE_ADD, addPrivateMessage);
  socket.on(PRIVATE_EVENTS.MESSAGE_REACT, reactMessage);
  socket.on(PRIVATE_EVENTS.MESSAGE_PIN, pinMessage);
  socket.on(PRIVATE_EVENTS.MESSAGE_UNPIN, unPinMessage);
  socket.on(PRIVATE_EVENTS.CONVERSATION_READ, markReadUpTo);
  socket.on(PRIVATE_EVENTS.PRESENCE_HEARTBEAT, heartbeat);
  socket.on(PRIVATE_EVENTS.PRESENCE_APP_STATE, updateState);
  socket.on(PRIVATE_EVENTS.PRESENCE_SUBSCRIBE, subscribePeers);
  socket.on(PRIVATE_EVENTS.PRESENCE_UNSUBSCRIBE, unsubscribePeers);
}
