import { logger } from "@aimess/logger";
import amqp from "amqplib";
import {
  isUnreadCallActivity,
  t,
  type CallActivityDirection,
} from "@aimess/constants";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
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

/**
 * Where a call event goes after its retries are exhausted, so it is parked for
 * inspection/replay instead of destroyed.
 *
 * Deliberately NOT wired as an `x-dead-letter-exchange` on `call.push.queue`:
 * queue arguments are immutable once declared, chat-service asserts that queue
 * with `{durable:true}` and nothing else, and a mismatched redeclare fails the
 * channel — which would take the consumer down on deploy. Publishing here
 * explicitly needs no argument change on either side and is the same amqplib
 * the rest of this file already uses.
 */
const CALL_PUSH_DLQ = "call.push.dlq";

/**
 * Attempts before a message is parked. The projection is idempotent by
 * construction (`groupKey = call:<callId>` transitions one row, never stacks
 * one), so a replay is free and the only cost of another attempt is latency.
 * One retry was not enough to outlive an ordinary rolling restart of
 * chat-service, and the message it dropped was somebody's call history.
 */
const MAX_DELIVERY_ATTEMPTS = 3;

/** 1-based attempt number for this delivery, carried on the message itself. */
function attemptOf(message: amqp.ConsumeMessage): number {
  const raw = message.properties.headers?.["x-delivery-attempt"];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Inbox type for call HISTORY. ONE type, not one per outcome — the outcome is
 * the canonical `CallTimelineStatus` carried in `data.callStatus`, so there is
 * no second call-state enum to keep in sync. The `call.` prefix is what routes
 * the row to the FRIENDS tab (chat-service lib/notification-category.ts).
 */
const CALL_ACTIVITY_TYPE = "call.activity";

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
  /** Session of the device that caused the dismissal — never pushed to. */
  excludeSessionId?: string;
}

// Same wire shape as the cancel payload; the meaning lives in the queue `type`.
type CallHandledPayload = CallCancelPayload;

interface CallActivityPayload {
  callId: string;
  callerId: string;
  calleeId: string;
  callType: string;
  /** Canonical terminal CallTimelineStatus from chat-service. */
  status: string;
  durationSec: number;
  /** Ring length in seconds; disambiguates a cancelled ring (see grace window). */
  ringDurationSec?: number;
  privateRoomId: string;
  endedAt: number;
  callerName: string;
  callerAvatar: string;
  calleeName: string;
  calleeAvatar: string;
}

/**
 * One ring push per call, no matter how many times the event is delivered.
 *
 * The consumer below acks INSIDE a detached async task with `prefetch(20)`, so
 * a restart, a channel drop or a broker reconnect mid-flight leaves the message
 * unacked and RabbitMQ redelivers it. That is a genuine second `call.incoming`
 * — a second VoIP push, a second PushKit delivery, and on iOS the second one
 * lands against a callId the client may already consider settled, which is
 * exactly the state that makes it fabricate a caller-less "Incoming call".
 *
 * `apns-collapse-id` only helps while APNs still HOLDS the first copy; once
 * delivered, collapsing cannot recall it. Suppressing the duplicate here is the
 * half that always works.
 *
 * Deliberately FAILS OPEN. A ring that is never sent is a missed call; a ring
 * sent twice is noise. If Redis is unreachable we send — every time.
 *
 * Claimed BEFORE the push rather than after: `pushToUser` never throws (it
 * swallows its own delivery failures), so there is no retry-after-failure path
 * that an early claim could starve. The TTL is the ringing window — past that
 * the callId can never ring again anyway.
 */
