import { logger } from "@aimess/logger";

import type { Redis, Cluster } from "ioredis";
import type {
  CommunityInvitationSystemAction,
  GroupInvitationSystemAction,
} from "../lib/chat-message.serializer.js";
import { notifyUnreadChanged } from "./unread-summary-bridge.js";

/**
 * WhatsApp/Telegram-style "bump-to-top" fan-out for the inbox/community list.
 *
 * Each function publishes one message per participant/member to that user's
 * personal `user:<userId>` Redis channel. The gateway's `/chat` namespace
 * psubscribes `user:*` and re-emits `{event,data}` to the `user:<id>` socket
 * room, so the client receives a `conv:updated` / `community:updated` event and
 * can re-sort its list without a refetch.
 *
 * Best-effort: a publish failure is logged (never thrown) so a bump can never
 * fail the underlying message send.
 */

interface BumpPreview {
  contentType: string;
  text: string;
  /**
   * Offline-first identity/freshness quartet for the previewed message (see
   * lib/list-row-identity.ts). ADDITIVE and optional: a caller that omits them
   * publishes exactly the payload it always did, and the publisher fills the
   * documented defaults (null / 0) so the shape stays single and stable.
   */
  clientMessageId?: string | null;
  seq?: number;
  revision?: number;
  /** epoch ms — the previewed message's own createdAt (== the row's
   *  `lastMessageAt`, nested here so `lastMessage` is self-describing). */
  createdAt?: number;
  /**
   * COMMUNITY_INVITATION cards only — mirrors the message's `systemAction`
   * (see `chat-message.serializer.ts`) so the inbox/list row can render an
   * "Invitation" chip and navigate straight to the community without a
   * refetch. Passed straight through into the bumped `lastMessage`.
   */
  systemAction?: CommunityInvitationSystemAction | GroupInvitationSystemAction;
  /**
   * SYSTEM rows only — the canonical event behind `text`, so the gateway can
   * re-render the sentence in each recipient's own language instead of fanning
   * out the one baked at write time (`STORED_TEXT_LOCALE`, English). See
   * `api-gateway/src/sockets/system-message-personalize.ts`.
   *
   * `systemEvent`/`systemData` are the private+group pair (the same names the
   * message row and `message:new` use); `systemMessageType`/`systemMetadata` are
   * the community pair. Optional: a bump without them keeps `text` verbatim, so
   * every non-SYSTEM caller and every already-published payload is unchanged.
   */
  systemEvent?: string;
  systemData?: Record<string, unknown>;
  systemMessageType?: string;
  systemMetadata?: Record<string, unknown>;
}

/**
 * A per-recipient override of the bumped list preview. Used by the
 * delete-for-everyone fan-out so a recipient who has personally hidden the new
 * shared previous-visible message receives THEIR own visible preview instead.
 * `null` => that recipient has no visible message (render the empty state).
 */
export interface RecipientBump {
  lastMessageId: string;
  /** epoch ms */
  lastMessageAt: number;
  senderId: string;
  senderName: string;
  preview: BumpPreview;
}

