import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { startConsumer } from "./consumers/notification.consumer.js";

async function start() {
  try {
    await startConsumer();
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
