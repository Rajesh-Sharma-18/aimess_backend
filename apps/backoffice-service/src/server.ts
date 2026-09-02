import type { Server } from "node:http";

import type * as grpc from "@grpc/grpc-js";
import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { connectBackofficeRedis, redis } from "./config/redis.js";
import { startAnnouncementScheduler } from "./lib/announcement-scheduler.js";
import { startLoginFailureSweeper } from "./lib/login-failure-sweeper.js";
import { startBackofficeGrpcServer } from "./grpc/server.js";
import { startAdminActivityIngestConsumer } from "./messaging/consume-admin-activity-ingest.js";
import { startAdminReportIngestConsumer } from "./messaging/consume-admin-report-ingest.js";
import { startAnnouncementDeliveryConsumer } from "./messaging/consume-announcement-delivery.js";
import { startStreamLifecycleConsumer } from "./messaging/consume-stream-lifecycle.js";

let httpServer: Server | undefined;
let grpcServer: grpc.Server | undefined;

const startServer = async (): Promise<void> => {
  logger.info("Backoffice service starting…");

  try {
    await prisma.$connect();
    logger.info("PostgreSQL (admin_db) connected");

    // Bounded so a hung/misconfigured Redis can never block app.listen. The
    // active-session + perms cache recover once Redis is reachable again.
    try {
      await Promise.race([
        connectBackofficeRedis(),
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
        "Redis unavailable/timed out — backoffice-service is starting anyway; active-session + perms cache will fail until Redis is reachable"
      );
      logger.warn(error);
    }

    // Bounded so a down/misconfigured broker can never block app.listen. Report
    // ingestion resumes once RabbitMQ is reachable again.
    try {
      await Promise.race([
        startAdminReportIngestConsumer(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("RabbitMQ connect timed out after 5s")),
            5000
          )
        ),
      ]);
      logger.info("Admin report ingest consumer connected");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable/timed out — backoffice-service starting anyway; report ingestion will not run until RabbitMQ is reachable"
      );
      logger.warn(error);
    }

    try {
      await Promise.race([
        startAdminActivityIngestConsumer(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error("RabbitMQ activity ingest connect timed out after 5s")
              ),
            5000
          )
        ),
      ]);
      logger.info("Admin activity ingest consumer connected");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable/timed out — website activity ingestion will not run until RabbitMQ is reachable"
      );
      logger.warn(error);
    }

    try {
      await Promise.race([
        startStreamLifecycleConsumer(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "RabbitMQ stream lifecycle connect timed out after 5s"
                )
              ),
            5000
          )
        ),
      ]);
      logger.info("Stream lifecycle consumer connected");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable/timed out — stream lifecycle consumer will not run until RabbitMQ is reachable"
      );
      logger.warn(error);
    }

    try {
      await Promise.race([
        startAnnouncementDeliveryConsumer(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "RabbitMQ announcement delivery connect timed out after 5s"
                )
              ),
            5000
          )
        ),
      ]);
      logger.info("Announcement delivery consumer connected");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable/timed out — announcement delivery will not run until RabbitMQ is reachable"
      );
      logger.warn(error);
    }

    try {
      startAnnouncementScheduler();
      // Admin login-failure rows are durable now, so nothing expires them.
      startLoginFailureSweeper();
      logger.info("Announcement scheduler started");
    } catch (error) {
      logger.warn("Failed to start announcement scheduler");
      logger.warn(error);
    }

    grpcServer = startBackofficeGrpcServer();

    httpServer = app.listen(env.BACKOFFICE_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        `Backoffice service listening on port ${String(env.BACKOFFICE_SERVICE_PORT)}`
      );
      logger.info("Admin routes: /v1/auth/*, /v1/me/*, /health, /health/ready");
    });
  } catch (error) {
    logger.error("Backoffice service startup failed");
    logger.error(error);
    process.exit(1);
  }
};

async function shutdown(signal: string): Promise<void> {
  logger.info(`Backoffice service shutting down (${signal})…`);

  await new Promise<void>((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }
    httpServer.close(() => resolve());
  });

  if (grpcServer) {
    grpcServer.forceShutdown();
  }

  try {
    await prisma.$disconnect();
  } catch {
    // ignore disconnect errors during shutdown
  }

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
