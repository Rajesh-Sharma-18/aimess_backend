/**
 * Auto-delete (disappearing messages) — pure resolution logic for PRIVATE rooms.
 *
 * The setting is stored PER USER on `PrivateRoom.autoDeleteBy` (same per-user
 * JSON-map shape as `mutedBy`/`archivedBy`), so the feature is one-sided by
 * design: either participant can turn it on without the other's approval.
 *
 * Which timer a given message gets is decided ONCE, at send time, by
 * {@link resolveEffectiveAutoDelete}: the SENDER's own setting wins, and the
 * peer's setting applies only when the sender has none. That single rule covers
 * both documented cases — one-sided (only one user configured it, so every new
 * message follows that timer regardless of who sent it) and two-sided-different
 * (each user's messages follow their own timer).
 *
 * Nothing here touches the DB or the clock beyond the timestamp it is handed —
 * kept pure so both the send path and the "timer changed mid-conversation"
 * re-stamp share the exact same arithmetic.
 */

/** OFF = no timer. TIMER = fixed TTL from send time. AFTER_VIEWING = TTL starts on the recipient's read receipt. */
export const AUTO_DELETE_MODES = ["OFF", "TIMER", "AFTER_VIEWING"] as const;
export type AutoDeleteMode = (typeof AUTO_DELETE_MODES)[number];

/** Presets the clients surface (1 hour / 1 day / 1 week / 1 month). Any other
 *  value inside the bounds below is a valid "Custom" timer. */
export const AUTO_DELETE_PRESET_SECONDS = [3600, 86400, 604800, 2592000];

/**
 * Grace period between the recipient's read receipt and an "After Viewing"
 * delete (§3.4 "deletes shortly after"). Long enough that the message doesn't
 * vanish mid-scroll on the reader's screen, short enough to still feel instant.
 */
export const AUTO_DELETE_AFTER_VIEW_GRACE_SEC = 5;

/** Bounds for a TIMER ttl: 1 minute .. 365 days. */
export const AUTO_DELETE_MIN_TTL_SEC = 60;
export const AUTO_DELETE_MAX_TTL_SEC = 365 * 24 * 3600;

export interface AutoDeleteSetting {
  mode: AutoDeleteMode;
  /** Seconds; null for OFF and AFTER_VIEWING. */
  ttlSeconds: number | null;
  /** ISO-8601, "" when never configured. */
  setAt: string;
}

export const AUTO_DELETE_OFF: AutoDeleteSetting = {
  mode: "OFF",
  ttlSeconds: null,
  setAt: "",
};

function coerceSetting(raw: unknown): AutoDeleteSetting {
  if (!raw || typeof raw !== "object") return AUTO_DELETE_OFF;
  const r = raw as Record<string, unknown>;
  const mode = String(r.mode ?? "OFF").toUpperCase() as AutoDeleteMode;
  if (!AUTO_DELETE_MODES.includes(mode)) return AUTO_DELETE_OFF;
  if (mode === "OFF") return AUTO_DELETE_OFF;
  const ttl = Number(r.ttlSeconds);
  return {
    mode,
    ttlSeconds:
      mode === "TIMER" && Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    setAt: typeof r.setAt === "string" ? r.setAt : "",
  };
}

/** Normalize the stored `PrivateRoom.autoDeleteBy` JSON into a typed map. */
export function parseAutoDeleteMap(
  raw: unknown
): Record<string, AutoDeleteSetting> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, AutoDeleteSetting> = {};
  for (const [userId, value] of Object.entries(
    raw as Record<string, unknown>
  )) {
    const setting = coerceSetting(value);
    if (setting.mode !== "OFF") out[userId] = setting;
  }
  return out;
}

/** One user's own setting (OFF when unset). */
export function readAutoDeleteSetting(
  map: Record<string, AutoDeleteSetting>,
  userId: string
): AutoDeleteSetting {
  return map[userId] ?? AUTO_DELETE_OFF;
}

