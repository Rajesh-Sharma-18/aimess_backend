import { logger } from "@aimess/logger";

import type {
  ChatFriendshipInfo,
  ChatFriendshipStatus,
  CheckFriendshipsResult,
} from "../grpc/user-snapshot.client.js";
import { isUserId } from "./room-id.js";

/**
 * Body of `userGrpcClient.checkFriendships`, taking the breaker's `fire` so it
 * can be tested without loading the proto (the client file uses
 * `import.meta`).
 *
 * `null` = the call was inconclusive (transport failure / breaker open), the
 * same convention as `getChatSettings`. It used to be an empty map, which
 * every caller then read as "no relationship" — so one upstream error rendered
 * every real friend on an inbox page as NONE. An empty map now only ever means
 * user-service answered.
 *
 * Only UUIDs are sent. Corrupt private rooms carry a `grp_` room id or a
 * community ObjectId as the "peer", and the friendship columns are Postgres
 * `uuid`: one such id failed the WHOLE batch with INTERNAL (and fed the
 * breaker), taking every valid peer's relationship down with it. A non-user
 * has no relationship, so it simply gets no entry.
 */
export async function lookupFriendships(
  fire: (args: {
    callerId: string;
    candidateIds: string[];
  }) => Promise<CheckFriendshipsResult>,
  callerId: string,
  candidateIds: string[]
): Promise<Map<string, ChatFriendshipInfo> | null> {
  const validIds = [...new Set(candidateIds.filter(isUserId))];
  if (!isUserId(callerId) || validIds.length === 0) return new Map();
  try {
    const result = await fire({ callerId, candidateIds: validIds });
    return new Map(
      (result.relationships ?? []).map((r) => [
        r.userId,
        {
          status: (r.status || "NONE") as ChatFriendshipStatus,
          direction:
            r.direction === "OUTGOING" || r.direction === "INCOMING"
              ? r.direction
              : null,
          friendshipId: r.friendshipId ? r.friendshipId : null,
          requesterId: r.requesterId ? r.requesterId : null,
          canAccept: r.canAccept ?? false,
          canReject: r.canReject ?? false,
          canCancel: r.canCancel ?? false,
          blockedEitherWay: r.blockedEitherWay ?? false,
          blockedByPeer: r.blockedByPeer ?? false,
          canSendRequest: r.canSendRequest ?? false,
        },
      ])
    );
  } catch (err) {
    // The breaker already logged the upstream cause; this names the call.
    logger.warn(
      `userGrpcClient|checkFriendships unavailable|ids=${validIds.length}|${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
