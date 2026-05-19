import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { ensureStorageBuckets } from "./config/minio.js";
import { prisma } from "./config/prisma.js";
import { connectUserRedis, disableUserCache } from "./config/redis.js";
import { startUserCreatedConsumer } from "./consumers/user-created.consumer.js";

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
      await ensureStorageBuckets();
      logger.info(`MinIO buckets ready: ${env.MINIO_BUCKET_AVATARS}`);
    } catch (error) {
      logger.warn(
        "MinIO unavailable — avatar upload APIs will fail until credentials/MinIO are fixed"
      );
      logger.warn(error);
    }

    await startUserCreatedConsumer();

    app.listen(env.USER_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        "User Service listening on port " + String(env.USER_SERVICE_PORT)
      );
    });
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

void start();
