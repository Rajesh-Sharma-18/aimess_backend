import type { Socket } from "socket.io";
import { resolveAuditSource, runWithAuditContext } from "@aimess/constants";

import { env } from "../config/env.js";

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
/** The handshake fields this module reads, with a safe shape when there is none. */
function readHandshake(socket: Socket): {
  headers: Record<string, string | string[] | undefined>;
  address: string;
  userAgent: string | null;
} {
  const handshake = socket.handshake as Socket["handshake"] | undefined;
  const headers = handshake?.headers ?? {};
  const userAgent = headers["user-agent"];

  return {
    headers,
    address: handshake?.address ?? "",
    userAgent: typeof userAgent === "string" ? userAgent : null,
  };
}

export function bindSocketAuditContext(socket: Socket): void {
  // Tolerate a socket that arrives with no handshake. This runs as the FIRST
  // statement of the `connection` handler on /chat, /community and /stream, so
  // a throw here aborts the rest of that handler and the socket ends up
  // connected with no event listeners bound at all — a silently dead client,
  // which is a far worse outcome than an audit row with an unknown source.
  const { headers, userAgent } = readHandshake(socket);

  const context = {
    // `query` is deliberately not passed: `?platform=` on a handshake URL is
    // client-supplied and survives a link click, and the header already covers
    // every real client. See `resolveAuditSource`.
    source: resolveAuditSource(headers),
    ip: resolveHandshakeIp(socket),
    userAgent,
  };

  socket.use((_packet, next) => runWithAuditContext(context, next));
}

/**
 * Client address for a Socket.IO handshake, honouring the configured hop count.
 *
 * Engine.IO does not give us Express's `req.ip`, so the hop counting has to be
 * done here — but it must be done the same way. The previous implementation
 * took the LEFTMOST `X-Forwarded-For` entry unconditionally, which is the value
 * the caller typed, so the IP on every socket-originated audit row was
 * attacker-chosen even when the deployment sat behind a trusted proxy.
 *
 * With `n` trusted hops the authoritative entry is the nth from the RIGHT: the
 * rightmost was appended by the proxy nearest us, and anything further left may
 * have been forged by the client. With zero trusted hops the header is ignored
 * entirely and the socket address is used.
 */
function resolveHandshakeIp(socket: Socket): string | null {
  const { headers, address } = readHandshake(socket);
  const hops = env.TRUST_PROXY_HOPS;
  if (hops <= 0) return address || null;

  const raw = headers["x-forwarded-for"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return address || null;

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return address || null;

  // Clamp: a chain shorter than the configured hop count means the request did
  // not traverse the proxies we expect, so fall back to the leftmost entry we
  // actually have rather than reading past the start of the list.
  const index = Math.max(0, entries.length - hops);
  return entries[index] ?? address ?? null;
}
