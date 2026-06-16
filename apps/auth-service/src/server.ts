import type { Server } from "node:http";

import app from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { connectAuthRedis, redis } from "./config/redis.js";
import { startProfileUpdatedConsumer } from "./messaging/profile-updated-consumer.js";
import { startAdminUserConsumer } from "./messaging/admin-user-consumer.js";
import { startGrpcServer } from "./grpc/server.js";
import { logger } from "@aimess/logger";
import type * as grpc from "@grpc/grpc-js";

let httpServer: Server | undefined;
let grpcServer: grpc.Server | undefined;

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

    // Mirror profile-completion status from user-service. Wrapped so a broker
    // outage never blocks startup; the flag just stays stale until reconnect.
    try {
      await startProfileUpdatedConsumer();
      logger.info("RabbitMQ profile-updated consumer started");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable after retries — profile-completion sync will not run until auth-service restarts"
      );
      logger.warn(error);
    }

    // Consume backoffice admin.user_* events: force-logout banned/suspended
    // users + bridge a notify to notifications-service. Wrapped so a broker
    // outage never blocks startup.
    try {
      await startAdminUserConsumer();
      logger.info("RabbitMQ admin.user consumer started");
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable after retries — admin force-logout/notify will not run until auth-service restarts"
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

    // Admin-dashboard aggregation gRPC server (read-only user/active counts).
    grpcServer = startGrpcServer(env.AUTH_GRPC_PORT);
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
