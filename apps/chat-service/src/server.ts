import { createServer, type Server } from "node:http";

import { logger } from "@aimess/logger";
import { ensureBuckets } from "@aimess/storage";

import { env } from "./config/env.js";
import { connectDatabase, disconnectDatabase } from "./config/db.js";
import { prisma } from "./config/prisma.js";
import { connectChatRedis, redis } from "./config/redis.js";
import { createSocketServer } from "./config/socket.js";
import { storageClient } from "./config/storage.js";
import { createApp } from "./app.js";

// -- Repositories --
import { PrivateRoomRepository } from "./repositories/private-room.repository.js";
import { PrivateMessageRepository } from "./repositories/private-message.repository.js";
import { PrivateMessagePinRepository } from "./repositories/private-message-pin.repository.js";
import { GroupRoomRepository } from "./repositories/group-room.repository.js";
import { GroupMessageRepository } from "./repositories/group-message.repository.js";
import { GroupMemberRepository } from "./repositories/group-member.repository.js";
import { GroupInviteLinkRepository } from "./repositories/group-invite-link.repository.js";
import { GroupMessagePinRepository } from "./repositories/group-message-pin.repository.js";
import { FriendshipRepository } from "./repositories/friendship.repository.js";
import { GeneralRoomRepository } from "./repositories/general-room.repository.js";
import { GeneralRoomMessageRepository } from "./repositories/general-room-message.repository.js";
import { RoomMemberRepository } from "./repositories/room-member.repository.js";
import { NotificationRepository } from "./repositories/notification.repository.js";
import { CacheRepository } from "./repositories/cache.repository.js";
import { LivestreamCommentRepository } from "./repositories/livestream-comment.repository.js";

// -- Services --
import { PrivateRoomService } from "./services/private-room.service.js";
import { PrivateMessageService } from "./services/private-message.service.js";
import { PrivatePinService } from "./services/private-pin.service.js";
import { GroupRoomService } from "./services/group-room.service.js";
import { GroupMessageService } from "./services/group-message.service.js";
import { GroupMemberService } from "./services/group-member.service.js";
import { GroupInviteLinkService } from "./services/group-invite-link.service.js";
import { GroupPinService } from "./services/group-pin.service.js";
import { NotificationService } from "./services/notification.service.js";
import { PresenceService } from "./services/presence.service.js";
import { CommunityRoomService } from "./services/community-room.service.js";
import { CommunityMessageService } from "./services/community-message.service.js";
import { UserSnapshotService } from "./services/user-snapshot.service.js";
import { LivestreamCommentService } from "./services/livestream-comment.service.js";

// -- Controllers --
import { PrivateRoomController } from "./api/controllers/private-room.controller.js";
import { PrivateMessageController } from "./api/controllers/private-message.controller.js";
import { GroupRoomController } from "./api/controllers/group-room.controller.js";
import { GroupMessageController } from "./api/controllers/group-message.controller.js";
import { GroupMemberController } from "./api/controllers/group-member.controller.js";
import { GroupInviteLinkController } from "./api/controllers/group-invite-link.controller.js";
import { NotificationController } from "./api/controllers/notification.controller.js";
import { CommunityController } from "./api/controllers/community.controller.js";
import { CommunityMessageController } from "./api/controllers/community-message.controller.js";
import { MediaController } from "./api/controllers/media.controller.js";

// -- Socket.IO --
import { registerSocketHandlers } from "./sockets/index.js";

let httpServer: Server | undefined;

