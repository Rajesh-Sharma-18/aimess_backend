import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { pushToUser } from "../services/push.service.js";

/**
 * Incoming-call → FCM push bridge.
 *
 * chat-service publishes `call.incoming` to the durable `call.push.queue` when a
 * call row is created (see apps/chat-service/src/events/publish-call-incoming.ts).
 * The `call:incoming` socket event is primary delivery, but it only reaches a
 * LIVE socket — a callee with the tab backgrounded or closed would never know
 * they were rung. This sends the high-priority push that wakes them.
 *
 * Best-effort and safely duplicable: the client dedups on callId.
 */
const CALL_PUSH_QUEUE = "call.push.queue";

interface CallIncomingPayload {
  callId: string;
  calleeId: string;
  callerId: string;
  callerName: string;
  callerAvatar: string;
  callType: string;
  initiatedAt: number;
}

interface CallMissedPayload {
  callId: string;
  calleeId: string;
  callerId: string;
  callerName: string;
  callerAvatar: string;
  callType: string;
  missedAt: number;
}

async function handleCallIncoming(data: CallIncomingPayload): Promise<void> {
  // HOP 3 of the push pipeline (RabbitMQ → notifications-service). If this
  // appears but [push:deliver] shows tokens=0, the callee never registered a
  // device — the backend is fine and the problem is in the browser.
  logger.info(
    `[push:consume] call.incoming callId=${data.callId} callee=${data.calleeId} ` +
      `caller=${data.callerId} type=${data.callType}`
  );
  if (!data.calleeId || !data.callId) {
    logger.warn("[push:consume] dropped — missing calleeId/callId");
    return;
  }

  const isVideo = String(data.callType).toUpperCase() === "VIDEO";
  const caller = data.callerName || "Someone";
  const deepLink = buildDeepLink("call", data.callId);

  await pushToUser({
    userId: data.calleeId,
    category: "callEnabled",
    type: "CALL_INCOMING",
    title: caller,
    body: isVideo ? "Incoming video call" : "Incoming voice call",
    actorId: data.callerId,
    deepLink,
    // One ring per call — a re-publish must replace, never stack.
    collapseKey: `call:${data.callId}`,
    // Calls are time-critical: wake the device immediately and keep the
    // notification on screen (sendPush maps high → requireInteraction on web,
    // apns-priority 10, android priority high).
    priority: "high",
    // A ring is worthless once it has stopped ringing — expire with the
    // ringing window rather than sitting in FCM for 24h.
    ttl: env.CALL_RINGING_TIMEOUT_SEC,
    // Calls are live events, not Notification Center entries. (CALL_INCOMING
    // is not on the inbox allowlist either — this makes the intent explicit.)
    skipInbox: true,
    // Masked body when the user has "show preview" off — never leaks who.
    showPreviewOverride: isVideo
      ? "Incoming video call"
      : "Incoming voice call",
    // FCM data map — all values MUST be strings.
    data: {
      type: "CALL_INCOMING",
      callId: data.callId,
      callerId: data.callerId,
      callerName: data.callerName ?? "",
      callerAvatar: data.callerAvatar ?? "",
      callType: isVideo ? "VIDEO" : "AUDIO",
      initiatedAt: String(data.initiatedAt ?? ""),
      idempotencyKey: data.callId,
      deepLink,
    },
  });
}

async function handleCallMissed(data: CallMissedPayload): Promise<void> {
  logger.info(
    `[push:consume] call.missed callId=${data.callId} callee=${data.calleeId} ` +
      `caller=${data.callerId} type=${data.callType}`
  );
  if (!data.calleeId || !data.callId) {
    logger.warn("[push:consume] dropped — missing calleeId/callId");
    return;
  }

  const isVideo = String(data.callType).toUpperCase() === "VIDEO";
  const caller = data.callerName || "Someone";
  const deepLink = buildDeepLink("call", data.callId);
  const body = isVideo ? "Missed video call" : "Missed voice call";

  await pushToUser({
    userId: data.calleeId,
    category: "callEnabled",
    type: "CALL_MISSED",
    title: caller,
    body,
    actorId: data.callerId,
    deepLink,
    // Distinct from the ring's `call:<id>` collapse key — the ring is long over
    // by the time this fires, no need to share/replace it.
    collapseKey: `call:missed:${data.callId}`,
    // Not time-critical — the moment already passed. Default priority/TTL (24h)
    // is fine, unlike the ring which had to be immediate and short-lived.
    // This DOES persist to the Notification Center (see INBOX_ALLOWED_TYPES) —
    // unlike the live ring, a missed call is exactly the kind of thing a user
    // wants to find later, so skipInbox is intentionally NOT set here.
    showPreviewOverride: body,
    data: {
      type: "CALL_MISSED",
      callId: data.callId,
      callerId: data.callerId,
      callerName: data.callerName ?? "",
      callerAvatar: data.callerAvatar ?? "",
      callType: isVideo ? "VIDEO" : "AUDIO",
      missedAt: String(data.missedAt ?? ""),
      idempotencyKey: data.callId,
      deepLink,
    },
  });
}

export async function startCallConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // chat-service publishes to a plain durable queue (NOT an exchange). Args MUST
  // match the publisher (apps/chat-service/src/events/publish-call-incoming.ts).
  await channel.assertQueue(CALL_PUSH_QUEUE, { durable: true });
  await channel.prefetch(20);

  logger.info("Call push consumer started");

  void channel.consume(CALL_PUSH_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        if (parsed.type === "call.incoming") {
          await handleCallIncoming(parsed.data as CallIncomingPayload);
        } else if (parsed.type === "call.missed") {
          await handleCallMissed(parsed.data as CallMissedPayload);
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
