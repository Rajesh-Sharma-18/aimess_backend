/**
 * Shared mappers for turning gRPC admin read-model rows into HTTP view models.
 * The downstream protos send epoch-ms (as strings under `longs:String`) and use
 * empty strings for "absent" optional fields, so the two normalisers below are
 * reused across every gRPC-backed repository (community, group, …).
 */

/** epoch-ms-as-string (longs:String) → ISO 8601. */
export function msToIso(ms: string | number): string {
  return new Date(Number(ms)).toISOString();
}

/** "" → null normaliser for optional string fields the proto sends as "". */
export function orNull(s: string | undefined): string | null {
  return s ? s : null;
}

/**
 * Combine first/last name into one display string: trims each part, joins
 * with a single space, and drops any part that is absent/blank (proto sends
 * "" for unset optional fields). Returns null when neither part is usable.
 */
export function buildFullName(
  firstName: string | undefined,
  lastName: string | undefined
): string | null {
  const parts = [firstName, lastName]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" ") : null;
}
