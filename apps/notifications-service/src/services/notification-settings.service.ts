import { logger } from "@aimess/logger";
import { resolveLocale, type SupportedLocale } from "@aimess/constants";
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
  timezone: "",
  language: "",
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

/**
 * The RECIPIENT's language for a push. This is the whole point of carrying
 * `language` on the settings payload: a single event fanned out to three users
 * must leave the server as three different languages, and the only place that
 * knows each recipient is here. Falls back to the default locale when the user
 * never picked one.
 */
export async function getUserLocale(userId: string): Promise<SupportedLocale> {
  const settings = await getNotificationSettings(userId);
  return resolveLocale(null, settings.language || null);
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
 * Why a notification was (or wasn't) allowed through. CATEGORY_OFF and
 * QUIET_HOURS are deliberately distinct outcomes: "I don't want this class of
 * thing" suppresses the push AND the inbox row, whereas "not right now" only
 * silences the push and leaves the row waiting in the Notification Center.
 * Callers that collapse both back into a boolean lose that distinction.
 */
export type DeliveryDecision = "ALLOW" | "CATEGORY_OFF" | "QUIET_HOURS";

/**
 * The single decision point for account-level notification preferences.
 * Category toggle first, then quiet hours.
 */
/**
 * The only notification types quiet hours may never silence.
 *
 * A LIVE ring is time-critical, comes from a known contact, and is worthless a
 * minute later — the `callEnabled` toggle is the only thing that may stop it.
 * Everything else under that category is NOT live: a missed-call alert is a
 * report of something that already finished, so it obeys quiet hours like any
 * other push and the user finds the row waiting (the call-history inbox row is
 * written before the quiet-hours gate, so nothing is lost). Exempting the whole
 * `callEnabled` category is what used to wake people at 3am for a call that had
 * already ended.
 */
const QUIET_HOURS_EXEMPT_TYPES = new Set<string>(["CALL_INCOMING"]);

/**
 * RETIRED account-level categories. The field still exists on the DB row, the
 * gRPC message and the REST envelope so older clients keep parsing, but it is
 * no longer allowed to suppress anything.
 *
 * `communityEnabled` was removed from the Notification Preferences screen:
 * community CHAT messages moved to `chatEnabled` (which is what the Chat row
 * has always claimed to cover — "1-1, group, community messages"), community
 * livestreams already had `liveStreamEnabled`, and every other community event
 * is gated by that community's OWN per-community preference
 * (`announcementEnabled`) plus the ACTIVE-membership check in push.service.
 *
 * Ignoring the stored value here — rather than deleting the column — is
 * deliberate: anyone who had already switched Community off would otherwise be
 * silenced forever, since no screen can ever switch it back on.
 */
const RETIRED_CATEGORIES = new Set<NotificationCategory>(["communityEnabled"]);

export function evaluateDelivery(
  settings: NotificationSettings,
  category: NotificationCategory,
  type?: string
): DeliveryDecision {
  if (!RETIRED_CATEGORIES.has(category) && !settings[category]) {
    return "CATEGORY_OFF";
  }
  if (type !== undefined && QUIET_HOURS_EXEMPT_TYPES.has(type)) return "ALLOW";
  // Back-compat: a caller that passes no type keeps the old category-wide call
  // exemption, so nothing silently starts being suppressed mid-rollout.
  if (type === undefined && category === "callEnabled") return "ALLOW";
  if (isInQuietHours(settings)) return "QUIET_HOURS";
  return "ALLOW";
}

/**
 * Wall-clock minutes-since-midnight and day-of-week (0=Sunday .. 6=Saturday)
 * in the user's IANA timezone. An empty or unrecognised timezone falls back to
 * server-local time, which is exactly what every row did before the column
 * existed — so no backfill is required.
 */
function wallClock(
  now: Date,
  timeZone: string
): { minutes: number; day: number } {
  const serverLocal = {
    minutes: now.getHours() * 60 + now.getMinutes(),
    day: now.getDay(),
  };

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
  } catch {
    return serverLocal;
  }

  const get = (type: Intl.DateTimeFormatPart["type"]): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  // Some ICU builds render midnight as "24" under hour12:false.
  const hour = get("hour") % 24;
  // The weekday has to come from the SHIFTED calendar date, not from `now` —
  // 01:00 Tuesday in Bangkok is still Monday in UTC.
  const day = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"))
  ).getUTCDay();

  return { minutes: hour * 60 + get("minute"), day };
}

/**
 * Quiet-hours check in the user's timezone. start/end are "HH:mm"; a window
 * that wraps past midnight (start > end) is handled. quietHoursDays uses
 * 0=Sunday .. 6=Saturday — the same numbering the API validator accepts and the
 * clients render; empty days = every day.
 *
 * ponytail: the day filter matches the day the window is evaluated on, not the
 * day it started. A 22:00-07:00 window with only Monday selected therefore
 * stops at midnight. Revisit if users report the tail hours leaking through.
 */
export function isInQuietHours(
  settings: NotificationSettings,
  now: Date = new Date()
): boolean {
  if (!settings.quietHoursEnabled) return false;
  if (!settings.quietHoursStart || !settings.quietHoursEnd) return false;

  const { minutes: cur, day } = wallClock(now, settings.timezone || "");

  if (
    settings.quietHoursDays.length > 0 &&
    !settings.quietHoursDays.includes(day)
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

  if (start === end) return false; // zero-length window
  return start < end
    ? cur >= start && cur < end // same-day window
    : cur >= start || cur < end; // wraps past midnight
}

/**
 * Whether the notification payload should include message content in the
 * preview. Defaults to true when the setting is absent.
 */
export function shouldShowPreview(settings: NotificationSettings): boolean {
  return settings.showPreview !== false;
}
