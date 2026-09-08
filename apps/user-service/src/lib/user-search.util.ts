import {
  normalizeForSearch,
  rankByHandle,
  tokenizeAndNormalize,
} from "@aimess/utils";

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

// Keyset position over people search's ORDER BY firstName ASC, userId ASC.
export type PeopleSearchCursor = { firstName: string; userId: string };

// Opaque on the wire — base64url("<firstName>\u0000<userId>"). NUL can never
// appear inside a firstName, so it is a split-safe separator.
export function encodePeopleCursor(row: PeopleSearchCursor): string {
  return Buffer.from(`${row.firstName}\u0000${row.userId}`, "utf8").toString(
    "base64url"
  );
}

// Unparseable input decodes to undefined, i.e. "no cursor" — a garbled cursor
// restarts at the head rather than 400ing a caller mid-walk.
export function decodePeopleCursor(
  raw: string | undefined
): PeopleSearchCursor | undefined {
  if (!raw) return undefined;
  const [firstName, userId] = Buffer.from(raw, "base64url")
    .toString("utf8")
    .split("\u0000");
  return userId ? { firstName: firstName ?? "", userId } : undefined;
}

/** People's handle IS their `username` — the shared ranker just needs the field. */
export function rankByUsername<T extends { username: string }>(
  rows: T[],
  q: string | undefined
): T[] {
  return rankByHandle(rows, q, (row) => row.username);
}

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
