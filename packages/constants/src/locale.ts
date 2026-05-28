export const SUPPORTED_LOCALES = ["vi", "en"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function resolveDefaultLocale(): SupportedLocale {
  return process.env.NODE_ENV === "production" ? "vi" : "en";
}

/** Default API language: English in dev/test, Vietnamese in production. */
export const DEFAULT_LOCALE: SupportedLocale = resolveDefaultLocale();
