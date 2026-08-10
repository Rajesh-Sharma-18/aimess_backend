import type { Socket } from "socket.io";
import {
  DEFAULT_LOCALE,
  runWithLocale,
  type SupportedLocale,
} from "@aimess/constants";

/**
 * Publish the socket's handshake locale for every event this socket emits.
 *
 * `socket.use()` runs once per inbound packet and dispatches the handler inside
 * `next()`, so the ambient locale set here covers the whole handler — including
 * the gRPC calls it makes, which forward it as `x-lang` metadata. Without this
 * a socket-driven read (chat history, community catch-up) would come back in
 * the server default language while the same read over REST came back in the
 * caller's.
 */
export function scopeSocketLocale(socket: Socket): void {
  socket.use((_packet, next) => {
    const locale =
      (socket.data.locale as SupportedLocale | undefined) ?? DEFAULT_LOCALE;
    runWithLocale(locale, next);
  });
}
