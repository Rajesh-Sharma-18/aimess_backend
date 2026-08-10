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
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Get a localized message for the given key and locale.
 *
 * @example
 * t("CHAT_MESSAGE_SENT", "th")
 * t("SYS_GROUP_MEMBER_REMOVED", "vi", { actor: "An", target: "Bình" })
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
  return interpolate(text, params);
}
