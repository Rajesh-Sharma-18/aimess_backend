import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { logger } from "@aimess/logger";
import { isCorsOriginAllowed } from "../config/env.js";
import { createGatewayRedisClients } from "./redis.js";
import { registerAuthNamespace } from "./namespaces/auth.ns.js";
import { registerSessionRevokeListener } from "./session-revoke.js";
import { registerSessionCreatedListener } from "./session-created-listener.js";
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
      origin: (origin, callback) => {
        callback(null, isCorsOriginAllowed(origin));
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
    maxHttpBufferSize: 1e6,
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      // Socket.IO defaults this to `true`, which SKIPS `namespace.use()` auth
      // middleware entirely on a recovered reconnect (e.g. after a silent
      // network drop) — a session revoked while the device was offline would
      // silently rejoin its rooms unauthenticated. `false` forces every
      // reconnect, recovered or not, back through
      // `createGatewaySocketAuthMiddleware`'s session-active check.
      skipMiddlewares: false,
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
  const { sub: authSub } = createGatewayRedisClients();
  const { sub: sessionRevokeSub } = createGatewayRedisClients();
  await Promise.all([
    chatSub.connect(),
    communitySub.connect(),
    notifySub.connect(),
    streamSub.connect(),
    authSub.connect(),
    sessionRevokeSub.connect(),
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
    pub,
    userClient,
    mediaClient
  );
  registerNotifyNamespace(io, notificationClient, notifySub, pub);
  registerStreamNamespace(io, streamClient, streamSub, pub, mediaClient);
  registerAuthNamespace(io, authSub, pub);
  registerSessionRevokeListener(io, sessionRevokeSub);
  // Reuses the same durable PSUBSCRIBE connection (filters by channel prefix).
  registerSessionCreatedListener(io, sessionRevokeSub);

  io.engine.on(
    "connection_error",
    (err: { code: unknown; message: unknown }) => {
      logger.error(
        `Socket.IO engine error: code=${String(err.code)} msg=${String(err.message)}`
      );
    }
  );

  logger.info(
    "Socket.IO namespaces registered: /chat, /community, /notify, /stream, /auth"
  );
}