interface PublishConvUpdatedParams {
  redis: Redis | Cluster;
  type: "PRIVATE" | "GROUP";
  roomId: string;
  recipientIds: string[];
  senderId: string;
  /**
   * Sender's live display name — the group inbox row's "<name>: <preview>"
   * prefix, and the input to the gateway's "You:"-personalization (which
   * requires both senderId AND senderName).
   *
   * REQUIRED, exactly like `publishCommunityUpdated`'s field of the same name.
   * It used to be optional, and the socket send path (gRPC `sendMessage`)
   * simply never passed it — so every group row bumped in realtime published
   * `senderName: ""` while the REST inbox, reading the same denormalized
   * `GroupRoom.lastMessagePreview`, returned the real name. The list therefore
   * lost its sender prefix the moment a message arrived live and got it back on
   * the next refetch. Community never had that bug for one reason only: its
   * publisher makes the field mandatory. Pass `""` ONLY for a genuinely
   * sender-less row (SYSTEM lines, call cards, an emptied conversation).
   */
  senderName: string;
  lastMessageId: string;
  /** epoch ms */
  lastMessageAt: number;
  preview: BumpPreview;
  /** Persisted unread policy for the new row (SYSTEM call audit rows pass false). */
  countInUnread?: boolean;
  /** Optional per-recipient preview overrides (key present => override applies;
   *  value null => empty preview for that recipient). */
  recipientOverrides?: Map<string, RecipientBump | null>;
  /**
   * Self-referential SYSTEM line personalization (mirrors
   * `publishCommunityUpdated`'s subjectUserId/selfPreview): when set, the one
   * recipient whose id === `subjectUserId` receives `selfPreview` ("You were
   * added to the group" / "Alex promoted you to admin") in place of
   * `preview.text`, while every other recipient gets the third-person
   * `preview` unchanged. Ignored when a delete-recalc override applies.
   */
  subjectUserId?: string;
  selfPreview?: string;
  /**
   * Viewer-scoped online-status lookup (reuses
   * `PresenceService.getPresenceFor`, i.e. the same `presence:user:<id>` Redis
   * source the REST conversation APIs read, behind the same
   * `whoCanSeeOnlineStatus` gate). When supplied for `type: "PRIVATE"`, each
   * recipient's payload gets an `isOffline` field for the OTHER participant in
   * the room — reported offline when that participant has hidden their
   * presence from this recipient. Omitted entirely for GROUP (no single
   * "peer") or when not supplied.
   */
  getIsOnline?: (viewerId: string, subjectId: string) => Promise<boolean>;
  /**
   * Absolute per-recipient unread after this bump. When set, the client SETs
   * the row badge to this value instead of blind +1 (albums / multi-row sends
   * would otherwise desync list badges from chat:unread_summary).
   */
  unreadCountByRecipient?: Record<string, number>;
  /**
   * This bump is a post-DELETE recalculation, not new activity.
   *
   * Clients keep a monotonic staleness guard on the list row ("ignore a bump
   * older than what I already show") so an out-of-order send can never drag a
   * conversation backwards. A delete recalc is the one legitimate BACKWARD
   * move — `lastMessageAt` points at the PREVIOUS visible message (or 0 when
   * nothing visible remains) — so without this marker every delete bump was
   * silently discarded by that guard and the row kept the deleted message's
   * timestamp/preview until the next refetch. Also forces `unread: false`, since
   * a recalc must never raise a badge.
   */
  deleteRecalc?: boolean;
  /**
   * Monotonic version of the ROOM PROJECTION this payload describes — the
   * room's `lastRevision` at the mutation that produced it.
   *
   * `lastMessageAt` cannot order projection updates, because a delete
   * legitimately moves it BACKWARD (to the previous surviving message, or to
   * nothing at all). A client comparing timestamps cannot tell that from a
   * stale bump, which is exactly why `deleteRecalc` had to be invented as an
   * override — and an override is not an ordering. With this field the client
   * keeps ONE rule for every payload: apply if `projectionRevision` is greater
   * than what it holds, ignore otherwise, whichever way the timestamp moved.
   *
   * Deliberately NOT `lastMessage.revision`: that is the previewed MESSAGE's
   * own revision, which for a delete-recalc points at the older surviving
   * message and therefore goes backwards with it.
   */
  projectionRevision?: number;
  /**
   * This bump changes the row's PREVIEW ONLY — never its position in the list,
   * never its badge.
   *
   * Reactions are the one activity that is published as a bump but is not
   * conversation activity: "You reacted 🔥 to 'hi'" is an overlay line the
   * actor (and the reacted-to message's owner) see in place of the real last
   * message, while the canonical `lastMessageAt` the list SORTS on is
   * deliberately never touched (see `setReactionActivity`). The bump has to
   * carry `lastMessageAt: now` anyway so the overlay's own timestamp is
   * expressible — which is exactly what made every client re-sort the row to
   * the top and blink. This flag says "paint the preview, leave the row where
   * it is", so a reaction can update the subtitle without reordering.
   *
   * Additive: a client that does not know the field keeps its previous
   * behavior, so no client is broken by shipping this ahead of them.
   */
  activityOnly?: boolean;
}

/** Empty per-recipient preview (the recipient has hidden every message). */
const EMPTY_BUMP_PREVIEW: BumpPreview = { contentType: "", text: "" };

