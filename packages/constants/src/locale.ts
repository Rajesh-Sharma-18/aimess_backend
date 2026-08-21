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

/**
 * A client-declared language, or null if this build does not carry it.
 *
 * Accepts `"th"`, `"th-TH"`, `"TH_th"`, and the `{ lang }` / `{ locale }`
 * wrappers different clients send — a language tag legitimately arrives with a
 * region subtag.
 *
 * Unknown values return **null rather than {@link DEFAULT_LOCALE}**, and that
 * distinction is the whole point of this helper existing next to
 * {@link resolveLocale}. Normalizing an unrecognized tag onto the default means
 * answering in Vietnamese (the production default) a client that asked for a
 * language this build simply lacks. Returning null lets every caller keep the
 * value it already had, which is always the safer answer.
 *
 * Locale is presentation context only — never consulted for authorization — so
 * an untrusted value here can at worst render the wrong language back to its
 * own sender.
 */
export function parseSupportedLocale(raw: unknown): SupportedLocale | null {
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw === "object" && raw !== null
        ? ((raw as { lang?: unknown }).lang ??
          (raw as { locale?: unknown }).locale)
        : undefined;
  if (typeof value !== "string") return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return isSupportedLocale(base) ? base : null;
}
