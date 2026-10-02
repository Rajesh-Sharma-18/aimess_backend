import { nanoid } from "nanoid";

import { BadRequestError } from "@aimess/errors";

/**
 * Generate a unique room ID with a prefix.
 * Format: `{prefix}_{nanoid(16)}`
 */
export function generateRoomId(prefix = "room"): string {
  return `${prefix}_${nanoid(16)}`;
}

/**
 * Build a deterministic participants key for a private room.
 * Sorts the two user IDs lexicographically and joins with `:`.
 * This ensures one room per pair regardless of who initiates.
 */
export function buildParticipantsKey(userId1: string, userId2: string): string {
  const sorted = [userId1, userId2].sort();
  return `${sorted[0]}:${sorted[1]}`;
}

/**
 * Build a deterministic pair key for friendships.
 * Same logic as participants key.
 */
export function buildPairKey(userId1: string, userId2: string): string {
  return buildParticipantsKey(userId1, userId2);
}

const USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A user id is a UUID. A `grp_`/`prv_` room id and the string "undefined" are not. */
export function isUserId(value: unknown): value is string {
  return typeof value === "string" && USER_ID_RE.test(value);
}

/**
 * What a non-user id stored where a user id belongs actually is — for logs and
 * the malformed-room audit only, never for a decision (that is `isUserId`).
 * The two shapes seen in corrupt private rooms are a group room id and a
 * 24-hex Mongo ObjectId (a community id), both written by invite shares that
 * took the target conversation for a recipient user.
 */
export function nonUserIdKind(
  value: unknown
): "GROUP_ROOM_ID" | "PRIVATE_ROOM_ID" | "OBJECT_ID" | "EMPTY" | "OTHER" {
  if (typeof value !== "string" || value === "" || value === "undefined") {
    return "EMPTY";
  }
  if (value.startsWith("grp_")) return "GROUP_ROOM_ID";
  if (value.startsWith("prv_")) return "PRIVATE_ROOM_ID";
  if (/^[0-9a-f]{24}$/i.test(value)) return "OBJECT_ID";
  return "OTHER";
}

/**
 * The invariant a private room's `participants` must satisfy: exactly two
 * DISTINCT user ids, each a UUID.
 *
 * Asserted twice, on purpose. `ensurePrivateRoom` calls it FIRST so the REST
 * get-or-create, the Auto-Connect gRPC batch and the friendship consumer all
 * answer 400 before spending a friendship round trip. `PrivateRoomRepository`
 * calls it again in `create`, which is the one choke point EVERY creation
 * passes through — including the group-invite share and the community
 * invite-link sync, which build their rooms without coming through the service
 * at all. The second call is the storage invariant; without it the next caller
 * to add a `create` has to remember.
 *
 * What it closes: `PrivateRoomService.getOrCreateRoom`/`getRoomDetails` mint a
 * room once `UserServiceClient.checkFriendship` says yes, and that check fails
 * OPEN — an unresolved upstream or a DB error both `return true`. So during any
 * user-service blip, `POST /chat/private/rooms/<anything>` created a real room
 * for whatever string was in the URL. That is how rows with a `grp_...` peer
 * and with the literal "undefined" got written; the peer id in them can never
 * resolve to a person, so `enrichConversations` would serialize them with a
 * placeholder name forever. They stay out of the inbox today only because they
 * have no `lastMessageAt`, which is luck, not a guard.
 */
export function assertPrivateParticipants(participants: string[]): void {
  const [a, b] = participants;
  if (participants.length !== 2 || !isUserId(a) || !isUserId(b) || a === b) {
    throw new BadRequestError("CHAT_INVALID_ID_FORMAT");
  }
}
