import type { Socket } from "socket.io";
import type { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import {
  verifyAccessToken,
  verifyAdminAccessToken,
  extractBearerToken,
} from "@aimess/auth-jwt";
import { getActiveSessionFromCache, isUserBanned } from "@aimess/redis";
import { logger } from "@aimess/logger";
import { resolveLocale, type SupportedLocale } from "@aimess/constants";
import { env } from "../config/env.js";
import type { SocketUserDetails } from "./user-details.js";

declare module "socket.io" {
  interface SocketData {
    userId: string;
    sessionId: string;
    /**
     * The viewer's language for everything this connection emits: ack copy,
     * SYSTEM message text, list previews.
     *
     * Seeded at handshake by {@link resolveHandshakeLocale} and updated in place
     * by the `locale:set` packet (see `locale-scope.ts`), so a Settings →
     * Language change takes effect on the OPEN connection instead of waiting for
     * a reconnect. Read per packet by `scopeSocketLocale` and per recipient by
     * `emitPersonalizedSender`.
     */
    locale: SupportedLocale;
    /** Epoch-ms when the handshake access token expires (0 = unknown). Used for session:expired warnings. */
    tokenExpiresAt: number;
    /** Raw JWT access token — kept so socket handlers can make authenticated internal HTTP calls on behalf of the user. Updated when auth:refresh succeeds. */
    accessToken: string;
    /** Resolved once per namespace connection; reused for every typing broadcast. */
    userDetails: SocketUserDetails;
    /**
     * The call leg this socket owns — one connection of the user, NOT one login.
     * Two browser tabs share a session (and so `sessionId`), so the client sends a
     * per-page-load id with `call:answer`; this defaults to `sessionId`/`socket.id`
     * until then. Read across gateway nodes via `fetchSockets()` to deliver
     * `call:handled` to every device EXCEPT the one that answered.
     */
    callLegId?: string;
    /** Backoffice admin id — set only on /admin sockets, where `userId` is unused. */
    adminId?: string;
  }
}

/**
 * The connection's starting locale.
 *
 * Order matters, and it is deliberately not the order the HTTP middleware uses.
 * A browser CANNOT set request headers on a websocket upgrade — `extraHeaders`
 * is ignored by every browser WebSocket implementation and applies only to the
 * polling transport — so a client that has picked a language has exactly two
 * places to put it: the `auth` payload of the connect packet, or the handshake
 * query string. Both are read here BEFORE `x-lang`/`Accept-Language`, which for
 * a browser client carry the OS/browser language rather than the one selected in
 * the app.
 *
 * That inversion is the bug this closes: with no client-sent value the chain
 * fell through to `Accept-Language` and then to `DEFAULT_LOCALE`, which is
 * `"vi"` in production — so a user who had chosen English received live SYSTEM
 * messages in Vietnamese, while the same room's REST history (which does send
 * `x-lang`) came back in English.
 */
export function resolveHandshakeLocale(handshake: {
  auth?: unknown;
  query?: unknown;
  headers: Record<string, string | string[] | undefined>;
}): SupportedLocale {
  const { auth, query, headers } = handshake;
  const explicit =
    firstString((auth as Record<string, unknown> | undefined)?.lang) ??
    firstString((auth as Record<string, unknown> | undefined)?.locale) ??
    firstString((query as Record<string, unknown> | undefined)?.lang) ??
    firstString(headers["x-lang"]);
  return resolveLocale(firstString(headers["accept-language"]), explicit);
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstString(value[0]);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

        socket.data.locale = resolveHandshakeLocale(socket.handshake);

        const verified = verifyAccessToken(token, env.JWT_ACCESS_SECRET);

        // Two independent verdicts, one round trip each: is this SESSION still
        // alive, and is this USER permanently banned. `connectionStateRecovery`
        // is configured with `skipMiddlewares: false`, so both also re-run on
        // every reconnect — a banned user cannot resurrect a recovered socket.
        const [active, banned] = await Promise.all([
          getActiveSessionFromCache(redis, verified.sessionId).catch(
            () => true
          ), // Redis hiccup: fail open, same as HTTP middleware.
          isUserBanned(redis, verified.userId).catch(() => false),
        ]);
        if (active === false || banned) {
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

/**
 * Handshake auth for the /admin namespace. Backoffice admin tokens carry a
 * separate secret and `type` claim, so the user middleware above rejects them.
 * Session liveness reads the same `admin:<sid>` active-session key
 * backoffice-service writes (see its lib/admin-session-cache.ts).
 */
export function createGatewayAdminSocketAuthMiddleware(
  redis: Redis
): (socket: Socket, next: (err?: Error) => void) => void {
  return function gatewayAdminSocketAuthMiddleware(
    socket: Socket,
    next: (err?: Error) => void
  ): void {
    void (async () => {
      try {
        const { auth, headers } = socket.handshake;
        const token =
          ((auth as Record<string, unknown>)?.token as string | undefined) ??
          extractBearerTokenSafe(headers.authorization);

        if (!token || !env.JWT_ADMIN_SECRET) {
          next(new Error("Authentication required"));
          return;
        }

        socket.data.locale = resolveHandshakeLocale(socket.handshake);

        const verified = verifyAdminAccessToken(token, env.JWT_ADMIN_SECRET);

        const active = await getActiveSessionFromCache(
          redis,
          `admin:${verified.sessionId}`
        ).catch(() => true); // Redis hiccup: fail open, same as the user middleware.
        if (active === false) {
          next(new Error("Authentication failed"));
          return;
        }

        socket.data.adminId = verified.adminId;
        socket.data.sessionId = verified.sessionId;
        socket.data.accessToken = token;

        const decoded = jwt.decode(token) as { exp?: number } | null;
        socket.data.tokenExpiresAt = decoded?.exp ? decoded.exp * 1000 : 0;

        next();
      } catch (err) {
        logger.warn(
          `Gateway admin socket auth failed: ${err instanceof Error ? err.message : String(err)}`
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
