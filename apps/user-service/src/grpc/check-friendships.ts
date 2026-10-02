import { friendshipRepository } from "../repositories/friendship.repository.js";
import { userSettingsRepository } from "../repositories/user-settings.repository.js";
import { canSendFriendRequest } from "../lib/privacy-scope.js";
import {
  buildFriendshipView,
  toChatRelationship,
} from "../lib/friendship-view.js";
import { isUserId } from "../lib/peer-id.js";

/**
 * Body of the `checkFriendships` gRPC handler (src/grpc/server.ts), kept out
 * of server.ts so it can be tested without loading the proto.
 *
 * Only user ids are looked up. requesterId/addresseeId are Postgres `uuid`
 * columns, so ONE non-uuid candidate — a `grp_` room id or a community
 * ObjectId read off a corrupt private room — failed the whole batch with
 * INTERNAL: every valid candidate lost its relationship, and the caller's
 * circuit breaker counted it as an outage. A non-uuid is not a user, so it
 * gets no entry; one entry per VALID candidate is the contract callers read.
 */
export async function resolveFriendshipRelationships(
  rawCallerId: string | undefined,
  rawCandidateIds: string[] | undefined
) {
  const callerId = rawCallerId ?? "";
  const candidateIds = [
    ...new Set((rawCandidateIds ?? []).filter(isUserId)),
  ].slice(0, 500);
  if (!isUserId(callerId) || candidateIds.length === 0) {
    return { friendIds: [] as string[], relationships: [] };
  }
  const [friendIds, { rows, blockedIds, blockedByIds }, scopeByUser] =
    await Promise.all([
      friendshipRepository.findAcceptedFriendIdsForUser(callerId, candidateIds),
      friendshipRepository.findRelationshipsForUser(callerId, candidateIds),
      // Add-friend eligibility for the whole candidate list in one
      // query — see `canSendFriendRequest`.
      userSettingsRepository.findFriendRequestScopes(candidateIds),
    ]);
  // FRIENDS_OF_FRIENDS is the only scope needing the mutual-friend
  // graph. Resolving it is one extra query for the WHOLE list (never
  // per candidate, which would be an N+1), so only pay it when some
  // candidate actually selected that scope.
  const needsMutualFriends = candidateIds.some(
    (id) => scopeByUser.get(id) === "FRIENDS_OF_FRIENDS"
  );
  const friendOfFriendIds = needsMutualFriends
    ? new Set(
        (await friendshipRepository.resolveViewerGraph(callerId))
          .friendOfFriendIds
      )
    : new Set<string>();
  const friendIdSet = new Set(friendIds);
  const rowByPeer = new Map(
    rows.map((r) => [
      r.requesterId === callerId ? r.addresseeId : r.requesterId,
      r,
    ])
  );
  const relationships = candidateIds.map((userId) => {
    const row = rowByPeer.get(userId) ?? null;
    const view = buildFriendshipView(callerId, row, blockedIds.has(userId));
    const relationship = toChatRelationship(view);
    const isPending = view.status === "PENDING";
    return {
      userId,
      status: relationship.status,
      direction: relationship.direction ?? "",
      friendshipId: row?.id ?? "",
      requesterId: isPending && row ? row.requesterId : "",
      canAccept: view.canAccept,
      canReject: view.canReject,
      canCancel: view.canCancel,
      // Either-direction block. `status` stays one-directional on
      // purpose (an incoming block must not be visible as BLOCKED);
      // this flag exists only for action gates that must refuse both
      // ways, e.g. sending a group/community invite DM.
      blockedEitherWay: blockedIds.has(userId) || blockedByIds.has(userId),
      // The incoming direction on its own — `status` hides it and
      // `blockedEitherWay` cannot separate it from the caller's own
      // block under a mutual block. Consumed only by chat-service's
      // pair-state resolver, which has to tell "you blocked them" from
      // "they blocked you" to pick between an Unblock action and a
      // disabled composer.
      blockedByPeer: blockedByIds.has(userId),
      // Same gate `friendshipService.sendRequest` enforces, so a
      // private-chat / inbox peer never renders an Add Friend action
      // the write path would reject.
      canSendRequest: canSendFriendRequest(
        {
          privacySettings: {
            whoCanSendFriendRequests: scopeByUser.get(userId) ?? null,
          },
        },
        {
          isSelf: userId === callerId,
          isFriend: friendIdSet.has(userId),
          isFriendOfFriend: friendOfFriendIds.has(userId),
        },
        {
          status: relationship.status,
          isBlockedEitherWay:
            blockedIds.has(userId) || blockedByIds.has(userId),
        }
      ),
    };
  });
  return { friendIds, relationships };
}
