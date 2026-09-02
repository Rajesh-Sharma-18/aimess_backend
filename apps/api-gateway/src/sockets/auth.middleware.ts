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
import { resolveAccountLocale } from "./account-locale.js";
import { env, accessTokenVerifyConfig } from "../config/env.js";
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
    /**
     * The conversation whose TRANSCRIPT this socket currently has open — the
     * presence signal behind read-at-delivery. Set by `conv:join {active:true}`
     * and cleared by `conv:leave`. Deliberately NOT the same as membership of
     * `conv:<roomId>`: the sidebar joins every visible thread's room to receive
     * typing indicators, so membership means "wants live traffic", not "is
     * looking at it". Read across gateway nodes via `fetchSockets()`.
     */
    activeConvId?: string;
    /** The /community twin of {@link activeConvId} — the community whose chat
     *  screen this socket has open. Set by `community:join {active:true}`. */
    activeCommunityId?: string;
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
export interface HandshakeLocaleSource {
  auth?: unknown;
  query?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The language THIS CONNECTION explicitly asked for, or null.
 *
 * Split out from the chain below because the account language sits between the
 * two halves: a declared value is this session speaking and outranks
 * everything, while `Accept-Language` is the device/OS and must NOT outrank a
 * language the user actually picked in the app. Only a null here lets the
 * account rung run.
 */
export function declaredHandshakeLocale(
  handshake: HandshakeLocaleSource
): { locale: SupportedLocale; source: string } | null {
  const { auth, query, headers } = handshake;
  const a = auth as Record<string, unknown> | undefined;
  const q = query as Record<string, unknown> | undefined;
  // All three spellings of the same field, in both channels. A client that
  // declares its language and has it ignored is indistinguishable, from the
  // user's seat, from a client that never declared one — and the cost of the
  // difference is being answered in the production default ("vi") forever.
  const declared: [string, string | undefined][] = [
    ["auth.lang", firstString(a?.lang)],
    ["auth.locale", firstString(a?.locale)],
    ["auth.language", firstString(a?.language)],
    ["query.lang", firstString(q?.lang)],
    ["query.locale", firstString(q?.locale)],
    ["query.language", firstString(q?.language)],
    ["x-lang", firstString(headers["x-lang"])],
  ];
  const found = declared.find(([, value]) => value !== undefined);
  if (!found) return null;
  return { locale: resolveLocale(null, found[1]), source: found[0] };
}

export function resolveHandshakeLocale(
  handshake: HandshakeLocaleSource
): SupportedLocale {
  const { headers } = handshake;
  const found = declaredHandshakeLocale(handshake);
  const acceptLanguage = firstString(headers["accept-language"]);
  const locale = found?.locale ?? resolveLocale(acceptLanguage, null);
  // The one fact needed to tell a gateway bug from a client that sends nothing:
  // WHICH rung answered. `source=default` on a session that shows the wrong
  // language means the client declared no locale on this connection, not that
  // some other session's language leaked into it — nothing here is keyed by
  // user, only by socket.
  logger.debug(
    `[socket:locale] resolved=${locale} source=${
      found?.source ?? (acceptLanguage ? "accept-language" : "default")
    }`
  );
  return locale;
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
/**
 * Maximum concurrent Socket.IO connections one account may hold.
 *
 * A real client holds a handful: one per namespace it uses, times the number of
 * devices and browser tabs the person has open. 40 leaves generous headroom for
 * a heavy multi-device user while still bounding a loop that opens sockets as
 * fast as the server accepts them.
 */
const MAX_SOCKETS_PER_USER = 40;

/**
 * Count this user's live sockets across every namespace and admit or reject.
 *
 * Counting from the server's own registry (rather than a Redis counter) keeps
 * it exact for this process and self-healing: a socket that dies for any reason
 * — crash, network drop, server restart — leaves no stale reservation to leak
 * the user out of their own quota, which is the failure mode a counter has.
 *
 * In a multi-node deployment the cap is therefore per node. That is the honest
 * limitation: it bounds what one node can be made to hold, which is the
 * resource being protected, and the per-IP ceiling belongs at the edge proxy.
 */
async function admitConnection(
  socket: Socket,
  userId: string
): Promise<boolean> {
  try {
    const server = socket.nsp.server;
    let live = 0;
    for (const [, namespace] of server._nsps) {
      // `.local` — only this node's sockets; a cluster-wide fetch would add a
      // cross-node round trip to every single handshake.
      for (const [, existing] of namespace.sockets) {
        if (existing.data?.userId === userId) {
          live += 1;
          if (live >= MAX_SOCKETS_PER_USER) return false;
        }
      }
    }
    return true;
  } catch (err) {
    // Never let the accounting itself refuse a legitimate connection.
    logger.warn(`Gateway socket connection-cap check failed: ${String(err)}`);
    return true;
  }
}

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

        const verified = verifyAccessToken(token, accessTokenVerifyConfig);

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

        // A connection that declared no language used to land on
        // `DEFAULT_LOCALE` — "vi" in production — so a client that has not been
        // taught to send `lang` yet was answered in Vietnamese while its REST
        // calls (which do send `x-lang`) came back correct. That split is what
        // made one add arrive as an English list row and a Vietnamese system
        // line on the same screen. The account's saved language is a language
        // this user actually chose, so it is a strictly better last resort than
        // the server default; it stays BELOW anything the connection declared,
        // because it is account-wide and five sessions overwrite each other in
        // it. Only paid on the handshake, and only when the client said nothing.
        if (!declaredHandshakeLocale(socket.handshake)) {
          const accountLocale = await resolveAccountLocale(verified.userId);
          if (accountLocale) socket.data.locale = accountLocale;
        }

        // Decode (not verify — already verified above) to extract expiry for session:expired warnings.
        const decoded = jwt.decode(token) as { exp?: number } | null;
        socket.data.tokenExpiresAt = decoded?.exp ? decoded.exp * 1000 : 0;

        // Concurrent-connection ceiling per account.
        //
        // The server was constructed with no per-user or per-IP connection
        // limit, and no namespace middleware counted existing connections, so
        // one valid access token could open thousands of sockets. Each joins
        // `user:<id>`, allocates its per-socket maps and timers, and writes a
        // presence device-session to Redis — a cheap way to exhaust gateway
        // memory and Redis presence keys from a single account.
        //
        // Counted across the whole namespace registry rather than per
        // namespace: a client legitimately holds one socket on each of /chat,
        // /community, /notify and /stream, and the point is to bound total
        // sockets per account, not to ration namespaces.
        if (!(await admitConnection(socket, verified.userId))) {
          logger.warn(
            `Gateway socket rejected: connection cap reached userId=${verified.userId} cap=${String(MAX_SOCKETS_PER_USER)}`
          );
          next(new Error("Too many connections"));
          return;
        }

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
