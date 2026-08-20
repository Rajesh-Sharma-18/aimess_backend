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
 * Lookup of a PUBLIC community card for the unauthenticated preview (the normal
 * by-handle resolver requires a Bearer token, but the preview page renders with
 * no user). Hits community-service's unauthenticated card route, which serves
 * PUBLIC communities only and 404s everything else.
 *
 * This used to go through a shared-secret `/internal` route, which disabled
 * itself whenever `INTERNAL_SHARED_SECRET` was unset — i.e. in every
 * environment that had not set two extra variables — so the preview silently
 * fell back to the generic card. `COMMUNITY_SERVICE_URL` is already required
 * for the community proxy, so there is nothing extra to configure.
 *
 * Returns null for any non-public / not-found / unreachable case — the caller
 * then renders the generic card. Never throws: a preview must always render.
 */
export async function fetchPublicCommunityCard(
  handle: string
): Promise<PublicCommunityCard | null> {
  if (!env.COMMUNITY_SERVICE_URL) return null;
  const base = env.COMMUNITY_SERVICE_URL.replace(/\/+$/, "");
  const url = `${base}/api/v1/communities/by-handle/${encodeURIComponent(
    handle
  )}/card`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(url, { signal: controller.signal });
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
