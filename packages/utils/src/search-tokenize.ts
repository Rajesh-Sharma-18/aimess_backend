/**
 * Shared free-text search tokenization, used by every "search my X"
 * endpoint (communities, users, groups) so they all match the same way:
 * whitespace-split tokens, each token required (AND) but free to match
 * ANY searchable field (OR) — order-independent, so "john doe" and
 * "doe john" match the same records.
 */

/**
 * Splits a free-text search query into individual terms: trims leading/
 * trailing whitespace, then splits on any run of whitespace. Empty input
 * (or whitespace-only) yields an empty token list.
 */
export function tokenizeSearchQuery(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean);
}

/**
 * Normalizes a string for formatting-insensitive search: lowercases, then
 * strips every character that isn't a Unicode letter or digit (spaces,
 * underscores, hyphens, dots, punctuation). So "Dr. Jhatka", "dr_jhatka",
 * "Dr-Jhatka", and "dr jhatka" all normalize to "drjhatka".
 */
export function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Non-empty (raw, normalized) pairs for a query — punctuation-only tokens are dropped. */
export function tokenizeAndNormalize(
  q: string
): { raw: string; normalized: string }[] {
  return tokenizeSearchQuery(q)
    .map((raw) => ({ raw, normalized: normalizeForSearch(raw) }))
    .filter(({ normalized }) => Boolean(normalized));
}
