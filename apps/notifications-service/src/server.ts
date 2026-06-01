import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase } from "./config/prisma.js";
import { redis } from "./config/redis.js";
import { startCommunityConsumer } from "./consumers/community.consumer.js";
import { startConsumer } from "./consumers/notification.consumer.js";
import { startFriendConsumer } from "./consumers/friend.consumer.js";
import { startSettingsConsumer } from "./consumers/settings.consumer.js";
import { startGrpcServer } from "./grpc/server.js";

/** Start a consumer without letting RabbitMQ outages crash the service. */
async function startConsumerSafe(
  name: string,
  start: () => Promise<void>
): Promise<void> {
  try {
    await start();
  } catch (error) {
    logger.warn(
      `RabbitMQ unavailable — ${name} will not run until the service restarts`
    );
    logger.warn(error);
  }
}

async function start() {
  try {
    // Device-token store. Required for push delivery; fail fast if unreachable.
    await connectDatabase();

    // Wait briefly for the settings-cache Redis client to be ready before
    // starting consumers (enableOfflineQueue is false, so commands issued
    // before the connection is up would error). Non-fatal: proceed after a
    // short timeout and let the cache helpers fall through to gRPC.
    if (redis.status !== "ready") {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          redis.off("ready", done);
          resolve();
        };
        const timer = setTimeout(done, 3000);
        redis.once("ready", done);
      });
    }

    await startConsumerSafe("notification consumer", startConsumer);
    await startConsumerSafe("community consumer", startCommunityConsumer);
    await startConsumerSafe("friend consumer", startFriendConsumer);
    await startConsumerSafe("settings consumer", startSettingsConsumer);

    // Start gRPC server (stub implementations — real logic wired in later)
    startGrpcServer(env.NOTIFICATIONS_GRPC_PORT);

    app.listen(env.NOTIFICATIONS_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        "Notifications Service listening on port " +
          String(env.NOTIFICATIONS_SERVICE_PORT)
      );
    });
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

void start();
