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
import { ConversationBulkService } from "./services/conversation-bulk.service.js";
import { UnreadSummaryService } from "./services/unread-summary.service.js";
import { registerUnreadSummaryPusher } from "./events/unread-summary-bridge.js";
import { registerCallTerminator } from "./events/call-teardown-bridge.js";
import { publishChatUserEvent } from "@aimess/redis";
import { SyncService } from "./services/sync.service.js";
import { PrivateMessageService } from "./services/private-message.service.js";
import { PrivatePinService } from "./services/private-pin.service.js";
import { PrivateSystemMessageService } from "./services/private-system-message.service.js";
import { AutoDeleteService } from "./services/auto-delete.service.js";
import { GroupAutoDeleteService } from "./services/group-auto-delete.service.js";
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
import { CallFlagService } from "./services/call-flag.service.js";
import { CallAnalyticsRepository } from "./repositories/call-analytics.repository.js";
import { SystemFlagRepository } from "./repositories/system-flag.repository.js";
import { CallChatMessageService } from "./services/call-chat-message.service.js";
import { LiveKitService } from "./services/livekit.service.js";
import { FriendshipRepository } from "./repositories/friendship.repository.js";
import { userGrpcClient } from "./grpc/user-snapshot.client.js";
import { resolveMediaUrl } from "./lib/media-resolve.js";
import { PresenceService } from "./services/presence.service.js";

// -- Controllers --
import { PrivateRoomController } from "./api/controllers/private-room.controller.js";
import { InboxController } from "./api/controllers/inbox.controller.js";
import { ConversationBulkController } from "./api/controllers/conversation-bulk.controller.js";
import { SyncController } from "./api/controllers/sync.controller.js";
import { PrivateMessageController } from "./api/controllers/private-message.controller.js";
import { GroupRoomController } from "./api/controllers/group-room.controller.js";
import { GroupMessageController } from "./api/controllers/group-message.controller.js";
import { GroupMemberController } from "./api/controllers/group-member.controller.js";
import { GroupInviteLinkController } from "./api/controllers/group-invite-link.controller.js";
import { NotificationController } from "./api/controllers/notification.controller.js";
import { UnreadSummaryController } from "./api/controllers/unread-summary.controller.js";
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
import { setCallTerminator } from "./events/call-terminator.js";
import { reconcileCommunityRooms } from "./startup/reconcile-community-rooms.js";
import { startChatSettingsInvalidationListener } from "./startup/chat-settings-invalidation.js";
import {
  ensureMongoIndex,
  dropMongoIndexIfExists,
} from "./lib/mongo-index-manager.js";

let httpServer: Server | undefined;
let callTimeoutSweepHandle: ReturnType<typeof setInterval> | undefined;
let groupMuteSweepHandle: ReturnType<typeof setInterval> | undefined;
let autoDeleteSweepHandle: ReturnType<typeof setInterval> | undefined;
let loginExpirySweepHandle: ReturnType<typeof setInterval> | undefined;
let presenceSweepHandle: ReturnType<typeof setInterval> | undefined;

/** Backstop so a huge mute backlog can't hold the DB for a whole tick — the
 *  remainder drains on the next tick. Mirrors community's sweeper. */
const GROUP_MUTE_SWEEP_MAX_BATCHES = 50;

/** Same backstop for the auto-delete sweep. */
const AUTO_DELETE_SWEEP_MAX_BATCHES = 50;

/** Rooms per tick for the restamp repair pass — normally zero rows to fix. */
const AUTO_DELETE_RESTAMP_REPAIR_BATCH = 100;

