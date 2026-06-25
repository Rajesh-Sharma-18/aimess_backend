import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

/** Minimal PUBLIC community metadata used to render the OG/preview card. */
export interface PublicCommunityCard {
  communityId: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
}

/**
 * Server-to-server lookup of a PUBLIC community card for the unauthenticated
 * web preview (the public by-handle resolver requires a Bearer token, but the
 * preview page renders with no user). Returns null for any non-public /
 * not-found / misconfigured case — the caller then renders the generic card.
 * Never throws: a preview must always render.
 */
export async function fetchPublicCommunityCard(
  handle: string
): Promise<PublicCommunityCard | null> {
  if (!env.COMMUNITY_INTERNAL_URL || !env.INTERNAL_SHARED_SECRET) {
    return null;
  }
  const base = env.COMMUNITY_INTERNAL_URL.replace(/\/+$/, "");
  const url = `${base}/internal/communities/by-handle/${encodeURIComponent(
    handle
  )}/card`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(url, {
      headers: { "x-internal-secret": env.INTERNAL_SHARED_SECRET },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const body = (await res.json()) as { data?: PublicCommunityCard };
    return body?.data ?? null;
  } catch (err) {
    logger.warn(
      `[linkhost] public-card lookup failed for handle="${handle}": ${String(
        err
      )}`
    );
    return null;
  }
}
