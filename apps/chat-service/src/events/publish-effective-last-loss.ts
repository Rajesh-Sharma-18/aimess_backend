/**
 * The delete-for-everyone fan-out for members whose EFFECTIVE last message was
 * removed while the SHARED snapshot did not move.
 *
 * `recalculateLastMessageAfterDelete` returns null when the removed message was
 * not the room's shared last one — correct for the shared snapshot, which really
 * did not change — and every delete path used to publish nothing at all in that
 * case. But a member who had personally hidden (delete-for-me) every message
 * NEWER than the removed one was still previewing it, so their list row kept a
 * message that no longer exists for anybody:
 *
 *   A sends "Hey" then "Hello"  →  shared last = "Hello"
 *   A deletes "Hello" for me    →  A's row previews "Hey" (shared last untouched)
 *   admin deletes "Hey" for all →  shared last still "Hello" ⇒ recalc null ⇒
 *                                  A's row stayed on "Hey" until a refetch
 *
 * These helpers publish the targeted bump those members never got. Nothing is
 * published when no member had hidden the shared last message (the common case),
 * so a normal delete costs exactly one extra `hidersAmong` lookup.
 *
 * Unread badges are deliberately untouched here: the removed message was not the
 * shared last, so this is a preview correction only — the badge story for a
 * non-last delete is the same before and after this change.
 */
import type { Redis, Cluster } from "ioredis";
import { logger } from "@aimess/logger";
import {
  publishCommunityUpdatedSafe,
  publishConvUpdatedSafe,
} from "./publish-conv-updated.js";
import type { RecipientOverride } from "../services/last-visible-resolver.js";
import {
  renderCommunityOverrides,
  renderConvOverrides,
} from "../lib/recipient-override-render.js";
import { getCommunityReconcileClient } from "../grpc/community.client.js";
import { convertMessageToPreview } from "../services/message-preview.service.js";

type Losers = Map<string, RecipientOverride | null>;

/** Empty shared bump: every recipient here carries a per-recipient override, so
 *  these top-level fields only supply the "nothing visible left" fallback that a
 *  null override falls back to (`lastMessageAt: 0` ⇒ row sorts to the bottom,
 *  never to the top — see bumpTimestampAfterDelete's contract). */
const EMPTY_SHARED = {
  senderId: "",
  senderName: "",
  lastMessageId: "",
  lastMessageAt: 0,
  preview: { contentType: "", text: "" },
} as const;

/**
 * This is a best-effort PREVIEW correction on top of a delete that has already
 * committed. It must never surface to the caller: the community gRPC delete path
 * awaits it BEFORE its ack, so a thrown error there would turn a successful
 * delete into an INTERNAL_ERROR. The list self-corrects on the next fetch.
 */
async function resolveSafely(
  roomId: string,
  resolve: () => Promise<Losers>
): Promise<Losers> {
  try {
    return await resolve();
  } catch (err) {
    logger.warn(
      `effectiveLastLoss|resolve failed roomId=${roomId}: ${String(err)}`
    );
    return new Map();
  }
}

/** Private/group (`conv:updated`). */
export async function publishConvEffectiveLastLoss(p: {
  redis: Redis | Cluster;
  type: "PRIVATE" | "GROUP";
  roomId: string;
  /** Every member/participant — the candidate set the losers are found among.
   *  A thunk so the fetch itself is inside this module's failure guard. */
  recipientIds: () => Promise<string[]>;
  /** The removed message's `sequenceNumber` — the ordering key the losers are
   *  decided on (see `deletedWasEffectiveLast`). */
  deletedMessageSeq: number;
  resolveLosers: (
    roomId: string,
    deletedMessageSeq: number,
    recipientIds: string[]
  ) => Promise<Losers>;
  /** The DELETE's own room revision — see the deleteRecalc branches. */
  projectionRevision?: number;
}): Promise<void> {
  const losers = await resolveSafely(p.roomId, async () =>
    p.resolveLosers(p.roomId, p.deletedMessageSeq, await p.recipientIds())
  );
  if (!losers.size) return;
  const overrides = renderConvOverrides(losers);
  publishConvUpdatedSafe({
    redis: p.redis,
    type: p.type,
    roomId: p.roomId,
    // ONLY the affected members: every other row is still correct and must not
    // be handed the empty shared preview below.
    recipientIds: [...losers.keys()],
    resolveOverrides: () => Promise.resolve(overrides),
    // Without this the bump is discarded by the client's monotonic list guard —
    // it points BACKWARD at the member's previous visible message.
    deleteRecalc: true,
    ...(p.projectionRevision !== undefined
      ? { projectionRevision: p.projectionRevision }
      : {}),
    ...EMPTY_SHARED,
  });
}

/** Community (`community:updated`) + the persisted self-hide overlay. */
export async function publishCommunityEffectiveLastLoss(p: {
  redis: Redis | Cluster;
  communityId: string;
  roomId: string;
  /** Every member — see the conv helper's `recipientIds`. */
  memberIds: () => Promise<string[]>;
  deletedMessageId: string;
  /** See the conv helper's `deletedMessageSeq`. */
  deletedMessageSeq: number;
  resolveLosers: (
    roomId: string,
    deletedMessageSeq: number,
    recipientIds: string[]
  ) => Promise<Losers>;
}): Promise<void> {
  const losers = await resolveSafely(p.roomId, async () =>
    p.resolveLosers(p.roomId, p.deletedMessageSeq, await p.memberIds())
  );
  if (!losers.size) return;

  // PERSISTENCE, not just realtime: community is the one surface that stores the
  // delete-for-me preview (`lastActivitySelfPreview`, written by the
  // delete-for-me path). That overlay carries no message identity, so nothing
  // invalidated it when the message it previewed was later deleted for everyone
  // — GET /communities/mine kept returning the removed message's text across
  // reloads. Rewriting it with the member's recomputed preview ("" = nothing
  // visible left) is what makes the fix survive a refresh.
  //
  // ponytail: the overlay is a SINGLE slot (one lastActivityUserId), so with two
  // or more losers only the last write is retained and the others fall back to
  // the canonical preview until the next real bump — the same pre-existing
  // ceiling delete-for-me already has. Per-member storage is the upgrade path.
  for (const [userId, override] of losers) {
    try {
      await getCommunityReconcileClient().updateMessageActivity({
        communityId: p.communityId,
        selfUserId: userId,
        // Same renderer `renderCommunityOverrides` uses for the socket preview,
        // so the persisted overlay and the realtime bump never disagree.
        selfPreview: override
          ? convertMessageToPreview(override.messageType, override.content)
          : "",
      });
    } catch (err) {
      logger.warn(
        `effectiveLastLoss|self overlay failed communityId=${p.communityId} userId=${userId}: ${String(err)}`
      );
    }
  }

  const overrides = renderCommunityOverrides(losers);
  publishCommunityUpdatedSafe({
    redis: p.redis,
    communityId: p.communityId,
    roomId: p.roomId,
    // ONLY the affected members — see the conv helper above.
    fetchMembers: () => Promise.resolve([...losers.keys()]),
    resolveOverrides: () => Promise.resolve(overrides),
    deleteRecalc: true,
    deleteRecalcId: p.deletedMessageId,
    ...EMPTY_SHARED,
  });
}
