import { DEFAULT_LOCALE, type SupportedLocale } from "./locale.js";
import { MESSAGES, type MessageKey } from "./messages/index.js";

function normalizeLocale(input?: string | null): SupportedLocale {
  if (!input) return DEFAULT_LOCALE;

  const primary = input
    .trim()
    .toLowerCase()
    .split(",")[0]
    ?.split(";")[0]
    ?.trim();
  if (!primary) return DEFAULT_LOCALE;

  if (primary.startsWith("en")) return "en";
  if (primary.startsWith("vi")) return "vi";
  if (primary.startsWith("th")) return "th";

  return DEFAULT_LOCALE;
}

/**
 * Resolve locale from `x-lang` (explicit) or `Accept-Language` (browser/client).
 * Falls back to {@link DEFAULT_LOCALE} (English in dev/test, Vietnamese in production).
 */
export function resolveLocale(
  acceptLanguage?: string | null,
  preferredLanguage?: string | null
): SupportedLocale {
  return normalizeLocale(preferredLanguage ?? acceptLanguage);
}

/** Values substituted into a message's `{{placeholders}}`. */
export type MessageParams = Record<string, string | number>;

/**
 * Substitute `{{name}}` placeholders. A placeholder with no matching param is
 * left as-is rather than blanked, so a missing interpolation is visible in
 * dev/test instead of silently producing "  was removed".
 */
export function interpolate(text: string, params?: MessageParams): string {
  if (!params) return text;
  return text.replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (whole, name: string, offset: number) => {
      const value = params[name];
      if (value === undefined) return whole;
      const s = String(value);
      if (!s) return s;
      // Thai has no word spaces, but a Latin name glued to Thai text ("Alexนำ") reads as one word.
      const before = isThai(text[offset - 1]) && !isThai(s[0]) ? " " : "";
      const after =
        isThai(text[offset + whole.length]) && !isThai(s[s.length - 1]) ? " " : "";
      return before + s + after;
    }
  );
}

const isThai = (c: string | undefined): boolean =>
  c !== undefined && c >= "฀" && c <= "๿";

/**
 * Get a localized message for the given key and locale.
 *
 * @example
 * t("CHAT_MESSAGE_SENT", "th")
 * t("SYS_MEMBER_REMOVED_FROM", "vi", { actor: "An", target: "Bình", entity: "Nhóm A" })
 */
export function t(
  key: MessageKey,
  locale: SupportedLocale = DEFAULT_LOCALE,
  params?: MessageParams
): string {
  const entry = MESSAGES[key];
  if (!entry) {
    return key;
  }
  const text = entry[locale] ?? entry[DEFAULT_LOCALE] ?? entry.en ?? key;
  return interpolate(text, params && localizeDeletedNames(params, locale));
}

// Keep in sync with DELETED_ACCOUNT_DISPLAY_NAME (user/deleted-account.ts; importing it here is a cycle).
const DELETED_NAME = "Deleted Account";

/** The stored deleted-account literal reads in the sentence's own language (v2 R6). */
function localizeDeletedNames(
  params: MessageParams,
  locale: SupportedLocale
): MessageParams {
  if (!Object.values(params).includes(DELETED_NAME)) return params;
  const name = MESSAGES.SYS_DELETED_ACCOUNT_NAME[locale];
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, v === DELETED_NAME ? name : v])
  );
}

/**
 * Render a key that arrived over the wire, or null when this build does not
 * carry it.
 *
 * {@link t} answers an unknown key with the key ITSELF, which is the right
 * answer for a compile-checked call site (a typo is loud) and the wrong one for
 * a string that crossed a service boundary: a client would be shown
 * `SYS_COMMUNITY_JOINED` verbatim. Returning null instead lets the caller keep
 * the sentence the producer already baked in, which is a real sentence in the
 * fallback language rather than an identifier.
 */
export function renderMessageKey(
  key: unknown,
  locale: SupportedLocale = DEFAULT_LOCALE,
  params?: MessageParams
): string | null {
  if (typeof key !== "string" || !key) return null;
  if (!Object.prototype.hasOwnProperty.call(MESSAGES, key)) return null;
  return t(key as MessageKey, locale, params);
}
