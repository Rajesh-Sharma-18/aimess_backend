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
 * Group: the caller MUST be an ACTIVE member. When `roles` is supplied the
 * member's role must be one of them (e.g. OWNER/ADMIN for management actions).
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
 * Community / general room: the caller MUST be an ACTIVE member (banned/left
 * members are rejected — this status check stays on `RoomMember`, unchanged;
 * only role-gating moved to community-service, see {@link assertCommunityRole}).
 * When `roles` is supplied, the caller's LIVE community-service role must be
 * one of them. Mirrors the check enforced by `getConversation`/`listMedia`.
 *
 * @throws ForbiddenError `CHAT_NOT_A_MEMBER` when the caller isn't an active member.
 * @throws ForbiddenError `CHAT_INSUFFICIENT_PERMISSIONS` when the live role is too low.
 */
export async function assertCommunityMember(
  memberRepo: Pick<RoomMemberRepository, "findByRoomAndUser">,
  roomId: string,
  userId: string,
  opts?: { roles?: readonly string[]; communityId?: string }
): Promise<RoomMember> {
  const member = await memberRepo.findByRoomAndUser(roomId, userId);
  if (!member || member.status !== "active") {
    throw new ForbiddenError("CHAT_NOT_A_MEMBER");
  }
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
 * For PRIVATE communities, active membership is required. A BANNED member is
 * denied outright — a ban revokes ALL access (open/read/catchup/sync/search/
 * media), not just writes; the membership row is kept only so the community
 * stays visible (locked) in their own community list.
 *
 * Returns `{ member: RoomMember | null, canRead: boolean, bannedAtCutoff?: Date }`
 * so callers know if they're a member without a separate query.
 * `bannedAtCutoff` is retained in the return shape for call-site compat but is
 * never populated — no status grants capped-history read anymore.
 *
 * The community visibility (PUBLIC/PRIVATE) is persisted on the GeneralRoom
 * (`communityType`, synced from community-service by the room provisioner, the
 * `community.visibility_changed` event, and the boot reconciler). A null/missing
 * value is treated as PRIVATE — conservative fail-closed so an unsynced room
 * never leaks a PRIVATE community's history to a non-member. The room is only
 * loaded for non-members; ACTIVE members short-circuit first.
 *
 * @throws ForbiddenError `CHAT_NOT_A_MEMBER` when the caller is BANNED, or is a
 *   non-member of a PRIVATE (or not-yet-synced) community.
 */
export async function assertCommunityReadAccess(
  roomRepo: Pick<GeneralRoomRepository, "findRoomById">,
  memberRepo: Pick<RoomMemberRepository, "findByRoomAndUser">,
  roomId: string,
  userId: string
): Promise<{
  member: RoomMember | null;
  canRead: boolean;
  bannedAtCutoff?: Date;
}> {
  const member = await memberRepo.findByRoomAndUser(roomId, userId);

  // Banned: denied outright, even for a PUBLIC community — a ban revokes all
  // access, so this must NOT fall through to the "PUBLIC non-member" branch
  // below (an existing-but-banned member is not a "non-member").
  if (member?.status === "banned") {
    throw new ForbiddenError("CHAT_NOT_A_MEMBER");
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

  // Private (or unsynced) community and not a member — denied.
  throw new ForbiddenError("CHAT_NOT_A_MEMBER");
}
