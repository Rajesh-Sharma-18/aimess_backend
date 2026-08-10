import type { UserClient } from "../grpc/clients/user.client.js";

/**
 * The two reciprocal Settings → Chat switches, applied at DELIVERY time.
 *
 * WhatsApp's rule for both the typing indicator and read receipts: turning your
 * own switch off also stops you seeing everyone else's. The sender side is
 * gated where the event is produced (typing:start in each namespace, the
 * `message:read` publish in chat-service); this module is the other half — the
 * recipient side, which is the only place reciprocity can be enforced, because
 * a single broadcast has many viewers with different settings.
 *
 * Every lookup is served by `userClient.getChatFlags`'s per-user TTL cache, so
 * a fan-out to N viewers costs at most N cached reads, not N round trips.
 */

/** Keep only the viewers who still show typing indicators. */
export function typingViewerFilter(
  userClient: UserClient
): (userIds: string[]) => Promise<string[]> {
  return async (userIds) => {
    const flags = await Promise.all(
      // Fail OPEN per viewer: a lookup that blows up must not silently stop the
      // indicator reaching someone who never opted out.
      userIds.map((id) =>
        Promise.resolve()
          .then(() => userClient.getChatFlags(id))
          .catch(() => ({ typingIndicators: true, readReceipts: true }))
      )
    );
    return userIds.filter((_, i) => flags[i]!.typingIndicators);
  };
}

/** True when this viewer has opted out of seeing others' read receipts. */
export async function viewerHidesReadReceipts(
  userClient: UserClient,
  viewerUserId: string
): Promise<boolean> {
  if (!viewerUserId) return false;
  // Fail OPEN: a failed lookup must never swallow a receipt for a viewer who
  // never opted out — the whole delivery is skipped when this says true.
  const flags = await Promise.resolve()
    .then(() => userClient.getChatFlags(viewerUserId))
    .catch(() => null);
  return flags ? !flags.readReceipts : false;
}
