import { logger } from "@aimess/logger";
import { usersWithRoomOpen } from "@aimess/redis";
import { type SupportedLocale } from "@aimess/constants";

import { redis } from "../config/redis.js";
import { chatCopy, chatPreviewHiddenBody } from "../lib/notification-copy.js";
import { pushToUser } from "./push.service.js";

/**
 * One tray entry per burst, per conversation, per recipient.
 *
 * Ten messages typed at someone in a few seconds used to produce ten push
 * notifications — one dispatch per message, with no debounce and (deliberately,
 * see the comment in chat.consumer.ts) no collapse key. This holds a short
 * window open per (recipient, conversation) and delivers ONE notification for
 * whatever landed in it: the count plus the newest line.
 *
 * Three things are decided at FLUSH time rather than at arrival, which is what
 * makes the window useful beyond simple deduplication:
 *
 *  - **Presence.** A recipient who opened the conversation while the window was
 *    running gets nothing at all — the pending notification is simply dropped.
 *    That is the "cancel on read" rule, and it falls out of checking late.
 *  - **Final content.** An edit or delete that lands inside the window rewrites
 *    or removes the message before anything is sent, so a deleted line can never
 *    be pushed.
 *  - **Which devices.** Sessions with a foregrounded socket are excluded by
 *    push.service, so the phone in a pocket still buzzes while the laptop the
 *    user is typing on does not.
 *
 * In-process, like the gateway's socket batcher: several notifications-service
 * replicas each coalesce their own share. Worst case that is one notification
 * per replica per burst instead of one — still bounded by replica count, never
 * by message count — and the collapse key makes the tray show the newest.
 */

/** Debounce window. A push is a background wake, so a couple of seconds of
 *  delay is invisible; it is the whole burst that must not be. */
export const PUSH_COALESCE_WINDOW_MS = Number(
  process.env.PUSH_COALESCE_WINDOW_MS ?? 2000
);

/** Safety valve: never hold a notification longer than this, however long the
 *  burst runs. Without it a sustained typer could postpone the push forever. */
export const PUSH_COALESCE_MAX_HOLD_MS = Number(
  process.env.PUSH_COALESCE_MAX_HOLD_MS ?? 10_000
);

export interface ChatPushMessage {
  messageId: string;
  clientMessageId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  preview: string;
  previewImageUrl?: string;
  messageType: string;
  sentAt: number;
}

/** Everything that is a property of the CONVERSATION, not of one message. */
export interface ChatPushContext {
  userId: string;
  conversationId: string;
  conversationType: "PRIVATE" | "GROUP" | "COMMUNITY";
  communityId?: string;
  communityName?: string;
  groupName?: string;
  conversationAvatar?: string;
  canReply?: boolean;
  deepLink: string;
  threadId: string;
  communityGatesPreResolved: boolean;
}

interface Pending {
  context: ChatPushContext;
  messages: ChatPushMessage[];
  timer: NodeJS.Timeout;
  /** Wall-clock deadline enforced by {@link PUSH_COALESCE_MAX_HOLD_MS}. */
  deadline: number;
}

const pending = new Map<string, Pending>();

const keyOf = (userId: string, conversationId: string): string =>
  `${userId}|${conversationId}`;

/**
 * Add one message to this recipient's pending notification for this
 * conversation, (re)arming the debounce.
 */
export function enqueueChatPush(
  context: ChatPushContext,
  message: ChatPushMessage
): void {
  const key = keyOf(context.userId, context.conversationId);
  const existing = pending.get(key);
  if (existing) {
    // Context is refreshed from the newest message: a rename mid-burst should
    // title the notification on the CURRENT name.
    existing.context = context;
    existing.messages.push(message);
    clearTimeout(existing.timer);
    const wait = Math.max(
      0,
      Math.min(PUSH_COALESCE_WINDOW_MS, existing.deadline - Date.now())
    );
    existing.timer = setTimeout(() => void flush(key), wait);
    existing.timer.unref();
    return;
  }
  const timer = setTimeout(() => void flush(key), PUSH_COALESCE_WINDOW_MS);
  timer.unref();
  pending.set(key, {
    context,
    messages: [message],
    timer,
    deadline: Date.now() + PUSH_COALESCE_MAX_HOLD_MS,
  });
}

/**
 * A message was deleted before its notification went out — drop it from every
 * pending entry. If it was the only one, nothing is sent at all.
 */
export function dropPendingChatMessage(messageId: string): void {
  if (!messageId) return;
  for (const [key, entry] of pending) {
    const before = entry.messages.length;
    entry.messages = entry.messages.filter((m) => m.messageId !== messageId);
    if (entry.messages.length === before) continue;
    if (entry.messages.length === 0) {
      clearTimeout(entry.timer);
      pending.delete(key);
    }
  }
}

