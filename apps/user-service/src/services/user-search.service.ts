import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";

import { avatarService } from "./avatar.service.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import {
  buildRelationshipLookup,
  getFriendPeerIds,
  type PeerRelationship,
  type RelationshipStatus,
} from "../lib/relationship-lookup.js";
import {
  canSendFriendRequest,
  visibleIdentity,
  visibleIsOnline,
} from "../lib/privacy-scope.js";
import { splitBlocks } from "../lib/block-visibility.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { recentUserSearchRepository } from "../repositories/recent-user-search.repository.js";
import { RecentSearchTargetType } from "../generated/prisma/client.js";
import {
  messagingGrpcClient,
  type GroupSummary,
} from "../grpc/messaging.client.js";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";
import {
  decodePeopleCursor,
  encodePeopleCursor,
  normalizeForSearch,
  rankByUsername,
} from "../lib/user-search.util.js";
import type { UnifiedSearchQuery } from "../api/validators/user-search.validator.js";

// The store already keeps (and the repository already fetches) the newest 20 per
// user, so this is purely how many of them the Recent Search list renders.
const RECENT_LIMIT = 10;
const CHAT_LIMIT = 10;
// const OTHER_LIMIT = 10;
/** Cap on how many of the viewer's private-room peers we pull per request. */
const PRIVATE_ROOM_PEER_CAP = 500;

export type SearchUserItem = {
  type: "USER";
  userId: string;
  username: string;
  /** Always the real name — identity is not viewer-scoped (`visibleIdentity`). */
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  avatar: MediaObject;
  isOnline: boolean;
  /** Existing private-room id with the viewer, resolved dynamically; null if none. */
  roomId: string | null;
  /**
   * Explicit friendship indicator — an ACCEPTED friendship with the viewer,
   * independent of whether a private room (`roomId`) exists. Never infer
   * friendship from `roomId`.
   */
  isFriend: boolean;
  /** Relationship: FRIEND | PENDING | NONE. */
  relationshipStatus: RelationshipStatus;
  /**
   * The VIEWER blocked this user. Blocks are one-way, so such rows stay in the
   * blocker's results — this flag lets the client offer "Unblock" instead of a
   * friend-request action the API would reject with FRIEND_BLOCKED. Users who
   * blocked the viewer never reach the client at all, so this is never true in
   * the other direction.
   */
  isBlockedByMe: boolean;
  /**
   * This user blocked the VIEWER. Normally such a user is subtracted from every
   * result (`hiddenIds`) and never reaches the client — with ONE exception: a
   * pair that already has a private conversation. That pair is already visible
   * to this viewer from their own inbox, and hiding it here is what made the
   * same pair open two different screens depending on the door: the chat list
   * opened the conversation, search offered "Send Request" for it. Row stays,
   * flagged, with every action off.
   *
   * Both flags are true under a mutual block.
   */
  isBlockedByPeer: boolean;
  /** Friendship row id when FRIEND/PENDING; null when NONE. */
  friendshipId: string | null;
  /** Who sent the PENDING request; null when FRIEND/NONE. */
  requesterId: string | null;
  /**
   * Effective "may this viewer send an add-friend request" — the target's
   * `whoCanSendFriendRequests` scope AND the self/block/friend/pending
   * preconditions, resolved server-side by `canSendFriendRequest`. The raw
   * scope is never exposed: a denied viewer cannot tell NO_ONE from FRIENDS
   * from a block. The client renders the action from this flag alone.
   */
  canSendRequest: boolean;
  /**
   * Normalized relationship the FE merges live `friend:*` socket updates
   * into by `userId` — status/direction/action flags, never re-derived
   * client-side. Additive alongside the legacy flat fields above.
   */
  relationship: {
    status: RelationshipStatus;
    direction: "OUTGOING" | "INCOMING" | null;
    canAccept: boolean;
    canReject: boolean;
    canCancel: boolean;
    canSendRequest: boolean;
  };
};

