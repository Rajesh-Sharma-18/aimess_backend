import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { startConsumer } from "./consumers/notification.consumer.js";
import { startGrpcServer } from "./grpc/server.js";

async function start() {
  try {
    try {
      await startConsumer();
    } catch (error) {
      logger.warn(
        "RabbitMQ unavailable after retries — notification consumer will not run until service restarts"
      );
      logger.warn(error);
    }

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
