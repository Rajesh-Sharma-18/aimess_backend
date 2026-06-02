import {
  deviceTokenRepository,
  type DeviceTokenPlatform,
} from "../repositories/device-token.repository.js";

export const deviceTokenService = {
  registerDevice(input: {
    userId: string;
    token: string;
    platform: DeviceTokenPlatform;
    deviceId?: string | null;
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

  getTokensForUser(userId: string): Promise<string[]> {
    return deviceTokenRepository.findTokensByUserId(userId);
  },

  /** Prune a dead token surfaced by FCM (invalid/unregistered). */
  pruneToken(token: string): Promise<void> {
    return deviceTokenRepository.deleteByToken(token);
  },
};
