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
  personalizeFn?: (data: unknown, userId: string) => unknown
): Promise<void> {
  const isPersonalizable =
    data &&
    typeof data === "object" &&
    "senderId" in (data as Record<string, unknown>) &&
    "senderName" in (data as Record<string, unknown>);

  // If we don't have both senderId and senderName, and we don't have a custom
  // personalizeFn (like SYSTEM messages), just do a normal broadcast.
  if (!isPersonalizable && !personalizeFn) {
    namespace.to(channel).emit(event, data);
    return;
  }

  try {
    const sockets = await namespace.in(channel).fetchSockets();
    for (const socket of sockets) {
      const viewerUserId = String(socket.data.userId ?? "");
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
    namespace.to(channel).emit(event, data);
  }
}