/** Same backstop for the login-detected auto-approval sweep. */
const LOGIN_EXPIRY_SWEEP_MAX_BATCHES = 50;

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

    // Message search no longer uses `$text` — it is a case-insensitive
    // substring match served by the `[roomId, createdAt desc]` compound index
    // (see buildTextSearchPipeline). These text indexes are now pure write
    // overhead on three of the hottest collections, so drop them on boot.
    for (const stale of [
      {
        collection: "private_messages",
        name: "private_messages_content_text_idx",
      },
      { collection: "group_messages", name: "group_messages_content_text_idx" },
      {
        collection: "general_room_messages",
        name: "general_room_messages_message_idx",
      },
      {
        collection: "private_messages",
        name: "private_messages_content_text_v2_idx",
      },
      {
        collection: "group_messages",
        name: "group_messages_content_text_v2_idx",
      },
      {
        collection: "general_room_messages",
        name: "general_room_messages_message_v2_idx",
      },
    ]) {
      try {
        await dropMongoIndexIfExists(prisma, stale.collection, stale.name);
      } catch (err) {
        logger.warn(`Failed to drop stale text index ${stale.name}`);
        logger.warn(err);
      }
    }

    const idemIndexes: {
      collection: string;
      key: Record<string, 1 | -1 | "text">;
      name: string;
    }[] = [
      {
        collection: "private_messages",
        key: { roomId: 1, senderId: 1, clientMessageId: 1 },
        name: "private_messages_idempotency_idx",
      },
      {
        collection: "group_messages",
        key: { roomId: 1, senderId: 1, clientMessageId: 1 },
        name: "group_messages_idempotency_idx",
      },
      {
        collection: "general_room_messages",
        key: { roomId: 1, sentBy: 1, clientMessageId: 1 },
        name: "general_room_messages_idempotency_idx",
      },
    ];
    for (const idx of idemIndexes) {
      try {
        await ensureMongoIndex(prisma, idx.collection, {
          key: idx.key,
          name: idx.name,
          unique: true,
          partialFilterExpression: { clientMessageId: { $type: "string" } },
        });
      } catch (err) {
        logger.warn(
          `Failed to create idempotency index ${idx.name} — continuing`
        );
        logger.warn(err);
      }
    }

    // Auto-delete claiming/backoff/repair. Declared on the schema too; created
    // here so existing deployments pick them up without a `prisma db push`.
    // Every one of these backs a query the sweeper runs on every tick, so a
    // missing index is a full collection scan every 30 seconds.
    const autoDeleteIndexes: {
      collection: string;
      key: Record<string, 1 | -1 | "text">;
      name: string;
    }[] = [
      // Stale-claim recovery: WHERE autoDeleteClaimedAt < leaseCutoff.
      {
        collection: "private_messages",
        key: { autoDeleteClaimedAt: 1 },
        name: "private_messages_auto_delete_claimed_at_idx",
      },
      // Claim winner read-back: WHERE autoDeleteClaimToken = <token>.
      {
        collection: "private_messages",
        key: { autoDeleteClaimToken: 1 },
        name: "private_messages_auto_delete_claim_token_idx",
      },
      // Watermark-bounded After Viewing arming.
      {
        collection: "private_messages",
        key: { roomId: 1, autoDeleteAfterView: 1, sequenceNumber: 1 },
        name: "private_messages_after_view_seq_idx",
      },
      {
        collection: "group_messages",
        key: { autoDeleteClaimedAt: 1 },
        name: "group_messages_auto_delete_claimed_at_idx",
      },
      {
        collection: "group_messages",
        key: { autoDeleteClaimToken: 1 },
        name: "group_messages_auto_delete_claim_token_idx",
      },
      // Restamp repair pass: WHERE autoDeleteRestampPending != null.
      {
        collection: "private_rooms",
        key: { autoDeleteRestampPending: 1 },
        name: "private_rooms_auto_delete_restamp_pending_idx",
      },
      {
        collection: "group_rooms",
        key: { autoDeleteRestampPending: 1 },
        name: "group_rooms_auto_delete_restamp_pending_idx",
      },
    ];
    for (const idx of autoDeleteIndexes) {
      try {
        await ensureMongoIndex(prisma, idx.collection, {
          key: idx.key,
          name: idx.name,
        });
      } catch (err) {
        logger.warn(
          `Failed to create auto-delete index ${idx.name} — continuing`
        );
        logger.warn(err);
      }
    }

    // Backs the community history (createdAt, _id) keyset page + countTimeline,
    // the V2 seq history page, and the zero-loss revision changes feed. Declared
    // on the schema too; created here so existing deployments pick them up
    // without a `prisma db push`. _id is the implicit trailing sort key in Mongo.
    const timelineIndexes: {
      key: Record<string, 1 | -1 | "text">;
      name: string;
    }[] = [
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
        await ensureMongoIndex(prisma, "general_room_messages", {
          key: idx.key,
          name: idx.name,
        });
      } catch (err) {
        logger.warn(`Failed to create ${idx.name} — continuing`);
        logger.warn(err);
      }
    }

    // Community's half of the nav-badge unread summary queries room_members BY
    // USER (`where: { userId, status }`), and RoomMember's only indexes are
    // `(roomId, userId)` unique and `(roomId, status)` — neither prefixed on
    // userId, so every one of those reads was a collection scan over every
    // membership row in the product. That read runs once per online recipient
    // of every community message, which is exactly the path that has to stay
    // cheap as membership grows. Declared on the schema too; created here so
    // existing deployments pick it up without a `prisma db push`.
    try {
      await ensureMongoIndex(prisma, "room_members", {
        key: { userId: 1, status: 1 },
        name: "room_members_user_status_idx",
      });
    } catch (err) {
      logger.warn("Failed to create room_members_user_status_idx — continuing");
      logger.warn(err);
    }

    // Old name for the general_room_messages timeline index; renamed to
    // general_room_messages_room_createdAt_idx. dropMongoIndexIfExists
    // swallows IndexNotFound, so on environments that never had it (or
    // already dropped it) this is a no-op.
    await dropMongoIndexIfExists(
      prisma,
      "general_room_messages",
      "general_room_messages_roomId_createdAt_idx"
    );

    // A stale unique index on (roomId, messageId) predates the current
    // CommunityMessagePin schema (which intentionally has no @@unique — the
    // same message can be pinned/unpinned/re-pinned as soft-delete history).
    // It was never introduced via a tracked schema/migration, so it can't be
    // reconciled by `prisma generate`/`db push`; drop it explicitly on every
    // startup so any environment still carrying it self-heals.
    await dropMongoIndexIfExists(
      prisma,
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
    const cacheRepo = new CacheRepository(redis, {
      deviceTtlSeconds: env.PRESENCE_SESSION_TTL_SEC,
      statusTtlSeconds: env.PRESENCE_STATUS_TTL_SEC,
    });
    const privateRoomRepo = new PrivateRoomRepository(prisma);
    const privateMessageRepo = new PrivateMessageRepository(
      prisma,
      privateRoomRepo
    );
    const privateMessagePinRepo = new PrivateMessagePinRepository(prisma);
    const groupRoomRepo = new GroupRoomRepository(prisma);
    const groupMessageRepo = new GroupMessageRepository(prisma, groupRoomRepo);
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

    // Constructed early so it can be injected into PrivateRoomService (REST
    // isOnline/isOffline/lastSeen) and ChatMessageOrchestrator below — single
    // source of truth for real-time presence.
    const presenceService = new PresenceService(
      cacheRepo,
      redis,
      {
        // An ONLINE belief outlives the session TTL by one sweep interval, so
        // the sweeper only wakes for sessions that really are past due.
        staleAfterMs:
          (env.PRESENCE_SESSION_TTL_SEC + env.PRESENCE_SWEEP_INTERVAL_SEC) *
          1000,
      },
      // whoCanSeeOnlineStatus gate — without it every presence read here would
      // bypass the setting the socket `presence:subscribe` path already honors.
      userGrpcClient
    );

    const privateSystemMessageService = new PrivateSystemMessageService(
      privateMessageRepo,
      privateRoomRepo,
      userSnapshotService,
      cacheRepo,
      redis
    );
    const privatePinService = new PrivatePinService(
      privateMessagePinRepo,
      privateMessageRepo,
      privateRoomRepo,
      cacheRepo,
      userSnapshotService,
      privateSystemMessageService
    );

    const privateRoomService = new PrivateRoomService(
      privateRoomRepo,
      privateMessageRepo,
      cacheRepo,
      userSnapshotService,
      userServiceClient,
      redis,
      presenceService,
      userGrpcClient,
      privatePinService
    );
    const privateMessageService = new PrivateMessageService(
      privateMessageRepo,
      privateRoomRepo,
      cacheRepo,
      userSnapshotService,
      userServiceClient,
      privateMessageReportRepo,
      getCommunityReconcileClient(),
      presenceService,
      redis,
      groupRoomRepo,
      groupMemberRepo,
      groupInviteLinkRepo
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
      groupSystemMessageService,
      redis,
      userServiceClient,
      userSnapshotService,
      cacheRepo
    );
    const groupRoomService = new GroupRoomService(
      groupRoomRepo,
      groupMemberRepo,
      groupInviteLinkRepo,
      groupSystemMessageService,
      redis,
      groupMessageRepo,
      userSnapshotService,
      cacheRepo
    );
    // Admin Group Management (backoffice gRPC): reads plus the two moderation
    // writes, which delegate to the group services above so disband/remove keep
    // their invite-link revoke, eviction and roster fan-out.
    const adminGroupService = new AdminGroupService(
      groupRoomRepo,
      groupMemberRepo,
      userSnapshotService,
      cacheRepo,
      authAdminClient,
      groupRoomService,
      groupMemberService
    );
    const groupMessageService = new GroupMessageService(
      groupMessageRepo,
      groupRoomRepo,
      groupMemberRepo,
      cacheRepo,
      userSnapshotService,
      presenceService,
      redis
    );
    // Wire presence-connect delivered-tick backfill: on offline→online,
    // PresenceService now walks both surfaces and marks pending messages
    // delivered, publishing `message:delivered` so senders see live ticks.
    presenceService.wireBackfill({
      privateMessages: privateMessageService,
      groupMessages: groupMessageService,
    });
    const groupInviteLinkService = new GroupInviteLinkService(
      groupInviteLinkRepo,
      groupRoomRepo,
      groupMemberRepo,
      privateRoomRepo,
      privateMessageRepo,
      userSnapshotService,
      cacheRepo,
      redis
    );
    const groupPinService = new GroupPinService(
      groupMessagePinRepo,
      groupMessageRepo,
      groupRoomRepo,
      groupMemberRepo,
      cacheRepo,
      userSnapshotService,
      groupSystemMessageService
    );

    const notificationService = new NotificationService(
      notificationRepo,
      redis
    );
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
          // Read by the call authorization gate to refuse ringing a deleted
          // account (deletion is soft, so the Friendship rows survive it).
          // Only ever trusted when explicitly true — the catch below returns an
          // unknown snapshot, which must not read as "deleted".
          isDeleted: snap.isDeleted === true,
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
    const systemFlagRepo = new SystemFlagRepository(prisma);
    const callFlagService = new CallFlagService(systemFlagRepo);
    const callAnalyticsRepo = new CallAnalyticsRepository(prisma);
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
      callChatMessageService,
      // Platform-wide calling kill-switch (admin panel). Fails open.
      callFlagService,
      // GROUP call membership authorization + roster resolution.
      groupMemberRepo,
      // GROUP call timeline audit rows (VOICE_CALL / VIDEO_CALL).
      groupSystemMessageService
    );
    // An unfriend/block must end the pair's live calls, and the AMQP consumer
    // that hears about it has no CallService — see events/call-teardown-bridge.ts.
    registerCallTerminator((userA, userB) =>
      callService.endCallsBetween(userA, userB)
    );

    // Blocking must cut a live call. The friendship consumer is already running
    // (started above, before this graph exists), so it reaches CallService
    // through this late-bound hook rather than a constructor argument.
    setCallTerminator((userA, userB, endedBy) =>
      callService.terminateCallsBetween(userA, userB, endedBy)
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

    // Cross-module unread totals for the Chats/Community nav badges.
    const unreadSummaryService = new UnreadSummaryService(
      privateRoomService,
      groupRoomService,
      communityMessageService
    );
    // Wire the bridge (see events/unread-summary-bridge.ts) so every
    // publishConvUpdated/publishCommunityUpdated call site and the private/
    // group/community mark-read paths can push a fresh summary without each
    // needing UnreadSummaryService injected directly.
    //
    // COALESCED per user. `notifyUnreadChanged` fires once per RECIPIENT per
    // conv:updated — so one message into a 50-member group asked for 50
    // summaries, and each summary is three collection-wide unread aggregations
    // (private + group + community). A burst of sends or a rapid read sequence
    // turned that into hundreds of concurrent aggregations, which is what made
    // every other real-time effect on the same service (read receipts, list
    // bumps) queue behind it and arrive seconds late.
    //
    // A trailing window collapses a burst to one query set per user: the badge
    // is a TOTAL, so only the last value in a window was ever going to be
    // rendered anyway. The window is short enough to stay inside the sub-second
    // budget for a single isolated change.
    //
    // The coalesce above collapses REPEATS for one user; it does nothing for N
    // DISTINCT users, which is the message-fan-out case it was written for. So
    // the pusher also drops recipients who have no live session: the summary is
    // published to `user:<id>`, a channel only a CONNECTED socket subscribes
    // to, so for an offline member the three aggregations are computed and the
    // result then discarded by Redis for want of a subscriber. Skipping them
    // removes no delivery that was ever going to happen. Presence is resolved
    // for the whole batch in ONE cache read, and if it is briefly wrong the
    // member still gets the per-room `conv:updated`/`community:updated` bump
    // (published unconditionally, in the same pipeline) plus
    // `GET /chat/unread-summary` on next load, so the total self-heals.
    // Two windows, because the two callers have different budgets. A user's
    // OWN action (opening a room, marking read) must feel instant, so it keeps
    // the original 200 ms. Someone ELSE's message raising your total by one is
    // not something you are watching for, and a busy room otherwise recomputes
    // every online member's summary once per 200 ms window for the whole
    // burst — the longer window collapses a burst of inbound messages into a
    // single recompute per member without dropping a single push.
    const UNREAD_SUMMARY_COALESCE_MS = 200;
    const UNREAD_SUMMARY_FANOUT_COALESCE_MS = 1000;
    const unreadSummaryTimers = new Map<string, NodeJS.Timeout>();
    const scheduleUnreadSummary = (
      userId: string,
      delayMs: number = UNREAD_SUMMARY_COALESCE_MS
    ): void => {
      if (unreadSummaryTimers.has(userId)) return;
      unreadSummaryTimers.set(
        userId,
        setTimeout(() => {
          unreadSummaryTimers.delete(userId);
          void unreadSummaryService
            .getUnreadSummary(userId)
            .then((summary) =>
              publishChatUserEvent(
                redis,
                userId,
                "chat:unread_summary",
                summary
              )
            )
            .catch((err) => {
              logger.warn(
                `chat:unread_summary push failed for ${userId}: ${String(err)}`
              );
            });
        }, delayMs).unref()
      );
    };
    registerUnreadSummaryPusher((userIds) => {
      // Drop ids already scheduled BEFORE asking presence — a burst into one
      // room must not re-query presence for members whose timer is pending.
      const pending = userIds.filter(
        (id) => id && !unreadSummaryTimers.has(id)
      );
      if (pending.length === 0) return;
      // One id is the mark-read/self case: it is the caller's own action, the
      // socket that triggered it is by definition connected, and a presence
      // round trip would only add latency to it.
      if (pending.length === 1) {
        scheduleUnreadSummary(pending[0]!);
        return;
      }
      void presenceService
        .getPresenceMany(pending)
        .then((online) => {
          for (const id of pending) {
            if (online.get(id) === true)
              scheduleUnreadSummary(id, UNREAD_SUMMARY_FANOUT_COALESCE_MS);
          }
        })
        .catch((err) => {
          // Fail OPEN: a presence outage must not silently freeze every
          // member's nav badge. Falls back to the old behaviour.
          logger.warn(
            `chat:unread_summary presence filter failed: ${String(err)}`
          );
          for (const id of pending)
            scheduleUnreadSummary(id, UNREAD_SUMMARY_FANOUT_COALESCE_MS);
        });
    });

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

    // Auto-delete (disappearing messages) for private chats. Constructed AFTER
    // the orchestrator on purpose — the sweeper deletes through the very same
    // `deleteDirect` entry point a manual delete-for-everyone uses.
    const autoDeleteService = new AutoDeleteService(
      privateRoomRepo,
      privateMessageRepo,
      privateSystemMessageService,
      privatePinService,
      chatMessageOrchestrator,
      redis
    );

    // The same feature for GROUP rooms — one timer per group, admin-set. Same
    // construction order and the same reason: its sweeper deletes through
    // `deleteDirect` too.
    const groupAutoDeleteService = new GroupAutoDeleteService(
      groupRoomRepo,
      groupMemberRepo,
      groupMessageRepo,
      groupSystemMessageService,
      groupPinService,
      chatMessageOrchestrator,
      redis
    );

    // Bulk (multi-select) inbox operations. Owns no domain logic — it fans
    // each roomId out to the SAME single-conversation entry point the one-off
    // REST routes use, so bulk and individual calls can never drift.
    const conversationBulkService = new ConversationBulkService(
      privateRoomService,
      groupRoomService,
      groupMemberService,
      chatMessageOrchestrator,
      privateRoomRepo,
      groupRoomRepo
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
      generalRoomRepo,
      adminGroupService,
      cacheRepo,
      userSnapshotService,
      callService,
      callAnalyticsRepo,
      callFlagService,
      presenceService,
      communityMessageService,
      communityPinService,
      notificationRepo,
      chatMessageOrchestrator,
      privateRoomService,
    });

    // 4. Instantiate controllers
    const controllers = {
      privateRoomCtrl: new PrivateRoomController(
        privateRoomService,
        autoDeleteService
      ),
      inboxCtrl: new InboxController(inboxService),
      conversationBulkCtrl: new ConversationBulkController(
        conversationBulkService
      ),
      syncCtrl: new SyncController(syncService),
      privateMessageCtrl: new PrivateMessageController(
        privateMessageService,
        privatePinService,
        redis,
        chatMessageOrchestrator
      ),
      groupRoomCtrl: new GroupRoomController(
        groupRoomService,
        groupAutoDeleteService
      ),
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
      unreadSummaryCtrl: new UnreadSummaryController(unreadSummaryService),
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

    // Drop the cached Settings → Chat block the moment a user flips a switch,
    // so read receipts / typing stop (or resume) on the next event instead of
    // on the next cache expiry.
    startChatSettingsInvalidationListener();

    // Call sweepers — both multi-node safe (atomic per-row updateMany):
    //   1. RINGING  → MISSED after CALL_RINGING_TIMEOUT_SEC (never answered).
    //   2. IN_PROGRESS → ENDED after CALL_MAX_DURATION_SEC (answered, then the
    //      `room_finished` webhook was lost — the row would otherwise stay open
    //      forever and keep both participants "busy").
    // Independently caught so a failure in one never stops the other.
    callTimeoutSweepHandle = setInterval(() => {
      const now = new Date();
      void callService
        .sweepMissedCalls(
          now,
          env.CALL_RINGING_TIMEOUT_SEC,
          env.CALL_TIMEOUT_SWEEP_BATCH
        )
        .catch((err: unknown) => {
          logger.warn(`callTimeoutSweep failed: ${String(err)}`);
        });
      void callService
        .sweepStaleInProgressCalls(
          now,
          env.CALL_MAX_DURATION_SEC,
          env.CALL_TIMEOUT_SWEEP_BATCH
        )
        .catch((err: unknown) => {
          logger.warn(`callStaleInProgressSweep failed: ${String(err)}`);
        });
    }, env.CALL_TIMEOUT_SWEEP_INTERVAL_SEC * 1000);
    // Don't hold the event loop open on shutdown.
    if (typeof callTimeoutSweepHandle.unref === "function") {
      callTimeoutSweepHandle.unref();
    }

    // Group auto-unmute sweep — the counterpart of community-service's
    // mute-sweeper job. Correctness does NOT depend on it (mute enforcement
    // applies lazy expiry the instant `moderationMutedUntil` passes); it exists
    // to emit `group:member:unmuted` so the composer re-enables on every device
    // without a refresh, and to clear the stale flag. Exactly-once across nodes
    // via the atomic per-row claim, so no distributed lock is needed. Drains in
    // pages so one tick can never monopolise the DB.
    groupMuteSweepHandle = setInterval(() => {
      void (async () => {
        try {
          for (let i = 0; i < GROUP_MUTE_SWEEP_MAX_BATCHES; i++) {
            const n = await groupMemberService.expireDueModerationMutes(
              env.GROUP_MUTE_SWEEP_BATCH
            );
            if (n > 0)
              logger.info(`Group auto-unmute sweep expired ${n} mute(s)`);
            if (n < env.GROUP_MUTE_SWEEP_BATCH) break; // drained
          }
        } catch (err) {
          logger.warn(`groupMuteSweep failed: ${String(err)}`);
        }
      })();
    }, env.GROUP_MUTE_SWEEP_INTERVAL_SEC * 1000);
    if (typeof groupMuteSweepHandle.unref === "function") {
      groupMuteSweepHandle.unref();
    }

    // Auto-delete (disappearing messages) sweep. Unlike the mute sweep this one
    // is load-bearing: it performs the actual deletion, server-side, so a
    // message disappears on schedule even when neither client is running
    // (§5.2 offline sender, §8.4 offline device). Drains in pages.
    //
    // Rows are LEASED, so several replicas may sweep concurrently and still
    // produce exactly one delete per message. What a lease does NOT prevent is
    // one process starting a second pass over its own un-drained backlog every
    // 30s until it is doing nothing but re-reading the same pages — hence the
    // in-flight flag below, which is per-process and per-conversation-type.
    const sweepInFlight: Record<string, boolean> = {};
    const runAutoDeleteSweep = (): void => {
      // Private and group drain independently and are caught separately, so a
      // failure on one conversation type can never stall the other.
      for (const [label, sweep, repair] of [
        [
          "private",
          (n: number) => autoDeleteService.sweepDue(new Date(), n),
          (n: number) => autoDeleteService.sweepPendingRestamps(n),
        ],
        [
          "group",
          (n: number) => groupAutoDeleteService.sweepDue(new Date(), n),
          (n: number) => groupAutoDeleteService.sweepPendingRestamps(n),
        ],
      ] as const) {
        if (sweepInFlight[label]) {
          logger.warn(
            `autoDeleteSweep(${label}) still running — skipping this tick`
          );
          continue;
        }
        sweepInFlight[label] = true;
        void (async () => {
          try {
            for (let i = 0; i < AUTO_DELETE_SWEEP_MAX_BATCHES; i++) {
              const { claimed, completed, failed } = await sweep(
                env.AUTO_DELETE_SWEEP_BATCH
              );
              if (claimed > 0)
                logger.info(
                  `Auto-delete sweep (${label}) claimed ${claimed}, deleted ${completed}, failed ${failed}`
                );
              if (claimed < env.AUTO_DELETE_SWEEP_BATCH) break; // drained
            }
            // Finish any setting change whose re-stamp never completed. Cheap:
            // an indexed lookup that returns nothing on a healthy system.
            const settled = await repair(AUTO_DELETE_RESTAMP_REPAIR_BATCH);
            if (settled > 0)
              logger.info(
                `Auto-delete restamp repair (${label}) settled ${settled} room(s)`
              );
          } catch (err) {
            logger.warn(`autoDeleteSweep(${label}) failed: ${String(err)}`);
          } finally {
            sweepInFlight[label] = false;
          }
        })();
      }
    };

    // Catch-up pass at startup, BEFORE the first interval fires. Without it,
    // everything that expired while the service was down (a deploy, a crash, a
    // scale-to-zero) sat undeleted for a further AUTO_DELETE_SWEEP_INTERVAL_SEC
    // — the exact window in which a disappearing message is expected to have
    // already disappeared.
    runAutoDeleteSweep();
    autoDeleteSweepHandle = setInterval(
      runAutoDeleteSweep,
      env.AUTO_DELETE_SWEEP_INTERVAL_SEC * 1000
    );
    if (typeof autoDeleteSweepHandle.unref === "function") {
      autoDeleteSweepHandle.unref();
    }

    // Presence staleness sweep. Load-bearing: a socket can vanish without ever
    // producing a `disconnect` (killed process, dead TCP path, a gateway node
    // that went down with its sockets open). The device-session hashes then
    // expire silently — and silence is the bug, because a peer's dot only ever
    // changes when `presence:status` is published. This tick re-derives exactly
    // the users whose ONLINE belief is past due and lets PresenceService emit
    // the OFFLINE + server-stamped lastSeen. Multi-node safe: the transition is
    // decided atomically in Redis, so N replicas still produce one event.
    presenceSweepHandle = setInterval(() => {
      void (async () => {
        try {
          const n = await presenceService.sweepStaleSessions(
            env.PRESENCE_SWEEP_BATCH
          );
          if (n > 0) logger.info(`Presence sweep re-derived ${n} user(s)`);
        } catch (err) {
          logger.warn(`presenceSweep failed: ${String(err)}`);
        }
      })();
    }, env.PRESENCE_SWEEP_INTERVAL_SEC * 1000);
    if (typeof presenceSweepHandle.unref === "function") {
      presenceSweepHandle.unref();
    }

    // "Login Detected" auto-approval sweep. Load-bearing, like the auto-delete
    // one: the deadline lives on the row, so an alert is resolved on schedule
    // whether or not any client is running — and a service that was down when
    // a deadline passed simply picks the row up on its next tick (the query is
    // "past due", not "due right now", so nothing is ever stranded). Runs
    // straight away on boot for exactly that catch-up case, then on interval.
    // Multi-node safe via the atomic per-row claim; drains in pages.
    const runLoginExpirySweep = async (): Promise<void> => {
      try {
        for (let i = 0; i < LOGIN_EXPIRY_SWEEP_MAX_BATCHES; i++) {
          const due = await notificationService.sweepExpiredLoginNotifications(
            new Date(),
            env.LOGIN_EXPIRY_SWEEP_BATCH
          );
          if (due > 0)
            logger.info(`Login-detected sweep auto-approved ${due} alert(s)`);
          // Short page = drained, or the remainder was claimed by another node.
          // Either way there is nothing more for THIS tick to do; anything left
          // is still past-due and gets picked up on the next one.
          if (due < env.LOGIN_EXPIRY_SWEEP_BATCH) break;
        }
      } catch (err) {
        logger.warn(`loginExpirySweep failed: ${String(err)}`);
      }
    };
    void runLoginExpirySweep();
    loginExpirySweepHandle = setInterval(() => {
      void runLoginExpirySweep();
    }, env.LOGIN_EXPIRY_SWEEP_INTERVAL_SEC * 1000);
    if (typeof loginExpirySweepHandle.unref === "function") {
      loginExpirySweepHandle.unref();
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

  if (groupMuteSweepHandle) {
    clearInterval(groupMuteSweepHandle);
    groupMuteSweepHandle = undefined;
  }

  if (autoDeleteSweepHandle) {
    clearInterval(autoDeleteSweepHandle);
    autoDeleteSweepHandle = undefined;
  }

  if (loginExpirySweepHandle) {
    clearInterval(loginExpirySweepHandle);
    loginExpirySweepHandle = undefined;
  }

  if (presenceSweepHandle) {
    clearInterval(presenceSweepHandle);
    presenceSweepHandle = undefined;
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
