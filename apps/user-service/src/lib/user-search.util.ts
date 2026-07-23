import { normalizeForSearch, tokenizeAndNormalize } from "@aimess/utils";

import type { Prisma } from "../generated/prisma/client.js";

export { normalizeForSearch, tokenizeSearchQuery } from "@aimess/utils";

/**
 * Space-insensitive full-name shadow: normalizeForSearch(firstName) +
 * normalizeForSearch(lastName), e.g. "Vasu" + "Rajesh" → "vasurajesh". Lets a
 * no-space query ("vasurajesh"/"VasuRajesh") match a two-word display name
 * even though it arrives as a single token.
 */
export function buildNormalizedFullName(
  firstName: string,
  lastName: string
): string {
  return normalizeForSearch(firstName) + normalizeForSearch(lastName);
}

/**
 * Builds the Prisma `AND`-of-`OR` clauses backing unified user search by
 * username/first name/last name — same shape as community search's
 * `buildCommunitySearchFilter`: every whitespace token must match SOME
 * field (normalized shadow or raw, case-insensitive `contains`), tokens are
 * free to match independently so word order doesn't matter — "doe john"
 * matches the same users as "john doe", replacing the old query-length-2
 * cross-field hack with the same N-token AND-of-OR approach used by
 * communities and groups.
 *
 * `normalizedFullName` additionally covers the single-token, no-space case
 * ("vasurajesh") that per-field `contains` alone can't — the token doesn't
 * fully appear in either `firstName` or `lastName` alone, only in their
 * concatenation.
 */
export function buildUserSearchFilter(
  q: string
): Prisma.UserProfileWhereInput[] {
  return tokenizeAndNormalize(q).map(({ raw, normalized }) => ({
    OR: [
      { normalizedUsername: { contains: normalized } },
      { normalizedFirstName: { contains: normalized } },
      { normalizedLastName: { contains: normalized } },
      { normalizedFullName: { contains: normalized } },
      { username: { contains: raw, mode: "insensitive" } },
      { firstName: { contains: raw, mode: "insensitive" } },
      { lastName: { contains: raw, mode: "insensitive" } },
    ],
  }));
}
