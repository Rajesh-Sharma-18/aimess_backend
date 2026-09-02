import { logger } from "@aimess/logger";
import { startUserPurgedConsumer } from "@aimess/messaging";

import { handleUserPurged } from "./handlers/user-purged.handler.js";

import { ensureBuckets } from "@aimess/storage";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { startUserGrpcServer } from "./grpc/server.js";
import { storageClient } from "./config/storage.js";
import { prisma } from "./config/prisma.js";
import { connectUserRedis, disableUserCache } from "./config/redis.js";
import { startUserCreatedConsumer } from "./consumers/user-created.consumer.js";
import { startUserDeletedConsumer } from "./consumers/user-deleted.consumer.js";
import { startUserRestoredConsumer } from "./consumers/user-restored.consumer.js";

async function start() {
  try {
    await prisma.$connect();
    logger.info("PostgreSQL connected");

    if (env.REDIS_CACHE_ENABLED) {
      try {
        await connectUserRedis();
        logger.info("Redis connected (caching enabled)");
      } catch (error) {
        disableUserCache();
        logger.warn(
          "Redis unavailable — user-service will run without response caching"
        );
        logger.warn(error);
      }
    }

    try {
      await ensureBuckets(storageClient, [env.MINIO_BUCKET_AVATARS]);
      logger.info(`MinIO buckets ready: ${env.MINIO_BUCKET_AVATARS}`);
    } catch (error) {
      logger.warn(
        "MinIO unavailable — avatar upload APIs will fail until credentials/MinIO are fixed"
      );
      logger.warn(error);
    }

    try {
      await startUserCreatedConsumer();
      await startUserDeletedConsumer();
      await startUserRestoredConsumer();
      // Erasure obligation: a purged account's personal data must be removed
      // from THIS service's copies too. Bound to the durable `user.purged`
      // fanout, so an event that fires while this service is down is processed
      // when it comes back rather than lost.
      await startUserPurgedConsumer({
        rabbitUrl: env.RABBITMQ_URL,
        serviceName: "user-service",
        onPurge: handleUserPurged,
        logger,
      });
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable after retries — user event consumers will not run until service restarts"
      );
      logger.warn(error);
    }

    app.listen(env.USER_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        "User Service listening on port " + String(env.USER_SERVICE_PORT)
      );
    });

    try {
      startUserGrpcServer();
    } catch (error) {
      logger.warn(
        "user-service gRPC server failed to start — CheckFriendship RPC will be unavailable"
      );
      logger.warn(error);
    }
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

void start();