/**
 * The ONE documented `lastMessage` shape both bumps emit. Every field is always
 * present (defaults null/0/"") so a consumer never has to support several
 * shapes — the exact complaint the offline-first clients raised. The caller's
 * `senderId`/`senderName`/`lastMessageAt` are mirrored INTO the object as well
 * as staying at the top level, so the existing top-level fields keep working
 * byte-for-byte while `lastMessage` becomes self-describing.
 */
function bumpLastMessage(
  preview: BumpPreview,
  ctx: { senderId: string; senderName: string; createdAt: number }
): Record<string, unknown> {
  return {
    ...preview,
    clientMessageId: preview.clientMessageId ?? null,
    seq: preview.seq ?? 0,
    revision: preview.revision ?? 0,
    senderId: ctx.senderId,
    senderName: ctx.senderName,
    createdAt: preview.createdAt ?? ctx.createdAt,
  };
}

/**
 * Fire-and-forget `conv:updated` bump. The recipient list may be supplied
 * directly (private chats, where ids are already in hand) or resolved lazily
 * via `fetchRecipients` (group chats, where the member-id fetch lives in the
 * service). Both the fetch and the publish run inside a non-awaited IIFE so the
 * send path never blocks on Redis or the DB; any error is logged, never thrown.
 */
type PublishConvUpdatedSafeParams = Omit<
  PublishConvUpdatedParams,
  "recipientIds" | "recipientOverrides" | "unreadCountByRecipient"
> &
  (
    | { recipientIds: string[]; fetchRecipients?: never }
    | { recipientIds?: never; fetchRecipients: () => Promise<string[]> }
  ) & {
    /** Lazily compute per-recipient overrides once the recipient list is known
     *  (used by the delete-for-everyone fan-out). */
    resolveOverrides?: (
      recipientIds: string[]
    ) => Promise<Map<string, RecipientBump | null>>;
    /** Lazily resolve absolute unread counts after the unread write has landed. */
    resolveUnreadCounts?: (
      recipientIds: string[]
    ) => Promise<Record<string, number>>;
  };

export function publishConvUpdatedSafe(p: PublishConvUpdatedSafeParams): void {
  void (async () => {
    const recipientIds = p.recipientIds ?? (await p.fetchRecipients());
    // Isolate per-recipient override resolution: it issues extra DB queries, and
    // a transient failure there must NOT suppress the bump for EVERY recipient
    // (the shared preview is correct for the vast majority who hid nothing).
    let recipientOverrides: Map<string, RecipientBump | null> | undefined;
    if (p.resolveOverrides) {
      try {
        recipientOverrides = await p.resolveOverrides(recipientIds);
      } catch (err) {
        logger.warn(
          `conv:updated override resolution failed for ${p.roomId}; falling back to shared preview: ${String(err)}`
        );
      }
    }
    let unreadCountByRecipient: Record<string, number> | undefined;
    if (p.resolveUnreadCounts) {
      try {
        unreadCountByRecipient = await p.resolveUnreadCounts(recipientIds);
      } catch (err) {
        logger.warn(
          `conv:updated unreadCount resolution failed for ${p.roomId}: ${String(err)}`
        );
      }
    }
    await publishConvUpdated({
      redis: p.redis,
      type: p.type,
      roomId: p.roomId,
      recipientIds,
      senderId: p.senderId,
      senderName: p.senderName,
      lastMessageId: p.lastMessageId,
      lastMessageAt: p.lastMessageAt,
      preview: p.preview,
      recipientOverrides,
      getIsOnline: p.getIsOnline,
      countInUnread: p.countInUnread,
      subjectUserId: p.subjectUserId,
      selfPreview: p.selfPreview,
      unreadCountByRecipient,
      deleteRecalc: p.deleteRecalc,
      projectionRevision: p.projectionRevision,
      activityOnly: p.activityOnly,
    });
  })().catch((error) => {
    logger.warn(
      `Failed to publish conv:updated for ${p.roomId}: ${String(error)}`
    );
  });
}

