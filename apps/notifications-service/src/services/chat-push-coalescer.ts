import { logger } from "@aimess/logger";
import { usersWithRoomOpen } from "@aimess/redis";
import { type SupportedLocale } from "@aimess/constants";

import { redis } from "../config/redis.js";
import {
  chatCopy,
  chatMentionAllPreviewHiddenBody,
  chatMentionPreviewHiddenBody,
  chatPreviewHiddenBody,
} from "../lib/notification-copy.js";
import { recordPushedMessages } from "./push-retraction.js";
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
  /** Permanent object key behind previewImageUrl — lets a client re-mint an expired URL. */
  previewImageKey?: string;
  messageType: string;
  sentAt: number;
  /** The recipient was @mentioned in this (GROUP) message. */
  mentioned?: boolean;
  /** The recipient is notified through @all in this (GROUP) message. */
  mentionAll?: boolean;
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

/** Who a GROUP edit still mentions: USER mention ids, and whether @all stays. */
export interface EditedMentions {
  ids: ReadonlySet<string>;
  hasAll: boolean;
}

/**
 * messageId → who its newest GROUP edit still mentions. A mention push that
 * lands AFTER the edit which removed it (a delayed event, e.g. two replayed
 * edits) is dropped against this instead of bypassing mute.
 * ponytail: remembered for one max hold; an event delayed longer still leaks.
 */
const editedMentions = new Map<string, EditedMentions & { at: number }>();

const keyOf = (userId: string, conversationId: string): string =>
  `${userId}|${conversationId}`;

/**
 * What a GROUP edit leaves of one copy queued for `userId`. A mention or @all
 * copy skipped the group mute, so the edit must still justify its flag or it is
 * dropped (`undefined`), never downgraded to a plain push. `mentioned` needs the
 * user still in `ids`: the @all mute was never read for them. `mentionAll`
 * needs `ids` or `hasAll`. A merged copy with both flags already passed the @all
 * mute, so losing only the individual mention downgrades it to @all.
 */
function afterEdit(
  message: ChatPushMessage,
  userId: string,
  edit: EditedMentions
): ChatPushMessage | undefined {
  if ((!message.mentioned && !message.mentionAll) || edit.ids.has(userId)) {
    return message;
  }
  if (!message.mentionAll || !edit.hasAll) return undefined;
  return message.mentioned ? { ...message, mentioned: false } : message;
}

/**
 * Add one message to this recipient's pending notification for this
 * conversation, (re)arming the debounce.
 */
