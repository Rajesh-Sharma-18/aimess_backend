import { createHash } from "node:crypto";

import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { takeQrLinkResult } from "@aimess/redis";

const QrSubscribeSchema = z.object({
  token: z.string().trim().min(1).max(200),
});

interface RedisSocketEvent {
  event: string;
  data: unknown;
}

/**
 * Public `/auth` namespace for the QR-login (linked devices) flow — no JWT,
 * since the browser scanning the QR isn't signed in yet. The only thing a
 * client can do here is join the room for a token it already displays as a
 * QR code; nothing enumerable, nothing privileged lives in the join itself.
 * auth-service publishes `devlink:<linkToken>` on Redis (see
 * `publishQrLinkEvent` in `@aimess/redis`) on every scan/approve/reject/expire
 * — this namespace relays that verbatim to room `qr:<linkToken>`.
 */
/**
 * A log-safe reference to a QR device-link token.
 *
 * The token is a bearer credential: whoever holds it can be handed a full
 * session by the device-link flow, on a namespace that requires no
 * authentication to subscribe. Logging it verbatim — on subscribe, on replay
 * and on failure — meant anyone who could read the gateway logs could join the
 * pending link channel and claim the session the moment the phone approved it.
 *
 * The digest is stable, so an operator can still trace one link attempt across
 * lines, and it is not redeemable.
 */
function qrRef(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function registerAuthNamespace(
  io: SocketIOServer,
  redisSub: Redis,
  /** Regular (non-subscriber) client — used only to collect the pending
   * success envelope; a subscriber connection cannot run commands. */
  redis: Redis
): void {
  const auth: Namespace = io.of("/auth");

  // Per-token subscriber ref-count. A browser can legitimately hold more than
  // one socket on the same linkToken for a moment — a reconnect whose old
  // socket has not been reaped yet, or the same login page in two tabs. Without
  // this, the FIRST of those to disconnect unsubscribes `devlink:<token>` for
  // ALL of them, and the surviving socket sits in room `qr:<token>` receiving
  // nothing: the scan succeeds on the phone and the browser never hears.
  const tokenSubCount = new Map<string, number>();

  const retainToken = async (token: string): Promise<void> => {
    const next = (tokenSubCount.get(token) ?? 0) + 1;
    tokenSubCount.set(token, next);
    if (next === 1) await redisSub.subscribe(`devlink:${token}`);
  };

  const releaseToken = (token: string): void => {
    const remaining = (tokenSubCount.get(token) ?? 1) - 1;
    if (remaining > 0) {
      tokenSubCount.set(token, remaining);
      return;
    }
    tokenSubCount.delete(token);
    void redisSub.unsubscribe(`devlink:${token}`);
  };

  redisSub.on("message", (channel: string, message: string) => {
    if (!channel.startsWith("devlink:")) return;
    try {
      const parsed = JSON.parse(message) as RedisSocketEvent;
      auth
        .to(channel.replace("devlink:", "qr:"))
        .emit(parsed.event, parsed.data);
    } catch (err) {
      logger.warn(
        `/auth Redis message parse error on ${channel}: ${String(err)}`
      );
    }
  });

  auth.on("connection", (socket: Socket) => {
    let joinedToken: string | null = null;

    socket.on("auth:qr:subscribe", (payload: unknown) => {
      const parsed = QrSubscribeSchema.safeParse(payload);
      if (!parsed.success) return;

      const token = parsed.data.token;
      // Re-subscribing to the token this socket already holds (the client
      // re-emits on every connect/reconnect) must not double-count it.
      if (joinedToken === token) {
        void (async () => {
          const pending = await takeQrLinkResult(redis, token);
          if (pending) socket.emit(pending.event, pending.data);
        })().catch((err: unknown) => {
          logger.warn(
            `/auth re-subscribe take failed for qr:${token}: ${String(err)}`
          );
        });
        return;
      }

      if (joinedToken) {
        void socket.leave(`qr:${joinedToken}`);
        releaseToken(joinedToken);
      }
      joinedToken = token;
      void socket.join(`qr:${token}`);

      void (async () => {
        await retainToken(token);
        logger.debug(`/auth socket subscribed to qr:${qrRef(token)}`);

        // Catch-up: a scan that completed before this subscribe finished — or
        // while this browser was disconnected — published `auth:qr:success` to
        // nobody, and Redis pub/sub does not replay. The publisher leaves a
        // one-shot copy behind; collect it now, AFTER the subscribe above, so
        // there is no gap between the two delivery paths. Anything published
        // from here on arrives live instead.
        const pending = await takeQrLinkResult(redis, token);
        if (pending) {
          socket.emit(pending.event, pending.data);
          logger.debug(
            `/auth replayed pending ${pending.event} for qr:${qrRef(token)}`
          );
        }
      })().catch((err: unknown) => {
        logger.warn(
          `/auth subscribe failed for qr:${qrRef(token)}: ${String(err)}`
        );
      });
    });

    socket.on("disconnect", () => {
      if (joinedToken) releaseToken(joinedToken);
    });
  });
}
