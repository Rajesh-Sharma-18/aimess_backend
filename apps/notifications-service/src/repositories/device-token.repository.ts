import { prisma } from "../config/prisma.js";

export type DeviceTokenPlatform = "ANDROID" | "IOS" | "WEB";
export type DeviceTokenType = "FCM" | "VOIP";

export interface UpsertDeviceTokenInput {
  userId: string;
  token: string;
  platform: DeviceTokenPlatform;
  tokenType: DeviceTokenType;
  deviceId?: string | null;
  /** auth-service session the registering JWT belongs to (see schema.prisma). */
  sessionId?: string | null;
}

export interface DeviceTokenRow {
  token: string;
  tokenType: string;
  platform: string;
  deviceId: string | null;
  /** auth-service session that registered this row; null for legacy rows. */
  sessionId: string | null;
  /**
   * Bumped on every re-registration and (throttled) on every accepted push, so
   * among several rows for the SAME device the largest value is the current
   * one. That ordering is what lets the send path collapse superseded PushKit
   * tokens instead of ringing the phone once per stale row.
   */
  lastSeenAt: Date;
}

/**
 * How long a token may go unseen before the sweeper drops it. Covers the
 * devices no revocation event will ever name: a refresh token that simply
 * expired, an uninstalled app, a browser that cleared site data.
 */
const STALE_AFTER_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Minimum gap between `lastSeenAt` writes on the send path. A push proves the
 * device is still reachable, but bumping the row on every single push would
 * add a write per notification per device for no extra signal.
 */
const TOUCH_THROTTLE_MS = 24 * 60 * 60 * 1000;

export const deviceTokenRepository = {
  /**
   * Upsert by unique `token`. Re-registering an existing token refreshes its
   * owner/platform/deviceId and bumps lastSeenAt (token may move between users).
   */
  async upsert(input: UpsertDeviceTokenInput): Promise<void> {
    await prisma.deviceToken.upsert({
      where: { token: input.token },
      update: {
        userId: input.userId,
        platform: input.platform,
        tokenType: input.tokenType,
        deviceId: input.deviceId ?? null,
        sessionId: input.sessionId ?? null,
        lastSeenAt: new Date(),
      },
      create: {
        token: input.token,
        userId: input.userId,
        platform: input.platform,
        tokenType: input.tokenType,
        deviceId: input.deviceId ?? null,
        sessionId: input.sessionId ?? null,
      },
    });

    // One live token per (user, device, tokenType). FCM hands out a fresh token
    // on rotation / re-subscribe without invalidating the old one immediately,
    // so both rows would survive until FCM finally reports the stale one dead —
    // and until then every push is delivered TWICE to the same browser, which
    // renders as two identical notifications. Tokens without a deviceId can't
    // be attributed to a device, so they're left alone.
    if (input.deviceId) {
      await prisma.deviceToken.deleteMany({
        where: {
          userId: input.userId,
          deviceId: input.deviceId,
          tokenType: input.tokenType,
          token: { not: input.token },
        },
      });
    }
  },

  /**
   * All active tokens for a user (used to fan a push out across devices).
   * Includes `tokenType` so callers can branch VoIP (APNs) vs FCM delivery.
   */
  async findTokensByUserId(userId: string): Promise<DeviceTokenRow[]> {
    return prisma.deviceToken.findMany({
      where: { userId },
      select: {
        token: true,
        tokenType: true,
        platform: true,
        deviceId: true,
        sessionId: true,
        lastSeenAt: true,
      },
    });
  },

  /**
   * Of the given users, those who have at least one live FCM registration on
   * `platform`. A token row exists only while its session does, so this is the
   * set of users actually reachable on that device type right now.
   *
   * VOIP rows are excluded: an iOS PushKit token is registered for call
   * ringing only and can never carry a normal notification.
   */
  async findUserIdsWithPlatform(
    userIds: string[],
    platform: DeviceTokenPlatform
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await prisma.deviceToken.findMany({
      where: { userId: { in: userIds }, platform, tokenType: "FCM" },
      select: { userId: true },
      distinct: ["userId"],
    });
    return rows.map((row) => row.userId);
  },

  /**
   * Mark a token as still alive (a push was accepted for it), at most once per
   * `TOUCH_THROTTLE_MS`. This is what keeps a long-lived, genuinely active
   * device off the stale sweeper's list without a write per notification.
   */
  async touchLastSeen(token: string): Promise<void> {
    await prisma.deviceToken.updateMany({
      where: {
        token,
        lastSeenAt: { lt: new Date(Date.now() - TOUCH_THROTTLE_MS) },
      },
      data: { lastSeenAt: new Date() },
    });
  },

  /**
   * Delete tokens unseen for longer than the TTL. The backstop for every path
   * that produces no revocation event at all — a naturally expired refresh
   * token, an uninstalled app, a browser that cleared site data — and the
   * bound on any event lost while RabbitMQ was unreachable.
   */
  async deleteStale(olderThanMs: number = STALE_AFTER_MS): Promise<number> {
    const res = await prisma.deviceToken.deleteMany({
      where: { lastSeenAt: { lt: new Date(Date.now() - olderThanMs) } },
    });
    return res.count;
  },

  /** Remove a single token (explicit unregister, or pruning a dead FCM token). */
  async deleteByToken(token: string): Promise<void> {
    await prisma.deviceToken.deleteMany({ where: { token } });
  },

  /** Remove a token only if it belongs to the given user (scoped unregister). */
  async deleteByUserAndToken(userId: string, token: string): Promise<number> {
    const res = await prisma.deviceToken.deleteMany({
      where: { userId, token },
    });
    return res.count;
  },

  /**
   * Remove ALL tokens for a user (logout-all-devices, account deletion).
   *
   * `exceptSessionId` keeps the tokens of one still-live session — "sign out
   * from all OTHER devices" revokes every session but the caller's, so wiping
   * the caller's token too would silently kill push on a device that is still
   * signed in. Rows predating the sessionId field can't be attributed to a
   * session and are removed; they are stale by definition.
   */
  async deleteAllByUserId(
    userId: string,
    exceptSessionId?: string | null
  ): Promise<void> {
    await prisma.deviceToken.deleteMany({
      where: exceptSessionId
        ? { userId, NOT: { sessionId: exceptSessionId } }
        : { userId },
    });
  },

  /** Remove tokens registered by one session (single-session logout/revoke). */
  async deleteByUserIdAndSessionId(
    userId: string,
    sessionId: string
  ): Promise<number> {
    const res = await prisma.deviceToken.deleteMany({
      where: { userId, sessionId },
    });
    return res.count;
  },

  /** Remove tokens for a specific device (single-device logout). */
  async deleteByUserIdAndDeviceId(
    userId: string,
    deviceId: string
  ): Promise<void> {
    await prisma.deviceToken.deleteMany({ where: { userId, deviceId } });
  },
};
