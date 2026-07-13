import { logger } from "@aimess/logger";

import type { Redis, Cluster } from "ioredis";

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
  /** Sender's live display name — mirrors `publishCommunityUpdated`'s
   *  `senderName` so the gateway's "You:"-personalization (which requires both
   *  senderId AND senderName) fires for `conv:updated` too. Optional/"" for
   *  call sites (delete-recalc) that don't have it in hand. */
  senderName?: string;
  lastMessageId: string;
  /** epoch ms */
  lastMessageAt: number;
  preview: BumpPreview;
  /** Optional per-recipient preview overrides (key present => override applies;
   *  value null => empty preview for that recipient). */
  recipientOverrides?: Map<string, RecipientBump | null>;
}

/** Empty per-recipient preview (the recipient has hidden every message). */
const EMPTY_BUMP_PREVIEW: BumpPreview = { contentType: "", text: "" };

/**
 * Fire-and-forget `conv:updated` bump. The recipient list may be supplied
 * directly (private chats, where ids are already in hand) or resolved lazily
 * via `fetchRecipients` (group chats, where the member-id fetch lives in the
 * service). Both the fetch and the publish run inside a non-awaited IIFE so the
 * send path never blocks on Redis or the DB; any error is logged, never thrown.
 */
type PublishConvUpdatedSafeParams = Omit<
  PublishConvUpdatedParams,
  "recipientIds" | "recipientOverrides"
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
      const lastMessage =
        override === undefined
          ? p.preview
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
      const unread = override === undefined ? recipientId !== senderId : false;
      pipeline.publish(
        `user:${recipientId}`,
        JSON.stringify({
          event: "conv:updated",
          data: {
            type: p.type,
            roomId: p.roomId,
            lastMessageId,
            lastMessage,
            lastMessageAt,
            senderId,
            senderName,
            unread,
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
}

export async function publishCommunityUpdated(
  p: PublishCommunityUpdatedParams
): Promise<void> {
  const memberIds = [...new Set(p.memberIds)];
  if (memberIds.length === 0) return;

  // Exclude members who just joined and haven't yet received their
  // `community:added` personal event. Including them here causes the FE to
  // trigger a clobbering refetch for a community it doesn't have in state yet.
  // Chat-service sets a short-lived key on `community.member.synced(ACTIVE)`;
  // the key expires after 60 s, well past any realistic delivery window.
  let eligibleIds = memberIds;
  try {
    const flags = await p.redis.mget(
      ...memberIds.map((id) => `community:fresh-join:${p.communityId}:${id}`)
    );
    eligibleIds = memberIds.filter((_, i) => flags[i] === null);
  } catch (err) {
    logger.warn(
      `community:updated fresh-join check failed for ${p.communityId}: ${String(err)}`
    );
    // Fail-open: include all members so the bump still fires.
  }
  if (eligibleIds.length === 0) return;

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
      if (override !== undefined) {
        pipeline.publish(
          `user:${memberId}`,
          JSON.stringify({
            event: "community:updated",
            data: {
              communityId: p.communityId,
              roomId: p.roomId,
              lastMessageId: override?.lastMessageId ?? "",
              lastMessage: override?.preview ?? EMPTY_BUMP_PREVIEW,
              lastMessageAt: override?.lastMessageAt ?? p.lastMessageAt,
              senderId: override?.senderId ?? "",
              senderName: override?.senderName ?? "",
              unread: false,
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
      pipeline.publish(
        `user:${memberId}`,
        JSON.stringify({
          event: "community:updated",
          data: {
            communityId: p.communityId,
            roomId: p.roomId,
            lastMessageId: p.lastMessageId,
            lastMessage,
            lastMessageAt: p.lastMessageAt,
            senderId,
            senderName,
            unread: isSystem ? false : memberId !== p.senderId,
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
  "memberIds" | "recipientOverrides"
> & {
  fetchMembers: () => Promise<string[]>;
  /** Lazily compute per-member overrides once the member list is known
   *  (delete-for-everyone fan-out). */
  resolveOverrides?: (
    memberIds: string[]
  ) => Promise<Map<string, RecipientBump | null>>;
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
    });
  })().catch((error) => {
    logger.warn(
      `Failed to publish community:updated for ${p.communityId}: ${String(error)}`
    );
  });
}
