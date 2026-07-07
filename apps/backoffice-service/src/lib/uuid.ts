/**
 * RFC 4122 UUID matcher (any version). Postgres `uuid` columns (e.g.
 * `Report.id`, `assignedTo`) reject non-UUID input with
 * `22P02 invalid input syntax for type uuid`, so callers must gate any
 * equality query on such a column behind this check when the value is
 * free-text (e.g. a search term).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}
