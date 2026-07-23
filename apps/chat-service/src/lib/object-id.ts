const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * True if `id` is a syntactically valid MongoDB ObjectId (24 hex chars).
 * Use before passing a client-supplied id into a Prisma `@db.ObjectId` lookup
 * or write — client-optimistic ids (e.g. "tmp-<ts>-<n>") are NOT valid and
 * would otherwise throw "Malformed ObjectID" deep inside Prisma.
 */
export function isObjectId(id: string | null | undefined): boolean {
  return typeof id === "string" && OBJECT_ID_RE.test(id);
}
