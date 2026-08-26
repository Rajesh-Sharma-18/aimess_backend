import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";
import {
  effectiveGroupMemberLimit,
  isInviteLinkExpired,
} from "@aimess/constants";

/**
 * The ONE answer to "what should the invite button say?", derived server-side
 * and consumed by every surface that renders one:
 *
 *  • the in-chat invitation card  (`private-message.service#enrichMessages`)
 *  • the invite landing screen    (`GroupInviteLinkService.preview`)
 *  • the join endpoint            (`GroupInviteLinkService.join`, via
 *                                  {@link assertJoinableState})
 *
 * The client never decides any of it — it maps a state to a string. Adding a
 * surface means calling this, not re-deriving the rules.
 */
export type GroupInviteState =
  /** Viewer is an ACTIVE member — "View Group". Wins over every other state:
   *  their access does not depend on the link, on free capacity, or on anything
   *  else the invite says (a member of a FULL group still opens their group). */
  | "ALREADY_MEMBER"
  /** The group itself is gone/disbanded — nothing to join or open. */
  | "GROUP_DELETED"
  /** Link revoked, time-expired, or out of uses — one dead-link state, because
   *  the product shows one sentence for all three ("Invitation link expired"). */
  | "LINK_EXPIRED"
  /** Roster is at the cap (see MAX_GROUP_MEMBERS) — "Group full". */
  | "GROUP_FULL"
  /** Removed or banned by staff — refused even with a live link and free room. */
  | "JOIN_BLOCKED"
  /** Nothing in the way — "Join Group". */
  | "CAN_JOIN";

/** Member-row statuses that must NOT be able to come back through a link.
 *  `LEFT` is deliberately absent: a voluntary leaver may rejoin. */
const BLOCKED_MEMBER_STATUSES = new Set(["KICKED", "BANNED"]);

export interface GroupInviteStateInput {
  /** ACTIVE room row, or null when the group is gone/disbanded. */
  room: { memberCount: number; memberLimit?: number | null } | null;
  /** The link row for the token, ANY status — null when the token is unknown. */
  link: {
    status?: string | null;
    expiresAt?: Date | string | null;
    maxUses?: number | null;
    usedCount?: number | null;
  } | null;
  /** The viewer's member row of ANY status, or null when they never joined. */
  membership: { status?: string | null } | null;
  /** False for a card/preview with no token at all (legacy rows) — such a card
   *  can still say "View Group", but it can never say "Join". */
  hasToken: boolean;
}

export function resolveGroupInviteState(
  input: GroupInviteStateInput
): GroupInviteState {
  const { room, link, membership, hasToken } = input;

  if (membership?.status === "ACTIVE" && room) return "ALREADY_MEMBER";

  // Link death outranks a missing group (SPEC priority 1): a dead token is dead
  // whatever it points at, and "Invitation link expired" is the sentence the
  // product shows for it.
  const linkDead =
    !hasToken ||
    !link ||
    // Absent `status` reads as ACTIVE: the column is non-nullable with an
    // ACTIVE default, so the only rows missing it predate it — and those were
    // live links. A dead link always carries an explicit REVOKED/…
    (link.status ?? "ACTIVE") !== "ACTIVE" ||
    isInviteLinkExpired(link.expiresAt) ||
    (!!link.maxUses && (link.usedCount ?? 0) >= link.maxUses);
  if (linkDead) return "LINK_EXPIRED";
  if (!room) return "GROUP_DELETED";

  if (room.memberCount >= effectiveGroupMemberLimit(room.memberLimit)) {
    return "GROUP_FULL";
  }
  if (membership && BLOCKED_MEMBER_STATUSES.has(membership.status ?? "")) {
    return "JOIN_BLOCKED";
  }
  return "CAN_JOIN";
}

/**
 * Turn a non-joinable state into the error the API answers with. One mapping,
 * so the REST code the client branches on can never drift from the state the
 * same request's card/preview reported.
 */
export function assertJoinableState(state: GroupInviteState): void {
  switch (state) {
    case "CAN_JOIN":
      return;
    case "ALREADY_MEMBER":
      throw new ConflictError("CHAT_ALREADY_MEMBER");
    case "GROUP_DELETED":
      throw new NotFoundError("CHAT_GROUP_NO_LONGER_EXISTS");
    case "LINK_EXPIRED":
      throw new BadRequestError("CHAT_INVITE_LINK_EXPIRED");
    case "GROUP_FULL":
      throw new BadRequestError("CHAT_GROUP_MEMBER_LIMIT_REACHED");
    case "JOIN_BLOCKED":
      throw new ForbiddenError("CHAT_JOIN_BLOCKED");
  }
}
