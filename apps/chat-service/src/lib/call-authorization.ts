import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";
import { buildParticipantsKey } from "./room-id.js";
import type { PrivateRoom } from "../generated/prisma/index.js";
import type { CallPrivacy } from "../grpc/user-snapshot.client.js";
import type { FriendshipRepository } from "../repositories/friendship.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { CallFlagService } from "./../services/call-flag.service.js";

/**
 * THE authorization chokepoint for starting a 1-to-1 call.
 *
 * Every 1:1 call in the platform is minted by `CallService.initiateCall`, which
 * is reached from exactly one place — the `/chat` socket's `call:initiate` — so
 * gating here covers REST, socket, deep link, "Call back" on a call card and any
 * future entry point at once. There is deliberately no second copy of these
 * rules anywhere: a caller that has not passed this function has no call row, no
 * LiveKit token, no ring and no push.
 *
 * The rule the product wants is simple and absolute: **calls are between
 * friends**. `whoCanCallMe` can only ever NARROW that (NO_ONE, or an explicit
 * allow-list); it can no longer widen it. This is the fix for the gap where
 * `whoCanCallMe` defaults to EVERYONE and therefore waived the friendship check
 * for essentially every account on the platform.
 */

/** What the caller-facing snapshot lookup must provide for the gate to run. */
export interface CallPeerSnapshot {
  displayName: string;
  avatarUrl: string;
  /**
   * Optional so best-effort lookups that fail (and return empty strings) read as
   * "unknown", not "deleted" — a snapshot outage must not block calling.
   */
  isDeleted?: boolean;
}

export interface CallAuthorizationDeps {
  friendshipRepo: Pick<
    FriendshipRepository,
    "areFriends" | "isBlockedEitherWay"
  >;
  privateRoomRepo: Pick<
    PrivateRoomRepository,
    "findByRoomId" | "findByParticipantsKey"
  >;
  getCallPrivacy: (userId: string) => Promise<CallPrivacy>;
  getUserSnapshot: (userId: string) => Promise<CallPeerSnapshot>;
  /** Absent means the platform kill-switch is not wired — calling is on. */
  callFlags?: Pick<CallFlagService, "isCallingEnabled">;
}

export interface CallAuthorization {
  /** The DM room both parties are authorized in — persist THIS on the call row. */
  room: PrivateRoom;
  /** Already fetched for the gate; reused for the ringing UI instead of refetching. */
  calleeSnapshot: CallPeerSnapshot;
}

/**
 * Re-assert the friendship immediately before a call session is created or
 * accepted.
 *
 * `assertCanStartCall` runs before the room lookup and the busy gate, which
 * leaves a window in which the callee can unfriend and still be rung. This is a
 * single indexed read against chat-service's own event-sourced Friendship
 * replica (no gRPC hop), so it is cheap enough to run at the very last moment —
 * which is the only moment that actually closes the race.
 */
export async function assertFriendshipStillValid(
  friendshipRepo: Pick<FriendshipRepository, "areFriends">,
  callerId: string,
  calleeId: string
): Promise<void> {
  if (!(await friendshipRepo.areFriends(callerId, calleeId))) {
    throw new ForbiddenError("FRIENDSHIP_REQUIRED");
  }
}

