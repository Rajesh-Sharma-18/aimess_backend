import type { Server as HttpServer } from "node:http";

import { createAdapter } from "@socket.io/redis-adapter";
import { Server as SocketIOServer } from "socket.io";

import { logger } from "@aimess/logger";

import { redis, createRedisSubClient } from "./redis.js";

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    path: "/z-socket/",
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      allowedHeaders: ["content-type"],
      credentials: true,
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
    },
    perMessageDeflate: false,
    maxHttpBufferSize: 1e6,
  });

  io.engine.on("connection_error", (err) => {
    logger.error(
      `Socket connection_error: ${String(err.req)} ${String(err.code)} ${String(err.message)}`
    );
  });

  // Attach Redis adapter for horizontal scaling
  try {
    const subClient = createRedisSubClient();
    io.adapter(createAdapter(redis, subClient));
    logger.info("Socket.IO Redis adapter attached");
  } catch (error) {
    logger.warn("Socket.IO Redis adapter failed — running without adapter");
    logger.warn(error);
  }

  return io;
}
