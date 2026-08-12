import type { Namespace } from "socket.io";
import { logger } from "@aimess/logger";
import { DEFAULT_LOCALE, t, type SupportedLocale } from "@aimess/constants";

/** Per-viewer rewrite of a broadcast payload (`socket.data.locale` is passed in). */
export type PersonalizeFn = (
  data: unknown,
  userId: string,
  locale: SupportedLocale
) => unknown;

/**
 * Deep checks for senderId and senderName and replaces senderName with 'You'
 * if the senderId matches the socket's viewerUserId. Emits to the room.
 *
 * This is also the per-recipient LOCALIZATION seam: the loop below already
 * visits every connected socket individually, and each socket carries the
 * locale resolved at its handshake — so one broadcast can leave the server as
 * three different languages without the publisher knowing anything about the
 * audience.
 */
export async function emitPersonalizedSender(
  namespace: Namespace,
  channel: string,
  event: string,
  data: unknown,
  personalizeFn?: PersonalizeFn,
  // When set, the named user's own sockets are skipped — every OTHER member in
  // the room still gets the event. Used for removal system messages
  // ("Admin banned X") and the removal roster event, so a still-connected
  // banned/kicked target never receives the line announcing their own removal.
  excludeUserId?: string,
  // Per-viewer opt-out, resolved once per connected socket. Used for read
  // receipts, where the viewer's own Settings → Chat switch decides whether
  // they may see someone else's — a decision the publisher cannot make, since
  // one broadcast reaches many viewers with different settings.
  skipViewer?: (viewerUserId: string) => Promise<boolean>
): Promise<void> {
  const isPersonalizable =
    data &&
    typeof data === "object" &&
    "senderId" in (data as Record<string, unknown>) &&
    "senderName" in (data as Record<string, unknown>);

  // If we don't have both senderId and senderName, no custom personalizeFn
  // (like SYSTEM messages), AND nothing to filter per viewer, just do a normal
  // broadcast.
  if (!isPersonalizable && !personalizeFn && !excludeUserId && !skipViewer) {
    namespace.to(channel).emit(event, data);
    return;
  }

  try {
    const sockets = await namespace.in(channel).fetchSockets();
    // Resolve every viewer's opt-out UP FRONT, in parallel. Awaiting inside the
    // loop made the checks strictly sequential, so nobody in a room of N saw a
    // read receipt until N lookups had completed one after another — on a cold
    // flag cache that is N gRPC round trips of head-of-line blocking on the
    // single event most sensitive to latency. Same lookups, one wall-clock cost.
    const skipByViewer = skipViewer
      ? new Map(
          await Promise.all(
            [...new Set(sockets.map((s) => String(s.data.userId ?? "")))].map(
              async (id): Promise<[string, boolean]> => [
                id,
                await skipViewer(id),
              ]
            )
          )
        )
      : null;
    for (const socket of sockets) {
      const viewerUserId = String(socket.data.userId ?? "");
      if (excludeUserId && viewerUserId === excludeUserId) continue;
      if (skipByViewer?.get(viewerUserId)) continue;
      const locale =
        (socket.data.locale as SupportedLocale | undefined) ?? DEFAULT_LOCALE;
      let payload = data;

      if (personalizeFn) {
        payload = personalizeFn(payload, viewerUserId, locale);
      }

      if (
        payload &&
        typeof payload === "object" &&
        (payload as Record<string, unknown>).senderId === viewerUserId &&
        "senderName" in (payload as Record<string, unknown>)
      ) {
        payload = {
          ...(payload as Record<string, unknown>),
          senderName: t("SYS_SENDER_YOU", locale),
        };
      }

      socket.emit(event, payload);
    }
  } catch (emitErr) {
    logger.warn(
      `emitPersonalizedSender failed on ${channel}: ${String(emitErr)}`
    );
    // Do NOT fall back to a full-room broadcast when someone must be filtered
    // out — that would leak the very event (their own removal line, a read
    // receipt they opted out of) the filter exists to withhold.
    if (excludeUserId || skipViewer) return;
    namespace.to(channel).emit(event, data);
  }
}