export async function publishConvUpdated(
  p: PublishConvUpdatedParams
): Promise<void> {
  const recipientIds = [...new Set(p.recipientIds)];
  if (recipientIds.length === 0) return;

  // Real-time peer presence (PRIVATE only — a room has exactly one "other"
  // participant per recipient). Reuses PresenceService.getIsOnline via the
  // caller-supplied `getIsOnline`, the same Redis source the REST conversation
  // APIs read, so socket + REST presence never disagree.
  // Keyed by RECIPIENT (the viewer), holding the OTHER participant's presence
  // as that recipient is allowed to see it — `getIsOnline` is viewer-scoped, so
  // a peer who hid their online status reads as offline here too.
  let onlineByViewer: Map<string, boolean> | undefined;
  if (p.type === "PRIVATE" && p.getIsOnline) {
    try {
      const entries = await Promise.all(
        recipientIds.map(async (viewerId): Promise<[string, boolean]> => {
          const subjectId = recipientIds.find((id) => id !== viewerId);
          return [
            viewerId,
            subjectId ? await p.getIsOnline!(viewerId, subjectId) : false,
          ];
        })
      );
      onlineByViewer = new Map(entries);
    } catch (err) {
      logger.warn(
        `conv:updated presence lookup failed for ${p.roomId}: ${String(err)}`
      );
    }
  }

  // Room-scoped and identical for every recipient: the projection mutation is
  // one event, however many personalized previews it fans out as.
  const projectionRevision = p.projectionRevision ?? p.preview.revision ?? 0;

  try {
    const pipeline = p.redis.pipeline();
    for (const recipientId of recipientIds) {
      // Per-recipient override (key present): a recipient who hid the shared
      // previous-visible message gets their own preview; null => empty preview.
      const hasOverride = p.recipientOverrides?.has(recipientId) ?? false;
      const override = hasOverride
        ? (p.recipientOverrides?.get(recipientId) ?? null)
        : undefined;
      const lastMessageId =
        override === undefined
          ? p.lastMessageId
          : (override?.lastMessageId ?? "");
      // Self-referential system line: the subject recipient sees "You …";
      // everyone else gets the third-person preview as-is. Only applies when
      // there's no delete-recalc override for this recipient.
      const lastMessage =
        override === undefined
          ? p.selfPreview && p.subjectUserId && recipientId === p.subjectUserId
            ? { ...p.preview, text: p.selfPreview }
            : p.preview
          : (override?.preview ?? EMPTY_BUMP_PREVIEW);
      const lastMessageAt =
        override === undefined
          ? p.lastMessageAt
          : (override?.lastMessageAt ?? p.lastMessageAt);
      const senderId =
        override === undefined ? p.senderId : (override?.senderId ?? "");
      const senderName =
        override === undefined
          ? (p.senderName ?? "")
          : (override?.senderName ?? "");
      // An override is a delete-recalc preview, never a NEW message — it must
      // never raise an unread badge (a null override has senderId "" which would
      // otherwise compute unread:true and show a phantom badge on an empty row).
      const isSystem =
        String(lastMessage.contentType ?? "").toUpperCase() === "SYSTEM";
      const effectiveSenderId = isSystem ? "" : senderId;
      const effectiveSenderName = isSystem ? "" : senderName;
      const absoluteUnread = p.unreadCountByRecipient?.[recipientId];
      // `recipientId !== senderId` is the only "is this mine?" test available for
      // a row with a real sender — but a call row is SENDER-LESS, so it holds for
      // BOTH participants and the CALLER's own unanswered outgoing call raised an
      // unread flag on their own inbox row. Where the authoritative per-recipient
      // count is in hand, let it veto: a recipient the room says has zero unread
      // never gets `unread: true`. It can only ever turn the flag off, so rows
      // without absolute counts keep their existing behavior exactly.
      const unread =
        override === undefined && !p.deleteRecalc && !p.activityOnly
          ? (p.countInUnread ?? !isSystem) &&
            recipientId !== effectiveSenderId &&
            absoluteUnread !== 0
          : false;
      const isOffline = onlineByViewer
        ? !(onlineByViewer.get(recipientId) ?? false)
        : undefined;
      // Nav-badge total changed for this recipient — single choke point for
      // every conv:updated caller (REST controllers, gRPC handlers, system
      // messages), see unread-summary-bridge.ts. A delete recalc changes the
      // total in the DOWNWARD direction (an unread message just vanished), which
      // the `unread` flag can never signal — so it has to push too, or the nav
      // badge keeps counting a message nobody can read any more.
      if (unread || p.deleteRecalc) notifyUnreadChanged(recipientId);
      pipeline.publish(
        `user:${recipientId}`,
        JSON.stringify({
          event: "conv:updated",
          data: {
            type: p.type,
            roomId: p.roomId,
            // Explicit emptiness. `lastMessageId: ""` and a preview whose
            // contentType is "" ALSO describe a thin payload that simply didn't
            // carry a preview, so a client could not tell "this room is now
            // empty, clear the row" from "I wasn't sent the details". This flag
            // says which, without changing either existing field.
            hasLastMessage: Boolean(lastMessageId),
            lastMessageId,
            lastMessage: bumpLastMessage(lastMessage, {
              senderId: effectiveSenderId,
              senderName: effectiveSenderName,
              createdAt: lastMessageAt,
            }),
            lastMessageAt,
            // Explicit when the caller has a mutation revision that differs
            // from the previewed message's (the delete-recalc case, where the
            // preview points BACKWARD at an older surviving message). For an
            // ordinary new-message bump the two coincide — the message being
            // previewed IS the mutation — so the preview's own revision is the
            // correct default and every existing call site gets the field for
            // free. Omitted rather than sent as 0 when neither is known, so a
            // client ordering strictly by this number is never handed a value
            // that would make it discard a real update.
            ...(projectionRevision > 0 ? { projectionRevision } : {}),
            senderId: effectiveSenderId,
            senderName: effectiveSenderName,
            unread,
            ...(typeof absoluteUnread === "number"
              ? { unreadCount: Math.max(0, absoluteUnread) }
              : {}),
            ...(p.deleteRecalc ? { deleteRecalc: true } : {}),
            ...(p.activityOnly ? { activityOnly: true } : {}),
            ...(isOffline !== undefined ? { isOffline } : {}),
          },
        })
      );
    }
    await pipeline.exec();
  } catch (error) {
    logger.warn(
      `Failed to publish conv:updated for ${p.roomId}: ${String(error)}`
    );
  }
}

