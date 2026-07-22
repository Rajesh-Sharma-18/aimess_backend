import type { Prisma } from "../generated/prisma/index.js";

/**
 * Splits a free-text search query into individual terms: trims leading/
 * trailing whitespace, then splits on any run of whitespace (so repeated
 * spaces between words collapse to a single separator). Empty input (or a
 * query that's whitespace-only) yields an empty token list.
 */
export function tokenizeSearchQuery(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean);
}

/**
 * Normalizes a string for formatting-insensitive search — Instagram/Telegram/
 * WhatsApp style: lowercases, then strips every character that isn't a
 * Unicode letter or digit (spaces, underscores, hyphens, dots, and any other
 * punctuation). So "Dr. Jhatka", "dr_jhatka", "Dr-Jhatka", and "dr jhatka" all
 * normalize to the same "drjhatka", regardless of how the stored record or
 * the searcher happens to punctuate/space/case it.
 *
 * `\p{L}`/`\p{N}` (Unicode property escapes, `u` flag) are used instead of
 * `[a-z0-9]` so non-Latin names/handles normalize correctly too, rather than
 * having every non-ASCII letter stripped out.
 */
export function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

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
  return tokenizeSearchQuery(q)
    .map((raw) => ({ raw, normalized: normalizeForSearch(raw) }))
    .filter(({ normalized }) => Boolean(normalized))
    .map(({ raw, normalized }) => ({
      OR: [
        { normalizedName: { contains: normalized } },
        { normalizedHandle: { contains: normalized } },
        { name: { contains: raw, mode: "insensitive" } },
        { handle: { contains: raw, mode: "insensitive" } },
      ],
    }));
}