export function enqueueChatPush(
  context: ChatPushContext,
  message: ChatPushMessage
): void {
  const edited = editedMentions.get(message.messageId);
  if (edited && Date.now() - edited.at < PUSH_COALESCE_MAX_HOLD_MS) {
    const kept = afterEdit(message, context.userId, edited);
    if (!kept) return;
    message = kept;
  }
  const key = keyOf(context.userId, context.conversationId);
  const existing = pending.get(key);
  if (existing) {
    // Context is refreshed from the newest message: a rename mid-burst should
    // title the notification on the CURRENT name.
    existing.context = context;
    // The SAME message again — typically the send push followed by the push
    // for an edit that added a mention. Replace it in place (newest text) and
    // keep it flagged as a mention if either copy was; never count it twice.
    const index = existing.messages.findIndex(
      (m) => m.messageId === message.messageId
    );
    if (index === -1) {
      existing.messages.push(message);
    } else {
      const previous = existing.messages[index]!;
      existing.messages[index] = {
        ...message,
        ...(previous.mentioned || message.mentioned ? { mentioned: true } : {}),
        ...(previous.mentionAll || message.mentionAll
          ? { mentionAll: true }
          : {}),
      };
    }
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

/**
 * A message was edited before its notification went out — push the new text.
 *
 * `mentions` (every GROUP edit) is who the edited message still mentions; each
 * queued copy of it is kept, downgraded or dropped per {@link afterEdit}.
 * `undefined` (non-GROUP edit) drops nothing and clears any earlier record.
 */
export function updatePendingChatMessage(
  messageId: string,
  preview: string,
  mentions?: EditedMentions
): void {
  if (!messageId) return;
  if (mentions) {
    const now = Date.now();
    for (const [id, e] of editedMentions) {
      if (now - e.at >= PUSH_COALESCE_MAX_HOLD_MS) editedMentions.delete(id);
    }
    editedMentions.set(messageId, { ...mentions, at: now });
  } else {
    editedMentions.delete(messageId);
  }
  for (const [key, entry] of pending) {
    if (mentions) {
      entry.messages = entry.messages.flatMap((m) =>
        m.messageId === messageId
          ? (afterEdit(m, entry.context.userId, mentions) ?? [])
          : [m]
      );
      if (entry.messages.length === 0) {
        clearTimeout(entry.timer);
        pending.delete(key);
        continue;
      }
    }
    if (!preview) continue;
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
    // A mention anywhere in the window leads the notification: the newest
    // mention is its subject (copy, ids, preview), not the newest message. With
    // no mention the subject is `latest` and the payload is exactly as before.
    // An individual mention outranks @all anywhere in the window.
    const lead =
      messages.filter((m) => m.mentioned).pop() ??
      messages.filter((m) => m.mentionAll).pop();
    const leadIsAll = lead !== undefined && lead.mentioned !== true;
    const subject = lead ?? latest;
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
    const copy = lead
      ? (leadIsAll ? chatCopy.mentionAll : chatCopy.mention)({
          ...(context.groupName ? { groupName: context.groupName } : {}),
          senderName: lead.senderName,
          preview: lead.preview,
          messageType: lead.messageType,
        })
      : count > 1
        ? chatCopy.messageBurst({ ...copyParams, count })
        : chatCopy.message(copyParams);

    const showPreviewOverride = (locale: SupportedLocale): string =>
      lead
        ? (leadIsAll
            ? chatMentionAllPreviewHiddenBody
            : chatMentionPreviewHiddenBody)(context.groupName, locale)
        : chatPreviewHiddenBody(
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
      messageId: subject.messageId,
    });

    await pushToUser({
      userId: context.userId,
      category: "chatEnabled",
      ...(context.communityGatesPreResolved
        ? { communityGatesPreResolved: true as const }
        : {}),
      type: "MESSAGE",
      copy,
      actorId: subject.senderId,
      deepLink: context.deepLink,
      // Collapse ONLY the coalesced summary. The historical objection to a
      // collapse key on chat — FCM keeps just the newest message per key while
      // a device is unreachable, so earlier ones are lost — does not apply to a
      // summary: a newer summary is strictly a better thing to show than an
      // older one, and the client's catch-up sync owns the actual history.
      // A mention collapses on its OWN key, so a later ordinary summary for the
      // same room cannot replace "X mentioned you" in the tray.
      collapseKey: lead
        ? `mention:${context.conversationId}`
        : `conv:${context.conversationId}`,
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
        // `type` stays MESSAGE for a mention: shipped Android builds render
        // MESSAGE via MessagingStyle and switch rendering path on any other
        // type. `notificationType` is what the web / newer clients branch on.
        type: "MESSAGE",
        ...(lead
          ? {
              notificationType: "MENTION",
              mentioned: "true",
              mentionType: leadIsAll ? "ALL" : "USER",
            }
          : {}),
        conversationId: context.conversationId,
        conversationType: context.conversationType,
        ...(context.communityId ? { communityId: context.communityId } : {}),
        ...(context.communityName
          ? { communityName: context.communityName }
          : {}),
        messageId: subject.messageId,
        clientMessageId: subject.clientMessageId ?? "",
        senderId: subject.senderId,
        senderName: subject.senderName ?? "",
        senderAvatar: subject.senderAvatar ?? "",
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
        contentType: subject.messageType ?? "",
        preview: subject.preview ?? "",
        ...(subject.previewImageUrl
          ? { previewImageUrl: subject.previewImageUrl }
          : {}),
        ...(subject.previewImageKey
          ? { previewImageKey: subject.previewImageKey }
          : {}),
        sentAt: String(subject.sentAt ?? ""),
        // The client dedups on this. A coalesced push stands for a RANGE, so it
        // carries the newest id plus the count and the full id list, letting a
        // client that already rendered some of them work out what is new.
        // A mention gets its own namespace so a client that already deduped
        // the plain push for the same id (send, then edit-added mention) still
        // shows it.
        idempotencyKey: lead ? `mention:${lead.messageId}` : latest.messageId,
        messageCount: String(count),
        messageIds: messages.map((m) => m.messageId).join(","),
        deepLink: context.deepLink,
        navigation,
      },
    });

    // The card is now on the device and the coalescer can no longer cancel it.
    // Remember who holds it so a later delete-for-everyone can retract it —
    // every id in the burst, because any one of them being deleted invalidates
    // the single notification that stands for all of them.
    await recordPushedMessages(
      context.userId,
      messages.map((m) => m.messageId)
    );
  } catch (error) {
    logger.error(
      `[push:coalesce] flush failed for ${key} (${messages.length} message(s))`,
      error
    );
  }
}

/** Tests / shutdown: deliver everything now. */
export async function flushAllChatPushes(): Promise<void> {
  editedMentions.clear();
  await Promise.all([...pending.keys()].map((key) => flush(key)));
}
