import type { Socket } from "socket.io";
import { logger } from "@aimess/logger";

/**
 * Drops a namespace CONNECT that arrives while an earlier CONNECT for the same
 * namespace, on the same engine.io connection, is still in middleware.
 *
 * Socket.IO rejects a CONNECT for a namespace the connection has already
 * joined, but only by looking at `client.nsps`, which is filled in AFTER
 * middleware. Every CONNECT that lands while the first is still in the (async)
 * auth middleware therefore becomes its own server-side socket; all of them
 * join `user:<id>`, `conv:<id>`, … and write into the same connection, so the
 * client receives every room broadcast once per extra socket. A web tab that
 * sent seven CONNECTs for /chat got each `typing:*`, `message:new` and receipt
 * seven times. socket.io-client sends one whenever `socket.connect()` is called
 * with the transport open and the previous CONNECT not yet acknowledged.
 *
 * Dropping the duplicate without a reply is safe: the client is waiting on the
 * first CONNECT's ack, which still arrives and completes its connect. No
 * connection handler runs for the dropped socket, so none of the per-socket
 * disconnect cleanup (presence session, call legs, stream viewer counts) fires.
 *
 * Reads Socket.IO's `nsp._preConnectSockets` and calls `socket._cleanup()`;
 * tests/sockets/duplicate-connect-guard.test.ts runs against the real library,
 * so a version that moves them fails there.
 *
 * Register it FIRST on every namespace, before the auth middleware.
 */
export function dropDuplicateNamespaceConnect(
  socket: Socket,
  next: (err?: Error) => void
): void {
  const pending = (
    socket.nsp as unknown as { _preConnectSockets?: Map<string, Socket> }
  )._preConnectSockets;
  let duplicate = false;
  for (const other of pending?.values() ?? []) {
    if (other !== socket && other.client === socket.client) {
      duplicate = true;
      break;
    }
  }
  if (!duplicate) {
    next();
    return;
  }

  logger.warn(
    `socket duplicate CONNECT dropped nsp=${socket.nsp.name} userAgent=${String(socket.handshake.headers["user-agent"] ?? "")}`
  );
  // Removes it from the namespace's pending map; `next` is never called, so it
  // never connects, never joins a room and never acks.
  (socket as unknown as { _cleanup(): void })._cleanup();
}
