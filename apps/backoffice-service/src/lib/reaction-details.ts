import type { AdminReactionsPageRes } from "../grpc/chat.client.js";

/**
 * One page of the read-only Reaction Details popup, shared by the group and
 * community viewers.
 *
 * Deliberately NOT a second reaction model: the page, the per-emoji counts and
 * the total all come from chat-service's canonical reaction aggregation — the
 * same numbers the user-facing popup shows — and this only reshapes the gRPC
 * response (int64 counts arrive as strings) for the admin API's JSON.
 *
 * There is no `selfEmoji`: the Super Admin is not a participant, so the popup
 * has no "You" row and no remove affordance to offer.
 */
export interface ReactionDetailsPageResult {
  users: Array<{
    userId: string;
    displayName: string;
    /** Presigned download URL, never a raw object key. "" when none. */
    avatar: string;
    emoji: string;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
  /** Counts over EVERY reaction on the message, not just the loaded page. */
  counts: Array<{ emoji: string; count: number }>;
  total: number;
}

export function toReactionDetailsPage(
  res: AdminReactionsPageRes
): ReactionDetailsPageResult {
  return {
    users: (res.users ?? []).map((u) => ({
      userId: u.userId,
      displayName: u.displayName || "Unknown",
      avatar: u.avatar || "",
      emoji: u.emoji,
    })),
    nextCursor: res.nextCursor || null,
    hasMore: Boolean(res.hasMore),
    counts: (res.counts ?? []).map((c) => ({
      emoji: c.emoji,
      count: Number(c.count) || 0,
    })),
    total: Number(res.total) || 0,
  };
}
