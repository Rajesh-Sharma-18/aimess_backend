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

/** A conversation kind, for the capability/validation split below. */
export type AutoDeleteConversationType = "PRIVATE" | "GROUP";

/**
 * Modes a conversation of each kind may be put into.
 *
 * GROUP deliberately omits AFTER_VIEWING. Under the current schema a message
 * carries ONE global `autoDeleteAt`, so "after viewing" in a group would mean
 * "the first member to open the chat deletes it for everyone else" — including
 * members who never saw it. That is a per-member visibility/deadline design,
 * not a flag, so the mode is rejected outright rather than shipped as a hidden
 * behaviour. See `capabilities.supportsAfterViewing` on the wire block.
 */
export const AUTO_DELETE_MODES_BY_TYPE: Record<
  AutoDeleteConversationType,
  readonly AutoDeleteMode[]
> = {
  PRIVATE: ["OFF", "TIMER", "AFTER_VIEWING"],
  GROUP: ["OFF", "TIMER"],
};

/** May this conversation kind be put into `mode`? */
export function supportsAutoDeleteMode(
  conversationType: AutoDeleteConversationType,
  mode: AutoDeleteMode
): boolean {
  return AUTO_DELETE_MODES_BY_TYPE[conversationType].includes(mode);
}

/**
 * Presets the clients surface: 24 hours / 1 week / 30 days.
 *
 * The 90-day entry that used to sit here was a stale copy of an early spec —
 * no client ever offered it and no server code read this constant, but it
 * disagreed with both the product list and the Profile default's own values.
 */
export const AUTO_DELETE_PRESET_SECONDS = [86400, 604800, 2592000];

/**
 * Additional values the backend accepts so clients can exercise the feature
 * without waiting a day. Everything here is inside the MIN/MAX bounds below —
 * the bounds, not this list, are what validation enforces.
 */
export const AUTO_DELETE_DEBUG_TTL_SECONDS = [300, 600, 1800, 3600, 21600];

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

/**
 * Validation for the PUT body. Returns an error CODE (i18n key) or null.
 *
 * `conversationType` is optional so the pure-mode/ttl checks stay callable on
 * their own; when supplied, a mode the conversation kind does not support (the
 * only case today being group AFTER_VIEWING) is rejected with its own stable
 * code so clients can distinguish "typo" from "not available here".
 */
