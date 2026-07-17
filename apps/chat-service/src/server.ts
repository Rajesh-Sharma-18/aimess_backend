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
import { CommunityMessagePinRepository } from "./repositories/community-message-pin.repository.js";
import { GeneralRoomRepository } from "./repositories/general-room.repository.js";
import { GeneralRoomMessageRepository } from "./repositories/general-room-message.repository.js";
import { RoomMemberRepository } from "./repositories/room-member.repository.js";
import { NotificationRepository } from "./repositories/notification.repository.js";
import { CacheRepository } from "./repositories/cache.repository.js";
import { CallRepository } from "./repositories/call.repository.js";
import { PrivateMessageReportRepository } from "./repositories/private-message-report.repository.js";

// -- Services --
import { PrivateRoomService } from "./services/private-room.service.js";
import { InboxService } from "./services/inbox.service.js";
import { SyncService } from "./services/sync.service.js";
import { PrivateMessageService } from "./services/private-message.service.js";
import { PrivatePinService } from "./services/private-pin.service.js";
import { GroupRoomService } from "./services/group-room.service.js";
import { GroupSystemMessageService } from "./services/group-system-message.service.js";
import { GroupMessageService } from "./services/group-message.service.js";
import { GroupMemberService } from "./services/group-member.service.js";
import { GroupInviteLinkService } from "./services/group-invite-link.service.js";
import { GroupPinService } from "./services/group-pin.service.js";
import { CommunityPinService } from "./services/community-pin.service.js";
import { NotificationService } from "./services/notification.service.js";
import { CommunityRoomService } from "./services/community-room.service.js";
import { CommunityMessageService } from "./services/community-message.service.js";
import { CommunitySystemMessageService } from "./services/community-system-message.service.js";
import { ChatMessageOrchestrator } from "./services/chat-message-orchestrator.js";
import { UserSnapshotService } from "./services/user-snapshot.service.js";
import { AdminGroupService } from "./services/admin-group.service.js";
import { CallService } from "./services/call.service.js";
import { CallChatMessageService } from "./services/call-chat-message.service.js";
import { LiveKitService } from "./services/livekit.service.js";
import { FriendshipRepository } from "./repositories/friendship.repository.js";
import { userGrpcClient } from "./grpc/user-snapshot.client.js";
import { resolveMediaUrl } from "./lib/media-resolve.js";
import { PresenceService } from "./services/presence.service.js";

// -- Controllers --
import { PrivateRoomController } from "./api/controllers/private-room.controller.js";
import { InboxController } from "./api/controllers/inbox.controller.js";
import { SyncController } from "./api/controllers/sync.controller.js";
import { PrivateMessageController } from "./api/controllers/private-message.controller.js";
import { GroupRoomController } from "./api/controllers/group-room.controller.js";
import { GroupMessageController } from "./api/controllers/group-message.controller.js";
import { GroupMemberController } from "./api/controllers/group-member.controller.js";
import { GroupInviteLinkController } from "./api/controllers/group-invite-link.controller.js";
import { NotificationController } from "./api/controllers/notification.controller.js";
import { CommunityController } from "./api/controllers/community.controller.js";
import { CommunityMessageController } from "./api/controllers/community-message.controller.js";
import { CallController } from "./api/controllers/call.controller.js";
import { PresenceController } from "./api/controllers/presence.controller.js";
import { MessageContextController } from "./api/controllers/message-context.controller.js";

// -- gRPC --
import { startGrpcServer } from "./grpc/server.js";
import { createUserServiceClient } from "./grpc/user.client.js";
import { createAuthAdminClient } from "./grpc/auth.client.js";
import { getCommunityReconcileClient } from "./grpc/community.client.js";

// -- Events --
import {
  initializeEventConsumers,
  closeEventConsumers,
} from "./events/index.js";
import { reconcileCommunityRooms } from "./startup/reconcile-community-rooms.js";

