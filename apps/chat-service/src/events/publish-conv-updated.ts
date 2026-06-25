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

interface PublishConvUpdatedParams {
  redis: Redis | Cluster;
  type: "PRIVATE" | "GROUP";
  roomId: string;
  recipientIds: string[];
  senderId: string;
  lastMessageId: string;
  /** epoch ms */
  lastMessageAt: number;
  preview: BumpPreview;
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
  "recipientIds"
> &
  (
    | { recipientIds: string[]; fetchRecipients?: never }
    | { recipientIds?: never; fetchRecipients: () => Promise<string[]> }
  );

export function publishConvUpdatedSafe(p: PublishConvUpdatedSafeParams): void {
  void (async () => {
    const recipientIds = p.recipientIds ?? (await p.fetchRecipients());
    await publishConvUpdated({
      redis: p.redis,
      type: p.type,
      roomId: p.roomId,
      recipientIds,
      senderId: p.senderId,
      lastMessageId: p.lastMessageId,
      lastMessageAt: p.lastMessageAt,
      preview: p.preview,
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
      pipeline.publish(
        `user:${recipientId}`,
        JSON.stringify({
          event: "conv:updated",
          data: {
            type: p.type,
            roomId: p.roomId,
            lastMessageId: p.lastMessageId,
            lastMessage: p.preview,
            lastMessageAt: p.lastMessageAt,
            senderId: p.senderId,
            unread: recipientId !== p.senderId,
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
}

export async function publishCommunityUpdated(
  p: PublishCommunityUpdatedParams
): Promise<void> {
  const memberIds = [...new Set(p.memberIds)];
  if (memberIds.length === 0) return;

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
    for (const memberId of memberIds) {
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
  "memberIds"
> & { fetchMembers: () => Promise<string[]> };

export function publishCommunityUpdatedSafe(
  p: PublishCommunityUpdatedSafeParams
): void {
  void (async () => {
    const memberIds = await p.fetchMembers();
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
    });
  })().catch((error) => {
    logger.warn(
      `Failed to publish community:updated for ${p.communityId}: ${String(error)}`
    );
  });
}
