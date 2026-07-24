import { logger } from "@aimess/logger";
import amqp from "amqplib";
import { type NotificationNavigation } from "@aimess/shared-types";

import { env } from "../config/env.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { callCopy } from "../lib/notification-copy.js";
import { pushToUser } from "../services/push.service.js";

// chat-service publishes call ring/cancel events to the durable `call.ring.queue`.
// We fan a high-priority DATA-ONLY FCM push out so a killed/backgrounded callee
// device can ring (client owns the full-screen intent) and dismiss on cancel.
// Push is the fallback wake — the socket `call:incoming` is primary — so this is
// best-effort. Args MUST match the publisher
// (apps/chat-service/src/events/publish-call-ringing.ts).
const CALL_RING_QUEUE = "call.ring.queue";

interface CallRingingPayload {
  calleeId: string;
  callId: string;
  callerId: string;
  callerName: string;
  callerAvatarUrl: string;
  callType: string;
  livekitUrl: string;
  token: string;
  sentAt: number;
}

interface CallCancelPayload {
  calleeId: string;
  callId: string;
  reason: string;
}

async function handleCallRinging(data: CallRingingPayload): Promise<void> {
  await pushToUser({
    userId: data.calleeId,
    category: "callEnabled",
    type: "CALL",
    ...callCopy.ringing(data.callerName, data.callType),
    priority: "high",
    bypassSettings: true,
    skipInbox: true,
    ttl: 40,
    dataOnly: true,
    collapseKey: `call:${data.callId}`,
    deepLink: buildDeepLink("call", data.callId),
    data: {
      notificationType: "CALL",
      callId: data.callId,
      navigation: JSON.stringify({
        screen: "PRIVATE_CHAT",
        userId: data.callerId,
      } satisfies NotificationNavigation),
      callerId: data.callerId,
      callerName: data.callerName ?? "",
      callerAvatarUrl: data.callerAvatarUrl ?? "",
      callType: data.callType ?? "",
      livekitUrl: data.livekitUrl ?? "",
      token: data.token ?? "",
      sentAt: String(data.sentAt ?? ""),
    },
  });
}

async function handleCallCancelled(data: CallCancelPayload): Promise<void> {
  await pushToUser({
    userId: data.calleeId,
    category: "callEnabled",
    type: "CALL_CANCEL",
    ...callCopy.cancelled(),
    priority: "high",
    bypassSettings: true,
    skipInbox: true,
    ttl: 40,
    dataOnly: true,
    collapseKey: `call:${data.callId}`,
    deepLink: buildDeepLink("call", data.callId),
    data: {
      notificationType: "CALL_CANCEL",
      callId: data.callId,
      reason: data.reason ?? "",
      navigation: JSON.stringify({
        screen: "PRIVATE_CHAT",
      } satisfies NotificationNavigation),
    },
  });
}

export async function startCallConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(CALL_RING_QUEUE, { durable: true });
  await channel.prefetch(20);

  logger.info("Call push consumer started");

  void channel.consume(CALL_RING_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: CallRingingPayload | CallCancelPayload;
        };
        if (parsed.type === "call.ringing") {
          await handleCallRinging(parsed.data as CallRingingPayload);
        } else if (parsed.type === "call.cancelled") {
          await handleCallCancelled(parsed.data as CallCancelPayload);
        } else {
          logger.warn(`Unknown call event type: ${parsed.type}`);
        }
        channel.ack(message);
      } catch (error) {
        // Deterministic/parse error → drop (no requeue) so it doesn't spin.
        logger.error("Call push consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
