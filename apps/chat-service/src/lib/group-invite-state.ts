import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";
import { effectiveGroupMemberLimit } from "@aimess/constants";

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
 *
 * Every failure is its OWN state. They used to collapse into one "link expired"
 * answer, which made a deleted group, a full group and a revoked token
 * indistinguishable to the client — so the only thing it could do with any of
 * them was send the user to the expired-link screen. Nothing here is lossy any
 * more: `assertJoinableState` maps each state to its own error code, and the
 * preview returns the state on a 200 so a client can render it in place.
 */
export type GroupInviteState =
  /** Viewer is an ACTIVE member — "View Group". Wins over every other state:
   *  their access does not depend on the link, on free capacity, or on anything
   *  else the invite says (a member of a FULL group still opens their group). */
  | "ALREADY_MEMBER"
  /** No group row at all — the invite points at nothing. */
  | "GROUP_NOT_FOUND"
  /** The group was disbanded: gone for everyone, takes no new members. */
  | "GROUP_DISBANDED"
  /** The group is frozen because its owner was permanently banned. Still
   *  readable for existing members, but closed to new ones. */
  | "GROUP_CLOSED"
  /** The group has no ACTIVE ADMIN left — nobody owns it, so nobody can admit,
   *  moderate or re-open it. Joining would drop the user into an unmanaged room. */
  | "GROUP_NO_ADMIN"
  /** Token unknown, or a card that carries no token at all. */
  | "LINK_NOT_FOUND"
  /** An admin revoked this link. Distinct from LINK_EXPIRED so the client can
   *  tell a deliberate kill from a lapsed clock even though today both render
   *  the same sentence. */
  | "LINK_REVOKED"
  /**
   * LEGACY. Invitation links do not expire on their own — nothing produces this
   * state any more. Kept on the wire so clients (and the error map below) still
   * understand rows/codes emitted by older builds.
   */
  | "LINK_EXPIRED"
  /** `maxUses` exhausted. */
  | "LINK_USED_UP"
  /** Roster is at the cap (see MAX_GROUP_MEMBERS). */
  | "GROUP_FULL"
  /** Removed or banned by staff — refused even with a live link and free room. */
  | "JOIN_BLOCKED"
  /** Nothing in the way — "Join Group". */
  | "CAN_JOIN";

/** Every state that is not "go ahead" — useful to clients as one check. */
export function isJoinableState(state: GroupInviteState): boolean {
  return state === "CAN_JOIN";
}

/** True while the GROUP itself is the problem, whatever the link says. */
export function isGroupGoneState(state: GroupInviteState): boolean {
  return (
    state === "GROUP_NOT_FOUND" ||
    state === "GROUP_DISBANDED" ||
    state === "GROUP_CLOSED" ||
    state === "GROUP_NO_ADMIN"
  );
}

/** True for every way a link can be dead. */
export function isDeadLinkState(state: GroupInviteState): boolean {
  return (
    state === "LINK_NOT_FOUND" ||
    state === "LINK_REVOKED" ||
    state === "LINK_EXPIRED" ||
    state === "LINK_USED_UP"
  );
}

/** Member-row statuses that must NOT be able to come back through a link.
 *  `LEFT` is deliberately absent: a voluntary leaver may rejoin. */
const BLOCKED_MEMBER_STATUSES = new Set(["KICKED", "BANNED"]);

export interface GroupInviteStateInput {
  /**
   * The group row of ANY status, or null when there is no row at all. Read with
   * `findByRoomId`, NOT `findActiveByRoomId` — the visible-status filter cannot
   * tell "disbanded" from "never existed", and a CLOSED group came back as a
   * perfectly joinable one.
   */
  room: {
    status?: string | null;
    memberCount: number;
    memberLimit?: number | null;
  } | null;
  /** The link row for the token, ANY status — null when the token is unknown. */
  link: {
    status?: string | null;
    maxUses?: number | null;
    usedCount?: number | null;
  } | null;
  /**
   * Read the link as if it were still live — used ONLY by the in-chat
   * invitation card, which must keep showing what it showed when it was sent
   * even after an admin resets the link. Group existence, capacity, membership
   * and the rejoin block stay live; only the LINK verdict is suppressed.
   */
  treatLinkAsLive?: boolean;
  /** The viewer's member row of ANY status, or null when they never joined. */
  membership: { status?: string | null } | null;
  /** False for a card/preview with no token at all (legacy rows) — such a card
   *  can still say "View Group", but it can never say "Join". */
  hasToken: boolean;
  /**
   * How many ACTIVE ADMINs the group still has. Omit (undefined) to skip the
   * check — callers that cannot afford the extra count, and the unit table,
   * pass nothing and the group is assumed owned.
   */
  activeAdminCount?: number;
}

