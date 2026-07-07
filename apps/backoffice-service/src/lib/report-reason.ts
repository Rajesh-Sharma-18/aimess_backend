/**
 * Canonicalizes a report `reason` value so aggregation groups logically-equal
 * reasons together regardless of source-service format: chat-service/stream-
 * service publish UPPER_SNAKE enum values (e.g. "INAPPROPRIATE_CONTENT"),
 * while community-service accepts free-text reason strings (e.g. "Spam
 * Messages", "inappropriate content"). Without this, `groupBy(["reason"])`
 * treats every distinct casing/format as its own category.
 *
 * `OTHER` is always canonicalized to the literal key/label "OTHER" so
 * existing `reason !== "OTHER"` checks keep working unchanged.
 */

/** slug(raw) → canonical { key, label }. Extend when a new predefined reason ships. */
const CANONICAL_REASONS: Array<{
  key: string;
  label: string;
  aliases: string[];
}> = [
  // "SPAM" (chat/stream enum) and "Spam Messages" (community-service free
  // text) are the SAME logical category — this pairing can only be captured
  // via an explicit alias, not generic slugification.
  {
    key: "SPAM_MESSAGES",
    label: "Spam Messages",
    aliases: ["SPAM", "SPAM_MESSAGES"],
  },
  { key: "HARASSMENT", label: "Harassment", aliases: ["HARASSMENT"] },
  { key: "HATE_SPEECH", label: "Hate Speech", aliases: ["HATE_SPEECH"] },
  { key: "NUDITY", label: "Nudity", aliases: ["NUDITY"] },
  { key: "VIOLENCE", label: "Violence", aliases: ["VIOLENCE"] },
  {
    key: "SCAM_OR_FRAUD",
    label: "Scam or Fraud",
    aliases: ["SCAM", "SCAM_OR_FRAUD"],
  },
  { key: "IMPERSONATION", label: "Impersonation", aliases: ["IMPERSONATION"] },
  {
    key: "MISINFORMATION",
    label: "Misinformation",
    aliases: ["MISINFORMATION"],
  },
  {
    key: "ILLEGAL_CONTENT",
    label: "Illegal Content",
    aliases: ["ILLEGAL_CONTENT"],
  },
  {
    key: "INAPPROPRIATE_CONTENT",
    label: "Inappropriate Content",
    aliases: ["INAPPROPRIATE_CONTENT"],
  },
  {
    key: "OFFENSIVE_LANGUAGE",
    label: "Offensive Language",
    aliases: ["OFFENSIVE_LANGUAGE"],
  },
];

/** "  Inappropriate   Content " → "INAPPROPRIATE_CONTENT" (trim, collapse whitespace, upper, space→underscore). */
function slug(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase().replace(/ /g, "_");
}

/** slug alias → canonical entry, built once from {@link CANONICAL_REASONS}. */
const ALIAS_TO_CANONICAL = new Map<string, { key: string; label: string }>(
  CANONICAL_REASONS.flatMap((entry) =>
    entry.aliases.map((alias) => [
      slug(alias),
      { key: entry.key, label: entry.label },
    ])
  )
);

/** Title-cases a slug fallback, e.g. "BANNED_WORD_USAGE" → "Banned Word Usage". */
function titleCaseFromSlug(s: string): string {
  return s
    .split("_")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Normalize a raw `reason` value into a canonical `{ key, label }`.
 * - Known predefined reasons (enum or display form, any case/whitespace)
 *   resolve to one shared canonical key + a single display label.
 * - "OTHER" (any case) always canonicalizes to key/label "OTHER".
 * - Unrecognized reasons fall back to a Title-Cased version of themselves
 *   (still keyed on their normalized slug, so future case/format variants of
 *   the SAME unrecognized reason still merge together).
 */
export function normalizeReportReason(raw: string): {
  key: string;
  label: string;
} {
  const s = slug(raw);
  if (s === "OTHER") return { key: "OTHER", label: "OTHER" };
  const known = ALIAS_TO_CANONICAL.get(s);
  if (known) return known;
  return { key: s, label: titleCaseFromSlug(s) };
}
