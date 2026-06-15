import { createServer } from "node:http";

import { logger } from "@aimess/logger";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { setupSockets } from "./sockets/index.js";
import { createMessagingClient } from "./grpc/clients/messaging.client.js";
import { createMediaClient } from "./grpc/clients/media.client.js";

async function start() {
  try {
    const messagingClient = createMessagingClient();
    const mediaClient = createMediaClient();
    const app = createApp(messagingClient, mediaClient);
    const httpServer = createServer(app);

    // Attach Socket.IO (Redis adapter init + namespace registration)
    await setupSockets(httpServer, messagingClient, mediaClient);

    // Bounded EADDRINUSE retry: under `tsx watch`, a packages/* rebuild restarts
    // every service at once and the new instance can try to bind before the old
    // one has released the port. listen() reports that as an async 'error' event
    // (not a throwable) — without this handler it crashes the process for good
    // and the watcher never recovers. Retry briefly, then exit cleanly.
    const MAX_BIND_ATTEMPTS = 5;
    let bindAttempt = 0;
    const tryListen = () => {
      bindAttempt += 1;
      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && bindAttempt < MAX_BIND_ATTEMPTS) {
          logger.warn(
            `Port ${String(env.API_GATEWAY_PORT)} busy (EADDRINUSE); retry ${bindAttempt}/${MAX_BIND_ATTEMPTS} in 500ms…`
          );
          setTimeout(tryListen, 500);
          return;
        }
        logger.error(
          `API Gateway failed to bind port ${String(env.API_GATEWAY_PORT)}: ${err.message}`
        );
        process.exit(1);
      });
      httpServer.listen(env.API_GATEWAY_PORT, "0.0.0.0", () => {
        const port = String(env.API_GATEWAY_PORT);
        logger.info(`API Gateway running on port ${port}`);
        logger.info(`Swagger UI (v1): http://localhost:${port}/docs/v1`);
        logger.info(`AsyncAPI (ws):   http://localhost:${port}/docs/socket`);
        logger.info(`API base (v1):   http://localhost:${port}/api/v1`);
        logger.info(`Socket.IO:       ws://localhost:${port}/socket.io/`);
      });
    };
    tryListen();
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

start();
