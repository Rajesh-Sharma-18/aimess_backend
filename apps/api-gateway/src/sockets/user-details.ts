import type { UserClient } from "../grpc/clients/user.client.js";
import type { MediaClient } from "../grpc/clients/media.client.js";
import { logger } from "@aimess/logger";

export interface SocketUserDetails {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Resolve a socket user's display identity ONCE per namespace connection
 * (handshake), so typing broadcasts can carry sender identity without a
 * per-event profile fetch. Pulls the snapshot over gRPC (UserService) and
 * presigns the avatar over the media client.
 *
 * Never throws and never blocks the socket: any failure (breaker open, missing
 * snapshot, media error) degrades to a safe shape with empty fields + null
 * avatar. `userId` is always the authenticated socket user — never client-trusted.
 */
export async function resolveSocketUserDetails(
  userClient: UserClient,
  mediaClient: MediaClient,
  userId: string,
  fallbackDisplayName = ""
): Promise<SocketUserDetails> {
  const degraded: SocketUserDetails = {
    userId,
    username: "",
    displayName: fallbackDisplayName,
    avatarUrl: null,
  };
  try {
    const snaps = await userClient.bulkGetUserSnapshots([userId]);
    const snap = snaps?.find((s) => s.userId === userId);
    if (!snap) return degraded;

    let avatarUrl: string | null = null;
    const key = snap.avatarObjectKey?.trim();
    if (key) {
      // USER_AVATAR downloads have no ownership gate, so requesterId:userId is fine.
      const dl = await mediaClient.generateDownloadUrl({
        objectKey: key,
        category: "USER_AVATAR",
        requesterId: userId,
      });
      avatarUrl = dl?.downloadUrl ?? null;
    }
    return {
      userId,
      username: snap.username ?? "",
      displayName: snap.displayName || fallbackDisplayName,
      avatarUrl,
    };
  } catch (err) {
    logger.warn(
      `resolveSocketUserDetails failed for ${userId}: ${String(err)}`
    );
    return degraded;
  }
}

/** Pure builder for the typing broadcast body — shared by all chat + community sites. */
export function buildTypingBroadcast(
  userId: string,
  userDetails: SocketUserDetails,
  conversationId: string,
  timestamp: number,
  opts?: { senderName?: string; communityId?: string }
) {
  return {
    conversationId,
    ...(opts?.communityId ? { communityId: opts.communityId } : {}),
    userId,
    userDetails,
    timestamp,
    senderName: userDetails.displayName || opts?.senderName || "",
  };
}
