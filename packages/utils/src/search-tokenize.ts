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
 * Normalizes a string for formatting-insensitive search: lowercases, folds
 * diacritics, then strips every character that isn't a Unicode letter or digit
 * (spaces, underscores, hyphens, dots, punctuation). So "Dr. Jhatka",
 * "dr_jhatka", "Dr-Jhatka", and "dr jhatka" all normalize to "drjhatka".
 *
 * Diacritic folding is what makes the multi-locale product searchable. NFD
 * splits a precomposed letter into base + combining marks, which the class
 * below then drops, so a Vietnamese name is findable the way it is actually
 * typed: "nguyen" matches "Nguyễn". Vietnamese `đ` is the one letter NFD does
 * not decompose — it is a distinct letter, not d-with-a-stroke — so it is
 * mapped by hand.
 *
 * Thai is unaffected by the change: its vowel and tone marks were already
 * dropped (they are marks, not letters), and both the stored shadow and the
 * query run through this same function, so "กิน" matches itself mark-insensitively.
 * Han and Hangul survive NFD unchanged.
 */
export function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[đ]/g, "d")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    // Back to composed form: NFD splits Hangul syllables into conjoining jamo,
    // which are letters and so survive the class above. Without this the shadow
    // would hold jamo while an NFC-composed query holds syllables.
    .normalize("NFC");
}

/** Non-empty (raw, normalized) pairs for a query — punctuation-only tokens are dropped. */
export function tokenizeAndNormalize(
  q: string
): { raw: string; normalized: string }[] {
  return tokenizeSearchQuery(q)
    .map((raw) => ({ raw, normalized: normalizeForSearch(raw) }))
    .filter(({ normalized }) => Boolean(normalized));
}
