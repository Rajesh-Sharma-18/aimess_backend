import type { Namespace, Socket } from "socket.io";

import {
  GROUP_EVENTS,
  GROUP_PREFIX,
  GROUP_HOME_LOBBY,
} from "../../types/socket-events.js";
import {
  validateSocketPayload,
  handleSocketAction,
  formatSocketResponse,
} from "../helpers/validate-socket.js";
import {
  sendGroupMessageSchema,
  reactGroupMessageSchema,
  pinGroupMessageSchema,
  deleteGroupMessageSchema,
} from "../../api/validators/group-message.validator.js";
import { markReadSchema } from "../../api/validators/group-member.validator.js";
import { SocketGuard } from "../guards/socket-guard.js";
import type { GroupMessageService } from "../../services/group-message.service.js";
import type { GroupRoomService } from "../../services/group-room.service.js";
import type { GroupMemberService } from "../../services/group-member.service.js";
import type { GroupPinService } from "../../services/group-pin.service.js";
import type { CacheRepository } from "../../repositories/cache.repository.js";
import type { UserSnapshotService } from "../../services/user-snapshot.service.js";

type SocketCallback = (response: Record<string, unknown>) => void;

export function registerGroupHandler(
  io: Namespace,
  socket: Socket,
  deps: {
    groupMessageService: GroupMessageService;
    groupRoomService: GroupRoomService;
    groupMemberService: GroupMemberService;
    groupPinService: GroupPinService;
    cacheRepo: CacheRepository;
    userSnapshotService: UserSnapshotService;
  }
): void {
  const {
    groupMessageService,
    groupRoomService,
    groupMemberService,
    groupPinService,
    cacheRepo,
    userSnapshotService,
  } = deps;

  const joinHome = async (
    _payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const { userId } = socket.user;
      socket.join(`${GROUP_HOME_LOBBY}:${userId}`);
      const groups = await groupRoomService.getUserGroups(userId, {
        limit: 20,
      });
      formatSocketResponse(callback, groups);
    }, callback);
  };

  const leaveHome = async (
    _payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const { userId } = socket.user;
      socket.leave(`${GROUP_HOME_LOBBY}:${userId}`);
      formatSocketResponse(callback, { message: "Left group home" });
    }, callback);
  };

  const loadMoreConversations = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const { userId } = socket.user;
      const cursor = payload.lastMessageAt as string;
      const groups = await groupRoomService.getUserGroups(userId, {
        limit: 20,
        cursor,
      });
      formatSocketResponse(callback, groups);
    }, callback);
  };

  const joinRoom = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const roomId = payload.roomId as string;
      if (!roomId) return;
      const roomName = `${GROUP_PREFIX}:${roomId}`;
      socket.join(roomName);

      const messages = await groupMessageService.getMessages({
        roomId,
        userId: socket.user.userId,
        limit: 30,
      });
      formatSocketResponse(callback, messages);
    }, callback);
  };

  const loadMoreMessages = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      const roomId = payload.roomId as string;
      const cursor = payload.lastMessageDate as string;
      const messages = await groupMessageService.getMessages({
        roomId,
        userId: socket.user.userId,
        cursor,
        limit: 30,
      });
      formatSocketResponse(callback, messages);
    }, callback);
  };

  const addMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        sendGroupMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const { userId } = socket.user;
      const snapshots = await userSnapshotService.getUserSnapshotsMap(
        [userId],
        cacheRepo
      );
      const snap = (snapshots.get(userId) || {}) as Record<string, unknown>;

      const message = await groupMessageService.sendMessage({
        roomId: value.roomId,
        senderId: userId,
        // Priority: displayName (full name) → memberId (account/username) → socket auth displayname
        senderName:
          (snap.displayName as string) ||
          (snap.memberId as string) ||
          socket.user.displayname ||
          socket.user.username ||
          "",
        senderAvatar: (snap.avatar as string) || "",
        content: value.content,
        messageType: value.messageType,
        parentMessageId: value.parentMessageId,
        clientMessageId: value.clientMessageId,
      });

      const roomName = `${GROUP_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${roomName}:message:add:new`, message);
      formatSocketResponse(callback, message);
    }, callback);
  };

  const reactMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        reactGroupMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const message = await groupMessageService.react(
        value.messageId,
        value.reactions
      );
      const roomName = `${GROUP_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${GROUP_PREFIX}:message:react:new`, message);
      formatSocketResponse(callback, message);
    }, callback);
  };

  const pinMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        pinGroupMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const result = await groupPinService.pin({
        roomId: value.roomId,
        messageId: value.messageId,
        userId: socket.user.userId,
      });

      const roomName = `${GROUP_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${roomName}:message:pin:new`, result);
      formatSocketResponse(callback, result);
    }, callback);
  };

  const unpinMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        pinGroupMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const result = await groupPinService.unpin({
        roomId: value.roomId,
        messageId: value.messageId,
        userId: socket.user.userId,
      });

      const roomName = `${GROUP_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${roomName}:message:pin:new`, result);
      formatSocketResponse(callback, result);
    }, callback);
  };

  const deleteMessage = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        deleteGroupMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const message = await groupMessageService.deleteMessage(
        value.messageId,
        socket.user.userId,
        value.roomId
      );

      const roomName = `${GROUP_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${roomName}:message:delete:new`, {
        ...message,
        type: "forEveryone",
        deletedBy: socket.user.userId,
      });
      formatSocketResponse(callback, message);
    }, callback);
  };

  const deleteMessageForMe = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(
        deleteGroupMessageSchema,
        payload,
        callback
      );
      if (!value) return;

      const message = await groupMessageService.deleteForMe(
        value.messageId,
        socket.user.userId,
        value.roomId
      );

      // Emit to the whole room so the user's other devices hide it too.
      // Clients must only act on this if deletedBy === their own userId.
      const roomName = `${GROUP_PREFIX}:${value.roomId}`;
      io.to(roomName).emit(`${roomName}:message:delete:new`, {
        messageId: value.messageId,
        type: "forMe",
        deletedBy: socket.user.userId,
      });
      formatSocketResponse(callback, message);
    }, callback);
  };

  const markRead = async (
    payload: Record<string, unknown>,
    callback: SocketCallback
  ) => {
    await handleSocketAction(async () => {
      SocketGuard.requireLoggedIn(socket);

      const value = validateSocketPayload(markReadSchema, payload, callback);
      if (!value) return;

      const result = await groupMemberService.markRead({
        roomId: value.roomId,
        userId: socket.user.userId,
        lastMessageId: value.lastMessageId,
      });
      formatSocketResponse(callback, result);
    }, callback);
  };

  // Register events
  socket.on(GROUP_EVENTS.HOME_JOIN, joinHome);
  socket.on(GROUP_EVENTS.HOME_LEAVE, leaveHome);
  socket.on(GROUP_EVENTS.HOME_LOAD_MORE, loadMoreConversations);
  socket.on(GROUP_EVENTS.USER_JOIN, joinRoom);
  socket.on(GROUP_EVENTS.MESSAGES_LOAD_MORE, loadMoreMessages);
  socket.on(GROUP_EVENTS.MESSAGE_ADD, addMessage);
  socket.on(GROUP_EVENTS.MESSAGE_REACT, reactMessage);
  socket.on(GROUP_EVENTS.MESSAGE_PIN, pinMessage);
  socket.on(GROUP_EVENTS.MESSAGE_UNPIN, unpinMessage);
  socket.on(GROUP_EVENTS.MESSAGE_DELETE, deleteMessage);
  socket.on(GROUP_EVENTS.MESSAGE_DELETE_FOR_ME, deleteMessageForMe);
  socket.on(GROUP_EVENTS.CONVERSATION_READ, markRead);
}
