import { prisma } from "../config/prisma.js";

export type DeviceTokenPlatform = "ANDROID" | "IOS" | "WEB";

export interface UpsertDeviceTokenInput {
  userId: string;
  token: string;
  platform: DeviceTokenPlatform;
  deviceId?: string | null;
}

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
        deviceId: input.deviceId ?? null,
        lastSeenAt: new Date(),
      },
      create: {
        token: input.token,
        userId: input.userId,
        platform: input.platform,
        deviceId: input.deviceId ?? null,
      },
    });
  },

  /** All active tokens for a user (used to fan a push out across devices). */
  async findTokensByUserId(userId: string): Promise<string[]> {
    const rows = await prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    return rows.map((r) => r.token);
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

  /** Remove ALL tokens for a user (logout-all-devices). */
  async deleteAllByUserId(userId: string): Promise<void> {
    await prisma.deviceToken.deleteMany({ where: { userId } });
  },

  /** Remove tokens for a specific device (single-device logout). */
  async deleteByUserIdAndDeviceId(
    userId: string,
    deviceId: string
  ): Promise<void> {
    await prisma.deviceToken.deleteMany({ where: { userId, deviceId } });
  },
};
