import { logger } from "@aimess/logger";

import { userGrpcClient } from "../grpc/user-snapshot.client.js";

/**
 * Why an invite may not be delivered to a recipient. Absent = eligible.
 *
 *  - NOT_FOUND  — no such account.
 *  - DELETED    — the account was deleted (tombstone; renders in history only).
 *  - SUSPENDED  — admin-banned/suspended; they cannot log in to act on it.
 *  - BLOCKED    — a block exists in EITHER direction between the two users.
 *
 * Deliberately identical to community-service's `fetchInviteIneligibility`
 * (apps/community-service/src/lib/user-client.ts): group and community invite
 * cards land in the same DM thread, so a recipient that one path refuses must
 * be refused by the other with the same code.
 */
export type InviteIneligibility =
  | "NOT_FOUND"
  | "DELETED"
  | "SUSPENDED"
  | "BLOCKED";

/** Wire code — also the `@aimess/constants` message key clients localize. */
export const INVITE_INELIGIBILITY_CODE: Record<InviteIneligibility, string> = {
  NOT_FOUND: "INVITE_RECIPIENT_NOT_FOUND",
  DELETED: "INVITE_RECIPIENT_DELETED",
  SUSPENDED: "INVITE_RECIPIENT_SUSPENDED",
  BLOCKED: "INVITE_RECIPIENT_BLOCKED",
};

/**
 * Two batch RPCs, never per-user.
 *
 * Reads user-service directly rather than `UserSnapshotService`: that map is a
 * 1-hour Redis cache built for rendering names, and a ban must not stay
 * inviteable for an hour. The block state is read from user-service too (the
 * local `Friendship` replica is event-sourced and lossy — a missing row is
 * indistinguishable from "not blocked").
 *
 * FAILS OPEN on a user-service outage: a verification blip must not block an
 * otherwise-valid send, and every one of these states is re-checked when the
 * recipient actually redeems the invite.
 */
export async function fetchInviteIneligibility(
  callerId: string,
  candidateIds: string[]
): Promise<Map<string, InviteIneligibility>> {
  const out = new Map<string, InviteIneligibility>();
  if (candidateIds.length === 0) return out;

  const [snapshots, relationships] = await Promise.all([
    userGrpcClient
      .bulkGetUserSnapshots(candidateIds)
      .catch((error: unknown) => {
        logger.error(
          `inviteRecipientGate|snapshot lookup failed (failing open): ${String(error)}`
        );
        return null;
      }),
    // `checkFriendships` already swallows transport errors and returns an
    // empty map — indistinguishable from "no blocks", which is the fail-open
    // behaviour we want here.
    userGrpcClient.checkFriendships(callerId, candidateIds),
  ]);

  if (snapshots) {
    const byId = new Map(snapshots.map((u) => [u.userId, u]));
    for (const id of candidateIds) {
      const snap = byId.get(id);
      if (!snap) out.set(id, "NOT_FOUND");
      else if (snap.isDeleted) out.set(id, "DELETED");
      else if (snap.isSuspended) out.set(id, "SUSPENDED");
    }
  }

  // DELETED/SUSPENDED are the more specific reason and win over BLOCKED.
  for (const [userId, info] of relationships) {
    if (info.blockedEitherWay && !out.has(userId)) out.set(userId, "BLOCKED");
  }

  return out;
}
