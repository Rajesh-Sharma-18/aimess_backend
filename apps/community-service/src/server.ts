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
