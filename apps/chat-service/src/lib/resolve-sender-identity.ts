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
  // A BLANK name must not short-circuit the lookup — socket callers routinely pass "" for
  // their own identity, and returning it verbatim renders the push as "Someone".
  if (senderName && senderAvatar) {
    return { senderName, senderAvatar };
  }
  const snaps = await userSnapshotService.getUserSnapshotsMap(
    [senderId],
    cacheRepo
  );
  const snap = snaps.get(senderId);
  const resolvedName = resolveDisplayName(snap);
  return {
    // "Unknown User" stays empty on the wire so each client renders its own localized
    // fallback instead of a hardcoded English string.
    senderName:
      senderName || (resolvedName === "Unknown User" ? "" : resolvedName),
    senderAvatar: senderAvatar || (snap?.avatar as string) || "",
  };
}
