/**
 * Shared per-connection session-timer machinery for all Socket.IO namespaces.
 *
 * Behavior: 5 min before the handshake JWT expires the socket receives a
 * `session:expired` warning carrying a 60-second grace period. If `auth:refresh`
 * is not called within that window the socket is force-disconnected. A successful
 * refresh resets both timers.
 *
 * Each namespace calls `createSessionTimers` once per connected socket and gets
 * back three functions:
 *  - `scheduleSessionTimers(expiresAt)` — arm (or re-arm) the warn + expire timers
 *  - `clearSessionTimers()`             — cancel both timers (call on disconnect)
 *  - `registerAuthRefreshHandler()`     — register the `auth:refresh` socket event
 */

import type { Socket } from "socket.io";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { ackOk, ackError } from "./ack.js";
import type { SupportedLocale } from "@aimess/constants";

const AuthRefreshSchema = z.object({ refreshToken: z.string().min(1) });

export interface SessionTimers {
  clearSessionTimers: () => void;
  scheduleSessionTimers: (expiresAt: number) => void;
  registerAuthRefreshHandler: () => void;
}

export function createSessionTimers(
  socket: Socket,
  locale: SupportedLocale,
  logPrefix: string,
  authServiceUrl: string
): SessionTimers {
  let sessionWarnTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionExpireTimer: ReturnType<typeof setTimeout> | null = null;

  const clearSessionTimers = (): void => {
    if (sessionWarnTimer !== null) {
      clearTimeout(sessionWarnTimer);
      sessionWarnTimer = null;
    }
    if (sessionExpireTimer !== null) {
      clearTimeout(sessionExpireTimer);
      sessionExpireTimer = null;
    }
  };

  const scheduleSessionTimers = (expiresAt: number): void => {
    clearSessionTimers();
    const warnMs = Math.max(0, expiresAt - Date.now() - 5 * 60 * 1000);
    sessionWarnTimer = setTimeout(() => {
      sessionWarnTimer = null;
      socket.emit("session:expired", {
        reason: "TOKEN_EXPIRED",
        expiresAt,
        reconnect: true,
        gracePeriod: 60,
      });
      sessionExpireTimer = setTimeout(() => {
        sessionExpireTimer = null;
        logger.debug(
          `${logPrefix} session grace elapsed, disconnecting userId=${String(socket.data.userId)}`
        );
        socket.disconnect(true);
      }, 60_000);
    }, warnMs);
  };

  const registerAuthRefreshHandler = (): void => {
    socket.on(
      "auth:refresh",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = AuthRefreshSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        fetch(`${authServiceUrl}/api/auth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: r.data.refreshToken }),
          signal: controller.signal,
        })
          .then(async (res) => {
            clearTimeout(timeoutId);
            if (!res.ok) {
              ackError(callback, "SERVICE_ERROR", locale);
              return;
            }
            const body = (await res.json()) as {
              data?: { accessToken?: string; accessTokenExpiresIn?: number };
            };
            const token = body.data?.accessToken;
            if (!token) {
              ackError(callback, "SERVICE_ERROR", locale);
              return;
            }
            const expiresIn = body.data?.accessTokenExpiresIn ?? 900;
            const newExpiresAt = Date.now() + expiresIn * 1000;
            socket.data.tokenExpiresAt = newExpiresAt;
            socket.data.accessToken = token;
            scheduleSessionTimers(newExpiresAt);
            ackOk(callback, "SOCKET_AUTH_REFRESHED", locale, {
              accessToken: token,
              expiresIn,
            });
          })
          .catch((err: unknown) => {
            clearTimeout(timeoutId);
            logger.warn(`${logPrefix} auth:refresh error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          });
      }
    );
  };

  return {
    clearSessionTimers,
    scheduleSessionTimers,
    registerAuthRefreshHandler,
  };
}
