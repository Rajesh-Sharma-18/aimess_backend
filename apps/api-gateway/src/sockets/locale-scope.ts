import type { Socket } from "socket.io";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
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
export function scopeSocketLocale(socket: Socket): void {
  socket.use((_packet, next) => {
    const locale =
      (socket.data.locale as SupportedLocale | undefined) ?? DEFAULT_LOCALE;
    runWithLocale(locale, next);
  });

  socket.on(SOCKET_IN.LOCALE_SET, (payload: unknown, ack?: unknown) => {
    const next = parseClientLocale(payload);
    // Unknown/unsupported values are IGNORED, not normalized. Passing them
    // through `resolveLocale` would map anything unrecognized onto
    // `DEFAULT_LOCALE` ("vi" in production) — i.e. a client sending a language
    // this build does not carry would be answered in Vietnamese, which is the
    // exact failure this path exists to remove. Keeping the previous locale is
    // always the safer answer.
    if (next) socket.data.locale = next;
    if (typeof ack === "function") {
      (ack as (res: unknown) => void)({
        success: Boolean(next),
        data: { locale: socket.data.locale ?? DEFAULT_LOCALE },
      });
    }
  });
}

/**
 * Accepts `"th"`, `"th-TH"`, `{ lang }` or `{ locale }` — clients differ, and a
 * language tag legitimately arrives with a region subtag. Returns null for
 * anything outside `SUPPORTED_LOCALES` so the caller can keep what it had.
 *
 * Locale is presentation context only and is never consulted for authorization,
 * so an untrusted value here can at worst render the wrong language back to the
 * sender's own socket.
 */
function parseClientLocale(payload: unknown): SupportedLocale | null {
  const raw =
    typeof payload === "string"
      ? payload
      : typeof payload === "object" && payload !== null
        ? ((payload as { lang?: unknown }).lang ??
          (payload as { locale?: unknown }).locale)
        : undefined;
  if (typeof raw !== "string") return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return isSupportedLocale(base) ? base : null;
}
