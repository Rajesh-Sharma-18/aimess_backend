import { createServer, type Server } from "node:http";

import { logger } from "@aimess/logger";
import { ensureBuckets } from "@aimess/storage";

import { env } from "./config/env.js";
import { connectDatabase, disconnectDatabase } from "./config/db.js";
import { prisma } from "./config/prisma.js";
import { connectChatRedis, redis } from "./config/redis.js";
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
import { GeneralRoomRepository } from "./repositories/general-room.repository.js";
import { GeneralRoomMessageRepository } from "./repositories/general-room-message.repository.js";
import { RoomMemberRepository } from "./repositories/room-member.repository.js";
import { NotificationRepository } from "./repositories/notification.repository.js";
import { CacheRepository } from "./repositories/cache.repository.js";
import { CallRepository } from "./repositories/call.repository.js";

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
import { CommunityRoomService } from "./services/community-room.service.js";
import { CommunityMessageService } from "./services/community-message.service.js";
import { UserSnapshotService } from "./services/user-snapshot.service.js";
import { CallService } from "./services/call.service.js";
import { WebRtcConfigService } from "./services/webrtc-config.service.js";

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
import { CallController } from "./api/controllers/call.controller.js";

// -- gRPC --
import { startGrpcServer } from "./grpc/server.js";
import { createUserServiceClient } from "./grpc/user.client.js";

// -- Events --
import {
  initializeEventConsumers,
  closeEventConsumers,
} from "./events/index.js";

let httpServer: Server | undefined;

