import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase } from "./config/prisma.js";
import { redis } from "./config/redis.js";
import { startChatConsumer } from "./consumers/chat.consumer.js";
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

    // Explicitly connect the Redis client before consumers start.
    // lazyConnect:true means ioredis stays in "wait" state until .connect() is
    // called — it does NOT auto-connect on the first command. Combined with
    // enableOfflineQueue:false, every command would immediately throw
    // "Stream isn't writeable" without this call.
    // Non-fatal: if Redis is unreachable the cache helpers fall through to gRPC.
    if (redis.status === "wait") {
      try {
        await redis.connect();
      } catch {
        logger.warn(
          "Redis unavailable at startup; notif settings will fall through to gRPC on each message"
        );
      }
    }

    await startConsumerSafe("notification consumer", startConsumer);
    await startConsumerSafe("chat push consumer", startChatConsumer);
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
