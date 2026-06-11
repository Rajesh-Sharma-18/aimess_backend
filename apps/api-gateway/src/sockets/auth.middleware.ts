import type { Socket } from "socket.io";
import { verifyAccessToken, extractBearerToken } from "@aimess/auth-jwt";
import { logger } from "@aimess/logger";
import { resolveLocale, type SupportedLocale } from "@aimess/constants";
import { env } from "../config/env.js";

declare module "socket.io" {
  interface SocketData {
    userId: string;
    sessionId: string;
    /** Resolved once at handshake from `x-lang` / `Accept-Language`; drives ack copy. */
    locale: SupportedLocale;
  }
}

export function gatewaySocketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
): void {
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
    socket.data.userId = verified.userId;
    socket.data.sessionId = verified.sessionId;
    next();
  } catch (err) {
    logger.warn(
      `Gateway socket auth failed: ${err instanceof Error ? err.message : String(err)}`
    );
    next(new Error("Authentication failed"));
  }
}

function extractBearerTokenSafe(header: string | undefined): string | null {
  try {
    return extractBearerToken(header);
  } catch {
    return null;
  }
}