/**
 * The timer that applies to a message SENT BY `senderId`. Sender's own setting
 * first, peer's as the fallback — see this module's header for why that single
 * rule covers both the one-sided and the two-different-timers case.
 */
export function resolveEffectiveAutoDelete(
  map: Record<string, AutoDeleteSetting>,
  senderId: string,
  peerId: string
): AutoDeleteSetting {
  const own = readAutoDeleteSetting(map, senderId);
  if (own.mode !== "OFF") return own;
  return readAutoDeleteSetting(map, peerId);
}

export interface AutoDeleteStamp {
  /** Absolute deletion time, or null when the timer hasn't started yet. */
  autoDeleteAt: Date | null;
  /** True while the message is waiting on the recipient's read receipt to arm. */
  autoDeleteAfterView: boolean;
}

export const AUTO_DELETE_NONE: AutoDeleteStamp = {
  autoDeleteAt: null,
  autoDeleteAfterView: false,
};

/** The columns a newly sent (or re-stamped) message carries for `setting`. */
export function computeAutoDeleteStamp(
  setting: AutoDeleteSetting,
  createdAt: Date
): AutoDeleteStamp {
  if (setting.mode === "AFTER_VIEWING")
    return { autoDeleteAt: null, autoDeleteAfterView: true };
  if (setting.mode === "TIMER" && setting.ttlSeconds) {
    return {
      autoDeleteAt: new Date(createdAt.getTime() + setting.ttlSeconds * 1000),
      autoDeleteAfterView: false,
    };
  }
  return AUTO_DELETE_NONE;
}

/** Validation for the PUT body. Returns an error CODE (i18n key) or null. */
export function validateAutoDeleteInput(input: {
  mode: string;
  ttlSeconds?: number | null;
}): string | null {
  const mode = String(input.mode ?? "").toUpperCase();
  if (!AUTO_DELETE_MODES.includes(mode as AutoDeleteMode))
    return "CHAT_AUTO_DELETE_INVALID_MODE";
  if (mode !== "TIMER") return null;
  const ttl = Number(input.ttlSeconds);
  if (!Number.isInteger(ttl)) return "CHAT_AUTO_DELETE_INVALID_TTL";
  if (ttl < AUTO_DELETE_MIN_TTL_SEC || ttl > AUTO_DELETE_MAX_TTL_SEC)
    return "CHAT_AUTO_DELETE_INVALID_TTL";
  return null;
}

/** Human label for the system message / toast — "1 day", "3 hours", "90 minutes". */
export function formatAutoDeleteDuration(ttlSeconds: number | null): string {
  const s = Number(ttlSeconds ?? 0);
  if (!s || s <= 0) return "";
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (s % 2592000 === 0) return plural(s / 2592000, "month");
  if (s % 604800 === 0) return plural(s / 604800, "week");
  if (s % 86400 === 0) return plural(s / 86400, "day");
  if (s % 3600 === 0) return plural(s / 3600, "hour");
  if (s % 60 === 0) return plural(s / 60, "minute");
  return plural(s, "second");
}

/** The wire block returned by the REST settings endpoints and the socket event. */
export function buildAutoDeleteWire(
  map: Record<string, AutoDeleteSetting>,
  userId: string,
  peerId: string
): Record<string, unknown> {
  const mine = readAutoDeleteSetting(map, userId);
  const theirs = readAutoDeleteSetting(map, peerId);
  const effective = resolveEffectiveAutoDelete(map, userId, peerId);
  const toWire = (s: AutoDeleteSetting) => ({
    mode: s.mode,
    ttlSeconds: s.ttlSeconds,
    setAt: s.setAt ? new Date(s.setAt).getTime() : 0,
  });
  return {
    // What MY next message will follow.
    mode: effective.mode,
    ttlSeconds: effective.ttlSeconds,
    isEnabled: effective.mode !== "OFF",
    label: formatAutoDeleteDuration(effective.ttlSeconds),
    // Both sides, so the UI can render "you: 1 day / them: 1 hour".
    self: toWire(mine),
    peer: toWire(theirs),
  };
}
