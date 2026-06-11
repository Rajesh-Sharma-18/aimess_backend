import type { Server } from "node:http";

import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { connectBackofficeRedis, redis } from "./config/redis.js";
import { startAdminReportIngestConsumer } from "./messaging/consume-admin-report-ingest.js";

let httpServer: Server | undefined;

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
