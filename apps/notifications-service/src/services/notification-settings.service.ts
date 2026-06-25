import { logger } from "@aimess/logger";
import { cacheGetJson, cacheSetJson, cacheDel } from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import {
  createUserSettingsClient,
  type NotificationSettings,
} from "../grpc/user-settings.client.js";

const userSettingsClient = createUserSettingsClient();

const cacheKey = (userId: string): string => `notif:settings:${userId}`;

/** Permissive default — when settings are unavailable we ALLOW delivery. */
const ALLOW_ALL: NotificationSettings = {
  chatEnabled: true,
  callEnabled: true,
  friendRequestEnabled: true,
  systemEnabled: true,
  communityEnabled: true,
  liveStreamEnabled: true,
  showPreview: true,
  quietHoursEnabled: false,
  quietHoursStart: "",
  quietHoursEnd: "",
  quietHoursDays: [],
};

export type NotificationCategory =
  | "chatEnabled"
  | "callEnabled"
  | "friendRequestEnabled"
  | "systemEnabled"
  | "communityEnabled"
  | "liveStreamEnabled";

/**
 * Fetch a user's notification settings, Redis-cached (TTL from env, default
 * 300s). On any failure (cache miss + gRPC circuit open / error) we fall back
 * to ALLOW_ALL so notifications still flow — availability over strict gating.
 */
export async function getNotificationSettings(
  userId: string
): Promise<NotificationSettings> {
  try {
    const cached = await cacheGetJson<NotificationSettings>(
      redis,
      cacheKey(userId)
    );
    if (cached) return cached;
  } catch (error) {
    logger.warn("notif settings cache read failed; falling through to gRPC");
    logger.warn(error);
  }

  let settings: NotificationSettings;
  try {
    settings = await userSettingsClient.getNotificationSettings(userId);
  } catch (error) {
    // Circuit open or gRPC error → allow-on-open (do NOT cache the fallback).
    logger.warn(`getNotificationSettings unavailable for ${userId}; allowing`);
    logger.warn(error);
    return ALLOW_ALL;
  }

  try {
    await cacheSetJson(
      redis,
      cacheKey(userId),
      settings,
      env.NOTIF_SETTINGS_CACHE_TTL_SEC
    );
  } catch (error) {
    logger.warn("notif settings cache write failed");
    logger.warn(error);
  }

  return settings;
}

/** Bust the cached entry (called from the user.settings_updated consumer). */
export async function invalidateNotificationSettings(
  userId: string
): Promise<void> {
  try {
    await cacheDel(redis, cacheKey(userId));
  } catch (error) {
    logger.warn(`Failed to invalidate notif settings cache for ${userId}`);
    logger.warn(error);
  }
}

/**
 * Whether a category is enabled AND we are not inside the user's quiet-hours
 * window. Quiet hours suppress delivery for ALL categories.
 */
export function isDeliveryAllowed(
  settings: NotificationSettings,
  category: NotificationCategory
): boolean {
  if (!settings[category]) return false;
  if (isInQuietHours(settings)) return false;
  return true;
}

/**
 * Whether the notification payload should include message content in the
 * preview. Defaults to true when the setting is absent.
 */
export function shouldShowPreview(settings: NotificationSettings): boolean {
  return settings.showPreview !== false;
}

/**
 * Quiet-hours check in server-local time. start/end are "HH:mm"; a window that
 * wraps past midnight (start > end) is handled. quietHoursDays uses ISO weekday
 * numbers (1=Mon … 7=Sun); empty days = every day.
 */
export function isInQuietHours(
  settings: NotificationSettings,
  now: Date = new Date()
): boolean {
  if (!settings.quietHoursEnabled) return false;
  if (!settings.quietHoursStart || !settings.quietHoursEnd) return false;

  const isoDay = now.getDay() === 0 ? 7 : now.getDay(); // JS Sun=0 → ISO 7
  if (
    settings.quietHoursDays.length > 0 &&
    !settings.quietHoursDays.includes(isoDay)
  ) {
    return false;
  }

  const toMinutes = (hhmm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };

  const start = toMinutes(settings.quietHoursStart);
  const end = toMinutes(settings.quietHoursEnd);
  if (start === null || end === null) return false;

  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false; // zero-length window
  return start < end
    ? cur >= start && cur < end // same-day window
    : cur >= start || cur < end; // wraps past midnight
}
