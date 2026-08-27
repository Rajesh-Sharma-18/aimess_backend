import type { Socket } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@aimess/logger";
import { publishSessionLocale } from "@aimess/redis";
import {
  DEFAULT_LOCALE,
  parseSupportedLocale,
  runWithLocale,
  SOCKET_IN,
  type SupportedLocale,
} from "@aimess/constants";

/**
 * Publish the socket's locale for every event this socket emits, and let the
 * client retarget it without reconnecting.
 *
 * `socket.use()` runs once per inbound packet and dispatches the handler inside
 * `next()`, so the ambient locale set here covers the whole handler — including
 * the gRPC calls it makes, which forward it as `x-lang` metadata. Without this
 * a socket-driven read (chat history, community catch-up) would come back in
 * the server default language while the same read over REST came back in the
 * caller's.
 *
 * Every namespace (`chat`, `community`, `notify`, `stream`) installs this, which
 * is why the `locale:set` handler lives here rather than in each of them.
 */
export function scopeSocketLocale(socket: Socket, redisPub?: Redis): void {
  socket.use((_packet, next) => {
    const locale =
      (socket.data.locale as SupportedLocale | undefined) ?? DEFAULT_LOCALE;
    runWithLocale(locale, next);
  });

  socket.on(SOCKET_IN.LOCALE_SET, (payload: unknown, ack?: unknown) => {
    const next = parseSupportedLocale(payload);
    // Unknown/unsupported values are IGNORED, not normalized. Passing them
    // through `resolveLocale` would map anything unrecognized onto
    // `DEFAULT_LOCALE` ("vi" in production) — i.e. a client sending a language
    // this build does not carry would be answered in Vietnamese, which is the
    // exact failure this path exists to remove. Keeping the previous locale is
    // always the safer answer.
    if (next) socket.data.locale = next;
    // Tell the push side, which cannot see this packet.
    //
    // `socket.data.locale` decides everything rendered THROUGH this connection;
    // the push tray is rendered from `DeviceToken.locale` for a device that may
    // be asleep with no connection at all. A user who switches language in the
    // app therefore flipped every socket surface instantly and kept receiving
    // push notifications in the old language until the client happened to
    // re-register its token — which is a contract the server cannot enforce.
    // This is the one moment the server KNOWS, so it says so.
    //
    // Fire-and-forget by design: a language preference must never be able to
    // fail the packet that expressed it.
    if (next && redisPub) {
      const userId = String(socket.data.userId ?? "");
      const sessionId = String(socket.data.sessionId ?? "");
      if (userId && sessionId) {
        void publishSessionLocale(redisPub, {
          userId,
          sessionId,
          locale: next,
        }).catch((err: unknown) => {
          logger.warn(
            `[socket:locale] session-locale publish failed: ${String(err)}`
          );
        });
      }
    }
    if (typeof ack === "function") {
      (ack as (res: unknown) => void)({
        success: Boolean(next),
        data: { locale: socket.data.locale ?? DEFAULT_LOCALE },
      });
    }
  });
}
