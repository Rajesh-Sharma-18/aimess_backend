import type { UserSnapshotService } from "../services/user-snapshot.service.js";
import { resolveDisplayName } from "../services/user-snapshot.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";

/**
 * Resolve a sender's display name + avatar from the user snapshot when the
 * caller did not already supply them. Uses the shared fullName → displayName
 * → username → memberId → "Unknown User" fallback chain so an empty computed
 * displayName still yields a real sender name. Best-effort: a snapshot miss
 * yields empty strings (never throws). Shared by the orchestrator (REST/socket)
 * and the gRPC service-impl handlers so both resolve identity the same way.
 */
export async function resolveSenderIdentity(
  userSnapshotService: UserSnapshotService,
  cacheRepo: CacheRepository,
  senderId: string,
  senderName?: string,
  senderAvatar?: string
): Promise<{ senderName: string; senderAvatar: string }> {
  if (senderName !== undefined && senderAvatar !== undefined) {
    return { senderName, senderAvatar };
  }
  const snaps = await userSnapshotService.getUserSnapshotsMap(
    [senderId],
    cacheRepo
  );
  const snap = snaps.get(senderId);
  const resolvedName = resolveDisplayName(snap);
  return {
    senderName: senderName ?? resolvedName,
    senderAvatar: senderAvatar ?? ((snap?.avatar as string) || ""),
  };
}
