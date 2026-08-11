/**
 * Auto-delete (disappearing messages) — pure resolution logic for PRIVATE rooms.
 *
 * The setting is keyed by (conversation, user): it lives in the per-user
 * `PrivateRoom.autoDeleteBy` JSON map, same shape as `mutedBy`/`archivedBy`.
 *
 * The two participants' timers are fully INDEPENDENT. A message is stamped with
 * its SENDER's own setting for this chat and nothing else — no fallback to the
 * peer's timer, no fallback to an account-wide default. One user turning
 * disappearing messages on must never change what the other's menu shows or
 * what happens to the other's messages, and a brand-new conversation therefore
 * starts Off for both sides without anything having to initialize it.
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
    };
  const ttl = Number(r.ttlSeconds);
  return {
    mode,
    ttlSeconds:
      mode === "TIMER" && Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    setAt: typeof r.setAt === "string" ? r.setAt : "",
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

/** One user's own setting (OFF when unset — the default for every new chat). */
export function readAutoDeleteSetting(
  map: Record<string, AutoDeleteSetting>,
  userId: string
): AutoDeleteSetting {
  return map[userId] ?? AUTO_DELETE_OFF;
}

/**
 * The timer that applies to a message SENT BY `senderId` — that sender's own
 * setting for this chat, full stop.
 *
 * Deliberately a one-line alias rather than a resolution chain: it used to fall
 * back to the peer's timer and then to the sender's account-wide default, which
 * made one participant's choice silently govern the other's messages and gave a
 * brand-new conversation an inherited timer nobody picked. Kept as its own
 * named function because the send path and the re-stamp must never drift apart.
 */
export function resolveEffectiveAutoDelete(
  map: Record<string, AutoDeleteSetting>,
  senderId: string
): AutoDeleteSetting {
  return readAutoDeleteSetting(map, senderId);
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
 * ONE user's view of ONE chat. It carries no `peer` block: the peer's timer no
 * longer affects this user's messages, so shipping it would only leak the other
 * participant's private preference and invite a client to render it as this
 * user's own state — which is exactly how "A set 7 days" started showing up in
 * B's menu. `self` is kept alongside the flat fields for older clients.
 */
export function buildAutoDeleteWire(
  map: Record<string, AutoDeleteSetting>,
  userId: string
): Record<string, unknown> {
  const mine = readAutoDeleteSetting(map, userId);
  return {
    mode: mine.mode,
    ttlSeconds: mine.ttlSeconds,
    isEnabled: mine.mode !== "OFF",
    label: formatAutoDeleteDuration(mine.ttlSeconds, currentLocale()),
    self: {
      mode: mine.mode,
      ttlSeconds: mine.ttlSeconds,
      setAt: mine.setAt ? new Date(mine.setAt).getTime() : 0,
    },
  };
}
