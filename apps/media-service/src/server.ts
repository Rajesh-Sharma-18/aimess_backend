import { logger } from "@aimess/logger";
import { ensureBuckets } from "@aimess/storage";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { storageClient } from "./config/storage.js";
import { startMediaGrpcServer } from "./grpc/server.js";

async function start() {
  try {
    try {
      await ensureBuckets(storageClient, [
        env.MINIO_BUCKET_AVATARS,
        env.MINIO_BUCKET_COMMUNITY,
        env.MINIO_BUCKET,
      ]);
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
