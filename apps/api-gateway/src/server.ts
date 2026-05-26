import { createServer } from "node:http";

import { logger } from "@aimess/logger";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { setupSockets } from "./sockets/index.js";

async function start() {
  try {
    const httpServer = createServer(app);

    // Attach Socket.IO (Redis adapter init + namespace registration)
    await setupSockets(httpServer);

    httpServer.listen(env.API_GATEWAY_PORT, "0.0.0.0", () => {
      const port = String(env.API_GATEWAY_PORT);
      logger.info(`API Gateway running on port ${port}`);
      logger.info(`Swagger UI (v1): http://localhost:${port}/docs/v1`);
      logger.info(`API base (v1):   http://localhost:${port}/api/v1`);
      logger.info(`Socket.IO:       ws://localhost:${port}/socket.io/`);
    });
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

start();
