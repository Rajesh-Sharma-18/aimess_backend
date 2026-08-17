import { logger } from "@aimess/logger";
import amqp from "amqplib";
import { t } from "@aimess/constants";

import { env } from "../config/env.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { callCopy } from "../lib/notification-copy.js";
import { generateEventThreadId } from "../lib/thread-id.js";
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
  livekitUrl?: string;
  token?: string;
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

interface CallCancelPayload {
  callId: string;
  calleeId: string;
  reason: string;
  callerId?: string;
  callerName?: string;
}

// Same wire shape as the cancel payload; the meaning lives in the queue `type`.
type CallHandledPayload = CallCancelPayload;

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
    copy: callCopy.ringing(caller, isVideo ? "VIDEO" : "VOICE"),
    actorId: data.callerId,
    deepLink,
    // One ring per call — a re-publish must replace, never stack.
    collapseKey: `call:${data.callId}`,
    // Group all call-related notifications together
    apnsThreadId: generateEventThreadId("CALL_INCOMING"),
    // Calls are time-critical: wake the device immediately and keep the
    // notification on screen (sendPush maps high → requireInteraction on web,
    // apns-priority 10, android priority high).
    priority: "high",
    // A ring is worthless once it has stopped ringing — expire with the
    // ringing window rather than sitting in FCM for 24h.
    ttl: env.CALL_RINGING_TIMEOUT_SEC,
    // Live ring — iOS VOIP tokens get an APNs VoIP push (required for reliable
    // wake); see PushInput.allowVoip docs for why this must stay opt-in.
    allowVoip: true,
    // iOS shows "Accept" / "Decline" action buttons when the category matches a
    // registered UNNotificationCategory. iOS side must register "INCOMING_CALL".
    apnsCategory: "INCOMING_CALL",
    // No `notification` block: the client renders its own full-screen CallStyle
    // ring. Sending one makes Android auto-post a SECOND tray notification
    // beside it, and a notification-carrying message does not reliably reach
    // onMessageReceived when the app is killed — which is the whole point.
    dataOnly: true,
    // Calls are live events, not Notification Center entries. (CALL_INCOMING
    // is not on the inbox allowlist either — this makes the intent explicit.)
    skipInbox: true,
    // Masked body when the user has "show preview" off — never leaks who.
    showPreviewOverride: (locale) =>
      t(
        isVideo ? "NOTIF_CALL_INCOMING_VIDEO" : "NOTIF_CALL_INCOMING_VOICE",
        locale
      ),
    // FCM data map — all values MUST be strings.
    data: {
      type: "CALL_INCOMING",
      callId: data.callId,
      callerId: data.callerId,
      callerName: data.callerName || "Someone",
      callerAvatar: data.callerAvatar ?? "",
      callType: isVideo ? "VIDEO" : "AUDIO",
      initiatedAt: String(data.initiatedAt ?? ""),
      idempotencyKey: data.callId,
      deepLink,
      livekitUrl: data.livekitUrl ?? "",
      token: data.token ?? "",
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

  await pushToUser({
    userId: data.calleeId,
    category: "callEnabled",
    type: "CALL_MISSED",
    copy: callCopy.missed(caller, isVideo ? "VIDEO" : "VOICE"),
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
    showPreviewOverride: (locale) =>
      t(
        isVideo ? "NOTIF_CALL_MISSED_VIDEO" : "NOTIF_CALL_MISSED_VOICE",
        locale
      ),
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

async function handleCallCancel(data: CallCancelPayload): Promise<void> {
  logger.info(
    `[push:consume] call.cancelled callId=${data.callId} callee=${data.calleeId} reason=${data.reason}`
  );
  if (!data.calleeId || !data.callId) {
    logger.warn("[push:consume] dropped — missing calleeId/callId");
    return;
  }

  // Data-only, same collapseKey as the incoming ring (`call:<id>`) — replaces
  // it on the device so the client can dismiss a ring that was answered
  // elsewhere / declined / ended / missed before this device woke up.
  await pushToUser({
    userId: data.calleeId,
    category: "callEnabled",
    type: "CALL_CANCELLED",
    title: "",
    body: "",
    bypassSettings: true,
    skipInbox: true,
    dataOnly: true,
    priority: "high",
    ttl: 30,
    collapseKey: `call:${data.callId}`,
    // allowVoip is deliberately OFF, for the same reason as handleCallHandled
    // below: iOS 13+ terminates the process if a PushKit delivery finishes
    // without a `reportNewIncomingCall`, so the app is FORCED to fabricate a
    // ring for whatever arrives on that channel. Routing a dismiss over VoIP
    // therefore produced a second, caller-less "Incoming call" screen a few
    // seconds after every cancel/decline/hangup — the ring the user had just
    // got rid of, coming back. The VoIP channel can only ever mean "incoming".
    //
    // Live devices already learn of this over the socket (`call:cancelled`);
    // this push only backstops a backgrounded one, which the normal data push
    // below reaches (iOS delivers it to `didReceiveRemoteNotification`, where
    // the app dismisses the CallKit ring without fabricating one). A device
    // suspended so deeply that even that is lost still falls back to the
    // client-side ring timeout.
    allowVoip: false,
    data: {
      type: "CALL_CANCELLED",
      callId: data.callId,
      reason: data.reason ?? "",
      callerId: data.callerId ?? "",
      callerName: data.callerName ?? "",
    },
  });
}

async function handleCallHandled(data: CallHandledPayload): Promise<void> {
  logger.info(
    `[push:consume] call.handled callId=${data.callId} callee=${data.calleeId} reason=${data.reason}`
  );
  if (!data.calleeId || !data.callId) {
    logger.warn("[push:consume] dropped — missing calleeId/callId");
    return;
  }

  // "One of your OWN devices answered this ring — stop ringing." Reaches ALL of
  // the recipient's devices, including the one that answered, so it must be
  // non-terminal: a client that is mid-call on this callId ignores it; a client
  // still ringing dismisses. That policy lives on the client; the backend's job
  // is to make the two cases distinguishable, which the `CALL_HANDLED` type does.
  //
  // allowVoip is deliberately OFF, as it now is on handleCallCancel too. A
  // PushKit/VoIP push MUST report an incoming call to CallKit or iOS penalises
  // the app — so the VoIP channel can only ever mean "incoming", never "stop".
  // Routing a stop-ringing hint over VoIP is precisely what turned an answered
  // call into a cancelled one. A normal data push is correct here; live devices
  // are already told over the socket (`call:handled`), and this only backstops
  // backgrounded siblings.
  await pushToUser({
    userId: data.calleeId,
    category: "callEnabled",
    type: "CALL_HANDLED",
    title: "",
    body: "",
    bypassSettings: true,
    skipInbox: true,
    dataOnly: true,
    priority: "high",
    ttl: 30,
    // Shares the ring's collapse key so it REPLACES the ring notification on the
    // sibling device rather than stacking beside it.
    collapseKey: `call:${data.callId}`,
    allowVoip: false,
    data: {
      type: "CALL_HANDLED",
      callId: data.callId,
      reason: data.reason ?? "",
      callerId: data.callerId ?? "",
      callerName: data.callerName ?? "",
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
        } else if (parsed.type === "call.cancelled") {
          await handleCallCancel(parsed.data as CallCancelPayload);
        } else if (parsed.type === "call.handled") {
          await handleCallHandled(parsed.data as CallHandledPayload);
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
