import type { Server as SocketIOServer } from "socket.io";

import { logger } from "@aimess/logger";

import { socketAuthMiddleware } from "./auth-middleware.js";
import { registerSessionHandler } from "./handlers/session.handler.js";
import { registerPrivateMessageHandler } from "./handlers/private-message.handler.js";
import { registerCommunityMessageHandler } from "./handlers/community-message.handler.js";
import { registerGroupHandler } from "./handlers/group.handler.js";
import { registerLivestreamHandler } from "./handlers/livestream.handler.js";

import type { CacheRepository } from "../repositories/cache.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { PresenceService } from "../services/presence.service.js";
import type { PrivateRoomService } from "../services/private-room.service.js";
import type { PrivateMessageService } from "../services/private-message.service.js";
import type { PrivatePinService } from "../services/private-pin.service.js";
import type { CommunityMessageService } from "../services/community-message.service.js";
import type { CommunityRoomService } from "../services/community-room.service.js";
import type { GroupMessageService } from "../services/group-message.service.js";
import type { GroupRoomService } from "../services/group-room.service.js";
import type { GroupMemberService } from "../services/group-member.service.js";
import type { GroupPinService } from "../services/group-pin.service.js";
import type { UserSnapshotService } from "../services/user-snapshot.service.js";
import type { LivestreamCommentService } from "../services/livestream-comment.service.js";

export interface SocketDependencies {
  cacheRepo: CacheRepository;
  generalRoomRepo: GeneralRoomRepository;
  roomMemberRepo: RoomMemberRepository;
  presenceService: PresenceService;
  privateRoomService: PrivateRoomService;
  privateMessageService: PrivateMessageService;
  privatePinService: PrivatePinService;
  communityMessageService: CommunityMessageService;
  communityRoomService: CommunityRoomService;
  groupMessageService: GroupMessageService;
  groupRoomService: GroupRoomService;
  groupMemberService: GroupMemberService;
  groupPinService: GroupPinService;
  userSnapshotService: UserSnapshotService;
  livestreamCommentService: LivestreamCommentService;
}

export function registerSocketHandlers(
  io: SocketIOServer,
  deps: SocketDependencies
): void {
  const xProduct = io.of("/z-product");

  // Apply auth middleware
  xProduct.use(socketAuthMiddleware);

  xProduct.on("connection", (socket) => {
    const { userId, deviceId, platform, clientType } = socket.user;
    logger.debug(
      `SocketIndex|connection userId=${userId}, deviceId=${deviceId}, platform=${platform}, clientType=${clientType}`
    );

    // Session handler (connection lifecycle + presence init)
    registerSessionHandler(io, socket, deps.cacheRepo, deps.presenceService);

    // Private messaging
    registerPrivateMessageHandler(xProduct, socket, {
      privateRoomService: deps.privateRoomService,
      privateMessageService: deps.privateMessageService,
      privatePinService: deps.privatePinService,
      presenceService: deps.presenceService,
      cacheRepo: deps.cacheRepo,
      userSnapshotService: deps.userSnapshotService,
    });

    // Community / general room messaging
    registerCommunityMessageHandler(xProduct, socket, {
      communityMessageService: deps.communityMessageService,
      communityRoomService: deps.communityRoomService,
      cacheRepo: deps.cacheRepo,
      generalRoomRepo: deps.generalRoomRepo,
      roomMemberRepo: deps.roomMemberRepo,
    });

    // Group chat
    registerGroupHandler(xProduct, socket, {
      groupMessageService: deps.groupMessageService,
      groupRoomService: deps.groupRoomService,
      groupMemberService: deps.groupMemberService,
      groupPinService: deps.groupPinService,
      cacheRepo: deps.cacheRepo,
      userSnapshotService: deps.userSnapshotService,
    });

    // Livestream comments
    registerLivestreamHandler(xProduct, socket, {
      livestreamCommentService: deps.livestreamCommentService,
    });
  });

  // Store namespace reference for presence service
  (deps.presenceService as unknown as Record<string, unknown>).namespace =
    xProduct;

  logger.info("Socket.IO handlers registered on /z-product namespace");
}
