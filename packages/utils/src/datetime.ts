/**
 * Canonical client-facing datetime conversion: everything sent to a client is
 * Unix epoch MILLISECONDS (number). Single source of truth — used by the REST
 * response serializer (ApiResponse) and ad-hoc socket/emit sites.
 *   Date → getTime(); number → passthrough; ISO/parseable → Date.parse();
 *   unparseable/null/undefined → null.
 * NOTE: inter-service RabbitMQ events (packages/shared-types/src/events) stay ISO.
 */
export function toEpochMs(
  v: Date | string | number | null | undefined
): number | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
