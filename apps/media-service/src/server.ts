import { logger } from "@aimess/logger";
import { ensureBuckets } from "@aimess/storage";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { storageClient } from "./config/storage.js";
import { connectMediaRedis } from "./config/redis.js";
import { startScanWorker, getScanQueue } from "./lib/scanner.js";
import { startMediaGrpcServer } from "./grpc/server.js";

async function start() {
  try {
    // Redis — used for scan-status cache. Non-fatal: confirm/download endpoints
    // degrade gracefully when Redis is unavailable (status reads return null,
    // treated as unconfirmed).
    try {
      await Promise.race([
        connectMediaRedis(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Redis connect timed out after 5s")),
            5000
          )
        ),
      ]);
      logger.info("Redis connected");
    } catch (error) {
      logger.warn(
        "Redis unavailable — scan-status gating will be bypassed until Redis is reachable"
      );
      logger.warn(error);
    }

    if (env.CLAMAV_ENABLED) {
      try {
        startScanWorker();
      } catch (error) {
        logger.warn(
          "media-scan worker failed to start — scans will fall back to inline on confirm"
        );
        logger.warn(error);
      }
    } else {
      logger.info(
        "CLAMAV_ENABLED=false — media-scan worker not started (confirm runs synchronously)"
      );
    }

    try {
      const corsOrigins =
        env.CORS_ALLOWED_ORIGINS === "*"
          ? ["*"]
          : env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim());
      await ensureBuckets(
        storageClient,
        [
          env.MINIO_BUCKET_AVATARS,
          env.MINIO_BUCKET_COMMUNITY,
          env.MINIO_BUCKET,
        ],
        corsOrigins
      );
      logger.info(
        `MinIO buckets ready: ${env.MINIO_BUCKET_AVATARS}, ${env.MINIO_BUCKET_COMMUNITY}, ${env.MINIO_BUCKET}`
      );
    } catch (error) {
      logger.warn(
        "MinIO unavailable — media upload/download APIs will fail until MinIO is reachable"
      );
      logger.warn(error);
    }

    const server = app.listen(env.MEDIA_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        "Media Service listening on port " + String(env.MEDIA_SERVICE_PORT)
      );
    });

    try {
      startMediaGrpcServer();
    } catch (error) {
      logger.warn(
        "media-service gRPC server failed to start — GenerateUploadUrl/GenerateDownloadUrl RPCs will be unavailable"
      );
      logger.warn(error);
    }

    process.on("SIGTERM", () => {
      logger.info("SIGTERM received — shutting down media-service");
      // Only close the Bull queue if it may exist — calling getScanQueue()
      // lazily creates one, so guard on the only path that ever creates it.
      if (env.CLAMAV_ENABLED) {
        void getScanQueue()
          .close()
          .catch(() => undefined);
      }
      server.close(() => {
        logger.info("HTTP server closed");
        process.exit(0);
      });
    });
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

void start();
