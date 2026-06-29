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
import { startStreamLiveConsumer } from "./consumers/stream-live.consumer.js";
import { startGrpcServer } from "./grpc/server.js";

async function start() {
  try {
    await prisma.$connect();
    logger.info("MongoDB connected");

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
