import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";

/**
 * Durable queue carrying "someone is ringing you" to notifications-service,
 * which sends a high-priority FCM push so the callee is woken even when the tab
 * is backgrounded/closed (the `call:incoming` socket event only reaches a live
 * socket). Push is the fallback wake — the socket is primary delivery — so this
 * is best-effort and safely duplicable (the client dedups on callId).
 *
 * Publisher (here) and consumer (notifications-service call.consumer.ts) MUST
 * assert identical queue args; RabbitMQ queue args are immutable once declared.
 */
const CALL_PUSH_QUEUE = "call.push.queue";

export const CALL_INCOMING_EVENT = "call.incoming";
export const CALL_MISSED_EVENT = "call.missed";
export const CALL_CANCELLED_EVENT = "call.cancelled";
/**
 * "One of your OWN devices answered/handled this ring — stop ringing, but this
 * call is NOT over." Distinct from `call.cancelled` on purpose: cancelled means
 * the call is gone (dismiss + tear down), handled means it lives on another of
 * the recipient's devices. Reusing `call.cancelled` for the answered-elsewhere
 * case is exactly what let a client dismiss the very call it had just answered —
 * `call.cancelled` fires against a RINGING recipient, `call.handled` can fire
 * against one who is mid-call, so it must be a separate, non-destructive signal.
 */
export const CALL_HANDLED_EVENT = "call.handled";

export interface CallIncomingPayload {
  callId: string;
  /** The user being rung — the push recipient. */
  calleeId: string;
  callerId: string;
  callerName: string;
  /** Already-resolved (presigned) avatar URL, never a raw object key. */
  callerAvatar: string;
  /** "AUDIO" | "VIDEO" */
  callType: string;
  /** epoch ms */
  initiatedAt: number;
  /** Callee's LiveKit creds, so a push-woken client can join without the socket. */
  livekitUrl: string;
  token: string;
}

export interface CallMissedPayload {
  callId: string;
  /** The user who missed the call — the push recipient. */
  calleeId: string;
  callerId: string;
  callerName: string;
  callerAvatar: string;
  callType: string;
  /** epoch ms */
  missedAt: number;
}

export interface CallCancelPayload {
  /** The user whose ring should be dismissed — the push recipient. */
  calleeId: string;
  callId: string;
  reason: string;
  /** Included so the device can resolve caller identity from its local cache. */
  callerId?: string;
  callerName?: string;
}

/**
 * Same shape as {@link CallCancelPayload} — the difference is entirely in the
 * event `type` on the wire (`call.handled` vs `call.cancelled`), which is what
 * lets a client tell "stop ringing, call continues elsewhere" apart from "call
 * is over".
 */
export type CallHandledPayload = CallCancelPayload;

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("call.incoming publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(CALL_PUSH_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

/**
 * Fire-and-forget push trigger for an incoming call. Best-effort: a failure is
 * logged, never thrown, so placing a call never fails on its push event.
 */
export function publishCallIncomingSafe(p: CallIncomingPayload): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (push is a fallback channel)
  void (async () => {
    try {
      const channel = await getChannel(url);
      const payload = JSON.stringify({ type: CALL_INCOMING_EVENT, data: p });
      channel.sendToQueue(CALL_PUSH_QUEUE, Buffer.from(payload), {
        persistent: true,
        // A ring is only meaningful while it is still ringing. Drop the message
        // if it can't be delivered within the ringing window — a push that
        // lands after the call timed out is noise.
        expiration: String(env.CALL_RINGING_TIMEOUT_SEC * 1000),
      });
      // HOP 2 of the push pipeline (chat-service → RabbitMQ). If this appears
      // but [push:consume] never does, notifications-service isn't consuming.
      logger.info(
        `[push:publish] call.incoming callId=${p.callId} callee=${p.calleeId} ` +
          `caller=${p.callerId} type=${p.callType}`
      );
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish call.incoming for ${p.callId}: ${String(error)}`
      );
    }
  })();
}

/**
 * Fire-and-forget push trigger for a missed call. Unlike the incoming-call
 * ring, this has no expiration — the point has already passed by the time it's
 * sent, but the recipient should still find out. Best-effort: a failure is
 * logged, never thrown, so the missed-call sweep never fails on this.
 */
export function publishCallMissedSafe(p: CallMissedPayload): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (push is a fallback channel)
  void (async () => {
    try {
      const channel = await getChannel(url);
      const payload = JSON.stringify({ type: CALL_MISSED_EVENT, data: p });
      channel.sendToQueue(CALL_PUSH_QUEUE, Buffer.from(payload), {
        persistent: true,
      });
      logger.info(
        `[push:publish] call.missed callId=${p.callId} callee=${p.calleeId} ` +
          `caller=${p.callerId} type=${p.callType}`
      );
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish call.missed for ${p.callId}: ${String(error)}`
      );
    }
  })();
}

/**
 * Fire-and-forget push trigger to dismiss an in-flight ring (answered
 * elsewhere / declined / ended / missed before the callee's device woke).
 * Best-effort: a failure is logged, never thrown.
 */
export function publishCallCancelSafe(p: CallCancelPayload): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (push is a fallback channel)
  void (async () => {
    try {
      const channel = await getChannel(url);
      const payload = JSON.stringify({ type: CALL_CANCELLED_EVENT, data: p });
      channel.sendToQueue(CALL_PUSH_QUEUE, Buffer.from(payload), {
        persistent: true,
      });
      logger.info(
        `[push:publish] call.cancelled callId=${p.callId} callee=${p.calleeId} reason=${p.reason}`
      );
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish call.cancelled for ${p.callId}: ${String(error)}`
      );
    }
  })();
}

/**
 * Fire-and-forget "answered/handled on another of YOUR devices — stop ringing"
 * push. Separate from {@link publishCallCancelSafe} because the recipient may be
 * mid-call on the device that answered, so this must NEVER be treated as
 * terminal by the receiver. Carries the ringing-window expiration: a "stop
 * ringing" is meaningless once the ring is over, and bounding it keeps a queued
 * copy from surfacing minutes later. Best-effort: a failure is logged, never
 * thrown.
 */
export function publishCallHandledPushSafe(p: CallHandledPayload): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (push is a fallback channel)
  void (async () => {
    try {
      const channel = await getChannel(url);
      const payload = JSON.stringify({ type: CALL_HANDLED_EVENT, data: p });
      channel.sendToQueue(CALL_PUSH_QUEUE, Buffer.from(payload), {
        persistent: true,
        expiration: String(env.CALL_RINGING_TIMEOUT_SEC * 1000),
      });
      logger.info(
        `[push:publish] call.handled callId=${p.callId} callee=${p.calleeId} reason=${p.reason}`
      );
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish call.handled for ${p.callId}: ${String(error)}`
      );
    }
  })();
}
