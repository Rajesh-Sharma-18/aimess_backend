import { ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type {
  PrivateRoom,
  GroupMember,
  RoomMember,
} from "../generated/prisma/index.js";
import { getCommunityReconcileClient } from "../grpc/community.client.js";

/**
 * Centralized access guards for chat-service.
 *
 * Every confidential read/write path routes its participation, membership and
 * role check through one of these helpers so the rule can't drift per endpoint.
 * Closes the IDOR/broken-access-control findings in `tests/AUDIT.md`:
 *   - H2  message timeline + search not gated on participation/membership
 *   - H3  group `addMember` did not authorize the actor
 *   - H4  invite-link listing exposed live tokens to any authed user
 *
 * Each guard returns the loaded room/member so callers can reuse it without a
 * second query.
 */

/**
 * Private DM: the caller MUST be one of the room's `participants`.
 * Mirrors the participation check already enforced by `listMedia`/`catchup`.
 *
 * @throws NotFoundError  `CHAT_ROOM_NOT_FOUND` when the room is gone.
 * @throws ForbiddenError `CHAT_NOT_PARTICIPANT` when the caller isn't in it.
 */
export async function assertPrivateParticipant(
  roomRepo: Pick<PrivateRoomRepository, "findByRoomId">,
  roomId: string,
  userId: string
): Promise<PrivateRoom> {
  const room = await roomRepo.findByRoomId(roomId, {
    projection: { roomId: 1, participants: 1 },
  });
  if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
  if (!room.participants?.includes(userId)) {
    throw new ForbiddenError("CHAT_NOT_PARTICIPANT");
  }
  return room;
}

/**
 * The OTHER participant of a private room, resolved from the room record.
 *
 * This is the ONLY authority on "who receives this DM". A client-supplied
 * `receiverId` must never reach persistence, socket fan-out, unread counting or
 * push targeting: omitting it silently dropped delivery to the real peer, and
 * forging it delivered `message:new` / `conv:updated` / a push to a third party
 * who is not in the room at all.
 *
 * Returns `""` for a malformed room (no second participant) so callers degrade
 * to "no peer" rather than fanning out to an empty-string channel.
 */
export function privateRoomPeerId(
  room: Pick<PrivateRoom, "participants">,
  userId: string
): string {
  return (room.participants ?? []).find((id) => id && id !== userId) ?? "";
}

/**
 * Group: the caller MUST be an ACTIVE member. When `roles` is supplied the
 * member's role must be one of them (e.g. ADMIN for management actions).
 *
 * @throws ForbiddenError `CHAT_NOT_A_MEMBER` when the caller isn't an active member.
 * @throws ForbiddenError `CHAT_INSUFFICIENT_PERMISSIONS` when the role is too low.
 */
export async function assertGroupMember(
  memberRepo: Pick<GroupMemberRepository, "findActiveByRoomAndUser">,
  roomId: string,
  userId: string,
  opts?: { roles?: readonly string[] }
): Promise<GroupMember> {
  const member = await memberRepo.findActiveByRoomAndUser(roomId, userId);
  if (!member) throw new ForbiddenError("CHAT_NOT_A_MEMBER");
  if (opts?.roles && !opts.roles.includes(member.role)) {
    throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");
  }
  return member;
}

/**
 * Group READ access: an ACTIVE member reads everything; a member who
 * voluntarily LEFT *or* was KICKED (removed by an admin/moderator) keeps read
 * access to history up to (and including) the moment they stopped being a
 * member (WhatsApp-style — the chat stays visible, read-only, no new
 * messages). Banned/never-a-member callers are denied, same as
 * {@link assertGroupMember} — this only widens LEFT/KICKED.
 *
 * READ and WRITE are deliberately split here: this guard is the ONLY one that
 * widens past ACTIVE. Every write/member action keeps calling
 * {@link assertGroupMember} (which resolves through `findActiveByRoomAndUser`),
 * so a removed member is read-allowed / write-denied by construction.
 *
 * BANNED is intentionally NOT widened — a ban is a harder state than a removal
 * and keeps its existing "no access" behavior.
 *
 * @throws ForbiddenError `CHAT_NOT_A_MEMBER` for anyone who isn't currently
 *   active, a past voluntary leaver, or a removed member (banned/no row).
 */
export async function assertGroupReadAccess(
  memberRepo: Pick<GroupMemberRepository, "findByRoomAndUser">,
  roomId: string,
  userId: string
): Promise<{ member: GroupMember; readCutoffBefore?: Date }> {
  const member = await memberRepo.findByRoomAndUser(roomId, userId);
  if (member?.status === "ACTIVE") return { member };
  const cutoff = groupReadCutoff(member);
  if (cutoff)
    return { member: member as GroupMember, readCutoffBefore: cutoff };
  throw new ForbiddenError("CHAT_NOT_A_MEMBER");
}

/**
 * The instant a non-ACTIVE membership's read access freezes, or `null` when the
 * row carries no historical read access at all (ACTIVE, BANNED, missing, or a
 * LEFT/KICKED row whose timestamp was never written).
 *
 * Single source of truth for "how far can this ex-member read" — used by the
 * guard above AND by the inbox/detail preview caps, so the sidebar preview and
 * the timeline can never disagree about the cutoff.
 */
export function groupReadCutoff(
  member:
    | { status: string; leftAt?: Date | null; kickedAt?: Date | null }
    | null
    | undefined
): Date | null {
  if (member?.status === "LEFT") return member.leftAt ?? null;
  if (member?.status === "KICKED") return member.kickedAt ?? null;
  return null;
}

/**
 * True when the group member row carries an effective moderation mute.
 * Lazy expiry: a timed mute (`moderationMutedUntil`) auto-lifts the instant it
 * passes — no sweeper needed. An indefinite mute has `moderationMuted=true`
 * with `moderationMutedUntil=null`. Mirrors {@link isCommunityMemberMuted};
 * unlike community's cross-service mirror, group membership is a single row
 * chat-service already owns, so no separate mute model/sync is needed.
 */
export function isGroupMemberMuted(
  member:
    | Pick<GroupMember, "moderationMuted" | "moderationMutedUntil">
    | null
    | undefined
): boolean {
  if (!member?.moderationMuted) return false;
  if (member.moderationMutedUntil == null) return true; // indefinite
  return member.moderationMutedUntil.getTime() > Date.now();
}

/**
 * Group WRITE gate for moderation mute: a muted member cannot send/react
 * (they keep full read access). Call AFTER the membership guard that loads
 * the member row, reusing it — zero extra I/O.
 *
 * @throws ForbiddenError `CHAT_MUTED_IN_GROUP` when the member is muted.
 */
export function assertGroupMemberNotMuted(
  member:
    | Pick<GroupMember, "moderationMuted" | "moderationMutedUntil">
    | null
    | undefined
): void {
  if (isGroupMemberMuted(member)) {
    throw new ForbiddenError("CHAT_MUTED_IN_GROUP");
  }
}

/**
 * Live role lookup against community-service's AUTHORITATIVE
 * `CommunityMember.role` — NOT chat-service's locally-mirrored `RoomMember.role`,
 * which is a one-way, async, best-effort sync (`events/community-room-sync.consumer.ts`)
 * that can go stale (a role change lands in community-service immediately but
 * only reaches `RoomMember` after its queue event is consumed). This is the
 * ONE centralized place chat-service asks community-service "what is this
 * user's role right now" — every role-gated community write path routes
 * through this function (directly, or via {@link assertCommunityRole} /
 * {@link assertCommunityMember}'s `opts.roles`) so the lookup is never
 * duplicated and the source of truth can't drift per call site again.
 *
 * `communityId` is the community-service community id — for community general
 * rooms this always equals the chat-service `roomId` (`GeneralRoom.id ===
 * communityId`), so existing call sites need no new field, just pass `roomId`.
 *
 * Never throws (delegates to `checkCommunityMembership`, which never throws
 * either) — returns `""` (lowercase-normalized) on a transport failure or when
 * the user isn't a member, so callers checking `roles.includes(role)` fail
 * CLOSED by construction, without each call site needing its own try/catch.
 */
export async function getCommunityLiveRole(
  communityId: string,
  userId: string
): Promise<string> {
  const { role } = await getCommunityReconcileClient().checkCommunityMembership(
    { communityId, userId }
  );
  return role.toLowerCase();
}

/**
 * Convenience wrapper over {@link getCommunityLiveRole} for call sites that
 * want the standard `CHAT_INSUFFICIENT_PERMISSIONS` 403. Some existing call
 * sites throw a DIFFERENT error class for this same condition (e.g.
 * `deleteForAll`'s "others need admin/moderator" branch uses `BadRequestError`,
 * a 400) — those call {@link getCommunityLiveRole} directly and throw their
 * own error to preserve their existing status code exactly.
 *
 * Fails CLOSED: an unreachable community-service resolves to role `""`, which
 * never matches `roles`, so the action is denied rather than silently
 * trusting a possibly-stale local role. Deliberate trade-off for
 * moderation-sensitive actions (the reverse of the socket ban-gate's
 * fail-OPEN policy, which only gates room visibility, not a mutation).
 *
 * @throws ForbiddenError `CHAT_INSUFFICIENT_PERMISSIONS` when the live role
 *   isn't one of `roles` (including when community-service is unreachable).
 */
export async function assertCommunityRole(
  communityId: string,
  userId: string,
  roles: readonly string[]
): Promise<void> {
  const liveRole = await getCommunityLiveRole(communityId, userId);
  if (!roles.includes(liveRole)) {
    logger.warn(
      `assertCommunityRole|denied communityId=${communityId} userId=${userId} liveRole="${liveRole || "(none)"}" required=[${roles.join(",")}]`
    );
    throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");
  }
}

/**
 * Community PERMISSION policy, single decision point: only an ACTIVE member
 * may act (read/send/react/edit/pin/mark-read/upload). A BANNED member is
 * rejected with `USER_BANNED` — distinct from a plain non-member — so every
 * protected surface reports the ban consistently (business rule: the
 * community stays VISIBLE in a banned member's list, but every action on it
 * is denied with USER_BANNED). LEFT/removed/missing rows get the existing
 * `CHAT_NOT_A_MEMBER` (or the caller-supplied error for anti-enumeration
 * paths that deliberately answer 404).
 *
 * Every community membership check in chat-service MUST route through this
 * (directly or via {@link assertCommunityMember} /
 * {@link assertCommunityReadAccess}) so the banned-vs-non-member distinction
 * can't drift per call site.
 *
 * @throws ForbiddenError `USER_BANNED` when the member row is banned.
 * @throws `notAMemberError` (default ForbiddenError `CHAT_NOT_A_MEMBER`) otherwise.
 */
export function assertRoomMemberActive<T extends Pick<RoomMember, "status">>(
  member: T | null | undefined,
  notAMemberError?: () => Error
): asserts member is T {
  if (member?.status === "banned") {
    throw new ForbiddenError("USER_BANNED");
  }
  if (!member || member.status !== "active") {
    throw notAMemberError
      ? notAMemberError()
      : new ForbiddenError("CHAT_NOT_A_MEMBER");
  }
}

/**
 * Community / general room: the caller MUST be an ACTIVE member (banned →
 * USER_BANNED, left/removed → CHAT_NOT_A_MEMBER — see
 * {@link assertRoomMemberActive}; the status check stays on `RoomMember`,
 * only role-gating moved to community-service, see {@link assertCommunityRole}).
 * When `roles` is supplied, the caller's LIVE community-service role must be
 * one of them.
 *
 * @throws ForbiddenError `USER_BANNED` when the caller is banned from the community.
 * @throws ForbiddenError `CHAT_NOT_A_MEMBER` when the caller isn't an active member.
 * @throws ForbiddenError `CHAT_INSUFFICIENT_PERMISSIONS` when the live role is too low.
 */
export async function assertCommunityMember(
  memberRepo: Pick<RoomMemberRepository, "findByRoomAndUser" | "upsert">,
  roomId: string,
  userId: string,
  opts?: { roles?: readonly string[]; communityId?: string }
): Promise<RoomMember> {
  let member = await memberRepo.findByRoomAndUser(roomId, userId);
  // ponytail: per-request lazy heal. Upgrade path if the async lag ever
  // dominates: make the rejoin API strong-consistent by pushing the mirror
  // synchronously (RPC into chat-service) instead of reconciling on read.
  // Stale-mirror reconciliation. The local RoomMember is an eventually-consistent
  // mirror of community-service's authoritative CommunityMember (fed by the
  // `community.member.synced` RabbitMQ event). A user who just rejoined after an
  // unban can hit this guard BEFORE the sync event lands, in which case the
  // mirror still says "banned" or "left" and the write is wrongly rejected.
  // On any non-active mirror state, do a single authoritative gRPC lookup: if
  // community-service says ACTIVE, upsert the mirror in place and continue; if
  // it confirms BANNED/non-member, fall through to the local assertion which
  // reports the correct error. Fails CLOSED on gRPC error (member stays null).
  if (!member || member.status !== "active") {
    const live = await getCommunityReconcileClient()
      .checkCommunityMembership({
        communityId: opts?.communityId ?? roomId,
        userId,
      })
      .catch(() => null);
    if (live && live.isMember && !live.isBanned) {
      const mapped = {
        status: "active",
        role: live.role ? live.role.toLowerCase() : "member",
        bannedAt: null,
        leftAt: null,
      };
      member = await memberRepo.upsert(roomId, userId, mapped);
      logger.info(
        `assertCommunityMember|reconciled stale mirror via gRPC roomId=${roomId} userId=${userId} status=active`
      );
    }
  }
  assertRoomMemberActive(member);
  if (opts?.roles) {
    await assertCommunityRole(opts.communityId ?? roomId, userId, opts.roles);
  }
  return member;
}

/**
 * Community WRITE gate: the community general room must be open (`status ===
 * "active"`) before any mutating chat action (send / reply / edit / delete /
 * react / pin). A room is moved to `"suspended"` when the community is closed
 * by its owner (status → CLOSED) or suspended by the platform; `"inactive"`
 * means deleted/unprovisioned.
 *
 * This is the SINGLE place chat-service interprets community-room writability —
 * call it in every write path so a closed community is read-only regardless of
 * any stale RoomMember rows.
 *
 * @throws ForbiddenError `COMMUNITY_SUSPENDED`     when the room is suspended (closed).
 * @throws ForbiddenError `COMMUNITY_CHAT_DISABLED` when the room is missing/inactive.
 */
export function assertCommunityRoomWritable(
  room: { status: string } | null | undefined
): void {
  if (room?.status === "active") return;
  if (room?.status === "suspended") {
    throw new ForbiddenError("COMMUNITY_SUSPENDED");
  }
  throw new ForbiddenError("COMMUNITY_CHAT_DISABLED");
}

/**
 * True when the member row carries an effective moderation mute. The mute state
 * is mirrored onto RoomMember from community-service (`community.member.mute_synced`)
 * so this is a pure, allocation-free check on an already-loaded row — no gRPC on
 * the hot send path. Lazy expiry: a timed mute (`mutedUntil`) auto-lifts the
 * instant it passes, even before the auto-unmute sweep clears the flag. An
 * indefinite mute has `isMuted=true` with `mutedUntil=null`.
 */
export function isCommunityMemberMuted(
  member: Pick<RoomMember, "isMuted" | "mutedUntil"> | null | undefined
): boolean {
  if (!member?.isMuted) return false;
  if (member.mutedUntil == null) return true; // indefinite
  return member.mutedUntil.getTime() > Date.now();
}

/**
 * Community WRITE gate for moderation mute: a muted member cannot send / reply /
 * edit / react / pin (Telegram parity — they keep full READ access). Call it in
 * every community write path AFTER the membership/role guard (which loads the
 * member), reusing the returned row so there is zero extra I/O. The mute is
 * enforced server-side for BOTH socket and REST since every write funnels
 * through chat-service.
 *
 * @throws ForbiddenError `CHAT_MUTED_IN_COMMUNITY` when the member is muted.
 */
export function assertCommunityMemberNotMuted(
  member: Pick<RoomMember, "isMuted" | "mutedUntil"> | null | undefined
): void {
  if (isCommunityMemberMuted(member)) {
    throw new ForbiddenError("CHAT_MUTED_IN_COMMUNITY");
  }
}

/**
 * Community read access: the caller is either an ACTIVE member, or the
 * community is PUBLIC (non-members can read PUBLIC community chat history).
 * For PRIVATE communities, active membership is required.
 *
 * A BANNED member is a READ/WRITE split, not a hard block: the ban is a
 * PERMISSION-axis rule (enforced by {@link assertRoomMemberActive} /
 * {@link assertCommunityMember} on every write/react/pin/upload/socket-join
 * path), but on the READ axis a ban acts as a read CUTOFF — the member may
 * still open the community, scroll/search history, and view media that
 * existed strictly before their ban, just never anything created after it.
 * `options.allowBannedReadCutoff` opts a read call site into that cutoff
 * instead of throwing; every write path must keep calling
 * {@link assertRoomMemberActive} directly (or omit the option here) so writes
 * stay hard-blocked with `USER_BANNED` regardless of this function's default.
 *
 * When the option is set, a banned member gets `canRead: true` and
 * `bannedAtCutoff` set to their `bannedAt` — callers MUST clamp their query to
 * `createdAt <= bannedAtCutoff` (or the equivalent `sequenceNumber`/`revision`
 * bound) so nothing created after the ban is ever returned. Without the
 * option (the default), a ban still throws `USER_BANNED` outright — checked
 * BEFORE the PUBLIC fallback, so a banned member of a PUBLIC community is
 * denied too, same as a PRIVATE one.
 *
 * Returns `{ member: RoomMember | null, canRead: boolean, bannedAtCutoff? }`
 * so callers know if they're a member without a separate query.
 *
 * The community visibility (PUBLIC/PRIVATE) is persisted on the GeneralRoom
 * (`communityType`, synced from community-service by the room provisioner, the
 * `community.visibility_changed` event, and the boot reconciler). A null/missing
 * value is treated as PRIVATE — conservative fail-closed so an unsynced room
 * never leaks a PRIVATE community's history to a non-member. The room is only
 * loaded for non-members; ACTIVE members short-circuit first.
 *
 * @throws ForbiddenError `USER_BANNED` when the caller is banned from the
 *   community and `options.allowBannedReadCutoff` is not set.
 * @throws ForbiddenError `CHAT_NOT_A_MEMBER` when the caller is a non-member of
 *   a PRIVATE (or not-yet-synced) community.
 */
export async function assertCommunityReadAccess(
  roomRepo: Pick<GeneralRoomRepository, "findRoomById">,
  memberRepo: Pick<RoomMemberRepository, "findByRoomAndUser" | "upsert">,
  roomId: string,
  userId: string,
  options?: { allowBannedReadCutoff?: boolean }
): Promise<{
  member: RoomMember | null;
  canRead: boolean;
  bannedAtCutoff?: Date;
}> {
  const member = await memberRepo.findByRoomAndUser(roomId, userId);

  // Banned: denied outright, even for a PUBLIC community — a ban revokes all
  // WRITE/realtime access, so this must NOT fall through to the "PUBLIC
  // non-member" branch below (an existing-but-banned member is not a
  // "non-member"). READ call sites opt into a capped history read instead via
  // allowBannedReadCutoff — see the doc above.
  if (member?.status === "banned") {
    if (options?.allowBannedReadCutoff) {
      return {
        member,
        canRead: true,
        bannedAtCutoff: member.bannedAt ?? new Date(0),
      };
    }
    throw new ForbiddenError("USER_BANNED");
  }

  // Active members can always read.
  if (member?.status === "active") {
    return { member, canRead: true };
  }

  // Non-members can read only if the community is PUBLIC (persisted on the room).
  const room = await roomRepo.findRoomById(roomId);
  if (room?.communityType === "PUBLIC") {
    return { member: null, canRead: true };
  }

  // Stale-mirror reconciliation — SAME lazy heal used by assertCommunityMember
  // (see doc there for the full rationale). The local RoomMember is an
  // eventually-consistent mirror of community-service's authoritative
  // CommunityMember, fed by the `community.member.synced` RabbitMQ event. A
  // user whose join-request was just APPROVED is instantly redirected to the
  // community and hits this guard BEFORE the sync event lands — the mirror
  // still says "not a member" and the read is wrongly rejected with a 403 the
  // user only escapes via a hard refresh. On the private-community miss path
  // (about to throw CHAT_NOT_A_MEMBER), do a single authoritative gRPC lookup:
  // if community-service says ACTIVE, opportunistically upsert the mirror so
  // subsequent reads short-circuit locally, and allow this read; if it
  // confirms non-member (or a transport error occurs), fall through to the
  // throw. Adds one gRPC call ONLY on the private + non-member miss — the hot
  // ACTIVE-member and PUBLIC branches short-circuit above.
  const live = await getCommunityReconcileClient()
    .checkCommunityMembership({ communityId: roomId, userId })
    .catch(() => null);
  if (live && live.isMember && !live.isBanned) {
    const mapped = {
      status: "active",
      role: live.role ? live.role.toLowerCase() : "member",
      bannedAt: null,
      leftAt: null,
    };
    // Best-effort mirror write — a repo without upsert (some tests) or a DB
    // write failure must NOT block the read; the RMQ consumer will heal on
    // its own shortly.
    const healed = await memberRepo
      .upsert?.(roomId, userId, mapped)
      .catch(() => null);
    logger.info(
      `assertCommunityReadAccess|reconciled stale mirror via gRPC roomId=${roomId} userId=${userId} status=active healed=${Boolean(healed)}`
    );
    return { member: healed ?? null, canRead: true };
  }

  // Private (or unsynced) community and not a member — denied.
  throw new ForbiddenError("CHAT_NOT_A_MEMBER");
}