export async function assertCanStartCall(
  deps: CallAuthorizationDeps,
  params: {
    callerId: string;
    calleeId: string;
    /** Client-supplied; never trusted — the pair's canonical room is derived when absent. */
    privateRoomId?: string | null;
  }
): Promise<CallAuthorization> {
  const { callerId, calleeId } = params;

  if (!callerId) throw new ForbiddenError("CALL_NOT_PARTICIPANT");
  if (!calleeId) throw new BadRequestError("CALL_TARGET_REQUIRED");
  if (callerId === calleeId) throw new BadRequestError("CALL_SELF_NOT_ALLOWED");

  // Gate 0: platform-wide kill-switch (admin panel). Checked first because it is
  // global — no point resolving a relationship for a feature that is switched
  // off. Fails OPEN: `isCallingEnabled` never throws, and an absent flag service
  // means calling is on. Blocks only NEW calls; anything connected keeps running.
  if (deps.callFlags && !(await deps.callFlags.isCallingEnabled())) {
    throw new ForbiddenError("CALLING_DISABLED");
  }

  // Gate 0.5: blocking, in BOTH directions, before every other gate. A block is
  // stored one-way but bans calling both ways, and it has to be answered from
  // the Friendship replica rather than only from `room.blockedBy` below: a pair
  // with no DM room at all has no `blockedBy` list to consult, and this must
  // also fire ahead of the privacy read so a blocked caller never learns the
  // callee's `whoCanCallMe` scope.
  if (await deps.friendshipRepo.isBlockedEitherWay(callerId, calleeId)) {
    throw new ForbiddenError("CALL_BLOCKED");
  }

  // Gate 1: the target must still be a usable account. A deleted user keeps its
  // Friendship rows (deletion is soft), so without this a call would ring a row
  // that no longer belongs to anybody. Free: this snapshot is needed anyway for
  // the caller's outgoing-mirror UI, so it is fetched here and handed back.
  // Fails OPEN on a lookup miss — `isDeleted` is only trusted when it is `true`.
  const calleeSnapshot = await deps.getUserSnapshot(calleeId);
  if (calleeSnapshot.isDeleted === true) {
    throw new NotFoundError("CALL_USER_UNAVAILABLE");
  }

  // Gate 2: friendship. MANDATORY and un-waivable — this is the whole rule.
  // Read from chat-service's local Friendship replica, which the `friendship.*`
  // AMQP consumer keeps in step with user-service, so an unfriend/block that
  // landed a moment ago is already reflected here.
  await assertFriendshipStillValid(deps.friendshipRepo, callerId, calleeId);

  // Gate 3: the callee's own `whoCanCallMe` preference, which may only NARROW
  // the friendship rule above. EVERYONE / FRIENDS add nothing beyond gate 2.
  const privacy = await deps.getCallPrivacy(calleeId);
  if (privacy.whoCanCallMe === "NO_ONE") {
    throw new ForbiddenError("PRIVACY_BLOCKED");
  }
  if (
    privacy.whoCanCallMe === "SELECTED_FRIENDS" &&
    !privacy.allowedUserIds.includes(callerId)
  ) {
    throw new ForbiddenError("PRIVACY_BLOCKED");
  }

  // Gate 4: the pair must share a DM room. Without this, any authenticated user
  // could ring an arbitrary calleeId by supplying a fabricated/omitted
  // privateRoomId. A client-supplied id is still checked for membership below,
  // so passing someone else's room id buys nothing. Friends always have a room
  // (the friendship consumer creates it on acceptance), so a miss here is a
  // genuine "no conversation exists", never a stranger to be let in.
  const participantsKey = buildParticipantsKey(callerId, calleeId);
  const room = params.privateRoomId
    ? await deps.privateRoomRepo.findByRoomId(params.privateRoomId, {
        projection: { participants: 1, blockedBy: 1 },
      })
    : await deps.privateRoomRepo.findByParticipantsKey(participantsKey);
  if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

  const participants = Array.isArray(room.participants)
    ? (room.participants as string[])
    : [];
  if (!participants.includes(callerId) || !participants.includes(calleeId)) {
    throw new ForbiddenError("CHAT_NOT_PARTICIPANT");
  }

  // Gate 5: blocks, in BOTH directions. Blocking also unfriends, so gate 2
  // normally catches this first; the explicit check stays as defense in depth
  // for a replica that has seen the block but not yet the unfriend. Previously
  // only the caller's own block was checked, so being blocked BY the callee did
  // not stop the call.
  // A private room has exactly these two participants, so ANY entry in
  // `blockedBy` names one of them — the id check and a bare `length > 0` are the
  // same test here; the explicit form documents which direction it covers.
  const blockedBy = Array.isArray(room.blockedBy)
    ? (room.blockedBy as string[])
    : [];
  if (blockedBy.includes(callerId) || blockedBy.includes(calleeId)) {
    throw new ForbiddenError("CALL_BLOCKED");
  }

  return { room, calleeSnapshot };
}
