import type { RequestHandler } from "express";
import { verifyAccessToken, extractBearerToken } from "@aimess/auth-jwt";
import { getRedis, isUserBanned } from "@aimess/redis";
import { logger } from "@aimess/logger";

import { env, accessTokenVerifyConfig } from "../config/env.js";

/**
 * Scoped ban gate for the consumer `/chat` REST proxy (private + group + community
 * chat). A permanent super-admin system ban revokes every session and
 * force-disconnects every socket the instant it lands, but the gateway HTTP
 * proxy is otherwise a pure passthrough — a still-valid access token would keep
 * working against plain REST until it naturally expires. This closes that window
 * for chat/group REST: a request whose bearer belongs to a banned user is
 * rejected with 403 before it reaches chat-service, so an old token cannot send
 * a message, react, join, or read after the ban (spec §28).
 *
 * Best-effort and fail-OPEN on any verify/redis error — chat-service still
 * enforces group membership/room state on every write, so a Redis blip must not
 * take down all chat REST. Only a POSITIVE ban confirmation blocks. A
 * missing/garbage/expired token is passed through untouched and left for the
 * downstream service to reject with its own 401, so this gate never changes
 * existing auth semantics for non-banned users.
 */
export function createChatBanGate(): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      let userId: string;
      try {
        const token = extractBearerToken(req.headers.authorization);
        userId = verifyAccessToken(token, accessTokenVerifyConfig).userId;
      } catch {
        // No/invalid/expired token — not our decision. Downstream 401s.
        next();
        return;
      }

      let banned: boolean;
      try {
        banned = await isUserBanned(getRedis(), userId);
      } catch (err) {
        // Fail open: downstream membership guards remain the backstop.
        logger.warn(
          `chat ban-gate redis check failed for ${userId}: ${String(err)}`
        );
        next();
        return;
      }

      if (banned) {
        res.status(403).json({
          success: false,
          code: "ACCOUNT_BANNED",
          message: "ACCOUNT_BANNED",
        });
        return;
      }
      next();
    })();
  };
}
