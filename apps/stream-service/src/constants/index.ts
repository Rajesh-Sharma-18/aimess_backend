/** Service-scoped constants. */
export const SERVICE_SLUG = "stream-service" as const;
export const SERVICE_TITLE = "Stream Service" as const;

/**
 * Source types SRS never ingests — the broadcast is a remote page/URL that
 * every viewer's own browser embeds directly, so there is no publisher for SRS
 * to report, to stall, or to drop.
 *
 * Their ONLY liveness signal is the owner's authenticated `POST
 * /streams/:id/heartbeat`, which is exactly the signal that dies when the
 * broadcaster logs out or their session expires. Anything that reasons about
 * liveness from SRS must exclude them rather than let SRS's silence speak for
 * them.
 */
export const NON_SRS_SOURCE_TYPES = ["URL", "YOUTUBE"] as const;
