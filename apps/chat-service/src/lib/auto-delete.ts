/**
 * Auto-delete (disappearing messages) — pure resolution logic for PRIVATE rooms.
 *
 * ONE timer belongs to the CONVERSATION, not to a participant (WhatsApp's
 * model): either side may change it, both sides' menus then show it, and every
 * new message from either side follows it. It lives in `PrivateRoom.autoDelete`
 * — absent means Off, so a brand-new conversation starts Off with nothing to
 * initialize and nothing inherited from either user's other chats or account.
 *
 * `PrivateRoom.autoDeleteBy` is the LEGACY per-user map from when each side had
 * its own timer. It is read-only now: {@link readRoomAutoDelete} falls back to
 * its most recently set entry so rooms configured before the change keep their
 * timer, and the first write through the new path replaces it.
 *
 * Nothing here touches the DB or the clock beyond the timestamp it is handed —
 * kept pure so both the send path and the "timer changed mid-conversation"
 * re-stamp share the exact same arithmetic.
 */
import {
  currentLocale,
  formatTtlDuration,
  STORED_TEXT_LOCALE,
  type SupportedLocale,
} from "@aimess/constants";

/** OFF = no timer. TIMER = fixed TTL from send time. AFTER_VIEWING = TTL starts on the recipient's read receipt. */
export const AUTO_DELETE_MODES = ["OFF", "TIMER", "AFTER_VIEWING"] as const;
export type AutoDeleteMode = (typeof AUTO_DELETE_MODES)[number];

/** Presets the clients surface — WhatsApp's set (24 hours / 7 days / 90 days).
 *  Any other value inside the bounds below is a valid "Custom" timer. */
export const AUTO_DELETE_PRESET_SECONDS = [86400, 604800, 7776000];

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
  /** Who last changed it; "" when never configured or for a legacy row. */
  setBy?: string;
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
  if (mode === "OFF")
    return {
      mode: "OFF",
      ttlSeconds: null,
      setAt: typeof r.setAt === "string" ? r.setAt : "",
      setBy: typeof r.setBy === "string" ? r.setBy : "",
    };
  const ttl = Number(r.ttlSeconds);
  return {
    mode,
    ttlSeconds:
      mode === "TIMER" && Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    setAt: typeof r.setAt === "string" ? r.setAt : "",
    setBy: typeof r.setBy === "string" ? r.setBy : "",
  };
}

/**
 * Normalize the stored `PrivateRoom.autoDeleteBy` JSON into a typed map.
 *
 * An entry with `mode: "OFF"` is KEPT rather than dropped — it carries the
 * `setAt` of the moment the user turned it off. Both states resolve to the same
 * timer (none), so every consumer can read through {@link readAutoDeleteSetting}.
 */
export function parseAutoDeleteMap(
  raw: unknown
): Record<string, AutoDeleteSetting> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, AutoDeleteSetting> = {};
  for (const [userId, value] of Object.entries(
    raw as Record<string, unknown>
  )) {
    out[userId] = coerceSetting(value);
  }
  return out;
}

/** One entry of the LEGACY per-user map (OFF when unset). */
export function readAutoDeleteSetting(
  map: Record<string, AutoDeleteSetting>,
  userId: string
): AutoDeleteSetting {
  return map[userId] ?? AUTO_DELETE_OFF;
}

/**
 * THE timer for a conversation — the single value every message in it follows,
 * whoever sent it, and the single value both participants' menus show.
 *
 * `autoDelete` is authoritative. A room that predates it falls back to the most
 * recently set entry of the legacy per-user map, so a chat someone had already
 * configured does not silently turn itself off on deploy; ties and empty maps
 * resolve to Off, which is also the correct state for a brand-new room.
 */
export function readRoomAutoDelete(room: {
  autoDelete?: unknown;
  autoDeleteBy?: unknown;
}): AutoDeleteSetting {
  if (room.autoDelete) return coerceSetting(room.autoDelete);

  let newest = AUTO_DELETE_OFF;
  for (const [userId, setting] of Object.entries(
    parseAutoDeleteMap(room.autoDeleteBy)
  )) {
    if (setting.setAt > newest.setAt)
      newest = { ...setting, setBy: setting.setBy || userId };
  }
  return newest;
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

/**
 * Human label for the system message / gear menu — "24 hours", "7 days".
 *
 * Thin alias over the shared `formatTtlDuration` in `@aimess/constants`, which
 * the SYSTEM-line renderer also uses — one spelling of a duration, in every
 * language, on both sides of the wire. Defaults to `STORED_TEXT_LOCALE` so the
 * label baked into an AUTO_DELETE_UPDATED row stays English, exactly as before.
 */
export function formatAutoDeleteDuration(
  ttlSeconds: number | null,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  return formatTtlDuration(ttlSeconds, locale);
}

/**
 * The wire block returned by the REST settings endpoints and the socket event.
 *
 * One conversation, one timer — the same payload for both participants, which is
 * what lets the socket event be published verbatim to each of them. `self` is
 * kept as a mirror of the flat fields so clients written against the older
 * per-user shape keep rendering the right thing.
 */
export function buildAutoDeleteWire(
  setting: AutoDeleteSetting
): Record<string, unknown> {
  const setAt = setting.setAt ? new Date(setting.setAt).getTime() : 0;
  return {
    mode: setting.mode,
    ttlSeconds: setting.ttlSeconds,
    isEnabled: setting.mode !== "OFF",
    label: formatAutoDeleteDuration(setting.ttlSeconds, currentLocale()),
    setAt,
    setBy: setting.setBy ?? "",
    self: {
      mode: setting.mode,
      ttlSeconds: setting.ttlSeconds,
      setAt,
    },
  };
}
