import { ForbiddenError, NotFoundError } from "@aimess/errors";

import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type {
  PrivateRoom,
  GroupMember,
  RoomMember,
} from "../generated/prisma/index.js";

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
 * Community / general room: the caller MUST be an ACTIVE member (banned/left
 * members are rejected). When `roles` is supplied the member's role must be one
 * of them. Mirrors the check enforced by `getConversation`/`listMedia`.
 *
 * @throws ForbiddenError `CHAT_NOT_A_MEMBER` when the caller isn't an active member.
 * @throws ForbiddenError `CHAT_INSUFFICIENT_PERMISSIONS` when the role is too low.
 */
export async function assertCommunityMember(
  memberRepo: Pick<RoomMemberRepository, "findByRoomAndUser">,
  roomId: string,
  userId: string,
  opts?: { roles?: readonly string[] }
): Promise<RoomMember> {
  const member = await memberRepo.findByRoomAndUser(roomId, userId);
  if (!member || member.status !== "active") {
    throw new ForbiddenError("CHAT_NOT_A_MEMBER");
  }
  if (opts?.roles && !opts.roles.includes(member.role)) {
    throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");
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
 * Community read access (Telegram-style): the caller is either an ACTIVE member
 * OR the community is PUBLIC (non-members can read PUBLIC community chat
 * history). For PRIVATE communities, active membership is required.
 *
 * Returns `{ member: RoomMember | null, canRead: boolean }` so callers know if
 * they're a member without a separate query.
 *
 * The community visibility (PUBLIC/PRIVATE) is persisted on the GeneralRoom
 * (`communityType`, synced from community-service by the room provisioner, the
 * `community.visibility_changed` event, and the boot reconciler). A null/missing
 * value is treated as PRIVATE — conservative fail-closed so an unsynced room
 * never leaks a PRIVATE community's history to a non-member. The room is only
 * loaded for non-members; ACTIVE members short-circuit first.
 *
 * @throws ForbiddenError `CHAT_NOT_A_MEMBER` when the caller is banned, or is a
 *   non-member of a PRIVATE (or not-yet-synced) community.
 */
export async function assertCommunityReadAccess(
  roomRepo: Pick<GeneralRoomRepository, "findRoomById">,
  memberRepo: Pick<RoomMemberRepository, "findByRoomAndUser">,
  roomId: string,
  userId: string
): Promise<{ member: RoomMember | null; canRead: boolean }> {
  const member = await memberRepo.findByRoomAndUser(roomId, userId);

  // Banned members cannot read (even if the community is PUBLIC).
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
