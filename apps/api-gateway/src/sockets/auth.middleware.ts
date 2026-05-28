import type { Socket } from "socket.io";
import { verifyAccessToken, extractBearerToken } from "@aimess/auth-jwt";
import { logger } from "@aimess/logger";
import { env } from "../config/env.js";

declare module "socket.io" {
  interface SocketData {
    userId: string;
    sessionId: string;
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