/** A message was edited before its notification went out — push the new text. */
export function updatePendingChatMessage(
  messageId: string,
  preview: string
): void {
  if (!messageId) return;
  for (const entry of pending.values()) {
    for (const message of entry.messages) {
      if (message.messageId === messageId) message.preview = preview;
    }
  }
}

async function flush(key: string): Promise<void> {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  clearTimeout(entry.timer);

  const { context, messages } = entry;
  if (messages.length === 0) return;

  try {
    // Cancel-on-read: the recipient opened this conversation while the window
    // was running, so the message was never unread and needs no notification.
    const open = await usersWithRoomOpen(redis, context.conversationId, [
      context.userId,
    ]);
    if (open.has(context.userId)) {
      logger.info(
        `[push:coalesce] suppressed ${messages.length} message(s) — recipient ${context.userId} has room ${context.conversationId} open`
      );
      return;
    }

    const latest = messages[messages.length - 1]!;
    const count = messages.length;
    const isCommunity = context.conversationType === "COMMUNITY";
    const isGroup = context.conversationType === "GROUP";
    const copyParams = {
      isCommunity,
      ...(context.communityName
        ? { communityName: context.communityName }
        : {}),
      ...(isGroup && context.groupName ? { groupName: context.groupName } : {}),
      senderName: latest.senderName,
      preview: latest.preview,
      messageType: latest.messageType,
    };
    const copy =
      count > 1
        ? chatCopy.messageBurst({ ...copyParams, count })
        : chatCopy.message(copyParams);

    const showPreviewOverride = (locale: SupportedLocale): string =>
      chatPreviewHiddenBody(
        isCommunity
          ? context.communityName
          : isGroup
            ? context.groupName
            : undefined,
        locale
      );

    const navigation = JSON.stringify({
      screen: isCommunity
        ? "COMMUNITY_CHAT"
        : isGroup
          ? "GROUP_CHAT"
          : "PRIVATE_CHAT",
      ...(context.communityId ? { communityId: context.communityId } : {}),
      ...(context.communityName
        ? { communityName: context.communityName }
        : {}),
      roomId: context.conversationId,
      conversationType: context.conversationType,
      messageId: latest.messageId,
    });

    await pushToUser({
      userId: context.userId,
      category: "chatEnabled",
      ...(context.communityGatesPreResolved
        ? { communityGatesPreResolved: true as const }
        : {}),
      type: "MESSAGE",
      copy,
      actorId: latest.senderId,
      deepLink: context.deepLink,
      // Collapse ONLY the coalesced summary. The historical objection to a
      // collapse key on chat — FCM keeps just the newest message per key while
      // a device is unreachable, so earlier ones are lost — does not apply to a
      // summary: a newer summary is strictly a better thing to show than an
      // older one, and the client's catch-up sync owns the actual history.
      collapseKey: `conv:${context.conversationId}`,
      apnsThreadId: context.threadId,
      chatType: isCommunity
        ? "COMMUNITY"
        : isGroup
          ? "GROUP"
          : ("PERSONAL" as const),
      showPreviewOverride,
      // A device whose app is foregrounded already has this over the socket.
      suppressForegroundSessions: true,
      skipInbox: true,
      data: {
        type: "MESSAGE",
        conversationId: context.conversationId,
        conversationType: context.conversationType,
        ...(context.communityId ? { communityId: context.communityId } : {}),
        ...(context.communityName
          ? { communityName: context.communityName }
          : {}),
        messageId: latest.messageId,
        clientMessageId: latest.clientMessageId ?? "",
        senderId: latest.senderId,
        senderName: latest.senderName ?? "",
        senderAvatar: latest.senderAvatar ?? "",
        ...(context.groupName ? { groupName: context.groupName } : {}),
        ...(context.conversationAvatar
          ? {
              conversationAvatar: context.conversationAvatar,
              ...(isGroup
                ? { groupAvatarUrl: context.conversationAvatar }
                : {}),
              ...(isCommunity
                ? { communityAvatarUrl: context.conversationAvatar }
                : {}),
            }
          : {}),
        canReply: context.canReply === false ? "false" : "true",
        contentType: latest.messageType ?? "",
        preview: latest.preview ?? "",
        ...(latest.previewImageUrl
          ? { previewImageUrl: latest.previewImageUrl }
          : {}),
        sentAt: String(latest.sentAt ?? ""),
        // The client dedups on this. A coalesced push stands for a RANGE, so it
        // carries the newest id plus the count and the full id list, letting a
        // client that already rendered some of them work out what is new.
        idempotencyKey: latest.messageId,
        messageCount: String(count),
        messageIds: messages.map((m) => m.messageId).join(","),
        deepLink: context.deepLink,
        navigation,
      },
    });
  } catch (error) {
    logger.error(
      `[push:coalesce] flush failed for ${key} (${messages.length} message(s))`,
      error
    );
  }
}

/** Tests / shutdown: deliver everything now. */
export async function flushAllChatPushes(): Promise<void> {
  await Promise.all([...pending.keys()].map((key) => flush(key)));
}
