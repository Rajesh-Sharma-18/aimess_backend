import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";

async function start() {
  try {
    app.listen(env.PORT, "0.0.0.0", () => {
      logger.info("Backoffice Service listening on port " + String(env.PORT));
    });
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

void start();
