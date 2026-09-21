/**
 * Wire shaping for the read-only Backoffice conversation viewer.
 *
 * The admin transcript reuses the canonical enriched message rows, but it is a
 * MONITORING surface, not a participant one: it needs to show that a message
 * has reactions, and which @mention spans to highlight, and nothing more. These
 * helpers strip everything past that.
 */

/** One emoji chip under a message: what it is and how many chose it. */
export interface AdminReactionCount {
  emoji: string;
  count: number;
}

/**
 * The reaction SUMMARY for the admin transcript — emoji + count only.
 *
 * The enriched row carries the full reactor list inline (`users[]` per emoji),
 * which is fine for a member's own chat and wrong here twice over: it ships
 * every reactor's identity and avatar URL into a monitoring payload nobody has
 * asked to see, and on a heavily-reacted message it is unbounded. The admin
 * panel reads the reactor list through the cursor-paginated reaction-details
 * endpoint instead, so this only has to carry what the chips render.
 */
export function adminReactionCounts(raw: unknown): AdminReactionCount[] {
  // Group rows carry `reactionGroups[]`; community rows can still hand over the
  // stored `{ emoji: reactor[] }` map when the canonical array is absent.
  if (!Array.isArray(raw)) {
    if (!raw || typeof raw !== "object") return [];
    return Object.entries(raw as Record<string, unknown>)
      .filter(([emoji, list]) => emoji && Array.isArray(list) && list.length > 0)
      .map(([emoji, list]) => ({
        emoji,
        count: (list as unknown[]).length,
      }));
  }
  const counts: AdminReactionCount[] = [];
  for (const entry of raw) {
    const group = (entry ?? {}) as Record<string, unknown>;
    const emoji = typeof group.emoji === "string" ? group.emoji : "";
    if (!emoji) continue;
    // `count` is authoritative when present; fall back to the inline list's
    // length for rows serialized before it was added.
    const count =
      typeof group.count === "number"
        ? group.count
        : Array.isArray(group.users)
          ? group.users.length
          : 0;
    if (count > 0) counts.push({ emoji, count });
  }
  return counts;
}

/**
 * The `@username` / `@all` entities stored on a message's content, as the
 * SERVER resolved them at send time. Render-only: the admin viewer highlights
 * these spans, never creates them, and opening the transcript must not make the
 * admin a mention recipient.
 */
export function adminMentions(content: unknown): unknown[] {
  const mentions = (content as { mentions?: unknown } | null | undefined)
    ?.mentions;
  return Array.isArray(mentions) ? mentions : [];
}