export type SearchGroupItem = {
  type: "GROUP";
  /** Also the group's stable id (chat-service GroupRoom.roomId). */
  roomId: string;
  name: string;
  /** Raw stored object key, unchanged — kept for existing clients. */
  avatar: string;
  /**
   * Presigned view URL for {@link SearchGroupItem.avatar}, or null when the
   * group has no logo. Group logos live under `group-avatars/` in the SAME
   * bucket as user avatars, so the row used to hand clients a bare object key
   * that no browser could load; `avatar` still carries that key.
   */
  avatarUrl: string | null;
  description: string;
  memberCount: number;
  /**
   * True when the viewer is an ACTIVE member. `false` here does NOT mean "any
   * group that happens to match the query" — a row only exists at all when the
   * viewer is an active member OR the group is still in their conversation
   * list, so `false` specifically means "left/removed, conversation kept".
   */
  isActiveMember: boolean;
};

export type SearchResultItem = SearchUserItem | SearchGroupItem;

type BasicProfile = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  isOnline: boolean;
  privacySettings?: {
    whoCanSeeOnlineStatus?: string | null;
    whoCanViewProfile?: string | null;
    whoCanSendFriendRequests?: string | null;
  } | null;
};

async function resolveAvatar(stored: string | null) {
  const view = await avatarService.resolveViewUrlForClient(stored);
  const avatar = await toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored,
    prefixes: MEDIA_PREFIXES.userAvatars,
    strategy: mediaUrlStrategy,
  });
  return {
    url: view?.url ?? null,
    expiresIn: view?.expiresIn ?? null,
    avatar,
  };
}

async function toUserItem(
  profile: BasicProfile,
  roomId: string | null,
  relationship: PeerRelationship,
  friendOfFriendIds: ReadonlySet<string>,
  blockedByMe: ReadonlySet<string>,
  blockedByPeer: ReadonlySet<string>
): Promise<SearchUserItem> {
  // Identity (name + photo) is not viewer-scoped — see `visibleIdentity`.
  // `whoCanViewProfile` gates the profile CONTENT, not who the row is.
  const relation = {
    isFriend: relationship.isFriend,
    isFriendOfFriend: friendOfFriendIds.has(profile.userId),
  };
  const identity = visibleIdentity(profile);
  // `whoCanSendFriendRequests` — same gate `friendshipService.sendRequest`
  // enforces, so the row never offers an action the API would reject. Blocks
  // count in EITHER direction: users who blocked the viewer never reach this
  // mapper, so only the viewer's own block is checkable here.
  const isBlockedByPeer = blockedByPeer.has(profile.userId);
  const canSendRequest = canSendFriendRequest(profile, relation, {
    status: relationship.relationshipStatus,
    isBlockedEitherWay: blockedByMe.has(profile.userId) || isBlockedByPeer,
  });
  const { url, expiresIn, avatar } = await resolveAvatar(profile.avatarUrl);
  return {
    type: "USER",
    userId: profile.userId,
    username: profile.username,
    firstName: identity.firstName,
    lastName: identity.lastName,
    fullName: identity.fullName,
    avatarUrl: url,
    avatarUrlExpiresIn: expiresIn,
    avatar,
    // `whoCanSeeOnlineStatus` — a denied viewer sees `false`, indistinguishable
    // from genuinely offline. Never leak the real flag here.
    // A blocker's presence is never exposed to the person they blocked, whatever
    // their `whoCanSeeOnlineStatus` says: the row survives only so the existing
    // conversation stays openable, and it must not become a liveness probe.
    isOnline:
      !isBlockedByPeer &&
      visibleIsOnline(profile, { isFriend: relationship.isFriend }),
    roomId,
    canSendRequest,
    isFriend: relationship.isFriend,
    relationshipStatus: relationship.relationshipStatus,
    isBlockedByMe: blockedByMe.has(profile.userId),
    isBlockedByPeer,
    friendshipId: relationship.friendshipId,
    requesterId: relationship.requesterId,
    relationship: {
      status: relationship.relationshipStatus,
      direction: relationship.direction,
      canAccept: relationship.canAccept,
      canReject: relationship.canReject,
      canCancel: relationship.canCancel,
      canSendRequest,
    },
  };
}

