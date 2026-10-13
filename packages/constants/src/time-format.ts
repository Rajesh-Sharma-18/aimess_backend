import { t } from "./i18n.js";
import { currentTimeZone } from "./locale-context.js";
import type { SupportedLocale } from "./locale.js";

/** A valid IANA zone, or "UTC" for anything missing/unknown (never throws). */
export function resolveTimeZone(raw: unknown): string {
  const tz = typeof raw === "string" ? raw.trim() : "";
  if (!tz) return "UTC";
  try {
    // Validate only: resolvedOptions() would rewrite Asia/Ho_Chi_Minh to Asia/Saigon.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const n = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour") % 24, minute: n("minute") };
}

/**
 * "10:00 PM, Oct 8" / "22:00, 8/10" / "22:00 น. 8 ต.ค." in the viewer's zone;
 * the year is appended only when it differs from the viewer's current year.
 */
export function formatViewerDateTime(
  epochMs: number,
  locale: SupportedLocale,
  timeZone: string = currentTimeZone(),
  nowMs: number = Date.now()
): string {
  const tz = resolveTimeZone(timeZone);
  const p = zonedParts(epochMs, tz);
  const otherYear = p.year !== zonedParts(nowMs, tz).year;
  const mm = String(p.minute).padStart(2, "0");
  const hh = String(p.hour).padStart(2, "0");
  if (locale === "vi") {
    return `${hh}:${mm}, ${p.day}/${p.month}${otherYear ? `/${p.year}` : ""}`;
  }
  if (locale === "th") {
    return `${hh}:${mm} น. ${p.day} ${TH_MONTHS[p.month - 1]}${otherYear ? ` ${p.year}` : ""}`;
  }
  const h12 = p.hour % 12 || 12;
  return `${h12}:${mm} ${p.hour < 12 ? "AM" : "PM"}, ${EN_MONTHS[p.month - 1]} ${p.day}${otherYear ? `, ${p.year}` : ""}`;
}

/** "1h 2m" / "12m" / "<1m" (vi "1 giờ 2 phút", th "1 ชม. 2 นาที"). */
export function formatDurationShort(
  seconds: number,
  locale: SupportedLocale
): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) {
    return minutes > 0
      ? t("SYS_STREAM_DURATION_HM", locale, { hours, minutes })
      : t("SYS_STREAM_DURATION_H", locale, { hours });
  }
  if (minutes > 0) return t("SYS_STREAM_DURATION_M", locale, { minutes });
  return t("SYS_DURATION_UNDER_MINUTE", locale);
}
