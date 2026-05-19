import { logger } from "@aimess/logger";
import { app } from "./app.js";
import { env } from "./config/env.js";

async function start() {
  try {
    app.listen(env.API_GATEWAY_PORT, "0.0.0.0", () => {
      const port = String(env.API_GATEWAY_PORT);
      logger.info(`API Gateway running on port ${port}`);
      logger.info(`Swagger UI (v1): http://localhost:${port}/docs/v1`);
      logger.info(`API base (v1): http://localhost:${port}/api/v1`);
    });
  } catch (error) {
    logger.error(error);

    process.exit(1);
  }
}

start();
