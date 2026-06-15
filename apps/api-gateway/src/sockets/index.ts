import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { logger } from "@aimess/logger";
import { getCorsAllowedOrigins } from "../config/env.js";
import { createGatewayRedisClients } from "./redis.js";
import { registerChatNamespace } from "./namespaces/chat.ns.js";
import { registerCommunityNamespace } from "./namespaces/community.ns.js";
import { registerNotifyNamespace } from "./namespaces/notify.ns.js";
import { registerStreamNamespace } from "./namespaces/stream.ns.js";
import type { MessagingClient } from "../grpc/clients/messaging.client.js";
import { createCommunityClient } from "../grpc/clients/community.client.js";
import { createNotificationClient } from "../grpc/clients/notification.client.js";
import { createUserClient } from "../grpc/clients/user.client.js";
import type { MediaClient } from "../grpc/clients/media.client.js";
import { createStreamClient } from "../grpc/clients/stream.client.js";

export async function setupSockets(
  httpServer: HttpServer,
  messagingClient: MessagingClient,
  mediaClient: MediaClient
): Promise<void> {
  const { pub, sub } = createGatewayRedisClients();
  await Promise.all([pub.connect(), sub.connect()]);

  const io = new SocketIOServer(httpServer, {
    path: "/socket.io/",
    cors: {
      origin: getCorsAllowedOrigins(),
      methods: ["GET", "POST"],
      credentials: true,
    },
    maxHttpBufferSize: 1e6,
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
    },
    perMessageDeflate: false,
  });

  io.adapter(createAdapter(pub, sub));
  logger.info("Socket.IO Redis adapter attached");

  // Each namespace gets its own dedicated sub client.
  // ioredis does not support mixing psubscribe and subscribe on the same connection,
  // and sharing a psubscribe client causes cross-firing of pmessage handlers.
  const { sub: chatSub } = createGatewayRedisClients();
  const { sub: communitySub } = createGatewayRedisClients();
  const { sub: notifySub } = createGatewayRedisClients();
  const { sub: streamSub } = createGatewayRedisClients();
  await Promise.all([
    chatSub.connect(),
    communitySub.connect(),
    notifySub.connect(),
    streamSub.connect(),
  ]);

  const communityClient = createCommunityClient();
  const notificationClient = createNotificationClient();
  const userClient = createUserClient();
  const streamClient = createStreamClient();

  registerChatNamespace(
    io,
    messagingClient,
    chatSub,
    pub,
    userClient,
    mediaClient
  );
  registerCommunityNamespace(
    io,
    communityClient,
    communitySub,
    userClient,
    mediaClient
  );
  registerNotifyNamespace(io, notificationClient, notifySub);
  registerStreamNamespace(io, streamClient, streamSub, pub);

  io.engine.on(
    "connection_error",
    (err: { code: unknown; message: unknown }) => {
      logger.error(
        `Socket.IO engine error: code=${String(err.code)} msg=${String(err.message)}`
      );
    }
  );

  logger.info(
    "Socket.IO namespaces registered: /chat, /community, /notify, /stream"
  );
}
