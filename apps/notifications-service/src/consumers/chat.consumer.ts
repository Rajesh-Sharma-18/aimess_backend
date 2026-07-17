import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { pushToUsers } from "../services/push.service.js";
import { isCommunityActorMuted } from "../services/notification-eligibility.service.js";

/**
 * V2 §4: chat-message → FCM/APNs push bridge.
 *
 * chat-service publishes `chat.message_sent` to the durable `chat.message.queue`
 * when a message is persisted. We fan an FCM/APNs **data message** out to each
 * recipient's devices (push.service handles per-category settings, quiet-hours,
 * device-token fan-out, and dead-token pruning).
 *
 * Push is the fallback wake — the socket is primary delivery — so this is
 * best-effort and safely duplicable: the client UPSERTs on `messageId`.
 */
const CHAT_MESSAGE_QUEUE = "chat.message.queue";

interface MessageSentPayload {
  conversationId: string;
  conversationType: "PRIVATE" | "GROUP" | "COMMUNITY";
  /** Present when conversationType === "COMMUNITY" */
  communityId?: string;
  /** Community display name — used as the FCM push title for community messages. */
  communityName?: string;
  messageId: string;
  clientMessageId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  preview: string;
  messageType: string;
  sentAt: number;
  recipientIds: string[];
}

async function handleMessageSent(data: MessageSentPayload): Promise<void> {
  // Notification eligibility gate (community only). A moderator-muted member's
  // community messages must NOT generate notifications for anyone. PRIVATE/GROUP
  // never invoke the gate (no gRPC call). Fail-open: an oracle outage resolves to
  // "not muted" so notifications still fan out. Returning early here is a
  // SUCCESS (the message is still ACKed by the consume callback) — NOT a nack.
  if (data.conversationType === "COMMUNITY" && data.communityId) {
    const muted = await isCommunityActorMuted(data.senderId, data.communityId);
    if (muted) {
      logger.info(
        `Suppressing community notification fan-out: sender ${data.senderId} is muted in community ${data.communityId} (message ${data.messageId})`
      );
      return;
    }
  }

  const recipients = (data.recipientIds ?? []).filter(
    (id) => id && id !== data.senderId
  );
  if (recipients.length === 0) return;

  const isCommunity = data.conversationType === "COMMUNITY";
  const category = isCommunity ? "communityEnabled" : "chatEnabled";

  // For community messages: title = community name (if known), body = "Sender: preview".
  // For private/group: title = sender name, body = preview text.
  const title = isCommunity
    ? data.communityName || data.senderName || "Community"
    : data.senderName || "New message";
  const body = isCommunity
    ? `${data.senderName || "Someone"}: ${data.preview || "New message"}`
    : data.preview || "New message";

  // Include messageId in the community deep link so the client can scroll to
  // the specific message after navigating to the community chat room.
  const communityTarget = data.communityId ?? data.conversationId;
  const deepLink = isCommunity
    ? buildDeepLink("community", communityTarget, data.messageId)
    : buildDeepLink("conversation", data.conversationId);

  // showPreviewOverride hides sender name and message content when the user
  // has "show preview" disabled — the title (community/sender name) is safe.
  const showPreviewOverride = isCommunity
    ? `New message in ${data.communityName || "community"}`
    : "New message";

  await pushToUsers(recipients, (userId) => ({
    userId,
    category,
    type: "MESSAGE",
    title,
    body,
    actorId: data.senderId,
    deepLink,
    collapseKey: `conv:${data.conversationId}`,
    showPreviewOverride,
    // Chat messages must never create a Notification Center entry — see
    // PushInput.skipInbox. Push (this call) and per-conversation unread
    // badges (chat-service, unrelated to the Notification collection)
    // continue to work unchanged.
    skipInbox: true,
    // FCM data map — all values MUST be strings.
    data: {
      type: "MESSAGE",
      conversationId: data.conversationId,
      conversationType: data.conversationType,
      ...(data.communityId ? { communityId: data.communityId } : {}),
      ...(data.communityName ? { communityName: data.communityName } : {}),
      messageId: data.messageId,
      clientMessageId: data.clientMessageId ?? "",
      senderId: data.senderId,
      senderName: data.senderName ?? "",
      senderAvatar: data.senderAvatar ?? "",
      contentType: data.messageType ?? "",
      preview: data.preview ?? "",
      sentAt: String(data.sentAt ?? ""),
      idempotencyKey: data.messageId,
      deepLink,
    },
  }));
}

export async function startChatConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // chat-service publishes to a plain durable queue (NOT an exchange). Args MUST
  // match the publisher (apps/chat-service/src/events/publish-message-sent.ts).
  await channel.assertQueue(CHAT_MESSAGE_QUEUE, { durable: true });
  await channel.prefetch(20);

  logger.info("Chat message push consumer started");

  void channel.consume(CHAT_MESSAGE_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: MessageSentPayload;
        };
        if (parsed.type === "chat.message_sent") {
          await handleMessageSent(parsed.data);
        } else {
          logger.warn(`Unknown chat event type: ${parsed.type}`);
        }
        channel.ack(message);
      } catch (error) {
        // Deterministic/parse error → drop (no requeue) so it doesn't spin.
        logger.error("Chat push consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
