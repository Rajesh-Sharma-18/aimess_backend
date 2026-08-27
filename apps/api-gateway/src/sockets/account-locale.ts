import type { SupportedLocale } from "@aimess/constants";

/**
 * The account's saved app language, for a socket handshake that declared none.
 *
 * A one-value registry rather than a parameter because the only consumer is
 * `createGatewaySocketAuthMiddleware`, which five namespaces construct — three
 * of them (`/notify`, `/stream`, `/auth`) hold no user client to thread through
 * and have no other reason to. Registered once in `setupSockets`, before any
 * namespace is registered, so no handshake can observe the unset state in
 * production.
 *
 * Unset is the correct default everywhere else: every socket unit suite builds
 * its own handshake, and a resolver that answers `null` leaves the existing
 * `x-lang` → `Accept-Language` → `DEFAULT_LOCALE` chain exactly as it was.
 */
type AccountLocaleResolver = (
  userId: string
) => Promise<SupportedLocale | null>;

let resolver: AccountLocaleResolver | null = null;

export function setAccountLocaleResolver(
  fn: AccountLocaleResolver | null
): void {
  resolver = fn;
}

/** Never throws and never blocks a handshake: an unreachable user-service just
 *  means this rung has no answer and the chain falls through. */
export async function resolveAccountLocale(
  userId: string
): Promise<SupportedLocale | null> {
  if (!resolver || !userId) return null;
  try {
    return await resolver(userId);
  } catch {
    return null;
  }
}
