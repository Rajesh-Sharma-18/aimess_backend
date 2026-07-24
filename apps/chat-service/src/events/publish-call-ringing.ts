import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";

// Durable queue carrying "a 1-to-1 call is ringing / was cancelled" to
// notifications-service, which fans a high-priority DATA-ONLY FCM push out so a
// killed/backgrounded callee device can ring (WhatsApp/Telegram style) and
// dismiss when handled. Push is a fallback wake — the socket `call:incoming` is
// primary — so this is best-effort and never throws. Publisher and consumer
// MUST assert identical queue args; RabbitMQ queue args are immutable.
const CALL_RING_QUEUE = "call.ring.queue";

export const CALL_RINGING_EVENT = "call.ringing";
export const CALL_CANCELLED_EVENT = "call.cancelled";

export interface CallRingingPayload {
  calleeId: string;
  callId: string;
  callerId: string;
  callerName: string;
  callerAvatarUrl: string;
  callType: string;
  livekitUrl: string;
  token: string;
  /** epoch ms */
  sentAt: number;
}

export interface CallCancelPayload {
  calleeId: string;
  callId: string;
  reason: string;
}

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("call.ring publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(CALL_RING_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

function publish(type: string, data: unknown): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (push is a fallback channel)
  void (async () => {
    try {
      const channel = await getChannel(url);
      channel.sendToQueue(
        CALL_RING_QUEUE,
        Buffer.from(JSON.stringify({ type, data })),
        { persistent: true }
      );
    } catch (error) {
      channelPromise = null;
      logger.warn(`Failed to publish ${type}: ${String(error)}`);
    }
  })();
}

/** Fire-and-forget ring push trigger. Best-effort — never throws. */
export function publishCallRingingSafe(payload: CallRingingPayload): void {
  publish(CALL_RINGING_EVENT, payload);
}

/** Fire-and-forget cancel push trigger (call answered/declined/ended/missed). */
export function publishCallCancelSafe(payload: CallCancelPayload): void {
  publish(CALL_CANCELLED_EVENT, payload);
}