export function resolveGroupInviteState(
  input: GroupInviteStateInput
): GroupInviteState {
  const { room, link, membership, hasToken, activeAdminCount, treatLinkAsLive } =
    input;

  // A member's access never depended on the invite, so nothing below can
  // downgrade them: a member of a full group, or one holding a revoked link,
  // still opens their group.
  if (membership?.status === "ACTIVE" && room && room.status !== "DISBANDED") {
    return "ALREADY_MEMBER";
  }

  // An unknown token with no group to fall back on is the TOKEN's fault, not a
  // missing group: there was never a room id to look up. (A caller that passes
  // `roomId` explicitly — the in-chat card — still gets the group verdict first.)
  if (!room && hasToken && !link) return "LINK_NOT_FOUND";

  // GROUP first. A dead group is not a link problem, and reporting one as
  // "invitation link expired" is exactly what sent people to the wrong screen.
  if (!room) return "GROUP_NOT_FOUND";
  if (room.status === "DISBANDED") return "GROUP_DISBANDED";
  if (room.status === "CLOSED") return "GROUP_CLOSED";
  if (activeAdminCount !== undefined && activeAdminCount <= 0) {
    return "GROUP_NO_ADMIN";
  }

  // A card that carries no token at all can never offer a join, historical or
  // not — there is nothing to tap. That is a property of the ROW rather than of
  // the link's lifecycle, so it is checked in both modes.
  if (!hasToken) return "LINK_NOT_FOUND";

  // LINK next, one state per cause. A historical card skips the block: its
  // verdict was decided when it was sent, and the link it names may since have
  // been reset. Nothing expires on a clock any more, so REVOKED and USED_UP are
  // the only ways a live link can be dead.
  if (!treatLinkAsLive) {
    if (!link) return "LINK_NOT_FOUND";
    // Absent `status` reads as ACTIVE: the column is non-nullable with an ACTIVE
    // default, so the only rows missing it predate it — and those were live links.
    const linkStatus = link.status ?? "ACTIVE";
    if (linkStatus === "REVOKED") return "LINK_REVOKED";
    if (linkStatus !== "ACTIVE") return "LINK_NOT_FOUND";
    if (link.maxUses && (link.usedCount ?? 0) >= link.maxUses) {
      return "LINK_USED_UP";
    }
  }

  // Finally the caller's own eligibility.
  if (room.memberCount >= effectiveGroupMemberLimit(room.memberLimit)) {
    return "GROUP_FULL";
  }
  if (membership && BLOCKED_MEMBER_STATUSES.has(membership.status ?? "")) {
    return "JOIN_BLOCKED";
  }
  return "CAN_JOIN";
}

/**
 * The error a non-joinable state answers with. ONE mapping, so the REST code a
 * client branches on always matches the state the same request's card or
 * preview reported — and so no failure is reported as a different failure.
 *
 * HTTP statuses are deliberately the ones each case already answered with; only
 * the `code` got more precise. Clients (web and mobile) branch on the code, and
 * moving a case between status classes would break the ones that branch on
 * status without telling any of them anything new.
 */
export function assertJoinableState(state: GroupInviteState): void {
  switch (state) {
    case "CAN_JOIN":
      return;
    case "ALREADY_MEMBER":
      throw new ConflictError("CHAT_ALREADY_MEMBER");
    case "GROUP_NOT_FOUND":
      throw new NotFoundError("CHAT_GROUP_NO_LONGER_EXISTS");
    case "GROUP_DISBANDED":
      throw new NotFoundError("CHAT_GROUP_DISBANDED");
    case "GROUP_CLOSED":
      // 403 — the status `assertGroupRoomWritable` has always answered for a
      // closed room.
      throw new ForbiddenError("CHAT_GROUP_CLOSED_ADMIN_BANNED");
    case "GROUP_NO_ADMIN":
      throw new NotFoundError("CHAT_GROUP_NO_ACTIVE_ADMIN");
    case "LINK_NOT_FOUND":
      throw new NotFoundError("CHAT_INVITE_LINK_NOT_FOUND");
    case "LINK_REVOKED":
      throw new BadRequestError("CHAT_INVITE_LINK_REVOKED");
    case "LINK_EXPIRED":
      throw new BadRequestError("CHAT_INVITE_LINK_EXPIRED");
    case "LINK_USED_UP":
      throw new BadRequestError("CHAT_INVITE_LINK_USAGE_LIMIT");
    case "GROUP_FULL":
      throw new BadRequestError("CHAT_GROUP_MEMBER_LIMIT_REACHED");
    case "JOIN_BLOCKED":
      throw new ForbiddenError("CHAT_JOIN_BLOCKED");
  }
}

