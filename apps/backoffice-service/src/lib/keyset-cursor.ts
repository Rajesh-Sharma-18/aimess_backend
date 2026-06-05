/**
 * Generic keyset-cursor primitives shared by the list repositories
 * (user-directory.repository.ts and report.repository.ts).
 *
 * A cursor is an opaque, base64url-encoded JSON object whose keys are the
 * compound sort key for the cursorable order (e.g. {joinedAt, userId} or
 * {createdAt, reportId}). Each repository owns its own cursor key shape; this
 * module just provides the codec + a small sort-string parser so the encode/
 * decode/parse logic is not copy-pasted. Behavior is byte-compatible with the
 * previous per-repo copies.
 */

/** A cursor is a flat record of string fields (the compound sort key). */
export type CursorShape = Record<string, string>;

/** Encode a cursor object to an opaque base64url token. */
export function encodeCursor<C extends CursorShape>(c: C): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/**
 * Decode an opaque token back to a cursor of shape `C`. Returns null on any
 * malformed input or if a required key is missing / non-string — callers treat
 * null as "no cursor" and fall back to offset paging.
 *
 * @param raw           the base64url token from the client
 * @param requiredKeys  the keys that must be present as strings to be valid
 */
export function decodeCursor<C extends CursorShape>(
  raw: string,
  requiredKeys: readonly (keyof C)[]
): C | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    for (const key of requiredKeys) {
      if (typeof parsed[key as string] !== "string") return null;
    }
    return parsed as C;
  } catch {
    return null;
  }
}

/**
 * Parse a `<field>:<asc|desc>` sort string into a typed field + direction.
 * Direction defaults to "desc" for any value other than "asc" (matching the
 * previous repo-local parsers). Map to `1|-1` at the call site if needed.
 */
export function parseSort<F extends string>(
  sort: string
): { field: F; dir: "asc" | "desc" } {
  const [field, dir] = sort.split(":") as [F, "asc" | "desc"];
  return { field, dir: dir === "asc" ? "asc" : "desc" };
}