let httpServer: Server | undefined;
let callTimeoutSweepHandle: ReturnType<typeof setInterval> | undefined;

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

    function isMongoIndexNotFoundError(error: unknown): boolean {
      if (!error || typeof error !== "object") return false;
      const meta = (error as { meta?: { message?: unknown } }).meta;
      const msg =
        (typeof meta?.message === "string" ? meta.message : "") ||
        (error instanceof Error ? error.message : "");
      return /index not found|ns not found/i.test(msg);
    }

    /**
     * Drops an index that should no longer exist. Used to clean up indexes
     * that predate the current schema and were never removed via migration
     * (Mongo indexes aren't reconciled by `prisma generate`/`db push` diffing
     * the way relational migrations are). Best-effort and idempotent: a
     * missing index (already dropped, or a fresh DB that never had it) is not
     * an error.
     */
    async function dropStaleIndex(collection: string, indexName: string) {
      try {
        await prisma.$runCommandRaw({
          dropIndexes: collection,
          index: indexName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        logger.info(`Stale index dropped: ${indexName}`);
      } catch (err) {
        if (isMongoIndexNotFoundError(err)) return;
        logger.warn(`Failed to drop stale index ${indexName} — continuing`);
        logger.warn(err);
      }
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

    // Backs the community history (createdAt, _id) keyset page + countTimeline,
    // the V2 seq history page, and the zero-loss revision changes feed. Declared
    // on the schema too; created here so existing deployments pick them up
    // without a `prisma db push`. _id is the implicit trailing sort key in Mongo.
    const timelineIndexes = [
      {
        key: { roomId: 1, createdAt: -1 },
        name: "general_room_messages_room_createdAt_idx",
      },
      // V2 seq keyset (findByRoomIdSeq / findAroundSeq): equality roomId +
      // deletedForAll, range+sort sequenceNumber.
      {
        key: { roomId: 1, deletedForAll: 1, sequenceNumber: 1 },
        name: "general_room_messages_room_deleted_seq_idx",
      },
      // Zero-loss changes feed + community:catchup(sinceRevision):
      // WHERE roomId=? AND revision > ? ORDER BY revision ASC (tombstones kept).
      {
        key: { roomId: 1, revision: 1 },
        name: "general_room_messages_room_revision_idx",
      },
    ];
    for (const idx of timelineIndexes) {
      try {
        await ensureIndex(
          "general_room_messages",
          { key: idx.key, name: idx.name },
          idx.name
        );
      } catch (err) {
        logger.warn(`Failed to create ${idx.name} — continuing`);
        logger.warn(err);
      }
    }

    // Old name for the general_room_messages timeline index; renamed to
    // general_room_messages_room_createdAt_idx — drop so re-creation succeeds.
    await dropStaleIndex(
      "general_room_messages",
      "general_room_messages_roomId_createdAt_idx"
    );

    // A stale unique index on (roomId, messageId) predates the current
    // CommunityMessagePin schema (which intentionally has no @@unique — the
    // same message can be pinned/unpinned/re-pinned as soft-delete history).
    // It was never introduced via a tracked schema/migration, so it can't be
    // reconciled by `prisma generate`/`db push`; drop it explicitly on every
    // startup so any environment still carrying it self-heals.
    await dropStaleIndex(
      "community_message_pins",
      "community_message_pins_roomId_messageId_key"
    );

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
    const communityMessagePinRepo = new CommunityMessagePinRepository(prisma);
    const generalRoomRepo = new GeneralRoomRepository(prisma);
    const generalRoomMessageRepo = new GeneralRoomMessageRepository(prisma);
    const roomMemberRepo = new RoomMemberRepository(prisma);
    const notificationRepo = new NotificationRepository(prisma);
    const callRepo = new CallRepository(prisma);
    const privateMessageReportRepo = new PrivateMessageReportRepository(prisma);

    // 3. Instantiate services
    const userSnapshotService = new UserSnapshotService();
    const userServiceClient = createUserServiceClient();
    const authAdminClient = createAuthAdminClient();

    // Admin Group Management read-side (backed by 3 admin gRPC RPCs).
    const adminGroupService = new AdminGroupService(
      groupRoomRepo,
      groupMemberRepo,
      userSnapshotService,
      cacheRepo,
      authAdminClient
    );

    // Constructed early so it can be injected into PrivateRoomService (REST
    // isOnline/isOffline) and ChatMessageOrchestrator (conv:updated isOffline)
    // below — single source of truth for real-time presence.
    const presenceService = new PresenceService(
      cacheRepo,
      redis,
      privateRoomRepo
    );

    const privateRoomService = new PrivateRoomService(
      privateRoomRepo,
      privateMessageRepo,
      cacheRepo,
      userSnapshotService,
      userServiceClient,
      redis,
      presenceService
    );
    const privateMessageService = new PrivateMessageService(
      privateMessageRepo,
      privateRoomRepo,
      cacheRepo,
      userSnapshotService,
      userServiceClient,
      privateMessageReportRepo,
      getCommunityReconcileClient()
    );
    const privatePinService = new PrivatePinService(
      privateMessagePinRepo,
      privateMessageRepo,
      privateRoomRepo,
      cacheRepo,
      userSnapshotService
    );

    const groupSystemMessageService = new GroupSystemMessageService(
      groupMessageRepo,
      groupRoomRepo,
      groupMemberRepo,
      cacheRepo,
      userSnapshotService,
      redis
    );
    const groupMemberService = new GroupMemberService(
      groupMemberRepo,
      groupRoomRepo,
      groupSystemMessageService
    );
    const groupRoomService = new GroupRoomService(
      groupRoomRepo,
      groupMemberRepo,
      groupInviteLinkRepo,
      groupSystemMessageService,
      redis,
      groupMessageRepo
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
    const liveKitService = new LiveKitService();
    const friendshipRepo = new FriendshipRepository();
    const resolveCallUserSnapshot = async (userId: string) => {
      try {
        const [snap] = await userGrpcClient.bulkGetUserSnapshots([userId]);
        if (!snap) return { displayName: "", avatarUrl: "" };
        const avatarUrl = snap.avatarObjectKey
          ? await resolveMediaUrl(snap.avatarObjectKey)
          : "";
        return {
          displayName: snap.displayName || snap.username || "",
          avatarUrl,
        };
      } catch {
        return { displayName: "", avatarUrl: "" };
      }
    };
    const callChatMessageService = new CallChatMessageService(
      privateMessageRepo,
      privateRoomRepo,
      redis,
      resolveCallUserSnapshot,
      (userId) => presenceService.getIsOnline(userId)
    );
    const callService = new CallService(
      callRepo,
      privateRoomRepo,
      redis,
      liveKitService,
      friendshipRepo,
      (userId) => userGrpcClient.getCallPrivacy(userId),
      // Caller snapshot for the `call:incoming` ringing UI. Best-effort:
      // on gRPC/S3 failure we still ring — just with empty name/avatar.
      resolveCallUserSnapshot,
      callChatMessageService
    );

    const communityRoomService = new CommunityRoomService(
      generalRoomRepo,
      roomMemberRepo,
      cacheRepo
    );

    const communitySystemMessageService = new CommunitySystemMessageService(
      generalRoomMessageRepo,
      generalRoomRepo,
      cacheRepo,
      userSnapshotService,
      redis,
      // Drives the real-time `community:updated` list bump for COMMUNITY-visible
      // system lines posted via the pin/unpin REST + socket paths.
      roomMemberRepo
    );

    const communityMessageService = new CommunityMessageService(
      generalRoomMessageRepo,
      generalRoomRepo,
      roomMemberRepo,
      cacheRepo,
      userSnapshotService,
      communitySystemMessageService
    );

    const communityPinService = new CommunityPinService(
      communityMessagePinRepo,
      generalRoomMessageRepo,
      generalRoomRepo,
      roomMemberRepo,
      communitySystemMessageService,
      userSnapshotService,
      cacheRepo
    );

    // Unified inbox = private rooms + group chats merged by lastMessageAt
    const inboxService = new InboxService(privateRoomService, groupRoomService);

    // V2 §3.3: per-conversation seq-based incremental sync (REST catch-up)
    const syncService = new SyncService(
      privateMessageService,
      groupMessageService
    );

    // Single owner of message SEND + post-write effects (broadcast, inbox bump,
    // FCM push) for private/group/community — shared by the REST send endpoints
    // (and, in a later slice, the gRPC handlers).
    const chatMessageOrchestrator = new ChatMessageOrchestrator(
      privateMessageService,
      groupMessageService,
      groupMemberService,
      communityMessageService,
      userSnapshotService,
      cacheRepo,
      redis,
      privatePinService,
      groupPinService,
      presenceService
    );

    // Start gRPC server with real service delegates
    startGrpcServer(env.CHAT_GRPC_PORT, {
      privateMessageService,
      groupMessageService,
      groupMemberService,
      groupRoomRepo,
      groupMemberRepo,
      privateRoomRepo,
      roomMemberRepo,
      adminGroupService,
      cacheRepo,
      userSnapshotService,
      callService,
      presenceService,
      communityMessageService,
      communityPinService,
      notificationRepo,
      chatMessageOrchestrator,
      privateRoomService,
    });

    // 4. Instantiate controllers
    const controllers = {
      privateRoomCtrl: new PrivateRoomController(privateRoomService),
      inboxCtrl: new InboxController(inboxService),
      syncCtrl: new SyncController(syncService),
      privateMessageCtrl: new PrivateMessageController(
        privateMessageService,
        privatePinService,
        redis,
        chatMessageOrchestrator
      ),
      groupRoomCtrl: new GroupRoomController(groupRoomService),
      groupMessageCtrl: new GroupMessageController(
        groupMessageService,
        groupPinService,
        redis,
        chatMessageOrchestrator
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
        communityPinService,
        redis,
        chatMessageOrchestrator
      ),
      callCtrl: new CallController(callService),
      presenceCtrl: new PresenceController(presenceService),
      messageContextCtrl: new MessageContextController(
        privateMessageService,
        groupMessageService,
        communityMessageService
      ),
    };

    // 5. Create Express app + HTTP server
    const app = createApp(controllers);
    httpServer = createServer(app);

    // 6. Listen
    //
    // Bounded EADDRINUSE retry: under `tsx watch`, a packages/* rebuild restarts
    // every service at once and the new instance can try to bind before the old
    // one has released the port. listen() reports that as an async 'error' event
    // (not a throwable) — without this handler it crashes the process for good
    // and the watcher never recovers. Retry briefly, then exit cleanly.
    const MAX_BIND_ATTEMPTS = 5;
    let bindAttempt = 0;
    const server = httpServer;
    const tryListen = () => {
      bindAttempt += 1;
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && bindAttempt < MAX_BIND_ATTEMPTS) {
          logger.warn(
            `Port ${String(env.CHAT_SERVICE_PORT)} busy (EADDRINUSE); retry ${bindAttempt}/${MAX_BIND_ATTEMPTS} in 500ms…`
          );
          setTimeout(tryListen, 500);
          return;
        }
        logger.error(
          `Chat service failed to bind port ${String(env.CHAT_SERVICE_PORT)}: ${err.message}`
        );
        process.exit(1);
      });
      server.listen(env.CHAT_SERVICE_PORT, "0.0.0.0", () => {
        logger.info(
          `Chat service listening on port ${String(env.CHAT_SERVICE_PORT)}`
        );
        logger.info(
          "HTTP routes: /api/chat/inbox, /api/chat/private, /api/chat/groups, /api/chat/group-members, /api/chat/invite-links, /api/chat/notifications, /api/chat/community"
        );
      });
    };
    tryListen();

    // Boot-time reconciliation of community chat rooms (best-effort, non-blocking):
    // pull communities from community-service over gRPC and provision any missing
    // rooms / deactivate rooms of deleted communities. Self-heals dropped events.
    void reconcileCommunityRooms();

    // Ringing-call timeout sweeper — flips RINGING → MISSED after
    // CALL_RINGING_TIMEOUT_SEC. Multi-node safe (atomic per-row updateMany).
    callTimeoutSweepHandle = setInterval(() => {
      void callService
        .sweepMissedCalls(
          new Date(),
          env.CALL_RINGING_TIMEOUT_SEC,
          env.CALL_TIMEOUT_SWEEP_BATCH
        )
        .catch((err: unknown) => {
          logger.warn(`callTimeoutSweep failed: ${String(err)}`);
        });
    }, env.CALL_TIMEOUT_SWEEP_INTERVAL_SEC * 1000);
    // Don't hold the event loop open on shutdown.
    if (typeof callTimeoutSweepHandle.unref === "function") {
      callTimeoutSweepHandle.unref();
    }
  } catch (error) {
    logger.error("Chat service startup failed");
    logger.error(error);
    process.exit(1);
  }
};

async function shutdown(signal: string): Promise<void> {
  logger.info(`Chat service shutting down (${signal})...`);

  if (callTimeoutSweepHandle) {
    clearInterval(callTimeoutSweepHandle);
    callTimeoutSweepHandle = undefined;
  }

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
