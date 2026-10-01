import { buildPrivateSystemFallbackText } from "@aimess/constants";

function parseCutoff(value: unknown): Date | undefined {
  return typeof value === "string" ? new Date(value) : undefined;
}

function latest(...dates: Array<Date | undefined>): Date | undefined {
  return dates
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => b.getTime() - a.getTime())[0];
}

/**
 * "This row's activity happened at/before the viewer's clear/delete cutoff, so
 * it is invisible to them." Inclusive (`<=`) — the cutoff is stamped at clear
 * time, and anything sharing that millisecond was already there.
 */
export function isHiddenByCutoff(
  at: Date | string | null | undefined,
  cutoff: Date | undefined
): boolean {
  return Boolean(cutoff && at && new Date(at) <= cutoff);
}

export function getPrivateDeletionCutoff(
  room: { deletedFor?: unknown; clearFor?: unknown } | null | undefined,
  userId: string
): Date | undefined {
  const deletedAt = parseCutoff(
    (room?.deletedFor as Record<string, unknown> | undefined)?.[userId]
  );
  const clearAt = parseCutoff(
    (room?.clearFor as Record<string, unknown> | undefined)?.[userId]
  );
  return latest(deletedAt, clearAt);
}

export function getGroupVisibilityCutoff(
  member:
    | {
        clearedAt?: Date | null;
        clearChatAt?: Date | null;
        joinedAt?: Date | null;
      }
    | null
    | undefined
): Date | undefined {
  return latest(
    member?.clearedAt ?? undefined,
    member?.clearChatAt ?? undefined,
    member?.joinedAt ?? undefined
  );
}

/**
 * The self-only "You cleared/deleted the conversation" lines. They mark a
 * boundary, they are not history: a chat holding nothing else has nothing to
 * clear, and clearing it again must not stack another line on top.
 */
export const HISTORY_LINE_EVENTS = [
  "CONVERSATION_CLEARED",
  "CONVERSATION_DELETED",
] as const;
export type HistoryLineEvent = (typeof HISTORY_LINE_EVENTS)[number];

/**
 * Which history line the viewer's private cutoff came from — CLEARED when Clear
 * Chat set it, null for Delete Conversation (that row leaves the list instead).
 */
export function privateHistoryLineEvent(
  room: { deletedFor?: unknown; clearFor?: unknown } | null | undefined,
  userId: string
): HistoryLineEvent | null {
  const clearAt = parseCutoff(
    (room?.clearFor as Record<string, unknown> | undefined)?.[userId]
  );
  const cutoff = getPrivateDeletionCutoff(room, userId);
  return clearAt && cutoff && clearAt.getTime() === cutoff.getTime()
    ? "CONVERSATION_CLEARED"
    : null;
}

/**
 * Same question for a group member: CLEARED / DELETED when Clear Chat / Delete
 * Conversation set the effective cutoff, null when it is just the join date.
 */
export function groupHistoryLineEvent(
  member:
    | {
        clearedAt?: Date | null;
        clearChatAt?: Date | null;
        joinedAt?: Date | null;
      }
    | null
    | undefined
): HistoryLineEvent | null {
  const cutoff = getGroupVisibilityCutoff(member)?.getTime();
  if (cutoff === undefined) return null;
  if (member?.clearChatAt?.getTime() === cutoff) return "CONVERSATION_CLEARED";
  if (member?.clearedAt?.getTime() === cutoff) return "CONVERSATION_DELETED";
  return null;
}

/**
 * The list-row snapshot of the viewer's own history line, for a row whose every
 * real message sits behind that line. Fields cover both stored shapes (private
 * `content.text`, group top-level `text`); the reader-language rebuild keys off
 * `systemEvent`.
 *
 * `createdAt` is deliberately where the row SORTED before the clear, not the
 * line's own time: Clear Chat repaints the row, it is not activity, so the row
 * keeps its place until a real message moves it.
 */
export function historyLineSnapshot(
  event: HistoryLineEvent,
  userId: string,
  sortAt: Date | string
) {
  const text = buildPrivateSystemFallbackText(event, {});
  return {
    messageId: "",
    messageType: "SYSTEM",
    systemEvent: event,
    systemData: { actorId: userId },
    senderId: userId,
    senderName: "",
    text,
    content: { text, urls: [], files: [] },
    createdAt: sortAt,
  };
}

/**
 * A timestamp strictly after `cutoff` — every cutoff filter hides
 * `createdAt <= cutoff`, so a line written "right after" a clear on the same
 * millisecond would be hidden by the very clear it announces.
 */
export function afterCutoff(cutoff: Date): Date {
  return new Date(Math.max(Date.now(), cutoff.getTime() + 1));
}
