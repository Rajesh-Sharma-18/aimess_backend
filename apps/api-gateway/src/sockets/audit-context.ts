import type { Socket } from "socket.io";
import { resolveAuditSource, runWithAuditContext } from "@aimess/constants";

/**
 * Publish the connecting client's audit context (source + IP + user-agent) for
 * every event this socket sends.
 *
 * REST gets this from `auditContextMiddleware` on each service; a socket event
 * would otherwise arrive at chat/community-service over gRPC with no trace of
 * the client that sent it, so a message deleted from the Android app would be
 * audited as SYSTEM. The context is captured once from the handshake (a socket
 * cannot change device mid-connection) and re-entered per inbound packet;
 * `@aimess/grpc-utils` puts it on the wire as `x-audit-source` metadata.
 */
export function bindSocketAuditContext(socket: Socket): void {
  const { headers, query, address } = socket.handshake;
  const forwarded = headers["x-forwarded-for"];
  const forwardedFirst =
    typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : null;
  const userAgent = headers["user-agent"];

  const context = {
    source: resolveAuditSource(headers, query as Record<string, unknown>),
    ip: forwardedFirst || address || null,
    userAgent: typeof userAgent === "string" ? userAgent : null,
  };

  socket.use((_packet, next) => runWithAuditContext(context, next));
}
