export const SUPPORTED_LOCALES = ["vi", "en", "th"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function resolveDefaultLocale(): SupportedLocale {
  return process.env.NODE_ENV === "production" ? "vi" : "en";
}

/** Default API language: English in dev/test, Vietnamese in production. */
export const DEFAULT_LOCALE: SupportedLocale = resolveDefaultLocale();

/**
 * Locale a SYSTEM message's text is BAKED IN as at write time (chat/community
 * system rows persist a rendered sentence). It is only ever a fallback — read
 * paths re-render the row in the viewer's locale from the persisted
 * `systemEvent` + `systemData` — so it stays English regardless of
 * {@link DEFAULT_LOCALE}, which keeps historical rows stable and comparable.
 */
export const STORED_TEXT_LOCALE: SupportedLocale = "en";

/** Type guard for a user-supplied language string (`"th"` → true, `"tl"` → false). */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}
