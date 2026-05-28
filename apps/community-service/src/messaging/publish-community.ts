import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  CommunityEvents,
  type CommunityAdminTransferredPayload,
  type CommunityDeletedPayload,
  type CommunityInviteAcceptedPayload,
  type CommunityInviteSentPayload,
  type CommunityJoinedPayload,
  type CommunityJoinRequestedPayload,
  type CommunityMemberAddedPayload,
  type CommunityMemberBannedPayload,
  type CommunityMemberKickedPayload,
  type CommunityMemberRoleChangedPayload,
  type CommunityReportActionedPayload,
  type CommunityReportCreatedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

const COMMUNITY_QUEUE = "community.queue";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertQueue(COMMUNITY_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(type: string, data: unknown): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({ type, data });
  channel.sendToQueue(COMMUNITY_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

function publishSafe(type: string, data: unknown, label: string): void {
  void publish(type, data).catch((error) => {
    logger.error(`Failed to publish ${label}`);
    logger.error(error);
  });
}

export function publishCommunityMemberAddedSafe(
  data: CommunityMemberAddedPayload
): void {
  publishSafe(CommunityEvents.MEMBER_ADDED, data, "community.member_added");
}

export function publishCommunityMemberKickedSafe(
  data: CommunityMemberKickedPayload
): void {
  publishSafe(CommunityEvents.MEMBER_KICKED, data, "community.member_kicked");
}

export function publishCommunityMemberBannedSafe(
  data: CommunityMemberBannedPayload
): void {
  publishSafe(CommunityEvents.MEMBER_BANNED, data, "community.member_banned");
}

export function publishCommunityMemberRoleChangedSafe(
  data: CommunityMemberRoleChangedPayload
): void {
  publishSafe(
    CommunityEvents.MEMBER_ROLE_CHANGED,
    data,
    "community.member_role_changed"
  );
}

export function publishCommunityJoinedSafe(data: CommunityJoinedPayload): void {
  publishSafe(CommunityEvents.JOINED, data, "community.joined");
}

export function publishCommunityAdminTransferredSafe(
  data: CommunityAdminTransferredPayload
): void {
  publishSafe(
    CommunityEvents.ADMIN_TRANSFERRED,
    data,
    "community.admin_transferred"
  );
}

export function publishCommunityDeletedSafe(
  data: CommunityDeletedPayload
): void {
  publishSafe(CommunityEvents.DELETED, data, "community.deleted");
}

export function publishCommunityJoinRequestedSafe(
  data: CommunityJoinRequestedPayload
): void {
  publishSafe(CommunityEvents.JOIN_REQUESTED, data, "community.join_requested");
}

export function publishCommunityInviteSentSafe(
  data: CommunityInviteSentPayload
): void {
  publishSafe(CommunityEvents.INVITE_SENT, data, "community.invite_sent");
}

export function publishCommunityInviteAcceptedSafe(
  data: CommunityInviteAcceptedPayload
): void {
  publishSafe(
    CommunityEvents.INVITE_ACCEPTED,
    data,
    "community.invite_accepted"
  );
}

export function publishCommunityReportCreatedSafe(
  data: CommunityReportCreatedPayload
): void {
  publishSafe(CommunityEvents.REPORT_CREATED, data, "community.report_created");
}

export function publishCommunityReportActionedSafe(
  data: CommunityReportActionedPayload
): void {
  publishSafe(
    CommunityEvents.REPORT_ACTIONED,
    data,
    "community.report_actioned"
  );
}
