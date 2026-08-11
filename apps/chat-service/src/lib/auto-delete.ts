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
 * An entry with `mode: "OFF"` is KEPT (it carries a `setAt`), because
 * "explicitly turned off in THIS chat" and "never configured" are no longer the
 * same state: the first must survive the account-wide default, the second must
 * not — see {@link resolveEffectiveAutoDelete}. Every other consumer reads
 * through {@link readAutoDeleteSetting}, which returns OFF either way.
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

/** True when this user has made an explicit per-chat choice (including OFF). */
export function hasExplicitAutoDelete(
  map: Record<string, AutoDeleteSetting>,
  userId: string
): boolean {
  return map[userId] !== undefined;
}

/** One user's own setting (OFF when unset). */
export function readAutoDeleteSetting(
  map: Record<string, AutoDeleteSetting>,
  userId: string
): AutoDeleteSetting {
  return map[userId] ?? AUTO_DELETE_OFF;
}

/**
 * The timer that applies to a message SENT BY `senderId`. Sender's own per-chat
 * setting first, peer's per-chat setting next — see this module's header for why
 * that covers both the one-sided and the two-different-timers case — and the
 * sender's ACCOUNT-WIDE default (Settings → Chat → Auto-Delete) last.
 *
 * OFF MEANS OFF: an explicit "Off" on THIS chat outranks every fallback, the
 * peer's timer included. Both fallbacks exist to cover a chat the sender never
 * configured; once they have said "not here", nothing may re-arm their messages
 * behind a menu that reads Off. That is why an explicit OFF is stored rather
 * than deleted — "off here" and "never chose" must stay distinguishable.
 */
export function resolveEffectiveAutoDelete(
  map: Record<string, AutoDeleteSetting>,
  senderId: string,
  peerId: string,
  accountDefault: AutoDeleteSetting = AUTO_DELETE_OFF
): AutoDeleteSetting {
  const own = readAutoDeleteSetting(map, senderId);
  if (own.mode !== "OFF") return own;
  if (hasExplicitAutoDelete(map, senderId)) return AUTO_DELETE_OFF;
  const peer = readAutoDeleteSetting(map, peerId);
  if (peer.mode !== "OFF") return peer;
  return accountDefault;
}

/** Account-wide `ChatSettings.autoDeleteTimer` (user-service) → a room setting. */
export const ACCOUNT_AUTO_DELETE_TTL_SECONDS: Record<string, number> = {
  DAYS_7: 7 * 24 * 3600,
  DAYS_15: 15 * 24 * 3600,
  DAYS_30: 30 * 24 * 3600,
};

export function accountAutoDeleteSetting(timer: string): AutoDeleteSetting {
  const ttlSeconds = ACCOUNT_AUTO_DELETE_TTL_SECONDS[String(timer)];
  if (!ttlSeconds) return AUTO_DELETE_OFF;
  return { mode: "TIMER", ttlSeconds, setAt: "" };
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

/** The wire block returned by the REST settings endpoints and the socket event. */
export function buildAutoDeleteWire(
  map: Record<string, AutoDeleteSetting>,
  userId: string,
  peerId: string,
  accountDefault: AutoDeleteSetting = AUTO_DELETE_OFF
): Record<string, unknown> {
  const mine = readAutoDeleteSetting(map, userId);
  const theirs = readAutoDeleteSetting(map, peerId);
  const effective = resolveEffectiveAutoDelete(
    map,
    userId,
    peerId,
    accountDefault
  );
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
    label: formatAutoDeleteDuration(effective.ttlSeconds, currentLocale()),
    // Where that timer came from, so the UI can say "from your Chat settings"
    // instead of showing this chat as configured when it isn't.
    source:
      effective.mode === "OFF"
        ? "NONE"
        : mine.mode !== "OFF"
          ? "SELF"
          : theirs.mode !== "OFF"
            ? "PEER"
            : "ACCOUNT",
    // Both sides, so the UI can render "you: 1 day / them: 1 hour".
    self: toWire(mine),
    peer: toWire(theirs),
    // The caller's account-wide default (Settings → Chat → Auto-Delete).
    accountDefault: toWire(accountDefault),
  };
}
