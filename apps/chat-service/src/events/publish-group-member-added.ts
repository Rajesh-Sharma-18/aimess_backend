import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import {
  ChatEvents,
  type ChatGroupMemberAddedPayload,
  type ChatGroupMemberMutedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { resolveMediaUrl } from "../lib/media-resolve.js";

/**
 * Durable queue carrying "a member was added to a group" to notifications-service,
 * which pushes/inboxes the added user who is not in the room socket (mirrors the
 * community MEMBER_ADDED fan-out). Best-effort: the in-room SYSTEM message is the
 * primary signal, so a publish failure is logged, never thrown — adding a member
 * must not fail on its notification event. Publisher (here) and consumer
 * (notifications-service) MUST assert identical queue args; queue args are
 * immutable once declared.
 */
const CHAT_GROUP_QUEUE = "chat.group.queue";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("chat.group publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(CHAT_GROUP_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

/**
 * Fire-and-forget group member-added trigger. Best-effort: a failure is logged,
 * never thrown, so adding a member never fails on its notification event.
 */
export function publishGroupMemberAddedSafe(
  data: ChatGroupMemberAddedPayload
): void {
  publishGroupEventSafe(ChatEvents.GROUP_MEMBER_ADDED, data);
}

/**
 * Moderation mute/unmute notice for the TARGET member — the group counterpart
 * of community's MEMBER_MUTED / MEMBER_UNMUTED push. The `group:member:muted`
 * socket event already covers every LIVE device; this covers the member whose
 * devices were all offline when the mute landed, so the state is not first
 * discovered by a send being rejected. Same best-effort contract as the add.
 */
export function publishGroupMemberMuteSafe(
  event:
    | typeof ChatEvents.GROUP_MEMBER_MUTED
    | typeof ChatEvents.GROUP_MEMBER_UNMUTED,
  data: ChatGroupMemberMutedPayload
): void {
  publishGroupEventSafe(event, data);
}

function publishGroupEventSafe(
  type: string,
  data: { roomId: string; groupName?: string }
): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (push is a fallback channel)
  void (async () => {
    try {
      // A group notification represents the GROUP, so the tray image is the
      // group avatar — never the actor's. Read from the authoritative GroupRoom
      // row at publish time (same choke-point rule as publish-message-sent.ts),
      // so a renamed/re-imaged group is correct on the very next event and the
      // name and image always come from one row. Best-effort: no row, no MinIO
      // → the fields are simply absent and the client falls back as before.
      const room = await prisma.groupRoom
        .findUnique({
          where: { roomId: data.roomId },
          select: { name: true, avatar: true },
        })
        .catch(() => null);
      const groupAvatarUrl = await resolveMediaUrl(room?.avatar).catch(
        () => ""
      );
      const channel = await getChannel(url);
      channel.sendToQueue(
        CHAT_GROUP_QUEUE,
        Buffer.from(
          JSON.stringify({
            type,
            data: {
              ...data,
              groupName: room?.name || data.groupName || "",
              ...(groupAvatarUrl ? { groupAvatarUrl } : {}),
            },
          })
        ),
        { persistent: true }
      );
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish ${type} for ${data.roomId}: ${String(error)}`
      );
    }
  })();
}