interface PublishCommunityUpdatedParams {
  redis: Redis | Cluster;
  communityId: string;
  /** The genuine chat (GeneralRoom) id — distinct from communityId. */
  roomId: string;
  memberIds: string[];
  senderId: string;
  senderName: string;
  lastMessageId: string;
  /** epoch ms */
  lastMessageAt: number;
  preview: BumpPreview;
  /**
   * Self-referential SYSTEM line personalization. When set, the single member
   * whose id === `subjectUserId` receives `selfPreview` ("You are now a
   * moderator" / "You joined the community") in place of `preview.text`, while
   * every other member receives the third-person `preview` unchanged.
   */
  subjectUserId?: string;
  selfPreview?: string;
  /** Optional per-member preview overrides (delete-for-everyone fan-out): a
   *  member who hid the shared previous-visible message gets their own preview;
   *  value null => empty preview for that member. Takes precedence over the
   *  shared preview but NOT over the self-referential selfPreview branch. */
  recipientOverrides?: Map<string, RecipientBump | null>;
  /** See `PublishConvUpdatedParams.deleteRecalc` — same contract, same reason. */
  deleteRecalc?: boolean;
  /**
   * The REMOVED message's id — the client's idempotency key for `unreadDelta`.
   *
   * Unlike the absolute `unreadCount` on `conv:updated`, a delta is not
   * idempotent: on a multi-instance gateway the same `user:*` pmessage can be
   * fanned out more than once, and a double-applied `-1` produces exactly the
   * wrong badge this whole change exists to fix. `lastMessageId` cannot serve as
   * the key — on a recalc it names the PREVIOUS surviving message (or is empty),
   * which collides with that message's own bumps.
   */
  deleteRecalcId?: string;
  /**
   * Per-member change to the unread badge caused by this bump (delete recalc
   * only; always <= 0 today).
   *
   * Community unread is DERIVED from `RoomMember.lastReadAt`, not stored as a
   * counter, so there is no absolute per-member number to send without one
   * aggregation per member — a 5k-member community would pay 5k aggregations per
   * delete. The decision that actually needs authority is "did this message
   * count toward THIS member's unread", and that is computed server-side from
   * the read watermark (see `resolveUnreadDeltasAfterDelete`); the client only
   * applies `max(0, prev + delta)`. Members absent from the map are unaffected.
   */
  unreadDeltaByMember?: Record<string, number>;
  /** See `PublishConvUpdatedParams.activityOnly` — same contract, same reason. */
  activityOnly?: boolean;
}

