import { randomUUID } from "node:crypto";
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

    // The avatar is a NICE-TO-HAVE; the name is the whole point of this call.
    // Resolving it must never be able to take the identity down with it — a
    // presign that rejects (media-service down, breaker open, or the antivirus
    // gate in generateDownloadUrl refusing an unscanned avatar) used to fall
    // through to the outer catch and return the degraded shape, which is what
    // made peers render "Someone is typing…" for a user with a perfectly good
    // name. Scoped catch, so a bad avatar costs the avatar and nothing else.
    let avatarUrl: string | null = snap.avatarUrl?.trim() || null;
    const key = snap.avatarObjectKey?.trim();
    if (!avatarUrl && key) {
      try {
        // USER_AVATAR downloads have no ownership gate, so requesterId:userId is fine.
        const dl = await mediaClient.generateDownloadUrl({
          objectKey: key,
          category: "USER_AVATAR",
          requesterId: userId,
        });
        avatarUrl = dl?.downloadUrl ?? null;
      } catch (avatarErr) {
        logger.warn(
          `resolveSocketUserDetails avatar presign failed for ${userId}: ${String(avatarErr)}`
        );
      }
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

/**
 * Re-resolve a good identity this often. Well under the 1 h avatar presign
 * (MINIO_AVATAR_VIEW_EXPIRES_IN), so a long-lived socket never broadcasts an
 * expired avatar URL, and a renamed / re-avatared user shows up within minutes
 * without reconnecting. One gRPC call per socket per window — never per keystroke.
 */
export const SOCKET_IDENTITY_TTL_MS = 5 * 60_000;
/** A degraded (nameless) lookup is retried this soon instead of kept for the whole connection. */
export const SOCKET_IDENTITY_RETRY_MS = 5_000;

export interface SocketIdentity {
  /** Last resolved value (the nameless default until the first lookup lands). */
  readonly current: SocketUserDetails;
  /**
   * Identity for a presence broadcast. Waits only while no usable name has ever
   * been resolved (first frames after connect, or after a failed lookup) —
   * otherwise returns the cached value at once and refreshes in the background.
   */
  get(): Promise<SocketUserDetails>;
}

const hasName = (d: SocketUserDetails) => Boolean(d.displayName || d.username);

/**
 * Per-socket cache around {@link resolveSocketUserDetails}. The identity comes
 * only from the authenticated `userId` — nothing the client sends reaches it.
 */
export function createSocketIdentity(
  userClient: UserClient,
  mediaClient: MediaClient,
  userId: string,
  onResolved?: (details: SocketUserDetails) => void
): SocketIdentity {
  let current: SocketUserDetails = {
    userId,
    username: "",
    displayName: "",
    avatarUrl: null,
  };
  let expiresAt = 0;
  let pending: Promise<SocketUserDetails> | null = null;

  const refresh = (): Promise<SocketUserDetails> => {
    pending ??= resolveSocketUserDetails(userClient, mediaClient, userId)
      .then((d) => {
        // A degraded refresh must not wipe a name we already had.
        if (hasName(d) || !hasName(current)) current = d;
        expiresAt =
          Date.now() +
          (hasName(d) ? SOCKET_IDENTITY_TTL_MS : SOCKET_IDENTITY_RETRY_MS);
        onResolved?.(current);
        return current;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  // Warm at connect so the first keystroke rarely has to wait.
  void refresh();

  return {
    get current() {
      return current;
    },
    get() {
      if (Date.now() < expiresAt) return Promise.resolve(current);
      if (hasName(current)) {
        void refresh();
        return Promise.resolve(current);
      }
      return refresh();
    },
  };
}

/**
 * Pure builder for the typing / recording presence broadcast body — the single
 * shape emitted by BOTH /chat (private + group) and /community.
 *
 * Canonical fields (all namespaces): `eventId`, `roomId`, `userId`,
 * `userDetails`, `timestamp`, `senderName`.
 *
 * Back-compat fields, deliberately kept and NOT removed:
 *  - `conversationId` — /chat clients (Web/Android/iOS) key typing state off it.
 *  - `communityId`    — /community clients key typing state off it; emitted only
 *                       when the caller passes it (i.e. on /community).
 * Both are duplicates of `roomId`; new clients should read `roomId` only.
 */
export function buildTypingBroadcast(
  userId: string,
  userDetails: SocketUserDetails,
  conversationId: string,
  timestamp: number,
  opts?: { communityId?: string; eventId?: string }
) {
  return {
    // Idempotency/dedupe key — /community has always carried this; /chat now
    // does too so clients can de-dup presence events identically everywhere.
    eventId: opts?.eventId ?? randomUUID(),
    roomId: conversationId,
    conversationId,
    ...(opts?.communityId ? { communityId: opts.communityId } : {}),
    userId,
    userDetails,
    timestamp,
    // `displayName` is server-derived from firstName+lastName (buildDisplayName)
    // and is EMPTY for any user who never set a name — fall back to `username`
    // (always set at signup). Server-derived only: a client-supplied name used to
    // fill in when the lookup degraded, which let any member broadcast
    // "<someone else> is typing".
    senderName: userDetails.displayName || userDetails.username || "",
  };
}
