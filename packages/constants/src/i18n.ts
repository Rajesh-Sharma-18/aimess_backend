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

/** Get a localized message for the given key and locale. */
export function t(
  key: MessageKey,
  locale: SupportedLocale = DEFAULT_LOCALE
): string {
  const entry = MESSAGES[key];
  if (!entry) {
    return key;
  }
  return entry[locale] ?? entry[DEFAULT_LOCALE] ?? entry.en ?? key;
}
