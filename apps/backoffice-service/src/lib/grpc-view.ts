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