async function claimRingPush(callId: string): Promise<boolean> {
  try {
    const won = await redis.set(
      `push:sent:call.incoming:${callId}`,
      "1",
      "EX",
      env.CALL_RINGING_TIMEOUT_SEC,
      "NX"
    );
    return won === "OK";
  } catch (error) {
    logger.warn(
      `[push:consume] ring dedup unavailable for ${callId}, sending anyway: ${String(error)}`
    );
    return true;
  }
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

  if (!(await claimRingPush(data.callId))) {
    logger.warn(
      `[push:consume] call.incoming callId=${data.callId} suppressed — ring already pushed (redelivery)`
    );
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
  // The DM, not the call. A missed call is over — there is nothing to open on
  // `aimess://call/<callId>`, and the matching Notification-Center row already
  // deep-links to the conversation. Tapping either now lands in the same place,
  // where the call card and the call-back button live.
  const deepLink = buildDeepLink("conversation", data.callerId);

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
    //
    // Push ONLY. The Notification-Center card for a missed call is written by
    // the `call.activity` projection below, which covers every outcome (missed,
    // declined, cancelled, completed, failed) with one consistent line and one
    // row per call. Two writers for the same call produced two cards.
    skipInbox: true,
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
    // MUST NOT be shorter than the ring's own TTL. A dismiss that expires while
    // the ring it dismisses is still queued is worse than useless: APNs drops
    // the cancel, keeps the CALL_INCOMING, and delivers the ring when the
    // device comes back — a phone ringing for a call that ended minutes ago.
    // This is always published AFTER the ring, so an equal TTL already outlives
    // it; tying both to the same env value keeps that true if it is ever tuned.
    ttl: env.CALL_RINGING_TIMEOUT_SEC,
    collapseKey: `call:${data.callId}`,
    // Never push a dismissal back to the device that produced it. It already
    // tore its own ring down, and this is a high-priority push that WAKES it —
    // the wake being the trigger that resurfaced a stale ring on iOS. Every
    // OTHER device of this user still gets the backstop.
    excludeSessionId: data.excludeSessionId,
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
    // Same reasoning as handleCallCancel: never shorter than the ring's TTL, or
    // the stop-ringing hint expires out from under a ring APNs is still holding.
    ttl: env.CALL_RINGING_TIMEOUT_SEC,
    // Shares the ring's collapse key so it REPLACES the ring notification on the
    // sibling device rather than stacking beside it.
    collapseKey: `call:${data.callId}`,
    // "Handled ELSEWHERE" is meaningless to the device that handled it — and it
    // is the device most likely to be mid-call, where an unnecessary wake is
    // most expensive. This is the push twin of the socket path's
    // `handledByLegId` exclusion.
    excludeSessionId: data.excludeSessionId,
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

/**
 * Settled 1:1 call → ONE Notification-Center row per participant.
 *
 * This is the call history behind Notifications → Friends. It writes the inbox
 * row ONLY (`skipPush`): the live ring and the missed-call alert are already
 * delivered by `call.incoming` / `call.missed`, so pushing here would notify
 * twice for one call.
 *
 * Duplicate prevention is structural, not defensive: every row carries
 * `groupKey = call:<callId>`, so a re-delivered event — or a second terminal
 * transition racing the first — transitions the SAME card instead of stacking a
 * second one, exactly like the friend request → accepted flow. `resurface:false`
 * keeps a late duplicate from flipping a read card back to unread.
 *
 * Only a call the reader never answered arrives unread (isUnreadCallActivity):
 * an outgoing call, and a call the reader was present for, are history — not
 * something to badge them about.
 */
export async function handleCallActivity(
  data: CallActivityPayload
): Promise<void> {
  logger.info(
    `[push:consume] call.activity callId=${data.callId} status=${data.status} ` +
      `type=${data.callType} duration=${data.durationSec}`
  );
  if (!data.callId || !data.callerId || !data.calleeId) {
    logger.warn("[push:consume] dropped — missing callId/callerId/calleeId");
    return;
  }

  const callType =
    String(data.callType).toUpperCase() === "VIDEO" ? "VIDEO" : "AUDIO";
  const status = String(data.status).toUpperCase();
  const durationSec = Math.max(0, Math.floor(Number(data.durationSec) || 0));
  // Absent on a legacy/in-flight event — left undefined so the shared mapper
  // falls back to the previous "a cancelled ring is a missed call" behaviour
  // rather than silently un-badging it.
  const ringDurationSec =
    data.ringDurationSec === undefined || data.ringDurationSec === null
      ? undefined
      : Math.max(0, Math.floor(Number(data.ringDurationSec) || 0));

  // Direction comes from the call record's own participants — never from text.
  const sides: {
    userId: string;
    peerId: string;
    peerName: string;
    peerAvatar: string;
    direction: CallActivityDirection;
  }[] = [
    {
      userId: data.callerId,
      peerId: data.calleeId,
      peerName: data.calleeName ?? "",
      peerAvatar: data.calleeAvatar ?? "",
      direction: "OUTGOING",
    },
    {
      userId: data.calleeId,
      peerId: data.callerId,
      peerName: data.callerName ?? "",
      peerAvatar: data.callerAvatar ?? "",
      direction: "INCOMING",
    },
  ];

  // Each participant's row is written INDEPENDENTLY. Sequentially awaiting one
  // side meant a failure on the first (the caller) threw out of this handler
  // before the second was ever attempted, so one flaky recipient silently cost
  // the OTHER participant their call history too. Both are derived from the
  // same canonical call record; neither depends on the other succeeding.
  const results = await Promise.allSettled(
    sides.map((side) =>
      pushToUser({
        userId: side.userId,
        category: "callEnabled",
        type: CALL_ACTIVITY_TYPE,
        copy: callCopy.activity(
          side.peerName,
          callType,
          status,
          side.direction,
          durationSec,
          ringDurationSec
        ),
        // The peer's name is the card heading; the body is the call line.
        inboxTitle: side.peerName || null,
        // The peer — so the read path resolves their fresh name/avatar and a
        // click opens their DM, the same contract a friendship row uses.
        actorId: side.peerId,
        deepLink: buildDeepLink("conversation", side.peerId),
        // History, not a live event: the inbox row is the whole point.
        skipPush: true,
        data: {
          type: CALL_ACTIVITY_TYPE,
          callId: data.callId,
          callType,
          callStatus: status,
          callDirection: side.direction,
          durationSec: String(durationSec),
          peerId: side.peerId,
          peerAvatarUrl: side.peerAvatar,
          roomId: data.privateRoomId ?? "",
          endedAt: String(data.endedAt ?? ""),
          // ONE card per call, transitioned in place — never a card per state.
          groupKey: `call:${data.callId}`,
          // Where a tap on this row goes. Every other navigable notification
          // type carries this; call rows did not, so a client had to special-
          // case them and infer the destination from `peerId`/`roomId`.
          // `serializeNotification` already parses `data.navigation` into a
          // top-level `navigation` field, so this is purely additive — and it
          // is the same destination the missed-call push already deep-links to.
          navigation: JSON.stringify({
            type: "conversation",
            id: side.peerId,
            roomId: data.privateRoomId ?? "",
          }),
          // A settled call must not jump back to unread when a late duplicate
          // transition rewrites it.
          resurface: "false",
          ...(isUnreadCallActivity(status, side.direction, ringDurationSec)
            ? {}
            : { markRead: "true" }),
        },
      })
    )
  );

  // A row that never got written is a hole in someone's call history, and
  // pushToUser swallows its own failures — so name the recipient here or it is
  // invisible. Throwing keeps the message unacked so the consumer can redeliver
  // it (the groupKey makes a replay idempotent).
  const failed = results
    .map((result, index) => ({ result, side: sides[index]! }))
    .filter((entry) => entry.result.status === "rejected");
  if (failed.length > 0) {
    for (const { result, side } of failed) {
      logger.error(
        `[call.activity] inbox row FAILED callId=${data.callId} ` +
          `recipient=${side.userId} peer=${side.peerId} direction=${side.direction} ` +
          `callType=${callType} callStatus=${status} type=${CALL_ACTIVITY_TYPE}: ` +
          String((result as PromiseRejectedResult).reason)
      );
    }
    throw new Error(
      `call.activity projection failed for ${failed.length} of ${sides.length} participants (callId=${data.callId})`
    );
  }
}

export async function startCallConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // chat-service publishes to a plain durable queue (NOT an exchange). Args MUST
  // match the publisher (apps/chat-service/src/events/publish-call-incoming.ts).
  await channel.assertQueue(CALL_PUSH_QUEUE, { durable: true });
  // Plain durable queue, no arguments — nothing here changes the args of
  // CALL_PUSH_QUEUE, so the redeclare stays compatible with chat-service's.
  await channel.assertQueue(CALL_PUSH_DLQ, { durable: true });
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
        } else if (parsed.type === CALL_ACTIVITY_TYPE) {
          await handleCallActivity(parsed.data as CallActivityPayload);
        } else {
          logger.warn(`Unknown call event type: ${parsed.type}`);
        }
        channel.ack(message);
      } catch (error) {
        // Bounded retry, then PARK — never destroy. Dropping on the first
        // failure treated every error as deterministic, so one transient blip
        // (chat-service restarting, a gRPC deadline) permanently erased that
        // call from both participants' history. One retry was better but still
        // did not outlive an ordinary rolling restart.
        //
        // Replay is safe by construction: every projection is keyed on
        // `groupKey = call:<callId>` and transitions the same row, so a
        // redelivery can only ever rewrite what is already there.
        //
        // The attempt count rides on the message because `fields.redelivered`
        // is a boolean and cannot count past one. Requeue-with-header is a
        // republish, so the message goes to the BACK of the queue rather than
        // spinning at the head — a poisonous message cannot starve the others.
        const attempt = attemptOf(message);
        if (attempt < MAX_DELIVERY_ATTEMPTS) {
          logger.error(
            `Call push consumer failed (attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS}), retrying`,
            error
          );
          channel.sendToQueue(CALL_PUSH_QUEUE, message.content, {
            persistent: true,
            headers: {
              ...(message.properties.headers ?? {}),
              "x-delivery-attempt": attempt + 1,
            },
          });
          channel.ack(message);
          return;
        }
        logger.error(
          `Call push consumer exhausted ${MAX_DELIVERY_ATTEMPTS} attempts — parking in ${CALL_PUSH_DLQ}`,
          error
        );
        channel.sendToQueue(CALL_PUSH_DLQ, message.content, {
          persistent: true,
          headers: {
            ...(message.properties.headers ?? {}),
            "x-delivery-attempt": attempt,
            "x-death-reason": String(error).slice(0, 500),
          },
        });
        channel.ack(message);
      }
    })();
  });
}
