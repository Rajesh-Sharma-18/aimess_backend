import type { Server as SocketIOServer } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@aimess/logger";

/**
 * Realtime linked-device sync. When auth-service persists a NEW session — normal
 * login, QR device-link approval, or social login, all via the single
 * `issueAuthTokens` funnel — it publishes the persisted session DTO to
 * `session-created:<userId>` (see `publishSessionCreatedEvent` in `@aimess/redis`).
 *
 * This relays it to the user's every live device using the SAME client-facing
 * `session:list_updated` event the revoke path already emits — just with
 * `action: "created"` plus the full session row — so the Linked Devices /
 * Sessions screen refreshes instantly without a manual refresh or polling.
 * Emitted only on `/notify` — the only namespace the client listens on for
 * session/device-list sync.
 *
 * Shares the durable session-revoke PSUBSCRIBE connection: both handlers receive
 * every pmessage and each filters by channel prefix, so no extra Redis
 * connection is needed (mirrors `registerSessionRevokeListener`).
 */
export function registerSessionCreatedListener(
  io: SocketIOServer,
  sessionSub: Redis
): void {
  sessionSub.on(
    "pmessage",
    (_pattern: string, channel: string, message: string) => {
      if (!channel.startsWith("session-created:")) return;
      const userId = channel.replace("session-created:", "");

      let session: unknown;
      try {
        ({ session } = JSON.parse(message) as { session?: unknown });
      } catch (err) {
        logger.warn(`session-created message parse error: ${String(err)}`);
        return;
      }
      if (!session) return;

      io.of("/notify")
        .to(`user:${userId}`)
        .emit("session:list_updated", { action: "created", session });
    }
  );

  void sessionSub.psubscribe("session-created:*");
}