// ---------------------------------------------------------------------------
// The single loader every surface goes through.
// ---------------------------------------------------------------------------

/** The three reads the state needs, as narrow structural types so the callers'
 *  repositories satisfy them without any of them importing the others. */
export interface GroupInviteStateDeps {
  inviteLinkRepo: {
    findByToken(token: string): Promise<GroupInviteStateInput["link"]>;
  } | null;
  roomRepo: {
    findByRoomId(roomId: string): Promise<
      | (GroupInviteStateInput["room"] & { roomId?: string })
      | null
    >;
  };
  memberRepo: {
    findByRoomAndUser(
      roomId: string,
      userId: string
    ): Promise<GroupInviteStateInput["membership"]>;
    countActiveByRole(roomId: string, role: string): Promise<number>;
  };
}

export interface LoadedGroupInviteState<TRoom, TLink, TMember> {
  state: GroupInviteState;
  room: TRoom | null;
  link: TLink | null;
  membership: TMember | null;
}

/**
 * Resolve the invite state for a token and/or a group, doing the reads ONCE.
 *
 * This is the source of truth requirement: the invitation card, the invite
 * landing screen and the join endpoint all call this, so "View Group" and
 * "Join Group" can never be decided from different reads or different rules.
 *
 * `roomId` lets a caller that already knows the group (the in-chat card, which
 * stores `groupId` on the message) resolve a state even when the token is
 * missing or unknown — that is what still lets a MEMBER see "View Group" on a
 * card whose link was revoked.
 */
export async function loadGroupInviteState<
  TRoom extends { status?: string | null; memberCount: number },
  TLink extends { roomId: string },
  TMember extends { status?: string | null },
>(
  deps: GroupInviteStateDeps,
  args: {
    token?: string | null;
    roomId?: string | null;
    viewerId?: string | null;
    /** See {@link GroupInviteStateInput.treatLinkAsLive} — the in-chat card. */
    treatLinkAsLive?: boolean;
  }
): Promise<LoadedGroupInviteState<TRoom, TLink, TMember>> {
  const token = args.token || null;
  const link = token
    ? ((await deps.inviteLinkRepo?.findByToken(token)) ?? null)
    : null;
  const roomId =
    args.roomId || (link as unknown as { roomId?: string } | null)?.roomId || null;
  // ANY status: `findActiveByRoomId` hides DISBANDED entirely and lets CLOSED
  // through as if it were joinable, so it cannot answer either question here.
  const room = roomId ? await deps.roomRepo.findByRoomId(roomId) : null;
  const membership =
    roomId && args.viewerId
      ? await deps.memberRepo.findByRoomAndUser(roomId, args.viewerId)
      : null;

  // Only worth counting when the group is otherwise alive — a disbanded or
  // closed group is already disqualified, and this is a second query.
  const alive =
    !!room && room.status !== "DISBANDED" && room.status !== "CLOSED";
  const activeAdminCount =
    alive && roomId
      ? await deps.memberRepo.countActiveByRole(roomId, "ADMIN")
      : undefined;

  const state = resolveGroupInviteState({
    room: room as GroupInviteStateInput["room"],
    link: link as GroupInviteStateInput["link"],
    membership: membership as GroupInviteStateInput["membership"],
    hasToken: !!token,
    activeAdminCount,
    treatLinkAsLive: args.treatLinkAsLive,
  });

  return {
    state,
    room: room as unknown as TRoom | null,
    link: link as unknown as TLink | null,
    membership: membership as unknown as TMember | null,
  };
}
