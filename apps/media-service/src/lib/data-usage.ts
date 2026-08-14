/**
 * Data Usage — pure calculation half.
 *
 * WHAT THIS NUMBER IS: bytes this user UPLOADED, as verified by MinIO's own
 * HeadObject at /confirm time. It is not the user's total network consumption.
 *
 * WHAT IT DELIBERATELY IS NOT: downloads. Media is served by presigned GETs
 * redeemed directly against MinIO, so no service is ever in the download byte
 * path and there is no CDN or bucket-notification sink to read them from. The
 * only download-shaped signal available is "a presigned URL was minted", which
 * is decoupled from real transfer in both directions at once (one mint can back
 * many downloads or none, while a re-mint of an unchanged object forces a real
 * re-download by rotating the URL's signature). Reporting that as "downloaded"
 * would be a plausible-looking wrong number, so the response carries an
 * explicit `measured` discriminator instead of pretending.
 *
 * See docs/DATA_USAGE_PHASE1_AUDIT.md for the full architecture audit.
 */
import { contentTypeFromMime } from "@aimess/constants";

/**
 * Categories the registry can actually distinguish. Derived from the stored
 * MIME, never from the upload category (`uploadCategory` is a storage scope —
 * CHAT_ATTACHMENT, USER_AVATAR — not a content taxonomy).
 *
 * There is no VOICE bucket on purpose: voice notes are ordinary `audio/*` chat
 * attachments and nothing in the registry marks them as voice, so splitting
 * AUDIO into VOICE/AUDIO would be a guess. See `contentTypeFromMime`.
 */
export const DATA_USAGE_CATEGORIES = [
  "VIDEO",
  "IMAGE",
  "AUDIO",
  "DOCUMENT",
] as const;

export type DataUsageCategory = (typeof DATA_USAGE_CATEGORIES)[number];

export interface DataUsageCategoryRow {
  type: DataUsageCategory;
  bytes: number;
  /** Integer, and the rows always sum to exactly 100 (or to 0 when empty). */
  percentage: number;
}

export interface DataUsageSummary {
  totalBytes: number;
  categories: DataUsageCategoryRow[];
}

/**
 * Message kind → chart category. GIF and STICKER are images to a usage chart,
 * and VOICE collapses into AUDIO — `contentTypeFromMime` cannot actually
 * produce either VOICE or STICKER from a MIME, but its return type spans every
 * message kind, so the mapping is spelled out rather than cast away.
 */
const CATEGORY_BY_KIND: Record<
  ReturnType<typeof contentTypeFromMime>,
  DataUsageCategory
> = {
  VIDEO: "VIDEO",
  IMAGE: "IMAGE",
  GIF: "IMAGE",
  STICKER: "IMAGE",
  AUDIO: "AUDIO",
  VOICE: "AUDIO",
  DOCUMENT: "DOCUMENT",
};

function toCategory(mime: string): DataUsageCategory {
  return CATEGORY_BY_KIND[contentTypeFromMime(mime)];
}

/**
 * Fold per-MIME byte sums into the four display categories and attach
 * percentages that add up.
 *
 * Percentages use the largest-remainder method rather than independent
 * rounding. Rounding each share on its own is what produced the mock screen's
 * 38/31/15/3 — a chart claiming to show a whole while summing to 87.
 */
export function summarizeUsage(
  rows: Array<{ contentType: string; bytes: number }>
): DataUsageSummary {
  const byCategory = new Map<DataUsageCategory, number>();
  for (const row of rows) {
    if (row.bytes <= 0) continue;
    const category = toCategory(row.contentType);
    byCategory.set(category, (byCategory.get(category) ?? 0) + row.bytes);
  }

  const totalBytes = [...byCategory.values()].reduce((sum, b) => sum + b, 0);
  if (totalBytes <= 0) return { totalBytes: 0, categories: [] };

  // Floor every share, then hand the leftover points to whoever was truncated
  // hardest. Ties break toward the bigger category so the chart's largest slice
  // never rounds below a smaller one.
  const scored = [...byCategory.entries()]
    .map(([type, bytes]) => {
      const exact = (bytes / totalBytes) * 100;
      const floor = Math.floor(exact);
      return { type, bytes, percentage: floor, remainder: exact - floor };
    })
    .sort((a, b) => b.bytes - a.bytes);

  let leftover = 100 - scored.reduce((sum, row) => sum + row.percentage, 0);
  for (const row of [...scored].sort((a, b) => b.remainder - a.remainder)) {
    if (leftover <= 0) break;
    row.percentage += 1;
    leftover -= 1;
  }

  return {
    totalBytes,
    categories: scored.map(({ type, bytes, percentage }) => ({
      type,
      bytes,
      percentage,
    })),
  };
}

/**
 * Start of the calendar month containing `now`, in UTC.
 *
 * The window is derived, not stored: there is no usage-reset feature, so a
 * `resetAt` column would be a field nothing writes. Clients render this in
 * their own timezone; the server does not need to know it.
 */
export function currentPeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