async function toGroupItem(g: GroupSummary): Promise<SearchGroupItem> {
  // `MEDIA_PREFIXES.avatars`, not `userAvatars`: the narrow sibling rejects
  // `group-avatars/` keys by design, which is exactly what a group logo is.
  const media = await toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored: g.avatar || null,
    prefixes: MEDIA_PREFIXES.avatars,
    strategy: mediaUrlStrategy,
  });
  return {
    type: "GROUP",
    roomId: g.roomId,
    name: g.name,
    avatar: g.avatar,
    avatarUrl: media.downloadUrl ?? null,
    description: g.description,
    memberCount: g.memberCount,
    isActiveMember: g.isActiveMember,
  };
}

export const userSearchService = {
  /** Upsert a recently-viewed User/Group target — never stores roomId. */
  async recordRecent(params: {
    userId: string;
    targetType: "USER" | "GROUP";
    targetId: string;
  }): Promise<void> {
    await recentUserSearchRepository.upsert({
      userId: params.userId,
      targetType:
        params.targetType === "GROUP"
          ? RecentSearchTargetType.GROUP
          : RecentSearchTargetType.USER,
      targetId: params.targetId,
    });
  },

  /** Remove one recently-viewed target. Returns false if no matching row existed. */
  async removeRecent(params: {
    userId: string;
    targetType: "USER" | "GROUP";
    targetId: string;
  }): Promise<boolean> {
    const result = await recentUserSearchRepository.deleteOne({
      userId: params.userId,
      targetType:
        params.targetType === "GROUP"
          ? RecentSearchTargetType.GROUP
          : RecentSearchTargetType.USER,
      targetId: params.targetId,
    });
    return result.count > 0;
  },

  /** Clear every recently-viewed target for this user. */
  async clearRecent(userId: string): Promise<void> {
    await recentUserSearchRepository.clearAll(userId);
  },

  /** `q` empty/whitespace → Recent only. No search logic runs. */
  async searchRecent(
    viewerId: string
  ): Promise<{ recent: SearchResultItem[] }> {
    const [blocks, relationships, recentRows, peers] = await Promise.all([
      friendshipRepository.findAllBlocks(viewerId),
      friendshipRepository.findAllForUser(viewerId),
      recentUserSearchRepository.findByUserId(viewerId),
      messagingGrpcClient.listPrivateRoomPeers(viewerId, PRIVATE_ROOM_PEER_CAP),
    ]);

    const { hiddenIds, blockedByMe } = splitBlocks(viewerId, blocks);
    const relationshipOf = buildRelationshipLookup(viewerId, relationships);
    const viewerFriendIds = getFriendPeerIds(viewerId, relationships);
    // FRIENDS_OF_FRIENDS needs the one-hop expansion, not just direct friends.
    const viewerGraph = await friendshipRepository.resolveViewerGraph(
      viewerId,
      viewerFriendIds
    );
    // Reused for the `whoCanSendFriendRequests` gate on every row below — the
    // same one-hop set discovery already paid for, never a second traversal.
    const fofIds = new Set(viewerGraph.friendOfFriendIds);
    // `peers` arrives ordered by lastMessageAt desc from chat-service.
    const peerRoomByUserId = new Map(
      peers.map((p) => [p.peerUserId, p.roomId])
    );

    const recentUserIds = recentRows
      .filter((r) => r.targetType === RecentSearchTargetType.USER)
      .map((r) => r.targetId);
    const recentGroupIds = recentRows
      .filter((r) => r.targetType === RecentSearchTargetType.GROUP)
      .map((r) => r.targetId);

    const [recentProfiles, recentGroups, recentRoomMatches] = await Promise.all(
      [
        recentUserIds.length
          ? userProfileRepository.findDiscoverableByUserIds(
              recentUserIds,
              viewerGraph
            )
          : Promise.resolve([]),
        recentGroupIds.length
          ? messagingGrpcClient.getGroupsByIds(viewerId, recentGroupIds)
          : Promise.resolve([]),
        recentUserIds.length
          ? messagingGrpcClient.resolvePrivateRooms(viewerId, recentUserIds)
          : Promise.resolve([]),
      ]
    );
    const recentProfileById = new Map(recentProfiles.map((p) => [p.userId, p]));
    const recentGroupById = new Map(recentGroups.map((g) => [g.roomId, g]));
    const recentRoomByUserId = new Map(
      recentRoomMatches.map((m) => [m.peerUserId, m.roomId])
    );

    const recent: SearchResultItem[] = [];
    for (const row of recentRows) {
      if (recent.length >= RECENT_LIMIT) break;
      if (row.targetType === RecentSearchTargetType.USER) {
        const profile = recentProfileById.get(row.targetId);
        if (!profile) continue;
        const roomId =
          recentRoomByUserId.get(profile.userId) ??
          peerRoomByUserId.get(profile.userId) ??
          null;
        // A user the viewer blocked stays in their own Recent list (they can
        // still open and unblock them). A user who blocked the VIEWER normally
        // drops out — unless the pair already has a conversation, which the
        // viewer can open from their inbox anyway; dropping the row there is
        // what made Recent and the chat list disagree about the same pair.
        if (hiddenIds.has(profile.userId) && !roomId) continue;
        recent.push(
          await toUserItem(
            profile,
            roomId,
            relationshipOf(profile.userId),
            fofIds,
            blockedByMe,
            hiddenIds
          )
        );
      } else {
        const group = recentGroupById.get(row.targetId);
        if (!group) continue; // group deleted/disbanded since last view
        recent.push(await toGroupItem(group));
      }
    }

    return { recent };
  },

  /**
   * `q` has a value → Chat + Other only. Never returns Recent.
   *
   * `chat` is a BOUNDED HEAD: it exists only on the first page (no cursor).
   * `hasMore`/`nextCursor` describe the PEOPLE keyset in `other` — the group
   * half of that bucket is a bounded head too, and is likewise dropped on
   * continuation pages so a walk never re-sends rows the caller already has.
   */
  async searchByQuery(
    viewerId: string,
    query: UnifiedSearchQuery
  ): Promise<{
    chat?: SearchResultItem[];
    other: SearchResultItem[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const q = query.q?.trim() || undefined;
    const cursor = decodePeopleCursor(query.cursor);
    const skip = (query.page - 1) * query.limit;
    const otherTake = query.limit;

    const [blocks, relationships, peers] = await Promise.all([
      friendshipRepository.findAllBlocks(viewerId),
      friendshipRepository.findAllForUser(viewerId),
      messagingGrpcClient.listPrivateRoomPeers(viewerId, PRIVATE_ROOM_PEER_CAP),
    ]);

    const { hiddenIds, blockedByMe } = splitBlocks(viewerId, blocks);
    const relationshipOf = buildRelationshipLookup(viewerId, relationships);
    // `peers` arrives ordered by lastMessageAt desc from chat-service; used
    // only to attach `roomId` metadata and to order friends by recency —
    // never to decide bucket membership.
    const peerRoomByUserId = new Map(
      peers.map((p) => [p.peerUserId, p.roomId])
    );
    const roomOrderIndex = new Map(peers.map((p, idx) => [p.peerUserId, idx]));
    // Users who blocked the viewer are subtracted from discovery EXCEPT where
    // the pair already has a private room — see `isBlockedByPeer`. A block
    // unfriends, so in practice this set is only non-empty for a stale replica;
    // computing it once keeps the two buckets on one rule.
    const hiddenWithoutRoom = new Set(
      [...hiddenIds].filter((id) => !peerRoomByUserId.has(id))
    );
    const friendIds = getFriendPeerIds(viewerId, relationships).filter(
      (id) => !hiddenWithoutRoom.has(id)
    );
    // Resolved once and reused by both buckets — a FRIENDS_OF_FRIENDS target is
    // discoverable when the viewer shares at least one mutual friend with them.
    const viewerGraph = await friendshipRepository.resolveViewerGraph(
      viewerId,
      friendIds
    );
    // Reused for the `whoCanSendFriendRequests` gate on every row below.
    const fofIds = new Set(viewerGraph.friendOfFriendIds);

    const toItem = (p: BasicProfile) =>
      toUserItem(
        p,
        peerRoomByUserId.get(p.userId) ?? null,
        relationshipOf(p.userId),
        fofIds,
        blockedByMe,
        hiddenIds
      );

    // ---------------------------------------------------------------------
    // Chat — max 10: accepted friends (isFriend === true), regardless of
    // whether a private room exists yet, + groups the viewer actively
    // belongs to. Skipped entirely on a cursor page — it is a bounded head,
    // not a paged list, so re-fetching it would only duplicate rows.
    // ---------------------------------------------------------------------
    // Exact `@handle` head. Runs on EVERY page, not just the first: the row is
    // emitted on page 1 only (below), but its id has to leave the keyset on all
    // of them, or the hoisted row comes back a second time when the walk
    // reaches wherever its first name actually sorts.
    //
    // `normalizeForSearch` has already stripped the `@` and every separator, so
    // "@Smiley_Creatures", "smiley creatures" and "smileycreatures" are one
    // lookup against one indexed field.
    const normalizedQ = q ? normalizeForSearch(q) : "";
    const [exactHandleHit, chatUserProfiles, chatGroupSummaries] =
      await Promise.all([
        normalizedQ
          ? userProfileRepository.findDiscoverableByNormalizedUsername(
              normalizedQ,
              viewerGraph,
              [...peerRoomByUserId.keys()]
            )
          : Promise.resolve(null),
        !cursor && friendIds.length
          ? userProfileRepository.findUsersInList(friendIds, q, 0, CHAT_LIMIT)
          : Promise.resolve([]),
        cursor
          ? Promise.resolve([])
          : messagingGrpcClient.listActiveGroups(viewerId, q, CHAT_LIMIT),
      ]);

    // Self is never a search result, and a peer who blocked the viewer with no
    // conversation to open is subtracted everywhere else — the exact-handle
    // door does not get to be the exception to either.
    const exactHit =
      exactHandleHit &&
      exactHandleHit.userId !== viewerId &&
      !hiddenWithoutRoom.has(exactHandleHit.userId)
        ? exactHandleHit
        : null;
    const isExactFriend = exactHit
      ? friendIds.includes(exactHit.userId)
      : false;

    // ---------------------------------------------------------------------
    const chat: SearchResultItem[] = [];
    const chatGroupIds: string[] = [];
    if (!cursor) {
      // Friends with an existing room sort by recency first; roomless friends
      // fall to the end in query order — then the handle tiers reorder on top,
      // so an exact/prefix handle match outranks a name-only one either way.
      chatUserProfiles.sort(
        (a, b) =>
          (roomOrderIndex.get(a.userId) ?? Infinity) -
          (roomOrderIndex.get(b.userId) ?? Infinity)
      );
      const chatRanked = rankByUsername(chatUserProfiles, q);
      // An exact-handle FRIEND belongs in this bucket, and must lead it even
      // when their first name put them past CHAT_LIMIT in the query above.
      const chatHead =
        exactHit && isExactFriend
          ? [
              exactHit,
              ...chatRanked.filter((p) => p.userId !== exactHit.userId),
            ]
          : chatRanked;

      // Rows are independent, so the per-row avatar headObject + presigns run
      // together rather than one round-trip after another.
      chat.push(
        ...(await Promise.all(chatHead.slice(0, CHAT_LIMIT).map(toItem)))
      );
      // Groups get their OWN CHAT_LIMIT rather than whatever the friends left
      // over. They are a different category, not a competitor: sharing one
      // budget meant a query matching ten friends returned zero groups, which
      // reads as "you have no such group" on a Group tab that is groups-only.
      for (const g of chatGroupSummaries.slice(0, CHAT_LIMIT)) {
        chat.push(await toGroupItem(g));
        chatGroupIds.push(g.roomId);
      }
    }

    // ---------------------------------------------------------------------
    // Other — max `limit` (default 10, paginated): non-friends (isFriend
    // === false), plus groups the viewer is no longer an active member of but
    // which are STILL in their conversation list (left/removed, conversation
    // not deleted). Groups the viewer has no relationship with never reach
    // this bucket — chat-service enforces that, not this filter. A user here
    // may still carry a `roomId` (e.g. unfriended peers) — that's fine,
    // roomId is conversation metadata only and plays no role in bucketing.
    // ---------------------------------------------------------------------
    const excludeUserIds = [
      viewerId,
      // Blocks are one-way: only users who blocked the VIEWER are removed, and
      // then only when the pair has no conversation to open. Users the viewer
      // blocked stay searchable to their own blocker, carrying `isBlockedByMe`
      // so the row renders as blocked rather than addable.
      ...hiddenWithoutRoom,
      ...friendIds, // only accepted friends are excluded from "other"
      // The exact-handle head is served ONCE, above the page. Leaving it in the
      // keyset would serve it a second time when the walk reaches its first
      // name, so it is excluded on every page — including the ones that do not
      // emit it, which is the page the duplicate would have landed on.
      ...(exactHit ? [exactHit.userId] : []),
    ];
    const [otherUserProfiles, otherGroupSummaries] = await Promise.all([
      // One row past the page: its presence is `hasMore`, and it is sliced off
      // before mapping so it never reaches the client.
      userProfileRepository.findUsersNotInList(
        excludeUserIds,
        q,
        skip,
        otherTake + 1,
        viewerGraph,
        cursor,
        // Same carve-out `hiddenWithoutRoom` makes for blocks, applied to
        // `whoCanFindMe`: a peer the viewer already has a private conversation
        // with is in their inbox anyway, so hiding the row here only made the
        // two doors disagree about the same pair. It widens the ROW alone —
        // presence and the friend-request action keep their own scopes.
        [...peerRoomByUserId.keys()]
      ),
      cursor
        ? Promise.resolve([])
        : messagingGrpcClient.listOtherGroups(
            viewerId,
            q,
            chatGroupIds,
            otherTake
          ),
    ]);

    const otherPage = otherUserProfiles.slice(0, otherTake);
    // An exact-handle NON-friend leads this bucket on page 1. It rides ON TOP of
    // the page rather than inside it: trimming a keyset row to make room would
    // move `nextCursor` back a row and skip whatever it displaced.
    const otherHead =
      exactHit && !isExactFriend && !cursor
        ? [exactHit, ...rankByUsername(otherPage, q)]
        : rankByUsername(otherPage, q);
    const other: SearchResultItem[] = await Promise.all(otherHead.map(toItem));
    // Own budget, same reason as the `chat` half above — a full page of people
    // must not silently swallow the whole group category.
    for (const g of otherGroupSummaries.slice(0, otherTake)) {
      other.push(await toGroupItem(g));
    }

    const hasMore = otherUserProfiles.length > otherTake;
    // The keyset boundary, NOT the ranked head: `rankByHandle` reorders the page
    // for display only, and paging from a re-sorted last row would re-walk rows
    // the caller already has.
    const last = otherPage.at(-1);
    return {
      // Omitted, not emptied, on a cursor page — an empty array would read as
      // "the viewer has no matching friends", which is a different claim.
      ...(cursor ? {} : { chat }),
      other,
      hasMore,
      nextCursor: hasMore && last ? encodePeopleCursor(last) : null,
    };
  },
};
