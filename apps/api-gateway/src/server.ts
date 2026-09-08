import { createServer } from "node:http";

import { logger } from "@aimess/logger";
import { connectRedis } from "@aimess/redis";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { setupSockets } from "./sockets/index.js";
import { createMessagingClient } from "./grpc/clients/messaging.client.js";
import { createMediaClient } from "./grpc/clients/media.client.js";

/**
 * Last-resort process guards.
 *
 * Socket.IO does not wrap event listeners in try/catch, so a throw inside any
 * handler reaches the process. With no `uncaughtException` listener, Node's
 * default is to terminate — and this process is the only public edge, so one
 * malformed socket frame took down all REST proxying and all six namespaces for
 * every user at once. (The specific throw that motivated this is fixed at
 * source: the /admin handlers now validate their payloads. This is the backstop
 * for the next one.)
 *
 * Deliberately NOT a blanket swallow. An uncaught exception means the process
 * is in an unknown state, so it is logged and the process still exits — but on
 * OUR terms: the exit is deferred long enough for the log to flush, and the
 * supervisor restarts a clean process. What changes is that the failure is
 * recorded with its stack instead of vanishing, and an unhandled promise
 * rejection (far more often a lost `.catch()` on one request than real
 * corruption) is logged without taking the edge down.
 */
function installProcessGuards(): void {
  process.on("uncaughtException", (error: Error) => {
    logger.error(
      `Uncaught exception — exiting: ${error.message}\n${error.stack ?? ""}`
    );
    // Give the transport a tick to write the line before the process goes.
    setTimeout(() => process.exit(1), 100).unref();
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(
      `Unhandled promise rejection: ${error.message}\n${error.stack ?? ""}`
    );
  });
}

async function start() {
  installProcessGuards();

  try {
    // Populates the @aimess/redis singleton that getRedis() returns. Without
    // it the chat ban-gate threw "Redis client not initialized" on EVERY
    // request and failed open — measured at 361 warnings/hour in production,
    // meaning that gate has never actually run. The Socket.IO adapter builds
    // its own clients from the same URL, so this adds one connection.
    // Connect eagerly: the client is created with `lazyConnect`, and the pool
    // is configured with `enableOfflineQueue: false`, so the first request to
    // arrive before the socket is up fails with "Stream isn't writeable"
    // instead of waiting. Observed once per restart before this await.
    const redis = connectRedis({ url: env.REDIS_URL });
    if (redis.status === "wait") await redis.connect();

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
