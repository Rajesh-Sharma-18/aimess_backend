import type { Redis, Cluster } from "ioredis";

/**
 * Fan-out channel for "this SESSION is now reading in this language".
 *
 * The gateway is the only place that learns a live language change (the
 * `locale:set` packet on an open socket). Push delivery happens somewhere else
 * entirely, off `DeviceToken.locale`, for a device that may be asleep with no
 * socket at all — so the two have to be connected by a message rather than by a
 * shared object.
 *
 * Without it, a device that declared its language once at registration keeps
 * receiving push tray text in that language until the client happens to
 * re-register, which is a contract no server can enforce.
 */
export const SESSION_LOCALE_CHANNEL = "session:locale";

export interface SessionLocaleChange {
  userId: string;
  /** auth-service session id — the link to `DeviceToken.sessionId`. */
  sessionId: string;
  /** Already validated against SUPPORTED_LOCALES by the publisher. */
  locale: string;
}

/** Fire-and-forget: a language change must never fail the packet that made it. */
export async function publishSessionLocale(
  redis: Redis | Cluster,
  change: SessionLocaleChange
): Promise<void> {
  await redis.publish(SESSION_LOCALE_CHANNEL, JSON.stringify(change));
}
