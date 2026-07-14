import type { Socket } from "socket.io";
import type { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import { verifyAccessToken, extractBearerToken } from "@aimess/auth-jwt";
import { getActiveSessionFromCache } from "@aimess/redis";
import { logger } from "@aimess/logger";
import { resolveLocale, type SupportedLocale } from "@aimess/constants";
import { env } from "../config/env.js";
import type { SocketUserDetails } from "./user-details.js";

declare module "socket.io" {
  interface SocketData {
    userId: string;
    sessionId: string;
    /** Resolved once at handshake from `x-lang` / `Accept-Language`; drives ack copy. */
    locale: SupportedLocale;
    /** Epoch-ms when the handshake access token expires (0 = unknown). Used for session:expired warnings. */
    tokenExpiresAt: number;
    /** Raw JWT access token — kept so socket handlers can make authenticated internal HTTP calls on behalf of the user. Updated when auth:refresh succeeds. */
    accessToken: string;
    /** Resolved once per namespace connection; reused for every typing broadcast. */
    userDetails: SocketUserDetails;
  }
}

/**
 * Builds the handshake auth middleware for a namespace. `redis` must be a
 * plain (non-subscriber-mode) client — it issues a GET per handshake to reject
 * a session already revoked via DELETE /sessions/{sessionId}, closing the
 * window where a terminated session could still open a brand-new socket
 * connection until its JWT naturally expires. Already-connected sockets are
 * handled separately by the live `session-revoke:*` disconnect listener.
 */
export function createGatewaySocketAuthMiddleware(
  redis: Redis
): (socket: Socket, next: (err?: Error) => void) => void {
  return function gatewaySocketAuthMiddleware(
    socket: Socket,
    next: (err?: Error) => void
  ): void {
    void (async () => {
      try {
        const { auth, headers } = socket.handshake;
        const token =
          ((auth as Record<string, unknown>)?.token as string | undefined) ??
          extractBearerTokenSafe(headers.authorization);

        if (!token) {
          next(new Error("Authentication required"));
          return;
        }

        const xLang = headers["x-lang"];
        socket.data.locale = resolveLocale(
          headers["accept-language"],
          Array.isArray(xLang) ? xLang[0] : xLang
        );

        const verified = verifyAccessToken(token, env.JWT_ACCESS_SECRET);

        const active = await getActiveSessionFromCache(
          redis,
          verified.sessionId
        ).catch(() => true); // Redis hiccup: fail open, same as HTTP middleware.
        if (active === false) {
          next(new Error("Authentication failed"));
          return;
        }

        socket.data.userId = verified.userId;
        socket.data.sessionId = verified.sessionId;
        socket.data.accessToken = token;

        // Decode (not verify — already verified above) to extract expiry for session:expired warnings.
        const decoded = jwt.decode(token) as { exp?: number } | null;
        socket.data.tokenExpiresAt = decoded?.exp ? decoded.exp * 1000 : 0;

        next();
      } catch (err) {
        logger.warn(
          `Gateway socket auth failed: ${err instanceof Error ? err.message : String(err)}`
        );
        next(new Error("Authentication failed"));
      }
    })();
  };
}

function extractBearerTokenSafe(header: string | undefined): string | null {
  try {
    return extractBearerToken(header);
  } catch {
    return null;
  }
}
