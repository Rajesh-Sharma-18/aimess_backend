import type { Socket } from "socket.io";

import { verifyAccessToken, extractBearerToken } from "@aimess/auth-jwt";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

declare module "socket.io" {
  interface Socket {
    user: {
      userId: string;
      sessionId: string;
      deviceId: string;
      platform: string;
      clientType: string;
      socketId: string;
      displayname: string;
      username: string;
    };
  }
}

/**
 * Socket.IO authentication middleware.
 * Extracts JWT from handshake auth or headers and validates it.
 * Rejects connections without a valid token.
 */
export function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
): void {
  try {
    const { auth, headers } = socket.handshake;

    // Try auth object first (Socket.IO client auth), then Authorization header
    const tokenStr =
      (auth as Record<string, string>)?.token ||
      extractBearerTokenSafe(headers.authorization);

    if (!tokenStr) {
      next(new Error("Authentication required"));
      return;
    }

    const verified = verifyAccessToken(tokenStr, env.JWT_ACCESS_SECRET);

    socket.user = {
      userId: verified.userId,
      sessionId: verified.sessionId,
      deviceId: (auth as Record<string, string>)?.deviceId || socket.id,
      platform: (auth as Record<string, string>)?.platform || "unknown",
      clientType: (auth as Record<string, string>)?.clientType || "mobile",
      socketId: socket.id,
      displayname: (auth as Record<string, string>)?.displayname || "",
      username: (auth as Record<string, string>)?.username || "",
    };

    next();
  } catch (error) {
    logger.warn(
      `Socket auth failed: ${error instanceof Error ? error.message : String(error)}`
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
