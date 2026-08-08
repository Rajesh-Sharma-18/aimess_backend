import type { Namespace } from "socket.io";
import { logger } from "@aimess/logger";

/**
 * Deep checks for senderId and senderName and replaces senderName with 'You'
 * if the senderId matches the socket's viewerUserId. Emits to the room.
 */
export async function emitPersonalizedSender(
  namespace: Namespace,
  channel: string,
  event: string,
  data: unknown,
  personalizeFn?: (data: unknown, userId: string) => unknown,
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
    for (const socket of sockets) {
      const viewerUserId = String(socket.data.userId ?? "");
      if (excludeUserId && viewerUserId === excludeUserId) continue;
      if (skipViewer && (await skipViewer(viewerUserId))) continue;
      let payload = data;

      if (personalizeFn) {
        payload = personalizeFn(payload, viewerUserId);
      }

      if (
        payload &&
        typeof payload === "object" &&
        (payload as Record<string, unknown>).senderId === viewerUserId &&
        "senderName" in (payload as Record<string, unknown>)
      ) {
        payload = {
          ...(payload as Record<string, unknown>),
          senderName: "You",
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
