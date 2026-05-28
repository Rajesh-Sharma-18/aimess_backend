import type { Server } from "node:http";

import app from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { connectAuthRedis, redis } from "./config/redis.js";
import { logger } from "@aimess/logger";

let httpServer: Server | undefined;

const startServer = async () => {
  logger.info("Auth service starting…");

  try {
    await prisma.$connect();
    logger.info("PostgreSQL connected");

    // Bounded so a hung/misconfigured Redis can never block app.listen (e.g. a
    // port collision where another process holds 6379). Redis-backed features
    // (OTP throttle, device-link, session cache) recover once Redis is reachable.
    try {
      await Promise.race([
        connectAuthRedis(),
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
        "Redis unavailable/timed out — auth-service is starting anyway; Redis-backed features (OTP throttle, device-link, session cache) will fail until Redis is reachable"
      );
      logger.warn(error);
    }

    httpServer = app.listen(env.AUTH_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        `Auth service listening on port ${String(env.AUTH_SERVICE_PORT)}`
      );
      logger.info(
        "Auth routes: accounts/validate, register, login, refresh, logout, sessions, google, apple, internal/account, forgot-password/*, link-email/*, change-email/*, change-password, social/*/link, social/unlink"
      );
    });
  } catch (error) {
    logger.error("Auth service startup failed");
    logger.error(error);
    process.exit(1);
  }
};

async function shutdown(signal: string): Promise<void> {
  logger.info(`Auth service shutting down (${signal})…`);

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