const startServer = async () => {
  logger.info("Chat service starting...");

  try {
    // 1. Connect databases + infra
    await connectDatabase();

    async function waitForMongoWritablePrimary(): Promise<void> {
      const maxAttempts = 30;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await prisma.$runCommandRaw({ hello: 1 } as any);
          const hello = result as {
            isWritablePrimary?: boolean;
            ismaster?: boolean;
            isMaster?: boolean;
            secondary?: boolean;
            hidden?: boolean;
          };

          const isWritablePrimary =
            hello.isWritablePrimary === true ||
            hello.ismaster === true ||
            hello.isMaster === true;

          if (isWritablePrimary) {
            logger.info("MongoDB writable primary confirmed");
            return;
          }

          logger.warn(
            `MongoDB not writable primary yet (hello result); retrying in 1000ms...`
          );
        } catch (error) {
          logger.warn(
            "MongoDB hello check failed; retrying in 1000ms...",
            error
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      logger.warn(
        "MongoDB did not become writable primary within the expected time. Index creation may still fail."
      );
    }

    await waitForMongoWritablePrimary();

    function isMongoNotPrimaryError(error: unknown): boolean {
      return (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message?: string }).message === "string" &&
        /not primary|not writable primary/i.test(
          (error as { message: string }).message
        )
      );
    }

    async function ensureIndex(
      collection: string,
      indexBody: Record<string, unknown>,
      indexName: string
    ) {
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await prisma.$runCommandRaw({
            createIndexes: collection,
            indexes: [indexBody],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
          logger.info(`Index ensured: ${indexName}`);
          return;
        } catch (err) {
          if (isMongoNotPrimaryError(err) && attempt < maxAttempts) {
            const delay = 1000 * attempt;
            logger.warn(
              `MongoDB not primary yet for ${indexName}, retrying in ${delay}ms...`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }
    }

    const textIndexes = [
      {
        collection: "private_messages",
        body: {
          key: { "content.text": "text" },
          name: "private_messages_content_text_idx",
        },
        name: "private_messages_content_text_idx",
      },
      {
        collection: "group_messages",
        body: {
          key: { "content.text": "text" },
          name: "group_messages_content_text_idx",
        },
        name: "group_messages_content_text_idx",
      },
      {
        collection: "general_room_messages",
        body: {
          key: { message: "text" },
          name: "general_room_messages_message_idx",
        },
        name: "general_room_messages_message_idx",
      },
    ];
    for (const idx of textIndexes) {
      try {
        await ensureIndex(idx.collection, idx.body, idx.name);
      } catch (err) {
        logger.warn(`Failed to create text index ${idx.name} — continuing`);
        logger.warn(err);
      }
    }

    const idemIndexes = [
      {
        collection: "private_messages",
        body: {
          key: { roomId: 1, senderId: 1, clientMessageId: 1 },
          name: "private_messages_idempotency_idx",
          unique: true,
          partialFilterExpression: { clientMessageId: { $type: "string" } },
        },
        name: "private_messages_idempotency_idx",
      },
      {
        collection: "group_messages",
        body: {
          key: { roomId: 1, senderId: 1, clientMessageId: 1 },
          name: "group_messages_idempotency_idx",
          unique: true,
          partialFilterExpression: { clientMessageId: { $type: "string" } },
        },
        name: "group_messages_idempotency_idx",
      },
      {
        collection: "general_room_messages",
        body: {
          key: { roomId: 1, sentBy: 1, clientMessageId: 1 },
          name: "general_room_messages_idempotency_idx",
          unique: true,
          partialFilterExpression: { clientMessageId: { $type: "string" } },
        },
        name: "general_room_messages_idempotency_idx",
      },
    ];
    for (const idx of idemIndexes) {
      try {
        await ensureIndex(idx.collection, idx.body, idx.name);
      } catch (err) {
        logger.warn(
          `Failed to create idempotency index ${idx.name} — continuing`
        );
        logger.warn(err);
      }
    }

    await connectChatRedis();

    // Initialize event consumers (RabbitMQ-based eventual consistency)
    try {
      await initializeEventConsumers();
    } catch (err) {
      logger.warn("Event consumers failed to initialize (non-critical)");
      logger.warn(err);
    }

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
    const generalRoomRepo = new GeneralRoomRepository(prisma);
    const generalRoomMessageRepo = new GeneralRoomMessageRepository(prisma);
    const roomMemberRepo = new RoomMemberRepository(prisma);
    const notificationRepo = new NotificationRepository(prisma);
    const callRepo = new CallRepository(prisma);

    // 3. Instantiate services
    const userSnapshotService = new UserSnapshotService();
    const userServiceClient = createUserServiceClient();

    const privateRoomService = new PrivateRoomService(
      privateRoomRepo,
      cacheRepo,
      userSnapshotService,
      userServiceClient
    );
    const privateMessageService = new PrivateMessageService(
      privateMessageRepo,
      privateRoomRepo,
      cacheRepo,
      userSnapshotService,
      userServiceClient
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
    const callService = new CallService(callRepo, privateRoomRepo, redis);

    const communityRoomService = new CommunityRoomService(
      generalRoomRepo,
      roomMemberRepo,
      cacheRepo
    );

    const communityMessageService = new CommunityMessageService(
      generalRoomMessageRepo,
      generalRoomRepo,
      roomMemberRepo,
      cacheRepo,
      userSnapshotService
    );

    const webRtcConfigService = new WebRtcConfigService();

    // Start gRPC server with real service delegates
    startGrpcServer(env.CHAT_GRPC_PORT, {
      privateMessageService,
      groupMessageService,
      groupMemberService,
      cacheRepo,
      userSnapshotService,
      callService,
      webRtcConfigService,
    });

    // 4. Instantiate controllers
    const controllers = {
      privateRoomCtrl: new PrivateRoomController(privateRoomService),
      privateMessageCtrl: new PrivateMessageController(
        privateMessageService,
        privatePinService,
        redis
      ),
      groupRoomCtrl: new GroupRoomController(groupRoomService),
      groupMessageCtrl: new GroupMessageController(
        groupMessageService,
        groupPinService,
        redis
      ),
      groupMemberCtrl: new GroupMemberController(groupMemberService),
      groupInviteLinkCtrl: new GroupInviteLinkController(
        groupInviteLinkService,
        groupMemberService
      ),
      notificationCtrl: new NotificationController(notificationService),
      communityCtrl: new CommunityController(communityRoomService),
      communityMessageCtrl: new CommunityMessageController(
        communityMessageService,
        redis
      ),
      mediaCtrl: new MediaController(),
      callCtrl: new CallController(callService),
    };

    // 5. Create Express app + HTTP server
    const app = createApp(controllers);
    httpServer = createServer(app);

    // 6. Listen
    httpServer.listen(env.CHAT_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        `Chat service listening on port ${String(env.CHAT_SERVICE_PORT)}`
      );
      logger.info(
        "HTTP routes: /api/chat/private, /api/chat/groups, /api/chat/group-members, /api/chat/invite-links, /api/chat/notifications, /api/chat/community, /api/chat/media"
      );
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

  // Close event consumers gracefully
  try {
    await closeEventConsumers();
  } catch (err) {
    logger.warn("Error closing event consumers", err);
  }

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
