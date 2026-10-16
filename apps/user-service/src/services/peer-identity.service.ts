import { DELETED_ACCOUNT_DISPLAY_NAME } from "@aimess/constants";

import { ProfileStatus } from "../generated/prisma/client.js";
import { messagingGrpcClient } from "../grpc/messaging.client.js";
import { buildDisplayName } from "../lib/profile-fields.util.js";
import { allocatedUsername } from "../lib/username.util.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { avatarService } from "./avatar.service.js";

export interface PeerIdentity {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isDeleted: boolean;
}

export const peerIdentityService = {
  /**
   * Identities of the caller's private-chat peers, in one call. Ids the caller shares no private
   * room with are dropped (not an error) so this can't be used to enumerate accounts; a messaging
   * outage resolves to no rooms, i.e. fails closed.
   */
  async identitiesFor(viewerId: string, userIds: string[]): Promise<PeerIdentity[]> {
    const requested = [...new Set(userIds)];
    const peers = new Set(
      (await messagingGrpcClient.resolvePrivateRooms(viewerId, requested)).map((m) => m.peerUserId)
    );
    if (requested.includes(viewerId)) peers.add(viewerId);
    if (peers.size === 0) return [];

    const ids = [...peers];
    const [profiles, { blockedByIds }] = await Promise.all([
      userProfileRepository.findManyByUserIds(ids),
      friendshipRepository.findRelationshipsForUser(viewerId, ids),
    ]);

    return Promise.all(
      profiles.map(async (p): Promise<PeerIdentity> => {
        const isDeleted = Boolean(p.deletedAt) || p.status === ProfileStatus.DELETED;
        if (isDeleted) {
          return { userId: p.userId, username: "", displayName: DELETED_ACCOUNT_DISPLAY_NAME, avatarUrl: null, isDeleted };
        }
        // Same rule as the public profile: a blocker's photo is hidden from the person they blocked.
        const avatar = blockedByIds.has(p.userId)
          ? null
          : await avatarService.resolveViewUrlForClient(p.avatarUrl);
        return {
          userId: p.userId,
          username: allocatedUsername(p),
          displayName: buildDisplayName(p.firstName, p.lastName),
          avatarUrl: avatar?.url ?? null,
          isDeleted,
        };
      })
    );
  },
};
