import { t } from "./i18n.js";
import { currentTimeZone } from "./locale-context.js";
import type { SupportedLocale } from "./locale.js";
import { formatViewerDateTime } from "./time-format.js";

/** 403 ACCOUNT_BANNED `message`: "Your account has been permanently banned. Reason: …". */
export function accountBannedMessage(
  reason: string | null | undefined,
  locale: SupportedLocale
): string {
  const r = reason?.trim();
  return r
    ? t("ACCOUNT_BANNED_REASON", locale, { reason: r })
    : t("ACCOUNT_BANNED", locale);
}

/** 403 ACCOUNT_SUSPENDED `message`, the until-time in the viewer's zone. */
export function accountSuspendedMessage(
  untilMs: number | null | undefined,
  reason: string | null | undefined,
  locale: SupportedLocale,
  timeZone: string = currentTimeZone()
): string {
  const until = Number(untilMs);
  if (!Number.isFinite(until) || until <= 0) return t("ACCOUNT_SUSPENDED", locale);
  const params = { until: formatViewerDateTime(until, locale, timeZone) };
  const r = reason?.trim();
  return r
    ? t("ACCOUNT_SUSPENDED_UNTIL_REASON", locale, { ...params, reason: r })
    : t("ACCOUNT_SUSPENDED_UNTIL", locale, params);
}
