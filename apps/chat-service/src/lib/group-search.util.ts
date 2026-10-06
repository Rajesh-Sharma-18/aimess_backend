import { tokenizeAndNormalize } from "@aimess/utils";

import type { Prisma } from "../generated/prisma/index.js";

export { normalizeForSearch, tokenizeSearchQuery } from "@aimess/utils";

/** Only "@"s (and spaces): a handle search that has not named anyone yet. */
const BARE_HANDLE_PREFIX = /^[\s@]*@[\s@]*$/;

/**
 * Builds the Prisma `AND`-of-`OR` clauses backing group search by name —
 * same shape as community search's `buildCommunitySearchFilter`: every
 * whitespace token must match SOME field (normalized shadow or raw,
 * case-insensitive `contains`), tokens are free to match independently so
 * word order doesn't matter ("doe john" matches the same rooms as "john
 * doe"). Groups have no handle field, so `name`/`normalizedName` is the
 * only searchable field.
 */
export function buildGroupSearchFilter(
  q: string
): Prisma.GroupRoomWhereInput[] {
  // A bare "@" starts a handle search: list the caller's groups unfiltered.
  if (BARE_HANDLE_PREFIX.test(q)) return [];
  const tokens = tokenizeAndNormalize(q);
  // Any other query with no searchable characters ("_", an emoji) → match
  // nothing, never `AND: []` (every group the caller is in).
  if (!tokens.length) return q.trim() ? [{ roomId: { in: [] } }] : [];
  return tokens.map(({ raw, normalized }) => ({
    OR: [
      { normalizedName: { contains: normalized } },
      { name: { contains: raw, mode: "insensitive" } },
    ],
  }));
}
