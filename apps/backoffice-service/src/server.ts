import type { Server } from "node:http";

import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { connectBackofficeRedis, redis } from "./config/redis.js";

let httpServer: Server | undefined;

const startServer = async (): Promise<void> => {
  logger.info("Backoffice service starting…");

  try {
    await prisma.$connect();
    logger.info("PostgreSQL (admin_db) connected");

    // Bounded so a hung/misconfigured Redis can never block app.listen. The
    // jti-blacklist + cache recover once Redis is reachable again.
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
        "Redis unavailable/timed out — backoffice-service is starting anyway; jti blacklist + cache will fail until Redis is reachable"
      );
      logger.warn(error);
    }

    // TODO: start the backoffice gRPC server on env.BACKOFFICE_GRPC_PORT (4010)
    // when read-only RPCs / event consumers land. Out of scope for this slice.

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