const startServer = async () => {
  logger.info("Chat service starting...");

  try {
    // 1. Connect databases + infra
    await connectDatabase();

    // Ensure MongoDB text indexes for full-text search (idempotent; skip on error)
    const textIndexes = [
      {
        collection: "private_messages",
        key: { "content.text": "text" },
        name: "private_messages_content_text_idx",
      },
      {
        collection: "group_messages",
        key: { "content.text": "text" },
        name: "group_messages_content_text_idx",
      },
      {
        collection: "general_room_messages",
        key: { message: "text" },
        name: "general_room_messages_message_idx",
      },
    ];
    for (const idx of textIndexes) {
      try {
        await prisma.$runCommandRaw({
          createIndexes: idx.collection,
          indexes: [{ key: idx.key, name: idx.name }],
        });
        logger.info(`Text index ensured: ${idx.name}`);
      } catch (err) {
        logger.warn(`Failed to create text index ${idx.name} — continuing`);
        logger.warn(err);
      }
    }

    // Partial unique indexes for clientMessageId idempotency.
    // partialFilterExpression limits the index to documents where clientMessageId
    // is a non-null string, so rows with clientMessageId: null are never indexed
    // and never trigger a duplicate-key error (unlike sparse:true, which only
    // skips documents where the field is entirely absent — not where it is null).
    const idemIndexes = [
      {
        collection: "group_messages",
        key: { roomId: 1, senderId: 1, clientMessageId: 1 },
        name: "group_messages_idempotency_idx",
        partialFilterExpression: { clientMessageId: { $type: "string" } },
      },
      {
        collection: "general_room_messages",
        key: { roomId: 1, sentBy: 1, clientMessageId: 1 },
        name: "general_room_messages_idempotency_idx",
        partialFilterExpression: { clientMessageId: { $type: "string" } },
      },
    ];
    for (const idx of idemIndexes) {
      try {
        await prisma.$runCommandRaw({
          createIndexes: idx.collection,
          indexes: [
            {
              key: idx.key,
              name: idx.name,
              unique: true,
              partialFilterExpression: idx.partialFilterExpression,
            },
          ],
        });
        logger.info(`Idempotency index ensured: ${idx.name}`);
      } catch (err) {
        logger.warn(
          `Failed to create idempotency index ${idx.name} — continuing`
        );
        logger.warn(err);
      }
    }

    await connectChatRedis();

    try {
      await ensureBuckets(storageClient, [env.MINIO_BUCKET]);
      logger.info(`MinIO buckets ready: ${env.MINIO_BUCKET}`);
    } catch {
      logger.warn(
        "MinIO unavailable — media upload APIs will fail until MinIO is reachable"
      );
    }

    // 2. Instantiate repositories (inject Prisma client)
    const cacheRepo = new CacheRepository(redis);
    const privateRoomRepo = new PrivateRoomRepository(prisma);
    const privateMessageRepo = new PrivateMessageRepository(prisma);
    const privateMessagePinRepo = new PrivateMessagePinRepository(prisma);
    const groupRoomRepo = new GroupRoomRepository(prisma);
    const groupMessageRepo = new GroupMessageRepository(prisma);
    const groupMemberRepo = new GroupMemberRepository(prisma);
    const groupInviteLinkRepo = new GroupInviteLinkRepository(prisma);
    const groupMessagePinRepo = new GroupMessagePinRepository(prisma);
    const friendshipRepo = new FriendshipRepository(prisma);
    const generalRoomRepo = new GeneralRoomRepository(prisma);
    const generalRoomMessageRepo = new GeneralRoomMessageRepository(prisma);
    const roomMemberRepo = new RoomMemberRepository(prisma);
    const notificationRepo = new NotificationRepository(prisma);
    const livestreamCommentRepo = new LivestreamCommentRepository(prisma);

    // 3. Instantiate services
    const userSnapshotService = new UserSnapshotService();

    const privateRoomService = new PrivateRoomService(
      privateRoomRepo,
      cacheRepo,
      userSnapshotService,
      friendshipRepo
    );
    const privateMessageService = new PrivateMessageService(
      privateMessageRepo,
      privateRoomRepo,
      cacheRepo,
      userSnapshotService,
      friendshipRepo
    );
    const privatePinService = new PrivatePinService(
      privateMessagePinRepo,
      privateMessageRepo,
      privateRoomRepo,
      cacheRepo,
      userSnapshotService
    );

    const groupMemberService = new GroupMemberService(
      groupMemberRepo,
      groupRoomRepo
    );
    const groupRoomService = new GroupRoomService(
      groupRoomRepo,
      groupMemberRepo,
      groupInviteLinkRepo
    );
    const groupMessageService = new GroupMessageService(
      groupMessageRepo,
      groupRoomRepo,
      groupMemberRepo,
      cacheRepo,
      userSnapshotService
    );
    const groupInviteLinkService = new GroupInviteLinkService(
      groupInviteLinkRepo,
      groupRoomRepo,
      groupMemberRepo
    );
    const groupPinService = new GroupPinService(
      groupMessagePinRepo,
      groupMessageRepo,
      groupRoomRepo,
      groupMemberRepo,
      cacheRepo,
      userSnapshotService
    );

    const notificationService = new NotificationService(notificationRepo);

    // Presence gets namespace later after Socket.IO setup
    const presenceService = new PresenceService(cacheRepo, null);

    const communityRoomService = new CommunityRoomService(
      generalRoomRepo,
      roomMemberRepo,
      cacheRepo
    );
    const livestreamCommentService = new LivestreamCommentService(
      livestreamCommentRepo
    );

    const communityMessageService = new CommunityMessageService(
      generalRoomMessageRepo,
      generalRoomRepo,
      roomMemberRepo,
      cacheRepo,
      userSnapshotService
    );

    // 4. Instantiate controllers
    const controllers = {
      privateRoomCtrl: new PrivateRoomController(privateRoomService),
      privateMessageCtrl: new PrivateMessageController(
        privateMessageService,
        privatePinService
      ),
      groupRoomCtrl: new GroupRoomController(groupRoomService),
      groupMessageCtrl: new GroupMessageController(
        groupMessageService,
        groupPinService
      ),
      groupMemberCtrl: new GroupMemberController(groupMemberService),
      groupInviteLinkCtrl: new GroupInviteLinkController(
        groupInviteLinkService,
        groupMemberService
      ),
      notificationCtrl: new NotificationController(notificationService),
      communityCtrl: new CommunityController(communityRoomService),
      communityMessageCtrl: new CommunityMessageController(
        communityMessageService
      ),
      mediaCtrl: new MediaController(),
    };

    // 5. Create Express app + HTTP server
    const app = createApp(controllers);
    httpServer = createServer(app);

    // 6. Attach Socket.IO
    const io = createSocketServer(httpServer);
    // Expose io so REST controllers can emit real-time events
    app.set("io", io);

    registerSocketHandlers(io, {
      cacheRepo,
      generalRoomRepo,
      roomMemberRepo,
      presenceService,
      privateRoomService,
      privateMessageService,
      privatePinService,
      communityMessageService,
      communityRoomService,
      groupMessageService,
      groupRoomService,
      groupMemberService,
      groupPinService,
      userSnapshotService,
      livestreamCommentService,
    });

    // 7. Listen
    httpServer.listen(env.CHAT_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        `Chat service listening on port ${String(env.CHAT_SERVICE_PORT)}`
      );
      logger.info(
        "HTTP routes: /api/chat/private, /api/chat/groups, /api/chat/group-members, /api/chat/invite-links, /api/chat/notifications, /api/chat/community, /api/chat/media"
      );
      logger.info("Socket.IO namespace: /z-product");
    });
  } catch (error) {
    logger.error("Chat service startup failed");
    logger.error(error);
    process.exit(1);
  }
};

async function shutdown(signal: string): Promise<void> {
  logger.info(`Chat service shutting down (${signal})...`);

  await new Promise<void>((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }
    httpServer.close(() => resolve());
  });

  await disconnectDatabase();

  try {
    if (redis.status === "ready" || redis.status === "connect") {
      await redis.quit();
    }
  } catch {
    // ignore redis shutdown errors
  }

  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void startServer();
