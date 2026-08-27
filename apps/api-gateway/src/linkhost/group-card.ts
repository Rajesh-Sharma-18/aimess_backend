import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

/** Minimal GROUP metadata used to render the invite preview card. */
export interface GroupInviteCard {
  groupId: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  memberCount: number;
}

interface GroupPreviewResponse {
  data?: {
    groupId?: string;
    groupName?: string;
    groupAvatar?: string;
    description?: string;
    memberCount?: number;
    /** chat-service `GroupInviteState` — see its `lib/group-invite-state.ts`. */
    state?: string;
  };
}

/**
 * States that must NOT produce a rich preview card. The preview endpoint now
 * answers 200 for every outcome (so an app client can render the reason in
 * place), which means `res.ok` alone no longer means "this invite is usable" —
 * without this the public link page would advertise a group behind a revoked or
 * expired token.
 */
const UNPRESENTABLE_STATES = new Set([
  "GROUP_NOT_FOUND",
  "GROUP_DISBANDED",
  "GROUP_CLOSED",
  "GROUP_NO_ADMIN",
  "LINK_NOT_FOUND",
  "LINK_REVOKED",
  "LINK_EXPIRED",
  "LINK_USED_UP",
]);

/**
 * Server-to-server lookup of a group invite card for the unauthenticated
 * preview page. chat-service already exposes
 * `GET /api/chat/invite-links/preview/:token` without auth (holding the token
 * IS the authorization), so no new downstream route is needed — this only
 * reshapes it and swallows every failure, because a preview must always render.
 *
 * Returns null for an expired / revoked / used-up / unreachable link.
 */
export async function fetchGroupInviteCard(
  token: string
): Promise<GroupInviteCard | null> {
  if (!env.CHAT_SERVICE_URL) return null;
  const base = env.CHAT_SERVICE_URL.replace(/\/+$/, "");
  const url = `${base}/api/chat/invite-links/preview/${encodeURIComponent(
    token
  )}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const body = (await res.json()) as GroupPreviewResponse;
    const preview = body?.data;
    if (!preview?.groupName) return null;
    if (preview.state && UNPRESENTABLE_STATES.has(preview.state)) return null;

    return {
      groupId: preview.groupId ?? "",
      name: preview.groupName,
      description: preview.description || null,
      avatarUrl: preview.groupAvatar || null,
      memberCount: preview.memberCount ?? 0,
    };
  } catch (err) {
    logger.warn(`[linkhost] group-card lookup failed: ${String(err)}`);
    return null;
  }
}
