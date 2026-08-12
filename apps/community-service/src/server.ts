import { logger } from "@aimess/logger";

import { ensureBuckets } from "@aimess/storage";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { storageClient } from "./config/storage.js";
import { prisma } from "./config/prisma.js";
import {
  connectCommunityRedis,
  disableCommunityCache,
} from "./config/redis.js";
import { startUserProfileUpdatedConsumer } from "./consumers/user-profile-updated.consumer.js";
import { startCommunityActivityConsumer } from "./consumers/community-activity.consumer.js";
import { startStreamLifecycleConsumer } from "./consumers/stream-lifecycle.consumer.js";
import { startStreamLiveConsumer } from "./consumers/stream-live.consumer.js";
import { startGrpcServer } from "./grpc/server.js";
import {
  startMuteSweeper,
  backfillActiveMutesToChat,
} from "./jobs/mute-sweeper.js";

function getRawCommandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const meta = (error as { meta?: { message?: unknown } }).meta;
  if (typeof meta?.message === "string") return meta.message;
  if (error instanceof Error) return error.message;
  return "";
}

function isDuplicateKeyIndexBuildError(error: unknown): boolean {
  const message = getRawCommandErrorMessage(error);
  return message.includes("E11000 duplicate key error");
}

async function start() {
  try {
    await prisma.$connect();
    logger.info("MongoDB connected");

    // Sparse unique index on Community.invitationCode — enforces global uniqueness
    // for non-null codes while allowing multiple communities to have null (i.e. no
    // permanent link yet). Prisma cannot express sparse indexes in the MongoDB
    // schema, so we create it idempotently here. createIndex is a no-op when the
    // index already exists with the same options.
    try {
      await prisma.$runCommandRaw({
        createIndexes: "communities",
        indexes: [
          {
            key: { invitationCode: 1 },
            name: "communities_invitationCode_unique_sparse",
            unique: true,
            sparse: true,
          },
        ],
      });
      logger.info("Index ready: communities.invitationCode (sparse unique)");
    } catch (indexErr) {
      logger.warn(
        "Could not create invitationCode sparse index — permanent invite links may lack uniqueness enforcement"
      );
      logger.warn(indexErr);
    }

    // Partial unique index on CommunityReport(communityId, reporterId,
    // targetUserId, reportedMessageId) — enforces "a user can report another
    // user only once per community, regardless of report status" at the DB
    // level. Scoped with partialFilterExpression to rows where targetUserId is
    // an actual string (i.e. targeted reports only), so community-level reports
    // (targetUserId stored as an explicit null) are never constrained by it —
    // Prisma cannot express partial/filtered indexes in the MongoDB schema,
    // so (like invitationCode above) we create it idempotently here.
    //
    // reportedMessageId is part of the key because a MESSAGE report also stores
    // the sender in targetUserId: without it, "report user B" and "report a
    // message B sent" collided on one unique slot and the second 409'd even
    // though they are different targets. Member reports keep reportedMessageId
    // null, so their uniqueness rule is unchanged.
    try {
      await prisma.$runCommandRaw({
        createIndexes: "community_reports",
        indexes: [
          {
            key: {
              communityId: 1,
              reporterId: 1,
              targetUserId: 1,
              reportedMessageId: 1,
            },
            name: "community_reports_reporter_target_message_unique",
            unique: true,
            partialFilterExpression: { targetUserId: { $type: "string" } },
          },
        ],
      });
      logger.info(
        "Index ready: community_reports.(communityId, reporterId, targetUserId, reportedMessageId) (partial unique)"
      );
      // Superseded by the index above — a pure (community, reporter, target)
      // unique would still reject a message report about an already-reported
      // member. Dropped only after the replacement exists; a missing old index
      // (fresh DB / second boot) is not an error.
      try {
        await prisma.$runCommandRaw({
          dropIndexes: "community_reports",
          index: "community_reports_reporter_target_unique",
        });
        logger.info(
          "Dropped superseded index: community_reports_reporter_target_unique"
        );
      } catch {
        // IndexNotFound — nothing to drop.
      }
    } catch (indexErr) {
      logger.warn(
        "Could not create community_reports duplicate-report unique index — falling back to service-level dedup only"
      );
      if (isDuplicateKeyIndexBuildError(indexErr)) {
        logger.warn(
          "Existing duplicate member-targeted reports must be repaired before MongoDB can build the unique index. Run: pnpm --filter @aimess/community-service db:repair:report-duplicates"
        );
      } else {
        logger.warn(indexErr);
      }
    }

    if (env.REDIS_CACHE_ENABLED) {
      try {
        await connectCommunityRedis();
        logger.info("Redis connected (caching enabled)");
      } catch (error) {
        disableCommunityCache();
        logger.warn(
          "Redis unavailable — community-service will run without availability caching"
        );
        logger.warn(error);
      }
    }

    try {
      await ensureBuckets(storageClient, [env.MINIO_BUCKET_COMMUNITY]);
      logger.info(`MinIO buckets ready: ${env.MINIO_BUCKET_COMMUNITY}`);
    } catch (error) {
      logger.warn(
        "MinIO unavailable — community image APIs will fail until credentials/MinIO are fixed"
      );
      logger.warn(error);
    }

    try {
      await startUserProfileUpdatedConsumer();
      logger.info("RabbitMQ consumer ready (user.profile_updated.queue)");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable on boot — user profile snapshot sync will not run until reconnected"
      );
      logger.warn(error);
    }

    try {
      await startCommunityActivityConsumer();
      logger.info("RabbitMQ consumer ready (community.activity.queue)");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable on boot — community lastActivityAt sync will not run until reconnected"
      );
      logger.warn(error);
    }

    try {
      await startStreamLifecycleConsumer();
      logger.info("RabbitMQ consumer ready (community.stream-lifecycle.queue)");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable on boot — livestream system messages + push will not run until reconnected"
      );
      logger.warn(error);
    }

    try {
      await startStreamLiveConsumer();
      logger.info("RabbitMQ consumer ready (stream.live.community.queue)");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable on boot — community stream live indicator sync will not run until reconnected"
      );
      logger.warn(error);
    }

    // Start gRPC server (stub implementations — real logic wired in later)
    startGrpcServer(env.COMMUNITY_GRPC_PORT);

    // Auto-unmute: re-mirror existing active mutes to chat-service (one-shot
    // migration backfill, best-effort) then start the per-minute expiry sweep.
    void backfillActiveMutesToChat();
    startMuteSweeper();

    app.listen(env.COMMUNITY_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        "Community Service listening on port " +
          String(env.COMMUNITY_SERVICE_PORT)
      );
    });
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

void start();