export function validateAutoDeleteInput(
  input: {
    mode: string;
    ttlSeconds?: number | null;
  },
  conversationType?: AutoDeleteConversationType
): string | null {
  const mode = String(input.mode ?? "").toUpperCase();
  if (!AUTO_DELETE_MODES.includes(mode as AutoDeleteMode))
    return "CHAT_AUTO_DELETE_INVALID_MODE";
  if (
    conversationType &&
    !supportsAutoDeleteMode(conversationType, mode as AutoDeleteMode)
  )
    return "CHAT_AUTO_DELETE_MODE_UNSUPPORTED";
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

/** Everything the canonical room-policy DTO needs beyond the stored setting. */
export interface RoomPolicyContext {
  conversationType: AutoDeleteConversationType;
  /** Monotonic per-room policy version — see `*RoomRepository.setAutoDelete`. */
  policyVersion: number;
  /** May the CALLER change this policy? (private: always; group: ADMIN/MODERATOR.) */
  canEdit: boolean;
}

/**
 * THE room-policy wire block — one shape for private and group, returned
 * verbatim by GET, by PUT, and by the `conv:auto_delete:updated` socket event,
 * and embedded in inbox/room-detail rows so a fresh client can render the timer
 * icon without one request per conversation.
 *
 * One conversation, one timer — the same payload for every participant, which
 * is what lets the socket event be published verbatim to each of them.
 *
 * `label` and `self` are the pre-existing fields, kept byte-identical so
 * current clients keep rendering; `self` is a mirror of the flat fields from
 * when each participant had their own timer and carries no independent meaning.
 * New clients read `mode`/`ttlSeconds`/`policyVersion`/`capabilities` instead.
 */
export function buildAutoDeleteWire(
  setting: AutoDeleteSetting,
  ctx: RoomPolicyContext = {
    conversationType: "PRIVATE",
    policyVersion: 0,
    canEdit: true,
  }
): Record<string, unknown> {
  const setAt = setting.setAt ? new Date(setting.setAt).getTime() : 0;
  return {
    conversationType: ctx.conversationType,
    mode: setting.mode,
    ttlSeconds: setting.ttlSeconds,
    isEnabled: setting.mode !== "OFF",
    label: formatAutoDeleteDuration(setting.ttlSeconds, currentLocale()),
    setAt,
    setBy: setting.setBy ?? "",
    policyVersion: ctx.policyVersion,
    canEdit: ctx.canEdit,
    capabilities: {
      supportsAfterViewing: supportsAutoDeleteMode(
        ctx.conversationType,
        "AFTER_VIEWING"
      ),
    },
    self: {
      mode: setting.mode,
      ttlSeconds: setting.ttlSeconds,
      setAt,
    },
  };
}

/**
 * The monotonic policy version stored beside a room's `autoDelete` JSON.
 *
 * Kept in its OWN integer column rather than inside the JSON so it can be
 * allocated with an atomic `$inc` in the same write that stores the policy —
 * two concurrent PUTs then get two distinct versions instead of both reading
 * the same "current" value and writing the same successor.
 */
export function readPolicyVersion(room: {
  autoDeletePolicyVersion?: number | null;
}): number {
  const v = room.autoDeletePolicyVersion;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The MongoDB aggregation-pipeline update that stores a room's new policy.
 *
 * ONE atomic write does three things that used to be split across two writes
 * and a fire-and-forget promise:
 *
 *   1. allocates the next `autoDeletePolicyVersion` with `$add` on the stored
 *      value, so two concurrent PUTs get two distinct versions rather than both
 *      reading "7" and both writing "8";
 *   2. stores the policy itself;
 *   3. records `autoDeleteRestampPending` = that same new version — the DURABLE
 *      intent that already-enrolled rows still need moving to the new deadline.
 *
 * Because (2) and (3) land together, a crash after the write leaves a room whose
 * policy is stored AND whose restamp is still owed, which the repair pass
 * finishes. Previously the restamp was a `.catch(log)` after the write, so a
 * failure there returned 200 to the client while every enrolled message stayed
 * on the old deadline with nothing left to fix it.
 *
 * `$literal` wraps the stored document so a user id or mode that happened to
 * start with `$` could never be interpreted as a field path.
 */
export function autoDeletePolicyUpdatePipeline(params: {
  mode: AutoDeleteMode;
  ttlSeconds: number | null;
  setBy: string;
  setAt: string;
  /** PRIVATE only — the legacy per-user map is retired on the first new write. */
  clearLegacyMap?: boolean;
}): Record<string, unknown>[] {
  return [
    {
      $set: {
        autoDeletePolicyVersion: {
          $add: [{ $ifNull: ["$autoDeletePolicyVersion", 0] }, 1],
        },
      },
    },
    {
      $set: {
        autoDelete: {
          $literal: {
            mode: params.mode,
            ttlSeconds: params.mode === "TIMER" ? params.ttlSeconds : null,
            setAt: params.setAt,
            setBy: params.setBy,
          },
        },
        // Turning the timer OFF never re-stamps: messages already counting down
        // keep their deadline (§7), so there is nothing owed and nothing to
        // repair. Only an ENABLED policy leaves work behind.
        autoDeleteRestampPending:
          params.mode === "OFF" ? null : "$autoDeletePolicyVersion",
        ...(params.clearLegacyMap ? { autoDeleteBy: { $literal: {} } } : {}),
      },
    },
  ];
}

// ─────────────────────── account default (Profile setting) ──────────────────

/**
 * LEGACY Profile enum → seconds. `DAYS_15` has no counterpart in the room-level
 * preset list; it is still honoured as a plain custom TTL so nobody's existing
 * account default silently changes meaning, but it is not offered going
 * forward — the canonical `{ mode, ttlSeconds }` shape is.
 */
export const LEGACY_ACCOUNT_TIMER_SECONDS: Record<string, number | null> = {
  OFF: null,
  DAYS_7: 604800,
  DAYS_15: 1296000,
  DAYS_30: 2592000,
};

/**
 * "Default message timer for new private chats" — the account-wide Profile
 * setting, resolved to the same {@link AutoDeleteSetting} shape a room stores.
 *
 * DUAL-READ during the migration window: the canonical versioned
 * `{ mode, ttlSeconds }` wins when user-service has one, otherwise the legacy
 * `autoDeleteTimer` enum is mapped. AFTER_VIEWING is never an account default —
 * it is an explicit per-conversation choice — so anything else degrades to OFF.
 */
export function resolveAccountDefaultSetting(settings: {
  autoDeleteDefaultMode?: string | null;
  autoDeleteDefaultTtlSeconds?: number | null;
  autoDeleteTimer?: string | null;
}): AutoDeleteSetting {
  const canonical = String(settings.autoDeleteDefaultMode ?? "").toUpperCase();
  if (canonical === "TIMER") {
    const ttl = Number(settings.autoDeleteDefaultTtlSeconds);
    if (
      Number.isInteger(ttl) &&
      ttl >= AUTO_DELETE_MIN_TTL_SEC &&
      ttl <= AUTO_DELETE_MAX_TTL_SEC
    )
      return { mode: "TIMER", ttlSeconds: ttl, setAt: "" };
    return AUTO_DELETE_OFF;
  }
  if (canonical === "OFF") return AUTO_DELETE_OFF;

  const ttl = LEGACY_ACCOUNT_TIMER_SECONDS[
    String(settings.autoDeleteTimer ?? "OFF").toUpperCase()
  ] ?? null;
  return ttl ? { mode: "TIMER", ttlSeconds: ttl, setAt: "" } : AUTO_DELETE_OFF;
}
