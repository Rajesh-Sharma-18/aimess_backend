/**
 * SINGLE SOURCE OF TRUTH for whether a message counts toward unread
 * badges/counters, across Private, Group, and Community chats.
 *
 * Policy: only genuine user-generated messages count toward unread. A
 * message is a SYSTEM message — and therefore excluded — if `messageType`
 * is `"SYSTEM"`, or if it carries a `systemEvent` (private/group) or
 * `systemMessageType` (community) marker at all, regardless of subtype.
 * There is no "important system message" exception: no system message,
 * however significant (member added, role changed, community created,
 * pinned, livestream start/end, etc.), inflates an unread count. System
 * messages remain fully visible in chat history — this flag only governs
 * unread accounting.
 *
 * ONE exception, and it is not a "significant system message": invitation
 * cards. A community/group invite is a message one PERSON deliberately sent
 * to another — it is addressed content the recipient is expected to act on,
 * not an audit line the room wrote about itself. It only rides a
 * `systemEvent` because that is how the card's link identity is carried (see
 * `deliverInviteLinkDm`). Excluding it made the delivery paths and the
 * mark-read recompute disagree: the row was `$inc`-ed on arrival but filtered
 * back out of the recompute, so the badge could only ever be cleared by
 * entering the room.
 *
 * `explicit` lets a caller override the derived value for a specific
 * persisted row (e.g. a client-provided `countInUnread` on a normal
 * message); it always wins.
 */
const COUNTABLE_SYSTEM_EVENTS = new Set(["COMMUNITY_INVITE", "GROUP_INVITE"]);

export function shouldCountInUnread(params: {
  messageType?: string | null;
  systemEvent?: string | null;
  systemMessageType?: string | null;
  explicit?: boolean | null;
}): boolean {
  if (typeof params.explicit === "boolean") return params.explicit;

  const messageType = String(params.messageType ?? "").toUpperCase();

  // Addressed content wearing a system marker — see the note above.
  if (
    COUNTABLE_SYSTEM_EVENTS.has(String(params.systemEvent ?? "").toUpperCase())
  )
    return true;

  // `systemEvent` / `systemMessageType` are authoritative on their own — a row
  // can carry a lifecycle marker while using a NON-"SYSTEM" kind (call rows are
  // stored as VOICE_CALL / VIDEO_CALL so the client can render a call card, yet
  // are still audit lines that must not raise a badge). Checking messageType
  // first and returning early would have counted every one of them.
  const isSystemMessage =
    messageType === "SYSTEM" ||
    !!params.systemEvent ||
    !!params.systemMessageType;

  return !isSystemMessage;
}

export const UNREAD_COUNTABLE_RAW_MATCH = {
  $or: [
    { countInUnread: { $ne: false } },
    { countInUnread: { $exists: false } },
  ],
} as const;

/**
 * Raw-Mongo form of {@link shouldCountInUnread}, for the two surfaces whose
 * system marker is `systemEvent` (private + group). Every recount pipeline must
 * match on THIS, not on a hand-rolled filter, because a writer and a reader that
 * disagree about countability produce a stored counter no recount can ever
 * reconcile.
 *
 * That is exactly what happened: the pipelines this replaces carried a blanket
 * `messageType != "SYSTEM"` + `systemEvent == null`, which excludes the invite
 * cards {@link shouldCountInUnread} deliberately counts. A conversation whose
 * only unread content was an invite therefore had its counter `$inc`-ed on
 * delivery and filtered straight back out of every recount — so it contributed a
 * permanent unread conversation to the nav badge that no read could clear.
 *
 * A persisted `countInUnread: false` still wins (it is the stored form of
 * `explicit`), and a MISSING `countInUnread` falls back to the derived rule, so
 * rows written before that column existed are classified here exactly as the
 * write path would classify them today.
 */
export const UNREAD_COUNTABLE_EVENT_RAW_MATCH = {
  $or: [
    // The persisted form of `explicit`, which wins outright.
    { countInUnread: true },
    // No stored verdict (a row written before the column existed) ⇒ derive it,
    // exactly as shouldCountInUnread derives it.
    {
      $and: [
        { countInUnread: { $exists: false } },
        {
          $or: [
            { systemEvent: { $in: [...COUNTABLE_SYSTEM_EVENTS] } },
            // No system marker of any kind. `systemEvent: null` matches a
            // missing field too, which is what an ordinary message has.
            {
              $and: [
                { messageType: { $ne: "SYSTEM" } },
                { systemEvent: null },
              ],
            },
          ],
        },
      ],
    },
  ],
} as const;


/**
 * Per-surface unread aggregate: the message total AND how many conversations
 * carry at least one unread. The nav badges render `conversations` (a room
 * with 500 unread contributes 1); `messages` stays for per-row/legacy totals.
 */
export interface UnreadStats {
  messages: number;
  conversations: number;
}

export const EMPTY_UNREAD_STATS: UnreadStats = { messages: 0, conversations: 0 };