export async function publishCommunityUpdated(
  p: PublishCommunityUpdatedParams
): Promise<void> {
  const memberIds = [...new Set(p.memberIds)];
  if (memberIds.length === 0) return;

  // Every active member is eligible. There used to be a 60-second
  // `community:fresh-join:*` suppression here for members who had just joined
  // and might not have received their `community:added` event yet — but
  // `community:added` is published SYNCHRONOUSLY by community-service at
  // join/create time (its delivery window is milliseconds), so a 60-second
  // blanket window silently swallowed every real list bump for a member (and
  // for the creator, from the moment the community was created). Clients
  // already drop a bump for a community that isn't in their list cache yet,
  // which is the correct place for that guard.
  const eligibleIds = memberIds;

  // SYSTEM activity (lifecycle lines such as "John is now a moderator") is
  // sender-less: the preview is a complete sentence. Force both senderId and
  // senderName empty so the frontend never prefixes with "You:" or an actor
  // name, and force unread=false (system lines carry no real sender to diff).
  const isSystem =
    String(p.preview.contentType ?? "").toUpperCase() === "SYSTEM";
  const senderId = isSystem ? "" : p.senderId;
  const senderName = isSystem ? "" : p.senderName;

  try {
    const pipeline = p.redis.pipeline();
    for (const memberId of eligibleIds) {
      // Per-member override (delete-for-everyone fan-out): a member who hid the
      // shared previous-visible message gets their OWN preview. Mutually
      // exclusive with the self-referential selfPreview branch in practice
      // (selfPreview is only set for lifecycle lines, overrides only for deletes).
      const hasOverride = p.recipientOverrides?.has(memberId) ?? false;
      const override = hasOverride
        ? (p.recipientOverrides?.get(memberId) ?? null)
        : undefined;
      // Authoritative badge adjustment for this member (delete recalc only).
      // Emitted on BOTH branches below: whether a member happens to have a
      // personal preview override is unrelated to whether the deleted message
      // was in their unread window.
      const unreadDelta = p.unreadDeltaByMember?.[memberId] ?? 0;
      // The nav-badge total dropped for this member too — the `unread` flag only
      // ever signals upward, so a delete has to push the summary explicitly.
      if (unreadDelta !== 0) notifyUnreadChanged(memberId);
      const deleteFields = {
        ...(p.deleteRecalc ? { deleteRecalc: true } : {}),
        ...(p.activityOnly ? { activityOnly: true } : {}),
        ...(unreadDelta !== 0
          ? {
              unreadDelta,
              ...(p.deleteRecalcId ? { deleteRecalcId: p.deleteRecalcId } : {}),
            }
          : {}),
      };
      if (override !== undefined) {
        pipeline.publish(
          `user:${memberId}`,
          JSON.stringify({
            event: "community:updated",
            data: {
              communityId: p.communityId,
              roomId: p.roomId,
              lastMessageId: override?.lastMessageId ?? "",
              lastMessage: bumpLastMessage(
                override?.preview ?? EMPTY_BUMP_PREVIEW,
                {
                  senderId: override?.senderId ?? "",
                  senderName: override?.senderName ?? "",
                  createdAt: override?.lastMessageAt ?? p.lastMessageAt,
                }
              ),
              lastMessageAt: override?.lastMessageAt ?? p.lastMessageAt,
              senderId: override?.senderId ?? "",
              senderName: override?.senderName ?? "",
              unread: false,
              ...deleteFields,
            },
          })
        );
        continue;
      }
      // Self-referential system line: the subject member sees "You …"; everyone
      // else gets the third-person preview as-is.
      const lastMessage =
        p.selfPreview && p.subjectUserId && memberId === p.subjectUserId
          ? { ...p.preview, text: p.selfPreview }
          : p.preview;
      // A delete recalc is never new activity — it must not raise a badge even
      // for members who have no personal preview override.
      const unread =
        isSystem || p.deleteRecalc || p.activityOnly
          ? false
          : memberId !== p.senderId;
      // Nav-badge total changed for this member — see unread-summary-bridge.ts.
      if (unread) notifyUnreadChanged(memberId);
      pipeline.publish(
        `user:${memberId}`,
        JSON.stringify({
          event: "community:updated",
          data: {
            communityId: p.communityId,
            roomId: p.roomId,
            lastMessageId: p.lastMessageId,
            lastMessage: bumpLastMessage(lastMessage, {
              senderId,
              senderName,
              createdAt: p.lastMessageAt,
            }),
            lastMessageAt: p.lastMessageAt,
            senderId,
            senderName,
            unread,
            ...deleteFields,
          },
        })
      );
    }
    await pipeline.exec();
  } catch (error) {
    logger.warn(
      `Failed to publish community:updated for ${p.communityId}: ${String(error)}`
    );
  }
}

