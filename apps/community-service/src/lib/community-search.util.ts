import { tokenizeAndNormalize, tokenizeSearchQuery } from "@aimess/utils";

import type { Prisma } from "../generated/prisma/index.js";

export { tokenizeSearchQuery };

/**
 * Normalizes a string for formatting-insensitive search — Instagram/Telegram/
 * WhatsApp style: lowercases, then strips every character that isn't a
 * Unicode letter or digit (spaces, underscores, hyphens, dots, and any other
 * punctuation). So "Dr. Jhatka", "dr_jhatka", "Dr-Jhatka", and "dr jhatka" all
 * normalize to the same "drjhatka", regardless of how the stored record or
 * the searcher happens to punctuate/space/case it.
 *
 * Re-exported from `@aimess/utils` (`normalizeForSearch`) so every "search my
 * X" endpoint (communities, users, groups) normalizes identically.
 */
export { normalizeForSearch } from "@aimess/utils";

/**
 * Builds the Prisma `AND`-of-`OR` clauses backing community search by name
 * and/or handle.
 *
 * The raw query is split into whitespace-separated tokens (preserving
 * cross-field multi-word search: e.g. `q = "text text1"` matches a community
 * named "Text Community" with handle "text1" even though neither field alone
 * contains the full query — every token must match SOME field, but different
 * tokens are free to match different fields).
 *
 * Each token is matched against BOTH:
 *   1. `normalizedName` / `normalizedHandle` (formatting-insensitive —
 *      "dr_jhatka" matches "Dr. Jhatka"), and
 *   2. raw `name` / `handle` with case-insensitive `contains` (so search still
 *      works if a row hasn't been backfilled with the normalized shadows yet).
 *
 * Tokens that normalize to nothing (pure punctuation, e.g. "...") are
 * dropped — they carry no search signal.
 *
 * Returns an array of `Prisma.CommunityWhereInput` (one per token) meant to
 * be spread into the caller's `AND` list.
 */
export function buildCommunitySearchFilter(
  q: string
): Prisma.CommunityWhereInput[] {
  return tokenizeAndNormalize(q).map(({ raw, normalized }) => ({
    OR: [
      { normalizedName: { contains: normalized } },
      { normalizedHandle: { contains: normalized } },
      { name: { contains: raw, mode: "insensitive" } },
      { handle: { contains: raw, mode: "insensitive" } },
    ],
  }));
}
