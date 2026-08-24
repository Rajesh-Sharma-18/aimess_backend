import type { SupportedLocale } from "@aimess/constants";

import {
  deviceTokenRepository,
  type DeviceTokenPlatform,
  type DeviceTokenRow,
  type DeviceTokenType,
} from "../repositories/device-token.repository.js";

export const deviceTokenService = {
  registerDevice(input: {
    userId: string;
    token: string;
    platform: DeviceTokenPlatform;
    tokenType: DeviceTokenType;
    deviceId?: string | null;
    sessionId?: string | null;
    /** This device's push language; null falls back to the account setting. */
    locale?: SupportedLocale | null;
  }): Promise<void> {
    return deviceTokenRepository.upsert(input);
  },

  /** Unregister a token. Scoped to the caller so users can only drop their own. */
  async unregisterDevice(userId: string, token: string): Promise<boolean> {
    const deleted = await deviceTokenRepository.deleteByUserAndToken(
      userId,
      token
    );
    return deleted > 0;
  },

  getTokensForUser(userId: string): Promise<DeviceTokenRow[]> {
    return deviceTokenRepository.findTokensByUserId(userId);
  },

  /** Prune a dead token surfaced by FCM (invalid/unregistered). */
  pruneToken(token: string): Promise<void> {
    return deviceTokenRepository.deleteByToken(token);
  },

  /** Refresh the liveness stamp the stale-token sweeper reads (throttled). */
  touchToken(token: string): Promise<void> {
    return deviceTokenRepository.touchLastSeen(token);
  },

  /** Delete every token unseen for longer than the TTL. Returns the count. */
  sweepStaleTokens(olderThanMs?: number): Promise<number> {
    return deviceTokenRepository.deleteStale(olderThanMs);
  },
};