/**
 * Fire-and-forget `community:updated` bump. The member-id fetch (which lives in
 * the service) is supplied via `fetchMembers` and runs together with the
 * publish inside a non-awaited IIFE, so the send path never blocks on Redis or
 * the DB; any error is logged, never thrown.
 */
type PublishCommunityUpdatedSafeParams = Omit<
  PublishCommunityUpdatedParams,
  "memberIds" | "recipientOverrides" | "unreadDeltaByMember"
> & {
  fetchMembers: () => Promise<string[]>;
  /** Lazily compute per-member overrides once the member list is known
   *  (delete-for-everyone fan-out). */
  resolveOverrides?: (
    memberIds: string[]
  ) => Promise<Map<string, RecipientBump | null>>;
  /** Lazily compute authoritative per-member unread deltas once the member list
   *  is known (delete-for-everyone fan-out). */
  resolveUnreadDeltas?: (
    memberIds: string[]
  ) => Promise<Record<string, number>>;
};

export function publishCommunityUpdatedSafe(
  p: PublishCommunityUpdatedSafeParams
): void {
  void (async () => {
    const memberIds = await p.fetchMembers();
    // Isolate override resolution so a transient query failure never suppresses
    // the bump for EVERY member (the shared preview is correct for the majority).
    let recipientOverrides: Map<string, RecipientBump | null> | undefined;
    if (p.resolveOverrides) {
      try {
        recipientOverrides = await p.resolveOverrides(memberIds);
      } catch (err) {
        logger.warn(
          `community:updated override resolution failed for ${p.communityId}; falling back to shared preview: ${String(err)}`
        );
      }
    }
    // Isolated for the same reason as the overrides above: a failed unread
    // recount must still let the preview/timestamp bump through (a stale badge
    // is a smaller defect than a stale row, and the badge self-corrects on the
    // next list fetch).
    let unreadDeltaByMember: Record<string, number> | undefined;
    if (p.resolveUnreadDeltas) {
      try {
        unreadDeltaByMember = await p.resolveUnreadDeltas(memberIds);
      } catch (err) {
        logger.warn(
          `community:updated unread delta resolution failed for ${p.communityId}: ${String(err)}`
        );
      }
    }
    await publishCommunityUpdated({
      redis: p.redis,
      communityId: p.communityId,
      roomId: p.roomId,
      memberIds,
      senderId: p.senderId,
      senderName: p.senderName,
      lastMessageId: p.lastMessageId,
      lastMessageAt: p.lastMessageAt,
      preview: p.preview,
      subjectUserId: p.subjectUserId,
      selfPreview: p.selfPreview,
      recipientOverrides,
      deleteRecalc: p.deleteRecalc,
      deleteRecalcId: p.deleteRecalcId,
      unreadDeltaByMember,
      activityOnly: p.activityOnly,
    });
  })().catch((error) => {
    logger.warn(
      `Failed to publish community:updated for ${p.communityId}: ${String(error)}`
    );
  });
}
